/**
 * Query audit: what the store actually issues, per endpoint.
 *
 * Wraps the database handle, drives each endpoint's real store path, and
 * records every statement -- how many times it ran, how long it took, and what
 * EXPLAIN QUERY PLAN says about it. The point is to find N+1s and full scans by
 * observation rather than by reading the code and guessing.
 *
 * Usage: node query-audit.mjs [/tmp/clovers.db]
 */

import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'module'

const { createStore } = createRequire(import.meta.url)('../../dist/lib/store/sqlite.js')

const dbPath = process.argv[2] || '/tmp/clovers.db'
const CLOVERS = '0xb55c5cac5014c662fdbf21a2c59cd45403c482fd'
const real = new DatabaseSync(dbPath, { readOnly: true })

let log = []
let recording = false

// A proxy handle: same surface createStore uses, but every prepare/step is
// recorded. Statements are compiled fresh each time, exactly as the store does.
const tracker = {
  prepare (sql) {
    const stmt = real.prepare(sql)
    const wrap = (name) => (...args) => {
      const t0 = performance.now()
      const out = stmt[name](...args)
      if (recording) log.push({ sql, ms: performance.now() - t0, rows: Array.isArray(out) ? out.length : out ? 1 : 0 })
      return out
    }
    return { get: wrap('get'), all: wrap('all'), run: wrap('run'),
             iterate: stmt.iterate ? stmt.iterate.bind(stmt) : undefined }
  },
  exec: (s) => real.exec(s),
  close: () => real.close()
}

const store = createStore(tracker, { cloversAddress: CLOVERS })

const boards = real.prepare(`SELECT board FROM clovers WHERE owner_lc <> '0x0000000000000000000000000000000000000000' ORDER BY modified DESC LIMIT 5`).all().map(r => r.board)
const owner = real.prepare('SELECT owner_lc o FROM clovers GROUP BY o ORDER BY count(*) DESC LIMIT 1 OFFSET 1').get().o
const chatBoard = real.prepare('SELECT board FROM chats GROUP BY board ORDER BY count(*) DESC LIMIT 1').get().board

// Each entry mirrors what one HTTP request makes the store do.
const ENDPOINTS = [
  ['GET /clovers', () => {
    store.countClovers('all')
    store.listCloversWithUsers({ filter: 'all', sort: 'modified', asc: false, page: 1, pageSize: 24 })
  }],
  ['GET /clovers?page=200', () => {
    store.countClovers('all')
    store.listCloversWithUsers({ filter: 'all', sort: 'modified', asc: false, page: 200, pageSize: 24 })
  }],
  ['GET /clovers/:id', () => store.getCloverWithUser(boards[0])],
  ['GET /clovers/:id/activity', () => {
    store.countLogsForClover(boards[0])
    store.logsForClover(boards[0], { page: 1, pageSize: 12 }).map(l => store.hydrateLogUsers(l))
  }],
  ['GET /logs', () => {
    store.countLogs(null)
    store.listLogs({ page: 1, pageSize: 24 }).map(l => store.hydrateLogUsers(l))
  }],
  ['GET /users', () => { store.countUsers(); store.listUsers({ sort: 'balance', page: 1, pageSize: 24 }) }],
  ['GET /users/:id/clovers', () => {
    store.countCloversByOwner(owner, null)
    store.cloversByOwner(owner, { page: 1, pageSize: 12 }).map(c => {
      store.getUser(c.owner); store.lastOrderForMarket(c.board)
    })
  }],
  ['GET /users/:id/albums', () => { store.countAlbumsByUser(owner); store.albumsByUser(owner, { page: 1, pageSize: 12 }) }],
  ['GET /albums', () => { store.countAlbums(); store.listAlbums({ page: 1, pageSize: 12 }).map(a => store.withAlbumUser(a)) }],
  ['GET /chats/:board', () => {
    store.countChatsForBoard(chatBoard)
    store.chatsBefore(chatBoard, new Date().toISOString(), { pageSize: 16 })
  }],
  ['GET /search?s=a', () => { store.searchClovers('a'); store.searchUsers('a'); store.searchAlbums('a') }],
  ['GET /orders', () => store.listOrders({ limit: 100 })]
]

const short = (sql) => sql.replace(/\s+/g, ' ').trim().slice(0, 62)

console.log('\n  QUERIES PER REQUEST\n')
console.log('  endpoint                     queries    ms    distinct   worst repeated statement')
console.log('  ' + '-'.repeat(108))

const findings = []
for (const [name, run] of ENDPOINTS) {
  log = []; recording = true
  const t0 = performance.now()
  run()
  const total = performance.now() - t0
  recording = false

  const counts = new Map()
  for (const e of log) {
    const c = counts.get(e.sql) || { n: 0, ms: 0 }
    c.n++; c.ms += e.ms
    counts.set(e.sql, c)
  }
  const worst = [...counts].sort((a, b) => b[1].n - a[1].n)[0]
  console.log(`  ${name.padEnd(28)} ${String(log.length).padStart(6)}  ${total.toFixed(1).padStart(6)}  ` +
    `${String(counts.size).padStart(8)}   ${worst ? `${worst[1].n}x ${short(worst[0])}` : ''}`)

  if (worst && worst[1].n > 4) findings.push({ name, n: worst[1].n, ms: worst[1].ms, sql: worst[0], total })
}

console.log('\n  N+1 PATTERNS  (one statement issued many times for one request)\n')
for (const f of findings.sort((a, b) => b.ms - a.ms)) {
  console.log(`  ${f.name.padEnd(28)} ${String(f.n).padStart(4)}x  ${f.ms.toFixed(1).padStart(6)} ms of ${f.total.toFixed(1)} ms total`)
  console.log(`      ${short(f.sql)}`)
}

// --------------------------------------------------------------------------
console.log('\n  QUERY PLANS  (every distinct statement the run above issued)\n')
const seen = new Set()
log = []; recording = true
for (const [, run] of ENDPOINTS) { try { run() } catch (e) {} }
recording = false

let scans = 0, sorts = 0
for (const e of log) {
  if (seen.has(e.sql)) continue
  seen.add(e.sql)
  let plan
  try {
    plan = real.prepare('EXPLAIN QUERY PLAN ' + e.sql).all().map(r => r.detail).join(' | ')
  } catch (err) { continue }
  const isScan = /SCAN (?!.*USING (COVERING )?INDEX)/.test(plan)
  const isSort = plan.includes('TEMP B-TREE')
  if (isScan || isSort) {
    if (isScan) scans++
    if (isSort) sorts++
    console.log(`  ${isScan ? 'TABLE SCAN' : 'SORT      '}  ${short(e.sql)}`)
    console.log(`              ${plan.slice(0, 100)}`)
  }
}
console.log(`\n  ${seen.size} distinct statements: ${scans} full table scans, ${sorts} needing a sort\n`)

// --------------------------------------------------------------------------
// Thresholds, so this is a guard and not just a report.
//
// The allowances are the two things that are genuinely inherent rather than
// unfixed: substring search cannot avoid scanning, because LIKE '%needle%' has
// no index that can help it, and it sorts what it finds. Everything else was
// designed out and should stay out. Raising these numbers should require an
// argument, not a shrug.
// --------------------------------------------------------------------------
const ALLOWED_SCANS = 1   // users, substring search
const ALLOWED_SORTS = 1   // the same statement
const ALLOWED_REPEATS = 24  // one user lookup per row of a 24-row page

let failed = 0
const assert = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed++ }

console.log('  THRESHOLDS\n')
assert(scans <= ALLOWED_SCANS, `full table scans: ${scans} (allowed ${ALLOWED_SCANS})`)
assert(sorts <= ALLOWED_SORTS, `statements needing a sort: ${sorts} (allowed ${ALLOWED_SORTS})`)
const worstRepeat = findings.length ? Math.max(...findings.map(f => f.n)) : 0
assert(worstRepeat <= ALLOWED_REPEATS,
  `worst repeated statement: ${worstRepeat}x (allowed ${ALLOWED_REPEATS}x)`)

console.log('')
process.exit(failed ? 1 : 0)
