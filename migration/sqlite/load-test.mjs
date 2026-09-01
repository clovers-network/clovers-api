/**
 * Load test: closed-loop concurrency sweep against a running API.
 *
 * Point it at the pre-port stack (RethinkDB) and the ported one (SQLite) in
 * turn, on the same machine with the same data, and the two runs are directly
 * comparable. Absolute numbers are laptop numbers and will not transfer to a
 * droplet; the ratio between the two runs, the shape of the degradation curve,
 * and the memory ceiling are what carry over.
 *
 * Every level replays the *same* request sequence, derived from a fixed seed,
 * so the two stacks answer identical work in an identical order.
 *
 * Usage:
 *   node load-test.mjs --target=http://127.0.0.1:4599 --label=sqlite \
 *                      --pid=<server pid> [--docker=<container>] \
 *                      [--levels=1,4,16,64] [--seconds=6] [--out=file.json]
 */

import { execSync } from 'child_process'
import fs from 'fs'

const arg = (k, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}
const TARGET  = arg('target', 'http://127.0.0.1:4599')
const LABEL   = arg('label', 'unknown')
const PID     = arg('pid', null)
const DOCKER  = arg('docker', null)
const LEVELS  = arg('levels', '1,2,4,8,16,32,64,128').split(',').map(Number)
const SECONDS = Number(arg('seconds', 6))
const WARMUP  = Number(arg('warmup', 2))
const OUT     = arg('out', null)
// Sequential-only skips the concurrency sweep. Use it against anything you must
// not put under load -- in particular the live production API, where the sweep
// would be a self-inflicted outage.
const SEQ_ONLY = process.argv.includes('--sequential-only')
// Subtracted from every sequential sample. Measure it against a cheap endpoint
// on the same host so remote timings are comparable with local ones.
const RTT     = Number(arg('rtt', 0))

// --------------------------------------------------------------------------
// request mix
//
// Weighted to look like dapp traffic rather than to flatter either store: the
// clover grid dominates, detail views and the comment thread follow, and the
// expensive ones (search, deep pages) are present but rare -- which is where
// a full-table scan would show up.
// --------------------------------------------------------------------------
const MIX = [
  [30, 'clovers grid',    () => `/clovers?filter=${pick(['', 'market', 'Sym', 'NonSym', 'commented', 'pending'])}&page=${1 + int(8)}`],
  [15, 'clover detail',   () => `/clovers/${pick(BOARDS)}`],
  [10, 'clover activity', () => `/clovers/${pick(BOARDS)}/activity`],
  [10, 'activity feed',   () => `/logs?page=${1 + int(5)}`],
  [ 8, 'comments',        () => `/chats/${pick(CHAT_BOARDS)}`],
  [ 8, 'user clovers',    () => `/users/${pick(OWNERS)}/clovers`],
  [ 5, 'leaderboard',     () => `/users?filter=${pick(['balance', 'clovers', 'albums'])}`],
  [ 5, 'albums',          () => `/albums?page=${1 + int(4)}`],
  [ 4, 'user detail',     () => `/users/${pick(OWNERS)}`],
  [ 3, 'grid by price',   () => `/clovers?sort=price&page=${1 + int(20)}`],
  [ 2, 'search',          () => `/search?s=${pick(['a', 'moon', 'clover', 'sym'])}`]
]

// Deterministic PRNG so both runs replay the same sequence.
let seed = 0x2545f491
const rnd = () => {
  seed ^= seed << 13; seed >>>= 0
  seed ^= seed >> 17
  seed ^= seed << 5;  seed >>>= 0
  return seed / 0x100000000
}
const int = (n) => Math.floor(rnd() * n)
const pick = (a) => a[int(a.length)]

// Fixed id pools, read from the SQLite copy so both stacks get the same ids.
const { DatabaseSync } = await import('node:sqlite')
const idb = new DatabaseSync(arg('db', '/tmp/clovers.db'), { readOnly: true })
const col = (sql) => idb.prepare(sql).all().map(r => Object.values(r)[0])
const BOARDS = col(`SELECT board FROM clovers WHERE owner_lc <> '0x0000000000000000000000000000000000000000' ORDER BY modified DESC LIMIT 200`)
const CHAT_BOARDS = col('SELECT board FROM chats GROUP BY board ORDER BY count(*) DESC LIMIT 50')
const OWNERS = col('SELECT owner_lc FROM clovers GROUP BY owner_lc ORDER BY count(*) DESC LIMIT 50')
idb.close()

const TOTAL_W = MIX.reduce((s, [w]) => s + w, 0)
const nextPath = () => {
  let n = int(TOTAL_W)
  for (const [w, name, f] of MIX) { if (n < w) return [name, f()]; n -= w }
  const [, name, f] = MIX[0]
  return [name, f()]
}

// Per-endpoint latency, accumulated across every level. This is where the
// aggregate hides things: a p50 of 12 ms next to a p95 of 7.8 s is not a slow
// service, it is one or two endpoints doing something quadratic.
const byEndpoint = new Map()
// Anything over a second, kept with its path. An aggregate p95 of 7.8 s tells
// you there is a problem; this tells you which request it was.
const slow = []
const recordEndpoint = (name, ms) => {
  if (!byEndpoint.has(name)) byEndpoint.set(name, [])
  byEndpoint.get(name).push(ms)
}

// --------------------------------------------------------------------------
// measurement
// --------------------------------------------------------------------------
const rssMB = () => {
  if (!PID) return null
  try { return Math.round(Number(execSync(`ps -o rss= -p ${PID}`).toString().trim()) / 1024) }
  catch (e) { return null }
}
const dockerMB = () => {
  if (!DOCKER) return null
  try {
    const s = execSync(`docker stats --no-stream --format '{{.MemUsage}}' ${DOCKER}`).toString().trim()
    const m = s.match(/^([\d.]+)\s*([A-Za-z]+)/)
    if (!m) return null
    const mult = { B: 1 / 1048576, KiB: 1 / 1024, MiB: 1, GiB: 1024 }[m[2]] ?? 1
    return Math.round(Number(m[1]) * mult)
  } catch (e) { return null }
}

const pct = (sorted, p) => sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  : 0

async function level (concurrency, seconds) {
  const lat = []
  let errors = 0, statusBad = 0, bytes = 0
  const deadline = Date.now() + seconds * 1000
  const peak = { node: 0, docker: 0 }

  const sampler = setInterval(() => {
    const n = rssMB(); if (n && n > peak.node) peak.node = n
    const d = dockerMB(); if (d && d > peak.docker) peak.docker = d
  }, 250)

  const worker = async () => {
    while (Date.now() < deadline) {
      const [name, p] = nextPath()
      const t0 = performance.now()
      try {
        const res = await fetch(TARGET + p)
        const body = await res.arrayBuffer()
        bytes += body.byteLength
        if (res.status >= 500) statusBad++
      } catch (e) {
        errors++
      }
      const ms = performance.now() - t0
      lat.push(ms)
      recordEndpoint(name, ms)
      if (ms > 1000) slow.push({ ms: Math.round(ms), concurrency, p })
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker))
  clearInterval(sampler)

  lat.sort((a, b) => a - b)
  const elapsed = seconds
  return {
    concurrency,
    requests: lat.length,
    rps: +(lat.length / elapsed).toFixed(1),
    p50: +pct(lat, 0.50).toFixed(1),
    p95: +pct(lat, 0.95).toFixed(1),
    p99: +pct(lat, 0.99).toFixed(1),
    max: +(lat[lat.length - 1] || 0).toFixed(1),
    errors,
    http5xx: statusBad,
    mbOut: +(bytes / 1048576).toFixed(1),
    peakNodeMB: peak.node || null,
    peakDockerMB: peak.docker || null
  }
}

// --------------------------------------------------------------------------
console.log(`\n  load test: ${LABEL}   ${TARGET}`)
console.log(`  ${SECONDS}s per level, ${WARMUP}s warmup, levels ${LEVELS.join(', ')}\n`)

console.log(`  idle memory: node ${rssMB() ?? '-'} MB` + (DOCKER ? `, ${DOCKER} ${dockerMB() ?? '-'} MB` : ''))

// --------------------------------------------------------------------------
// Warmup.
//
// A random sample is not good enough here. RethinkDB pages each secondary
// index in on first touch, and with 74 of them a randomly-sampled warmup
// leaves most still cold -- which showed up as a p95 of 7.8 s at concurrency
// ONE, from a single request that happened to be the first to touch
// `pending-modified`. Sequentially the same endpoint answers in 12 ms.
//
// So the warmup enumerates the mix's whole parameter space instead of
// sampling it, and every distinct path is fetched once before the clock
// starts. What is measured after this is steady state, which is what capacity
// planning needs. Cold-start is measured separately and reported on its own.
// --------------------------------------------------------------------------
async function warmEverything () {
  const paths = new Set()
  seed = 0x2545f491
  for (let i = 0; i < 4000; i++) paths.add(nextPath()[1])
  let slowest = 0, slowestPath = ''
  for (const p of paths) {
    const t0 = performance.now()
    try { await (await fetch(TARGET + p)).arrayBuffer() } catch (e) { /* ignore */ }
    const ms = performance.now() - t0
    if (ms > slowest) { slowest = ms; slowestPath = p }
  }
  return { count: paths.size, slowest: Math.round(slowest), slowestPath }
}

const rows = []
if (!SEQ_ONLY) {
  const warm = await warmEverything()
  console.log(`  cold start: warmed ${warm.count} distinct paths, ` +
    `slowest first-touch ${warm.slowest} ms (${warm.slowestPath})`)
  await level(4, WARMUP)

  console.log('')
  console.log('  conc   req/s     p50      p95      p99      max    errs   node MB' + (DOCKER ? '   rdb MB' : ''))
  console.log('  ' + '-'.repeat(DOCKER ? 84 : 74))
  for (const c of LEVELS) {
    seed = 0x2545f491     // identical request sequence at every level and run
    const r = await level(c, SECONDS)
    rows.push(r)
    console.log(
      `  ${String(r.concurrency).padStart(4)}  ${String(r.rps).padStart(6)}  ` +
      `${String(r.p50).padStart(7)}  ${String(r.p95).padStart(7)}  ${String(r.p99).padStart(7)}  ` +
      `${String(r.max).padStart(7)}  ${String(r.errors + r.http5xx).padStart(5)}  ` +
      `${String(r.peakNodeMB ?? '-').padStart(7)}` +
      (DOCKER ? `  ${String(r.peakDockerMB ?? '-').padStart(7)}` : ''))
  }

  if (slow.length) {
    console.log(`\n  requests over 1 s (${slow.length} of ${rows.reduce((a, b) => a + b.requests, 0)}):`)
    const worst = [...slow].sort((a, b) => b.ms - a.ms).slice(0, 8)
    worst.forEach(x => console.log(`    ${String(x.ms).padStart(6)} ms  c=${String(x.concurrency).padStart(3)}  ${x.p}`))
  }
}

byEndpoint.clear()   // measured again below, isolated from the sweep

// --------------------------------------------------------------------------
// per-endpoint pass: one worker at a time, so each number is the endpoint's own
// cost rather than its share of a contended queue.
// --------------------------------------------------------------------------
console.log('\n  per endpoint, sequential (isolating cost from contention)' +
  (RTT ? `, minus ${RTT} ms network RTT` : '') + '\n')
console.log('  endpoint            n      p50      p95      max')
console.log('  ' + '-'.repeat(52))
for (const [, name, f] of MIX) {
  seed = 0x2545f491
  const samples = []
  const until = Date.now() + 2000
  for (let i = 0; i < 40 && Date.now() < until; i++) {
    const p = f()
    const t0 = performance.now()
    try { await (await fetch(TARGET + p)).arrayBuffer() } catch (e) { /* counted in sweep */ }
    samples.push(Math.max(0, performance.now() - t0 - RTT))
  }
  samples.sort((a, b) => a - b)
  console.log(`  ${name.padEnd(16)} ${String(samples.length).padStart(4)}  ` +
    `${pct(samples, 0.5).toFixed(1).padStart(7)}  ${pct(samples, 0.95).toFixed(1).padStart(7)}  ` +
    `${(samples[samples.length - 1] || 0).toFixed(1).padStart(7)}`)
  byEndpoint.set(name, samples)
}

if (rows.length) {
  const best = rows.reduce((a, b) => b.rps > a.rps ? b : a)
  console.log('')
  console.log(`  peak throughput: ${best.rps} req/s at concurrency ${best.concurrency}`)
  console.log(`  p95 at c=1: ${rows[0].p95} ms   at peak: ${best.p95} ms`)
}

if (OUT) {
  const endpoints = Object.fromEntries([...byEndpoint].map(([k, v]) => {
    const s2 = [...v].sort((a, b) => a - b)
    return [k, { n: s2.length, p50: +pct(s2, 0.5).toFixed(1), p95: +pct(s2, 0.95).toFixed(1), max: +(s2[s2.length - 1] || 0).toFixed(1) }]
  }))
  fs.writeFileSync(OUT, JSON.stringify({ label: LABEL, target: TARGET, seconds: SECONDS, rtt: RTT, rows, endpoints, slow: slow.slice(0, 50) }, null, 2))
  console.log(`  wrote ${OUT}`)
}
console.log('')
