/**
 * Query parity: SQLite vs the live RethinkDB-backed API.
 *
 * This is the step that decides whether the schema design holds. Row counts
 * matching proves the import worked; it says nothing about whether the 74 ReQL
 * indexes were translated correctly. These are the queries that actually
 * exercise them — the computed and compound ones behind each API filter.
 *
 * For each case it compares the total result count *and* the ordered first
 * page, because a wrong ORDER BY produces the right count and the wrong page.
 *
 * Usage: node parity.mjs /tmp/clovers.db
 */

import { DatabaseSync } from 'node:sqlite'

const dbPath = process.argv[2] || '/tmp/clovers.db'
const API = 'https://api.clovers.network'
const db = new DatabaseSync(dbPath)

const ZERO = '0x0000000000000000000000000000000000000000'
const CLOVERS = '0xb55c5cac5014c662fdbf21a2c59cd45403c482fd'
const PAGE = 24

// Each case mirrors one ReQL index. `where` is the translated predicate.
const CLOVER_FILTERS = [
  { filter: '',          label: 'all',       where: `owner_lc <> '${ZERO}'` },
  { filter: 'contract',  label: 'contract',  where: `owner_lc = '${CLOVERS}'` },
  { filter: 'public',    label: 'public',    where: `owner_lc NOT IN ('${CLOVERS}','${ZERO}')` },
  { filter: 'market',    label: 'market',    where: `price_num <> 0` },
  { filter: 'pending',   label: 'pending',   where: `owner_lc = '${CLOVERS}' AND price_num = 0` },
  { filter: 'Sym',       label: 'Sym',       where: `sym_total > 0` },
  { filter: 'NonSym',    label: 'NonSym',    where: `sym_total = 0 AND owner_lc <> '${ZERO}'` },
  { filter: 'RotSym',    label: 'RotSym',    where: `json_extract(symmetries,'$.RotSym') = 1` },
  { filter: 'X0Sym',     label: 'X0Sym',     where: `json_extract(symmetries,'$.X0Sym') = 1` },
  { filter: 'XYSym',     label: 'XYSym',     where: `json_extract(symmetries,'$.XYSym') = 1` },
  { filter: 'XnYSym',    label: 'XnYSym',    where: `json_extract(symmetries,'$.XnYSym') = 1` },
  { filter: 'Y0Sym',     label: 'Y0Sym',     where: `json_extract(symmetries,'$.Y0Sym') = 1` },
  { filter: 'commented', label: 'commented', where: `commentCount > 0` }
]

const LOG_FILTERS = [
  { filter: '',                              label: 'active feed', where: `is_active = 1` },
  { filter: 'Clovers_Transfer',              label: 'Clovers_Transfer', where: `feed_type = 'Clovers_Transfer'` },
  { filter: 'SimpleCloversMarket_updatePrice', label: 'updatePrice', where: `feed_type = 'SimpleCloversMarket_updatePrice'` },
  { filter: 'Coin_Activity',                 label: 'Coin_Activity', where: `feed_type = 'Coin_Activity'` },
  { filter: 'Comment_Added',                 label: 'Comment_Added', where: `feed_type = 'Comment_Added'` }
]

async function api (path) {
  const res = await fetch(API + path)
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
  return res.json()
}

let pass = 0, fail = 0
const report = (ok, label, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(22)} ${detail}`)
  ok ? pass++ : fail++
}

console.log('\nCLOVERS  (count, then ordered first page by modified desc)\n')
for (const c of CLOVER_FILTERS) {
  let live
  try { live = await api(`/clovers?page=1${c.filter ? '&filter=' + c.filter : ''}`) }
  catch (e) { report(false, c.label, 'live API error: ' + e.message); continue }

  const n = db.prepare(`SELECT count(*) AS n FROM clovers WHERE ${c.where}`).get().n
  const countOk = n === live.allResults
  report(countOk, c.label + ' count', `sqlite ${String(n).padStart(6)}  api ${String(live.allResults).padStart(6)}`)

  // The API sorts by modified descending and joins users, but board order is
  // what identifies the page.
  const mine = db.prepare(
    `SELECT board FROM clovers WHERE ${c.where} ORDER BY modified DESC LIMIT ${PAGE}`
  ).all().map(r => r.board)
  const theirs = (live.results || []).map(r => r.board)
  // Many clovers share a `modified` block, and neither store defines an order
  // within a tie, so require set equality. Sequence equality would be testing
  // undefined behaviour. (A deterministic tiebreaker is worth adding to the
  // real queries -- see MIGRATION notes -- but it would differ from today.)
  const sameSet = mine.length === theirs.length && mine.every(b => theirs.includes(b))
  const identical = JSON.stringify(mine) === JSON.stringify(theirs)

  // Where the page boundary falls inside a group of rows sharing `modified`,
  // which member lands on page 1 is arbitrary in both stores. Verified against
  // the live API that its order is stable across calls and pages do not
  // overlap, so this is two consistent-but-different orderings, not a fault.
  // Accept it when every differing board is inside the boundary tie group.
  let boundaryTie = false
  if (!sameSet) {
    const boundary = db.prepare(
      `SELECT modified FROM clovers WHERE ${c.where} ORDER BY modified DESC LIMIT 1 OFFSET ${PAGE - 1}`
    ).get()
    if (boundary) {
      const tied = new Set(db.prepare(
        `SELECT board FROM clovers WHERE ${c.where} AND modified = ?`
      ).all(boundary.modified).map(r => r.board))
      const differing = [...mine.filter(b => !theirs.includes(b)), ...theirs.filter(b => !mine.includes(b))]
      boundaryTie = differing.length > 0 && differing.every(b => tied.has(b))
    }
  }

  report(sameSet || boundaryTie, c.label + ' page',
    identical ? `${mine.length} boards identical & in order`
              : sameSet ? `${mine.length} boards identical (tie order differs)`
                        : boundaryTie ? `differs only within a tie at the page boundary`
                                      : `${mine.filter(b => theirs.includes(b)).length}/${theirs.length} overlap`)
}

console.log('\nLOGS  (count, then ordered first page by blockNumber desc)\n')
for (const l of LOG_FILTERS) {
  let live
  try { live = await api(`/logs?page=1${l.filter ? '&filter=' + l.filter : ''}`) }
  catch (e) { report(false, l.label, 'live API error: ' + e.message); continue }

  const n = db.prepare(`SELECT count(*) AS n FROM logs WHERE ${l.where}`).get().n
  report(n === live.allResults, l.label + ' count',
    `sqlite ${String(n).padStart(6)}  api ${String(live.allResults).padStart(6)}`)

  const mine = db.prepare(
    `SELECT id FROM logs WHERE ${l.where} ORDER BY blockNumber DESC LIMIT ${PAGE}`
  ).all().map(r => r.id)
  const theirs = (live.results || []).map(r => r.id)
  const overlap = mine.filter(i => theirs.includes(i)).length
  // Ties on blockNumber have no defined order in either store, so require set
  // equality rather than identical sequence.
  const sameSet = overlap === theirs.length && mine.length === theirs.length
  report(sameSet, l.label + ' page',
    sameSet ? `${mine.length} ids identical (as a set)` : `${overlap}/${theirs.length} overlap`)
}

console.log('\nUSERS / ALBUMS / CHATS\n')
// Both endpoints count through a predicated index, not the whole table:
//   users  -> all-modified is `address <> ZERO_ADDRESS`
//   albums -> all           is `clovers.count() > 0`
for (const [label, sql, path, key] of [
  ['users',  `SELECT count(*) AS n FROM users WHERE lower(address) <> '${ZERO}'`, '/users?page=1',  'allResults'],
  ['albums', `SELECT count(*) AS n FROM albums WHERE cloverCount > 0`,            '/albums?page=1', 'allResults']
]) {
  try {
    const live = await api(path)
    const n = db.prepare(sql).get().n
    report(n === live[key], label + ' count', `sqlite ${String(n).padStart(6)}  api ${String(live[key]).padStart(6)}`)
  } catch (e) { report(false, label, 'live API error: ' + e.message) }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
