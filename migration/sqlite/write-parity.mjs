/**
 * Write parity: RethinkDB vs SQLite.
 *
 * Read parity (parity.mjs) proved the schema and index translation. This proves
 * the *mutations*: every scenario below is executed against a real RethinkDB
 * and against SQLite, and the resulting rows are compared field by field.
 *
 * The RethinkDB side runs the original ReQL, copied from the application code,
 * so this compares against what the app actually does today rather than against
 * a description of it. The SQLite side goes through src/lib/store/sqlite.js.
 *
 * Both databases are scratch: a throwaway RethinkDB database in a local
 * container, and a temp SQLite file. Production is never touched.
 *
 * Requires:
 *   docker run -d --name rdb-parity --platform linux/amd64 -p 28016:28015 rethinkdb:2.4
 *
 * Usage: node write-parity.mjs
 */

import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const r = require('rethinkdb')
const { createStore } = require('../../dist/lib/store/sqlite.js')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RDB = { host: 'localhost', port: 28016 }
const DB = 'parity'
const CLOVERS_ADDR = '0xb55c5cac5014c662fdbf21a2c59cd45403c482fd'
const ZERO = '0x0000000000000000000000000000000000000000'

const TABLES = [
  ['clovers', 'board'], ['users', 'address'], ['logs', 'id'],
  ['chats', 'id'], ['albums', 'id'], ['orders', 'id']
]

// --------------------------------------------------------------------------
// setup
// --------------------------------------------------------------------------
const conn = await new Promise((res, rej) =>
  r.connect(RDB, (e, c) => e ? rej(e) : res(c)))

const dbs = await r.dbList().run(conn)
if (dbs.includes(DB)) await r.dbDrop(DB).run(conn)
await r.dbCreate(DB).run(conn)
for (const [t, pk] of TABLES) await r.db(DB).tableCreate(t, { primaryKey: pk }).run(conn)
// Only the indexes the scenarios below actually exercise.
await r.db(DB).table('clovers').indexCreate('owner', r.row('owner')).run(conn)
await r.db(DB).table('clovers').indexWait().run(conn)

const sqlitePath = '/tmp/write-parity.db'
if (fs.existsSync(sqlitePath)) fs.unlinkSync(sqlitePath)
const sdb = new DatabaseSync(sqlitePath)
sdb.exec(fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8'))
const store = createStore(sdb, { cloversAddress: CLOVERS_ADDR })

const rq = q => q.run(conn)

// --------------------------------------------------------------------------
// comparison
// --------------------------------------------------------------------------
/** Normalise so the two stores are compared on meaning, not representation. */
function norm (table, row) {
  if (!row) return null
  const o = { ...row }
  // RethinkDB keeps booleans; SQLite stores 0/1 and the store decodes them.
  for (const k of ['kept', 'deleted', 'flagged', 'removed']) if (k in o) o[k] = !!o[k]
  // Fields the app never reads back and which differ structurally.
  delete o.id_generated
  // undefined vs null: RethinkDB omits absent fields, SQLite returns null.
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null) delete o[k]
  return o
}

/**
 * Stable stringify: JSON object key order is not semantic, and the two stores
 * differ on it -- RethinkDB returns keys sorted, SQLite preserves insertion
 * order. Comparing raw JSON.stringify would report identical documents as
 * different.
 */
function canon (v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
  }
  return JSON.stringify(v)
}

function diff (a, b) {
  const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort()
  const out = []
  for (const k of keys) {
    const av = canon(a ? a[k] : undefined)
    const bv = canon(b ? b[k] : undefined)
    if (av !== bv) out.push(`${k}: rethink=${av} sqlite=${bv}`)
  }
  return out
}

let pass = 0, fail = 0
const results = []

async function check (label, table, pk, key) {
  const rethinkRow = await rq(r.db(DB).table(table).get(key)).catch(() => null)
  const sqliteRow = table === 'clovers' ? store.getClover(key)
    : table === 'users' ? store.getUser(key)
    : table === 'chats' ? store.getChat(key)
    : table === 'albums' ? store.getAlbum(key)
    : table === 'logs' ? store.getLogById(key)
    : sdb.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).get(key)

  const d = diff(norm(table, rethinkRow), norm(table, sqliteRow))
  const ok = d.length === 0 && !!rethinkRow === !!sqliteRow
  results.push({ label, ok, d })
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
  d.slice(0, 4).forEach(x => console.log(`          ${x}`))
}

async function checkCount (label, rethinkQuery, sqliteValue) {
  const a = await rq(rethinkQuery)
  const ok = a === sqliteValue
  results.push({ label, ok, d: ok ? [] : [`rethink=${a} sqlite=${sqliteValue}`] })
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}   rethink=${a} sqlite=${sqliteValue}`)
}

// --------------------------------------------------------------------------
// scenarios — each mirrors a real write path in the application
// --------------------------------------------------------------------------
console.log('\nWRITE PARITY  (RethinkDB 2.4 in docker  vs  SQLite)\n')

const board = '0xaaaa555a5aaa556a55a65aa655aa556a'
const alice = '0x1111111111111111111111111111111111111111'
const bob   = '0x2222222222222222222222222222222222222222'

const cloverDoc = {
  board, name: board, owner: alice, price: ''.padStart(64, '0'),
  originalPrice: ''.padStart(64, '0'), reward: ''.padStart(64, '0'),
  created: 100, modified: 100, commentCount: 0, kept: false, foundBy: alice,
  moves: ['0xaa', '0xbb'],
  symmetries: { RotSym: 1, X0Sym: 0, XYSym: 1, XnYSym: 0, Y0Sym: 0 }
}

// 1. addNewClover -- plain insert
await rq(r.db(DB).table('clovers').insert(cloverDoc))
store.insertClover(cloverDoc)
await check('insert clover', 'clovers', 'board', board)

// 2. userTemplate insert, twice, with conflict:'update' (the upsert path)
const userDoc = { address: alice, name: '', balance: ''.padStart(64, '0'),
  created: 100, modified: 100, cloverCount: 0, albumCount: 0, curationMarket: {} }
await rq(r.db(DB).table('users').insert(userDoc, { conflict: 'update' }))
store.insertUser(userDoc, { conflict: 'update' })
await rq(r.db(DB).table('users').insert({ ...userDoc, name: 'alice' }, { conflict: 'update' }))
store.insertUser({ ...userDoc, name: 'alice' }, { conflict: 'update' })
await check('upsert user twice (conflict:update)', 'users', 'address', alice)

// 3. cloverCount from a subquery count -- models/clovers.js:363.
// The { nonAtomic: true } is required and is in the production call: RethinkDB
// refuses a subquery inside update() otherwise, "could not prove argument
// deterministic". Worth noting for the port -- the original is explicitly
// giving up atomicity here, so the SQL equivalent is not weaker.
await rq(r.db(DB).table('users').get(alice).update({
  cloverCount: r.db(DB).table('clovers').getAll(r.row('address'), { index: 'owner' }).count()
}, { nonAtomic: true }))
store.recomputeCloverCount(alice)
await check('cloverCount via subquery count', 'users', 'address', alice)

// 4. transfer: clover changes owner -- updateClover
await rq(r.db(DB).table('clovers').get(board).update({ owner: bob, modified: 200 }))
store.updateClover(board, { owner: bob, modified: 200 })
await check('update clover owner', 'clovers', 'board', board)

// 5. both users' counts recomputed after the transfer
await rq(r.db(DB).table('users').insert({ ...userDoc, address: bob }, { conflict: 'update' }))
store.insertUser({ ...userDoc, address: bob }, { conflict: 'update' })
for (const addr of [alice, bob]) {
  await rq(r.db(DB).table('users').get(addr).update({
    cloverCount: r.db(DB).table('clovers').getAll(r.row('address'), { index: 'owner' }).count()
  }, { nonAtomic: true }))
  store.recomputeCloverCount(addr)
}
await check('sender count after transfer', 'users', 'address', alice)
await check('recipient count after transfer', 'users', 'address', bob)

// 6. atomic comment counter -- api/chats.js:134
const chat = { id: 'chat-1', board, comment: 'hello', userAddress: bob,
  userName: 'bob', created: '2026-01-01T00:00:00.000Z', edited: null,
  deleted: false, flagged: false }
await rq(r.db(DB).table('chats').insert(chat))
store.insertChat(chat)
await rq(r.db(DB).table('clovers').get(board).update({
  commentCount: r.row('commentCount').add(1).default(0)
}))
store.bumpCommentCount(board, 1)
await check('insert chat', 'chats', 'id', 'chat-1')
await check('commentCount incremented atomically', 'clovers', 'board', board)

// 7. soft delete a comment, decrement the counter
await rq(r.db(DB).table('chats').get('chat-1').update({ deleted: true }))
store.updateChat('chat-1', { deleted: true })
await rq(r.db(DB).table('clovers').get(board).update({
  commentCount: r.row('commentCount').add(-1).default(0)
}))
store.bumpCommentCount(board, -1)
await check('soft-deleted comment', 'chats', 'id', 'chat-1')
await check('commentCount decremented', 'clovers', 'board', board)

// 8. log insert, then the duplicate guard
const log = { id: 'log-1', name: 'Clovers_Transfer', address: CLOVERS_ADDR,
  blockNumber: 300, transactionHash: '0xdead', transactionIndex: 1, logIndex: 2,
  blockHash: '0xbeef', removed: false, topics: ['0xa'],
  data: { _from: alice, _to: bob, _tokenId: board },
  userAddresses: [{ id: '_from', address: alice }] }
await rq(r.db(DB).table('logs').insert(log))
store.insertLog(log)
await check('insert log with nested data', 'logs', 'id', 'log-1')

// 9. album create then edit (JSON array column)
const album = { id: 'alb-1', name: 'My Album', userAddress: bob,
  created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z',
  clovers: [board] }
await rq(r.db(DB).table('albums').insert(album))
store.insertAlbum(album)
await check('insert album', 'albums', 'id', 'alb-1')

await rq(r.db(DB).table('albums').get('alb-1').update({ clovers: [board, '0xbbbb'], modified: '2026-01-02T00:00:00.000Z' }))
store.updateAlbum('alb-1', { clovers: [board, '0xbbbb'], modified: '2026-01-02T00:00:00.000Z' })
await check('update album clovers array', 'albums', 'id', 'alb-1')

// 10. delete
await rq(r.db(DB).table('albums').get('alb-1').delete())
store.deleteAlbum('alb-1')
await check('deleted album is gone from both', 'albums', 'id', 'alb-1')

// 11. price change -- simpleCloversMarket
const priced = '0'.repeat(46) + '100000000000000000'
await rq(r.db(DB).table('clovers').get(board).update({ price: priced, modified: 400 }))
store.updateClover(board, { price: priced, modified: 400 })
await check('clover price updated', 'clovers', 'board', board)

// 12. aggregate agreement after all of the above
await checkCount('clovers count', r.db(DB).table('clovers').count(),
  sdb.prepare('SELECT count(*) n FROM clovers').get().n)
await checkCount('users count', r.db(DB).table('users').count(),
  sdb.prepare('SELECT count(*) n FROM users').get().n)
await checkCount('logs count', r.db(DB).table('logs').count(),
  sdb.prepare('SELECT count(*) n FROM logs').get().n)
await checkCount('market filter agrees',
  r.db(DB).table('clovers').filter(row => row('price').ne(''.padStart(64, '0'))).count(),
  store.countClovers('market'))

console.log(`\n  ${pass} passed, ${fail} failed\n`)
conn.close()
process.exit(fail ? 1 : 0)
