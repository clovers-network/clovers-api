/**
 * Endpoint parity: the real store vs the live RethinkDB-backed API.
 *
 * Where parity.mjs validates the *schema* by running hand-written SQL, this
 * validates the *port* by calling the very methods src/api/* now calls. If a
 * store method orders, filters or joins differently from the ReQL it replaced,
 * it shows up here rather than in production.
 *
 * Usage: node endpoint-parity.mjs [/tmp/clovers.db]
 */

import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'module'

const { createStore } = createRequire(import.meta.url)('../../dist/lib/store/sqlite.js')

const dbPath = process.argv[2] || '/tmp/clovers.db'
const API = 'https://api.clovers.network'
const CLOVERS = '0xb55c5cac5014c662fdbf21a2c59cd45403c482fd'

const db = new DatabaseSync(dbPath)
const store = createStore(db, { cloversAddress: CLOVERS })

// --------------------------------------------------------------------------
// Deliberate divergences from production.
//
// The port fixes several bugs rather than reproducing them, so a handful of
// endpoints are *expected* to disagree with the live API. Listing the exact
// expected delta here keeps this a parity suite: a fix that changes more than
// it was supposed to still fails, and the day a divergence disappears (because
// production was fixed too) the entry stops matching and has to be revisited.
//
// Burned clovers -- owner 0x0 -- leaked into the symmetry filters because those
// ReQL indexes had no owner check, unlike `all`, `public`, `multi` and NonSym.
// --------------------------------------------------------------------------
const EXPECTED = {
  'Sym':    -161,
  'RotSym':  -38,
  'X0Sym':   -68,
  'XYSym':    -8,
  'XnYSym':  -11,
  'Y0Sym':   -44
}
// GET /albums?filter=<these> returned an empty 404; they now select the same
// rows every other filter does.
const ALBUM_FILTERS_FIXED = ['name', 'userAddress', 'dates', 'cloverCount']

let pass = 0, fail = 0
const report = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(40)} ${detail}`)
  ok ? pass++ : fail++
}
const api = async (path) => {
  const res = await fetch(API + path)
  if (!res.ok && res.status !== 404) throw new Error(`${path} -> HTTP ${res.status}`)
  return res.json()
}
// Compare ordered id lists; that is what a wrong ORDER BY breaks.
const ids = (rows, key) => (rows || []).map(r => r[key]).join(',')

// `orders` holds one duplicate pair -- two rows identical but for their id,
// sharing (transactionHash, logIndex) -- which the UNIQUE index rejects on
// import. So the live list is one row longer and everything after it shifts.
//
// Which of the pair survives is arbitrary (the importer keeps the one it sees
// first, the live store kept the other), so orders are identified here by
// (transactionHash, logIndex) rather than by their uuid. The 4,171 older orders
// that carry no transactionHash fall back to the uuid, which is the only thing
// distinguishing them and which both stores agree on.
const orderKey = (o) => o.transactionHash == null || o.logIndex == null
  ? o.id
  : `${o.transactionHash}:${o.logIndex}`

const dedupeOrders = (rows) => {
  const seen = new Set()
  return rows.filter(o => {
    const k = orderKey(o)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
const orderIds = (rows) => rows.map(orderKey).join(',')

const section = (t) => console.log(`\n${t}\n`)

// ---- GET /clovers -----------------------------------------------------------
//
// This endpoint is compared on page *membership*, not page order, and that is
// a deliberate exception -- every other endpoint below is compared on order.
//
// The live /clovers pipeline is  .between(index).orderBy(index).slice(page)
// .eqJoin('owner', users).  The eqJoin runs after the slice and does not
// reliably preserve the order it was handed: the live response is stable across
// calls, and its pages do not overlap, but the rows within a page are not in
// the `modified` order the response itself declares (`orderBy: "modified",
// sort: "descending"`). Pages that happen to hold a single owner come back in
// order; pages spanning many owners come back shuffled. Nothing about that is
// reproducible in SQL, and it is not behaviour worth reproducing -- so the port
// returns the declared order, and this asserts the set is identical.
//
// Sort-key ties are the other wrinkle. Where a whole page sits inside one tie
// -- all 24 rows share a price, say -- which 24 rows appear is arbitrary in
// both stores, so membership is checked as "both pages lie entirely within the
// tie" instead of row by row. This is what price/asc hits: after the importer
// pads legacy prices (see import.mjs), every zero-priced clover ties, where the
// live `all-price` index sorts the unpadded '0' rows ahead of the padded ones.
section('GET /clovers  (set equality -- see note in source)')
const CLOVER_FILTERS = ['', 'contract', 'public', 'market', 'pending', 'Sym',
  'NonSym', 'RotSym', 'X0Sym', 'XYSym', 'XnYSym', 'Y0Sym', 'commented']

const set = (rows, key) => [...new Set((rows || []).map(r => r[key]))].sort().join(',')
const boardsOf = (rows) => (rows || []).map(r => r.board)
const burned = new Set(db.prepare(
  "SELECT board FROM clovers WHERE owner_lc = '0x0000000000000000000000000000000000000000'"
).all().map(r => r.board))
const sortedBy = (rows, col, asc) => rows.every((r, i) =>
  i === 0 || (asc ? rows[i - 1][col] <= r[col] : rows[i - 1][col] >= r[col]))

for (const f of CLOVER_FILTERS) {
  for (const sort of ['modified', 'price']) {
    for (const asc of [false, true]) {
      const filter = f || 'all'
      const live = await api(`/clovers?${f ? `filter=${f}&` : ''}sort=${sort}&asc=${asc}`)
      const count = store.countClovers(filter)
      const rows = store.listCloversWithUsers({ filter, sort, asc, page: 1, pageSize: 24 })
      const label = `${filter}/${sort}/${asc ? 'asc' : 'desc'}`
      const delta = EXPECTED[filter] || 0

      // Is either page wholly inside a tie on the sort key? Compared on the
      // numeric value: the live store still holds unpadded '0' prices, which
      // are textually different from the padded zeros but the same number, and
      // it is the number the tie is on.
      const key = (r) => sort === 'price' ? (String(r.price).replace(/^0+/, '') || '0') : r[sort]
      const tied = (rs) => rs.length > 1 && new Set(rs.map(key)).size === 1
      const membership = (tied(rows) && tied(live.results) &&
                          key(rows[0]) === key(live.results[0]))
        ? 'tie'
        : (set(rows, 'board') === set(live.results, 'board') ? 'ok' : 'differs')

      // Three ways a page can legitimately match, checked in order:
      //   tie      -- both pages sit wholly inside one sort-key tie, so which
      //               rows appear is arbitrary in either store
      //   burned   -- a fix is in play, and everything live has that we do not
      //               is a burned clover we deliberately dropped
      //   ok       -- identical membership
      const dropped = boardsOf(live.results).filter(b => !rows.some(r => r.board === b))
      const verdict = membership === 'tie' ? 'tie'
        : delta && dropped.length && dropped.every(b => burned.has(b)) ? 'burned-only'
        : membership === 'ok' ? 'ok'
        : 'differs'

      report(count === live.allResults + delta && verdict !== 'differs' &&
             sortedBy(rows, sort, asc),
        label, `n=${count}/${live.allResults}${delta ? ` (${delta} burned)` : ''} page=${verdict}`)
    }
  }
}

// page 2, to catch off-by-one in OFFSET
for (const f of ['market', 'pending']) {
  const live = await api(`/clovers?filter=${f}&page=2`)
  const rows = store.listCloversWithUsers({ filter: f, sort: 'modified', asc: false, page: 2, pageSize: 24 })
  report(set(rows, 'board') === set(live.results, 'board'), `${f} page 2`)
}
// Sym has a delta, so page 2 can only be checked for "no burned clovers".
{
  const rows = store.listCloversWithUsers({ filter: 'Sym', sort: 'modified', asc: false, page: 2, pageSize: 24 })
  report(rows.length === 24 && rows.every(r => !burned.has(r.board)), 'Sym page 2 has no burned clovers')
}

// pagination must be a partition: no overlap, no gaps
for (const f of ['pending', 'commented']) {
  const seen = new Set()
  let dupes = 0
  for (let page = 1; page <= 5; page++) {
    for (const c of store.listCloversWithUsers({ filter: f, sort: 'modified', asc: false, page, pageSize: 24 })) {
      if (seen.has(c.board)) dupes++
      seen.add(c.board)
    }
  }
  report(dupes === 0, `${f} pages 1-5 disjoint`, `${seen.size} distinct, ${dupes} repeats`)
}

// ---- GET /users -------------------------------------------------------------
section('GET /users')
for (const sort of ['balance', 'clovers', 'albums', 'modified']) {
  for (const asc of [false, true]) {
    const live = await api(`/users?filter=${sort}&asc=${asc}`)
    const rows = store.listUsers({ sort, asc, page: 1, pageSize: 24 })
    report(store.countUsers() === live.allResults && ids(rows, 'address') === ids(live.results, 'address'),
      `${sort}/${asc ? 'asc' : 'desc'}`, `n=${live.allResults}`)
  }
}

// ---- GET /users/:id/clovers and /albums -------------------------------------
section('GET /users/:id/clovers, /users/:id/albums')
const OWNERS = db.prepare('SELECT owner_lc o FROM clovers GROUP BY o ORDER BY count(*) DESC LIMIT 4').all().map(r => r.o)
for (const owner of OWNERS) {
  for (const f of [null, 'forsale', 'Sym']) {
    for (const sort of ['modified', 'price']) {
      const live = await api(`/users/${owner}/clovers?${f ? `filter=${f}&` : ''}sort=${sort}`)
      const count = store.countCloversByOwner(owner, f)
      const rows = store.cloversByOwner(owner, { page: 1, pageSize: 12, sort, asc: false, filter: f })
      report(count === live.allResults && ids(rows, 'board') === ids(live.results, 'board'),
        `${owner.slice(0, 8)} ${f || 'all'}/${sort}`, `n=${count}/${live.allResults}`)
    }
  }
}
const ALBUM_USERS = db.prepare('SELECT lower(userAddress) o FROM albums GROUP BY o ORDER BY count(*) DESC LIMIT 3').all().map(r => r.o)
for (const owner of ALBUM_USERS) {
  for (const sort of ['modified', 'created', 'name']) {
    const live = await api(`/users/${owner}/albums?sort=${sort}`)
    const count = store.countAlbumsByUser(owner)
    const rows = store.albumsByUser(owner, { sort, asc: false, page: 1, pageSize: 12 })
    report(count === live.allResults && ids(rows, 'id') === ids(live.results, 'id'),
      `${owner.slice(0, 8)} albums/${sort}`, `n=${count}/${live.allResults}`)
  }
}

// ---- GET /logs and /clovers/:id/activity ------------------------------------
section('GET /logs, GET /clovers/:id/activity')
for (const f of [null, 'Comment_Added', 'CloverName_Changed', 'Clovers_Transfer',
  'SimpleCloversMarket_updatePrice', 'Coin_Activity']) {
  for (const asc of [false, true]) {
    const live = await api(`/logs?${f ? `filter=${f}&` : ''}asc=${asc}`)
    const count = store.countLogs(f)
    const rows = store.listLogs({ filter: f, page: 1, pageSize: 24, asc })
    report(count === live.allResults && ids(rows, 'id') === ids(live.results, 'id'),
      `${f || 'active'}/${asc ? 'asc' : 'desc'}`, `n=${count}/${live.allResults}`)
  }
}
const BOARDS = db.prepare('SELECT clover_key b FROM logs WHERE clover_key IS NOT NULL GROUP BY b ORDER BY count(*) DESC LIMIT 3').all().map(r => r.b)
for (const board of BOARDS) {
  const live = await api(`/clovers/${board}/activity`)
  const count = store.countLogsForClover(board)
  const rows = store.logsForClover(board, { page: 1, pageSize: 12, asc: false })
  report(count === live.allResults && ids(rows, 'id') === ids(live.results, 'id'),
    `activity ${board.slice(0, 12)}`, `n=${count}/${live.allResults}`)
}

// userAddresses hydration shape
{
  const live = await api('/logs?filter=Clovers_Transfer')
  const rows = store.listLogs({ filter: 'Clovers_Transfer', page: 1, pageSize: 24 }).map(l => store.hydrateLogUsers(l))
  const shape = (r) => Array.isArray(r.userAddresses)
    ? r.userAddresses.map(u => `${u.id}:${u.address && u.address.address}`).join('|')
    : String(r.userAddresses)
  report(rows.map(shape).join(' ') === live.results.map(shape).join(' '), 'userAddresses hydration')
}

// ---- GET /orders ------------------------------------------------------------
section('GET /orders')
{
  const live = dedupeOrders(await api('/orders?limit=500'))
  const rows = store.listOrders({ limit: 500, offset: 0 })
  // Compare only as far as the shorter list: dropping the duplicate pulls one
  // extra row in from beyond the live page boundary.
  const n = Math.min(rows.length, live.length)
  report(orderIds(rows.slice(0, n)) === orderIds(live.slice(0, n)), 'orders page 1', `n=${n}`)
  const live3 = dedupeOrders(await api('/orders/ClubToken'))
  const rows3 = store.ordersForMarket('ClubToken', { limit: 2000 })
  const n3 = Math.min(rows3.length, live3.length)
  report(orderIds(rows3.slice(0, n3)) === orderIds(live3.slice(0, n3)), 'orders/ClubToken', `n=${n3}`)
}

// ---- GET /search ------------------------------------------------------------
section('GET /search')
for (const s of ['moon', 'a', 'Bob', 'clover', 'z']) {
  const live = await api(`/search?s=${encodeURIComponent(s)}`)
  const c = store.searchClovers(s), u = store.searchUsers(s), a = store.searchAlbums(s)
  report(c.length === live.cloverCount && u.length === live.userCount && a.length === live.albumCount,
    `search "${s}"`, `c=${c.length}/${live.cloverCount} u=${u.length}/${live.userCount} a=${a.length}/${live.albumCount}`)
}

// ---- GET /clovers/:id -------------------------------------------------------
section('GET /clovers/:id')
const SAMPLE = db.prepare("SELECT board FROM clovers WHERE owner_lc <> '0x0000000000000000000000000000000000000000' ORDER BY modified DESC LIMIT 5").all().map(r => r.board)
for (const board of SAMPLE) {
  const live = await api(`/clovers/${board}`)
  const got = { ...store.getCloverWithUser(board), lastOrder: null }
  const same = got.board === live.board && got.owner === live.owner &&
    // numeric compare: the live store may still hold the unpadded legacy '0'
    BigInt(got.price) === BigInt(live.price) && got.name === live.name &&
    JSON.stringify(got.lastOrder) === JSON.stringify(live.lastOrder) &&
    (got.user && got.user.address) === (live.user && live.user.address) &&
    got.user && !('curationMarket' in got.user) && !('curationMarket' in live.user)
  report(!!same, `clover ${board.slice(0, 12)}`)
}

// ---- GET /albums ------------------------------------------------------------
section('GET /albums')
for (const f of ['', 'all', 'name', 'userAddress', 'dates', 'cloverCount', 'bogus']) {
  for (const sort of ['modified', 'created', 'name']) {
    const fixed = ALBUM_FILTERS_FIXED.includes(f)
    const live = await api(`/albums?${f ? `filter=${f}&` : ''}sort=${sort}`)
    const count = store.countAlbums()
    const rows = store.listAlbums({ sort, asc: false, page: 1, pageSize: 12 })
    // The fixed filters returned 0 live; ours return the full set, and must
    // match what the equivalent unfiltered request returns.
    const ok = fixed
      ? (live.allResults === 0 && count === 314 && rows.length === 12)
      : (count === live.allResults && ids(rows, 'id') === ids(live.results, 'id'))
    report(ok, `${f || '(none)'}/${sort}`, `n=${count}/${live.allResults}${fixed ? ' (was empty 404)' : ''}`)
  }
}
{
  // the multi-index lookup
  const board = db.prepare(
    "SELECT value b FROM albums, json_each(albums.clovers) WHERE json_array_length(COALESCE(clovers,'[]')) > 0 LIMIT 1"
  ).get().b
  const live = await api(`/albums?clover=${board}`)
  const rows = store.albumsContainingClover(board)
  report(ids(rows, 'id') === ids(live, 'id'), `by clover ${board.slice(0, 12)}`, `n=${rows.length}/${live.length}`)

  const id = db.prepare('SELECT id FROM albums WHERE cloverCount > 0 LIMIT 1').get().id
  const one = await api(`/albums/${id}`)
  const got = store.withAlbumUser(store.getAlbum(id))
  report(got.id === one.id && got.name === one.name &&
    JSON.stringify(got.clovers) === JSON.stringify(one.clovers) &&
    (got.user && got.user.address) === (one.user && one.user.address), `album ${id.slice(0, 8)}`)
}

// ---- GET /chats/:board ------------------------------------------------------
section('GET /chats/:board')
const CHAT_BOARDS = db.prepare('SELECT board b FROM chats GROUP BY b ORDER BY count(*) DESC LIMIT 3').all().map(r => r.b)
for (const board of CHAT_BOARDS) {
  const live = await api(`/chats/${board}`)
  const count = store.countChatsForBoard(board)
  const rows = store.chatsBefore(board, new Date().toISOString(), { pageSize: 16 })
  report(count === live.allResults && ids(rows, 'id') === ids(live.results, 'id'),
    `chats ${board.slice(0, 12)}`, `n=${count}/${live.allResults}`)

  // the `before` cursor: page 2 must start strictly after page 1 ends
  if (rows.length === 16) {
    const before = rows[rows.length - 1].created
    const live2 = await api(`/chats/${board}?before=${encodeURIComponent(before)}`)
    const rows2 = store.chatsBefore(board, before, { pageSize: 16 })
    report(ids(rows2, 'id') === ids(live2.results, 'id'), `chats ${board.slice(0, 12)} before-cursor`)
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
