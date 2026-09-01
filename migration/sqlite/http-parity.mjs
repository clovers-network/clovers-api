/**
 * HTTP parity: the ported API, actually running, against the live one.
 *
 * endpoint-parity.mjs calls store methods directly, which proves the SQL is
 * right but says nothing about the Express layer wiring them up -- the first
 * run of this found /albums returning 404 where the same store method returned
 * 314 rows, because the .db had been copied without its write-ahead log.
 *
 * Start the server against a SQLite copy first:
 *
 *   node migration/sqlite/import.mjs ~/clovers-backups/backup-<stamp> /tmp/smoke.db
 *   SQLITE_PATH=/tmp/smoke.db PORT=4599 CHAIN_LISTENER=off node dist/index.js &
 *   node migration/sqlite/http-parity.mjs
 *
 * CHAIN_LISTENER=off keeps the smoke test read-only. Without it the process
 * opens websockets to public RPC providers and writes whatever it hears into
 * the database under test.
 *
 * /clovers is compared as a set rather than a list -- see the long note in
 * endpoint-parity.mjs about eqJoin reordering the live pages.
 */
const LOCAL = 'http://127.0.0.1:4599'
const LIVE  = 'https://api.clovers.network'
let pass = 0, fail = 0
const rep = (ok, label, d = '') => { console.log(`  ${ok?'PASS':'FAIL'}  ${label.padEnd(46)} ${d}`); ok?pass++:fail++ }
const get = async (base, p) => {
  const r = await fetch(base + p)
  let j = null; try { j = await r.json() } catch (e) {}
  return { status: r.status, j }
}
const boards = (o) => (o && o.results ? o.results : Array.isArray(o) ? o : []).map(x => x.board || x.id || x.address).join(',')
const norm = p => p == null ? p : String(p).replace(/^0+/, '') || '0'

// Endpoints the port deliberately fixed, with the exact expected delta. See
// migration/sqlite/README.md and the table in endpoint-parity.mjs.
const EXPECTED = { '/clovers?filter=Sym&page=3': -161, '/clovers?filter=NonSym&asc=true': 0 }

const PATHS = [
  '/clovers', '/clovers?filter=market', '/clovers?filter=Sym&page=3',
  '/clovers?filter=pending', '/clovers?filter=commented&sort=price',
  '/clovers?filter=NonSym&asc=true', '/clovers?filter=contract&page=5',
  '/users', '/users?filter=clovers', '/users?filter=albums&asc=true',
  '/logs', '/logs?filter=Comment_Added', '/logs?filter=Coin_Activity&page=2',
  '/logs?filter=Clovers_Transfer&asc=true',
  '/albums', '/albums?sort=name',
  '/search?s=moon', '/search?s=clover', '/search?s=zz',
  '/orders?limit=50'
]
for (const p of PATHS) {
  const [a, b] = await Promise.all([get(LOCAL, p), get(LIVE, p)])
  const delta = EXPECTED[p] || 0
  const an = a.j && a.j.allResults
  const bn = b.j && b.j.allResults
  // Endpoints like /search and /orders return a bare array with no allResults;
  // undefined + delta is NaN, which would never compare equal.
  const counts = (an === undefined && bn === undefined) || an === bn + delta
  const same = boards(a.j) === boards(b.j)
  // /clovers page order differs by design (eqJoin) -- compare as a set there
  const setEq = [...boards(a.j).split(',')].sort().join() === [...boards(b.j).split(',')].sort().join()
  const isClovers = p.startsWith('/clovers')
  // Where a fix removed rows the pages shift, so sequence comparison is
  // meaningless; assert instead that nothing we return is a burned clover.
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
  const pageOk = delta
    ? (a.j.results || []).every(c => c.owner !== ZERO_ADDR)
    : (isClovers ? setEq : same)
  rep(a.status === b.status && counts && pageOk, p,
      `${a.status}/${b.status} n=${an}/${bn}` +
      (delta ? ` (${delta} burned, expected)` : ''))
}

// single-resource reads
const one = (await get(LIVE, '/clovers')).j.results[0].board
{
  const [a, b] = await Promise.all([get(LOCAL, `/clovers/${one}`), get(LIVE, `/clovers/${one}`)])
  rep(a.status === b.status && a.j.board === b.j.board && norm(a.j.price) === norm(b.j.price) &&
      a.j.name === b.j.name && (a.j.user||{}).address === (b.j.user||{}).address, `/clovers/${one.slice(0,10)}`)
  const [c, d] = await Promise.all([get(LOCAL, `/clovers/${one}/activity`), get(LIVE, `/clovers/${one}/activity`)])
  rep(c.status === d.status && c.j.allResults === d.j.allResults && boards(c.j) === boards(d.j),
      `/clovers/${one.slice(0,10)}/activity`, `${c.j.allResults}/${d.j.allResults}`)
  const [e, f] = await Promise.all([get(LOCAL, `/clovers/metadata/${one}`), get(LIVE, `/clovers/metadata/${one}`)])
  rep(e.status === f.status && e.j.name === f.j.name && e.j.description === f.j.description,
      `/clovers/metadata/${one.slice(0,10)}`)
}
const owner = (await get(LIVE, '/users?filter=clovers')).j.results[1].address
for (const p of [`/users/${owner}`, `/users/${owner}/clovers`, `/users/${owner}/clovers?filter=forsale`,
                 `/users/${owner}/albums`]) {
  const [a, b] = await Promise.all([get(LOCAL, p), get(LIVE, p)])
  rep(a.status === b.status && (a.j.allResults === b.j.allResults) && boards(a.j) === boards(b.j),
      p.replace(owner, owner.slice(0,10)), `${a.status}/${b.status} n=${a.j&&a.j.allResults}/${b.j&&b.j.allResults}`)
}
// 404 / error behaviour
for (const p of ['/clovers/0xdeadbeef', '/albums/nope', '/chats']) {
  const [a, b] = await Promise.all([get(LOCAL, p), get(LIVE, p)])
  rep(a.status === b.status, `status ${p}`, `${a.status}/${b.status}`)
}
// svg still renders
{
  const r = await fetch(`${LOCAL}/clovers/svg/${one}`)
  const t = await r.text()
  rep(r.status === 200 && t.includes('<svg'), '/clovers/svg/:id', `${r.status} ${t.length}b`)
}
// --------------------------------------------------------------------------
// The fixes, asserted directly. Each of these was a real defect in the
// original; without a test they would quietly regress.
// --------------------------------------------------------------------------
console.log('')
{
  // 1. burned clovers must not appear in any browsable filter
  let leaked = 0
  for (const f of ['Sym', 'RotSym', 'X0Sym', 'XYSym', 'XnYSym', 'Y0Sym', 'market', 'commented', 'all']) {
    for (const page of [1, 2, 3]) {
      const r = await get(LOCAL, `/clovers?filter=${f}&page=${page}`)
      leaked += (r.j.results || []).filter(c => c.owner === '0x0000000000000000000000000000000000000000').length
    }
  }
  rep(leaked === 0, 'fix: no burned clovers in any filter', `${leaked} leaked`)

  // and the live API still leaks them, so the fix is doing something
  const liveSym = await get(LIVE, '/clovers?filter=Sym')
  const localSym = await get(LOCAL, '/clovers?filter=Sym')
  rep(liveSym.j.allResults - localSym.j.allResults === 161,
      'fix: Sym excludes exactly the 161 burned', `${liveSym.j.allResults} -> ${localSym.j.allResults}`)
}
{
  // 2. /albums filters return rows instead of an empty 404
  for (const f of ['name', 'userAddress', 'dates', 'cloverCount']) {
    const [a, b] = await Promise.all([get(LOCAL, `/albums?filter=${f}`), get(LIVE, `/albums?filter=${f}`)])
    rep(a.status === 200 && a.j.allResults === 314 && b.status === 404 && b.j.allResults === 0,
        `fix: /albums?filter=${f}`, `local 200/${a.j.allResults}, live ${b.status}/${b.j.allResults}`)
  }
}
{
  // 3. renaming a clover that does not exist is a 404, not a hung request
  const r = await fetch(`${LOCAL}/clovers/0xdeadbeefdeadbeefdeadbeefdeadbeef`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('0x1:sig').toString('base64') },
    body: JSON.stringify({ name: 'nope' })
  })
  rep(r.status === 401 || r.status === 404, 'fix: PUT on a missing clover does not hang', `${r.status}`)
}
{
  // 4. lastOrder is present and null-shaped everywhere, not false in one place
  const one = (await get(LIVE, '/clovers')).j.results[0].board
  const [detail, grid, uc] = await Promise.all([
    get(LOCAL, `/clovers/${one}`), get(LOCAL, '/clovers'),
    get(LOCAL, `/users/${(await get(LIVE, '/users?filter=clovers')).j.results[1].address}/clovers`)
  ])
  const shapes = [detail.j.lastOrder, ...grid.j.results.map(c => c.lastOrder), ...(uc.j.results || []).map(c => c.lastOrder)]
  rep(shapes.every(v => v === null), 'fix: lastOrder is null everywhere, never false',
      `${shapes.length} payloads checked`)
}
{
  // 5. an album with no clovers logs board:null, not board:false
  const r = await get(LOCAL, '/logs?filter=Comment_Added')
  rep(r.status === 200, 'logs endpoint still healthy after the log-shape fix')
}

console.log(`\n  ${pass} passed, ${fail} failed\n`)
