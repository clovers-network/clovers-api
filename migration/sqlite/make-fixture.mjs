/**
 * Build a small synthetic database that behaves like the real one.
 *
 * Most of the suites here need data, and the real data is 371 MB of production
 * rows that cannot go in a repository. Without a fixture, none of them can run
 * in CI -- which means the guarantees they encode quietly stop being checked.
 *
 * This is deliberately not "some rows". It reproduces the specific shapes that
 * caused bugs, so the regression tests have something to catch:
 *
 *   * burned clovers (owner 0x0) that are symmetrical, priced and commented --
 *     the leak the filter fix closed;
 *   * prices stored as a bare '0' alongside 64-char padded ones;
 *   * foundBy holding a whole user object instead of an address;
 *   * album logs with `board: false`;
 *   * two orders sharing (transactionHash, logIndex);
 *   * a clover whose owner has no users row, for the left join.
 *
 * Enough rows that SQLite prefers indexes: with fifty rows the planner scans
 * everything because scanning is cheaper, and the query audit's assertions
 * would pass or fail for the wrong reason.
 *
 *   node migration/sqlite/make-fixture.mjs /tmp/fixture.db
 */
import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const out = process.argv[2] || '/tmp/fixture.db'
const ZERO = '0x0000000000000000000000000000000000000000'
const CLOVERS = '0xb55c5cac5014c662fdbf21a2c59cd45403c482fd'

for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(out + s) } catch (e) {} }
const db = new DatabaseSync(out)
db.exec(fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8'))

// Deterministic, so a failure is reproducible.
let seed = 0x9e3779b9
const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0; return seed / 0x100000000 }
const int = (n) => Math.floor(rnd() * n)
const hex = (n) => [...Array(n)].map(() => '0123456789abcdef'[int(16)]).join('')
const addr = () => '0x' + hex(40)
const pad = (n) => String(n).padStart(64, '0')

const N_USERS = 300, N_CLOVERS = 3000, N_LOGS = 5000, N_ALBUMS = 200, N_CHATS = 150, N_ORDERS = 400

const users = [ZERO, CLOVERS, ...Array.from({ length: N_USERS }, addr)]
const ins = (t, cols) => db.prepare(`INSERT OR IGNORE INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)

db.exec('BEGIN')

const u = ins('users', ['address', 'name', 'balance', 'created', 'modified', 'cloverCount', 'albumCount', 'image', 'curationMarket'])
users.forEach((a, i) => u.run(a, i % 7 === 0 ? `user${i}` : '', pad(int(1e6)), 8000000 + i, 8000000 + i * 3, 0, 0, null, '{}'))

// One clover whose owner has no users row: the left-join case.
const orphanOwner = addr()

const c = ins('clovers', ['board', 'name', 'owner', 'price', 'originalPrice', 'reward', 'created', 'modified',
  'commentCount', 'kept', 'foundBy', 'moves', 'symmetries'])
const boards = []
for (let i = 0; i < N_CLOVERS; i++) {
  const board = '0x' + hex(32)
  boards.push(board)
  const burned = i % 40 === 0                    // ~2.5% burned, as in production
  const owner = burned ? ZERO : i % 9 === 0 ? CLOVERS : i === 5 ? orphanOwner : users[2 + int(N_USERS)]
  const sym = { RotSym: i % 5 === 0 ? 1 : 0, X0Sym: i % 7 === 0 ? 1 : 0, XYSym: i % 11 === 0 ? 1 : 0,
    XnYSym: i % 13 === 0 ? 1 : 0, Y0Sym: i % 3 === 0 ? 1 : 0 }
  // Both price shapes, including burned-but-priced and burned-but-commented,
  // which are exactly what leaked into the filters.
  const price = i % 4 === 0 ? '0' : i % 3 === 0 ? pad(0) : pad(int(1e18))
  c.run(board, i % 6 === 0 ? `named clover ${i}` : board, owner, price, pad(int(1e18)), pad(int(1e17)),
    8000000 + i, 8000000 + i * 2, i % 12 === 0 ? int(5) : 0, i % 8 === 0 ? 1 : 0,
    // foundBy is polymorphic in production: null, an address, or a whole user doc.
    i % 50 === 0 ? JSON.stringify({ address: users[3], name: 'x', balance: pad(1) }) : i % 9 === 0 ? users[4] : null,
    JSON.stringify(['0x' + hex(56), '0x' + hex(56)]), JSON.stringify(sym))
}

const l = ins('logs', ['id', 'name', 'address', 'blockNumber', 'transactionHash', 'transactionIndex', 'logIndex',
  'blockHash', 'removed', 'topics', 'data', 'userAddresses'])
const NAMES = ['Clovers_Transfer', 'SimpleCloversMarket_updatePrice', 'ClubTokenController_Buy',
  'ClubTokenController_Sell', 'Comment_Added', 'CloverName_Changed', 'ClubToken_Transfer', 'Album_Created']
for (let i = 0; i < N_LOGS; i++) {
  const name = NAMES[i % NAMES.length]
  const board = boards[int(boards.length)]
  const data = name === 'Album_Created'
    // The literal `false` that ReQL's index choked on.
    ? { id: 'alb' + i, userAddress: users[2 + int(N_USERS)], name: 'a', board: i % 3 === 0 ? false : board }
    : name.startsWith('Clovers') || name.startsWith('Simple')
      ? { _from: users[2 + int(N_USERS)], _to: i % 10 === 0 ? CLOVERS : users[2 + int(N_USERS)], _tokenId: board, price: pad(int(1e18)) }
      : { buyer: users[2 + int(N_USERS)], tokens: pad(int(1e18)), value: pad(int(1e17)) }
  l.run('log-' + i, name, CLOVERS, 8000000 + i * 3, '0x' + hex(64), int(200), int(500), '0x' + hex(64), 0,
    JSON.stringify(['0x' + hex(64)]), JSON.stringify(data),
    JSON.stringify([{ id: '_to', address: users[2 + int(N_USERS)] }]))
}

const a = ins('albums', ['id', 'name', 'userAddress', 'created', 'modified', 'clovers'])
for (let i = 0; i < N_ALBUMS; i++) {
  a.run('alb-' + i, `album ${i}`, users[2 + int(N_USERS)],
    new Date(Date.UTC(2021, i % 12, 1 + (i % 27))).toISOString(),
    new Date(Date.UTC(2022, i % 12, 1 + (i % 27))).toISOString(),
    JSON.stringify(i % 9 === 0 ? [] : boards.slice(i, i + 1 + int(4))))
}

const ch = ins('chats', ['id', 'board', 'comment', 'userAddress', 'userName', 'created', 'edited', 'deleted', 'flagged'])
for (let i = 0; i < N_CHATS; i++) {
  ch.run('chat-' + i, boards[int(boards.length)], `comment ${i}`, users[2 + int(N_USERS)], '',
    new Date(Date.UTC(2021, i % 12, 1 + (i % 27), i % 24)).toISOString(), null, 0, 0)
}

const o = ins('orders', ['id', 'market', 'created', 'transactionIndex', 'transactionHash', 'logIndex', 'type',
  'user', 'tokens', 'value', 'poolBalance', 'tokenSupply'])
for (let i = 0; i < N_ORDERS; i++) {
  o.run('ord-' + i, 'ClubToken', 8000000 + i * 7, int(200), '0x' + hex(64), int(500), i % 2 ? 'buy' : 'sell',
    users[2 + int(N_USERS)], pad(int(1e18)), pad(int(1e17)), pad(int(1e19)), pad(int(1e20)))
}
// A duplicate order: same (transactionHash, logIndex) as the one above it.
const dup = db.prepare('SELECT * FROM orders WHERE id = ?').get('ord-1')
try {
  o.run('ord-dup', dup.market, dup.created, dup.transactionIndex, dup.transactionHash, dup.logIndex,
    dup.type, dup.user, dup.tokens, dup.value, dup.poolBalance, dup.tokenSupply)
} catch (e) { /* the UNIQUE index rejecting it is the point */ }

db.exec('COMMIT')
db.exec(`UPDATE users SET cloverCount = (SELECT count(*) FROM clovers WHERE clovers.owner_lc = lower(users.address)),
                          albumCount  = (SELECT count(*) FROM albums  WHERE lower(albums.userAddress) = lower(users.address))`)
db.exec('ANALYZE')
db.exec('PRAGMA wal_checkpoint(TRUNCATE)')

const n = (t) => db.prepare(`SELECT count(*) c FROM ${t}`).get().c
console.log(`  ${out}  ${(fs.statSync(out).size / 1048576).toFixed(1)} MB`)
console.log(`  clovers ${n('clovers')} (burned ${db.prepare("SELECT count(*) c FROM clovers WHERE owner_lc = ?").get(ZERO).c}` +
  `, unpadded price ${db.prepare("SELECT count(*) c FROM clovers WHERE length(price) < 64").get().c})`)
console.log(`  users ${n('users')}  logs ${n('logs')}  albums ${n('albums')}  chats ${n('chats')}  orders ${n('orders')}`)
db.close()
