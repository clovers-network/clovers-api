/**
 * The authenticated write paths, end to end over HTTP, plus realtime delivery.
 *
 * Everything else in this directory tests reads, or tests writes at the store
 * layer. This signs a real message, makes real requests, and listens on a real
 * socket -- the layer where auth, express, the store and socket.io have to
 * agree with each other.
 *
 * Needs a server running against a scratch database:
 *   SQLITE_PATH=/tmp/w.db PORT=4597 CHAIN_LISTENER=off node dist/index.js &
 *   node migration/sqlite/write-endpoints.mjs
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const sigUtil = require('eth-sig-util')
const { DatabaseSync } = await import('node:sqlite')
// socket.io-client is not a dependency of the API -- it is the dapp's. Resolve
// it from there rather than adding a dependency just to test one.
const io = require(require.resolve('socket.io-client', { paths: ['../clovers-dapp/node_modules', '/Users/billy/GitHub/clovers-network/clovers-dapp'] }))
const crypto = await import('crypto')

const API = process.env.API || 'http://127.0.0.1:4597'
const DB = process.env.SQLITE_PATH || '/tmp/w.db'

let pass = 0, fail = 0
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} ${detail}`)
  ok ? pass++ : fail++
}

// ---- a throwaway identity -------------------------------------------------
const priv = crypto.randomBytes(32)
const addr = '0x' + require('ethereumjs-util').privateToAddress(priv).toString('hex')
const monthKey = () => {
  const n = new Date()
  return `Please sign this message to authenticate with Clovers - ${n.getMonth() + 1}/${n.getFullYear()}`
}
const sign = () => sigUtil.signTypedData(priv, {
  data: [{ type: 'string', name: 'Message', value: monthKey() }]
})
const authHeader = () => 'Basic ' + Buffer.from(`${addr}:${sign()}`).toString('base64')

const req = async (method, path, body) => {
  const r = await fetch(API + path, {
    method,
    headers: { authorization: authHeader(), 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  let j = null
  try { j = await r.json() } catch (e) {}
  return { status: r.status, body: j }
}

// ---- give the identity something it owns ----------------------------------
const db = new DatabaseSync(DB)
const board = db.prepare(
  "SELECT board FROM clovers WHERE owner_lc <> '0x0000000000000000000000000000000000000000' LIMIT 1").get().board
db.prepare('UPDATE clovers SET owner = ? WHERE board = ?').run(addr.toLowerCase(), board)
db.prepare(`INSERT INTO users (address, name, balance, created, modified, cloverCount, albumCount, curationMarket)
            VALUES (?, '', ?, 1, 1, 1, 0, '{}')
            ON CONFLICT(address) DO UPDATE SET cloverCount = 1`).run(addr.toLowerCase(), ''.padStart(64, '0'))
const db2 = new DatabaseSync(DB, { readOnly: true })
db.close()
console.log(`\n  identity ${addr}\n  owns clover ${board}\n`)

// ---- realtime listener ----------------------------------------------------
const events = []
const socket = io(API, { transports: ['websocket', 'polling'] })
const connected = await new Promise(r => {
  const t = setTimeout(() => r(false), 15000)
  socket.on('connect', () => { clearTimeout(t); r(true) })
  socket.on('connect_error', () => { clearTimeout(t); r(false) })
})
check(connected, 'socket.io client connects', connected ? socket.io.engine.transport.name : 'no')
for (const ev of ['newLog', 'updateClover', 'updateUser', 'addClover']) {
  socket.on(ev, (p) => events.push({ ev, p }))
}

// ---- the write paths ------------------------------------------------------
console.log('')
const r1 = await req('PUT', `/clovers/${board}`, { name: 'first rename' })
check(r1.status === 200, 'PUT /clovers/:id  (1st authenticated request)', `HTTP ${r1.status}`)

const r2 = await req('PUT', `/clovers/${board}`, { name: 'second rename' })
check(r2.status === 200, 'PUT /clovers/:id  (2nd authenticated request)', `HTTP ${r2.status}`)

const r3 = await req('POST', `/chats/${board}`, { comment: 'hello from the test' })
check(r3.status === 200 && r3.body && r3.body.id, 'POST /chats/:board', `HTTP ${r3.status}`)

const alb = await req('POST', '/albums', { albumName: 'test album ' + Date.now(), clovers: [board] })
check(alb.status === 200 && alb.body && alb.body.id, 'POST /albums', `HTTP ${alb.status}`)

if (alb.body && alb.body.id) {
  const up = await req('PUT', `/albums/${alb.body.id}`, { albumName: 'renamed ' + Date.now(), clovers: [board] })
  check(up.status === 200, 'PUT /albums/:id', `HTTP ${up.status}`)
  const del = await req('DELETE', `/albums/${alb.body.id}`)
  check(del.status === 200, 'DELETE /albums/:id', `HTTP ${del.status}`)
}

// ---- impersonation must be rejected ---------------------------------------
//
// auth() used to return `matches || new Error('try again')`, and
// express-basic-auth authorises on any truthy return -- so a mismatch
// authorised the request and any valid signature authenticated as any address.
// Confirmed exploitable over HTTP: an unrelated key renamed a clover it did not
// own. These are the regression tests for that.
console.log('')
{
  const victim = db2.prepare(
    "SELECT board, owner FROM clovers WHERE lower(owner) NOT IN (?, '0x0000000000000000000000000000000000000000') LIMIT 1"
  ).get(addr.toLowerCase())

  const asVictim = 'Basic ' + Buffer.from(`${victim.owner}:${sign()}`).toString('base64')
  const r = await fetch(`${API}/clovers/${victim.board}`, {
    method: 'PUT',
    headers: { authorization: asVictim, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'IMPERSONATED' })
  })
  check(r.status === 401, 'impersonation: signing for someone else is rejected', `HTTP ${r.status}`)

  const junk = 'Basic ' + Buffer.from(`${addr}:0xdeadbeef`).toString('base64')
  const r2 = await fetch(`${API}/clovers/${board}`, {
    method: 'PUT', headers: { authorization: junk, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'junk' })
  })
  check(r2.status === 401, 'garbage signature is rejected', `HTTP ${r2.status}`)

  const none = await fetch(`${API}/clovers/${board}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' })
  })
  check(none.status === 401, 'missing credentials are rejected', `HTTP ${none.status}`)
}

// ---- did the events actually arrive? --------------------------------------
await new Promise(r => setTimeout(r, 1500))
console.log('')
check(events.some(e => e.ev === 'newLog'), 'realtime: newLog delivered to a client',
  `${events.length} events: ${[...new Set(events.map(e => e.ev))].join(', ') || 'none'}`)
check(events.some(e => e.ev === 'updateClover'), 'realtime: updateClover delivered')

socket.close()
console.log(`\n  ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
