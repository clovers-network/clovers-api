/**
 * Tests for the chain data source.
 *
 * These run offline. `fetch` is stubbed so the catch-up logic can be driven
 * through failure modes that are hard to provoke against a real provider:
 * range rejections, rate limits, and total endpoint failure.
 *
 * Run with: node --test test/
 */

const test = require('node:test')
const assert = require('node:assert')

// Endpoints must be set before the module is required — it reads them at import.
process.env.RPC_HTTP = 'https://a.example,https://b.example,https://c.example'
process.env.RPC_WS = 'wss://a.example'
// Keep the failure-path backoff at ~0 so the retry test runs in milliseconds.
process.env.RPC_RECONNECT_DELAY_MS = '1'

const chain = require('../dist/lib/chain.js')

// A real Clovers mint: block 25761840, logIndex 503. The expected `data` below
// is exactly what production has stored for this log, so this test pins the
// storage format — changing the decode path would change every stored row.
const REAL_LOG = {
  address: '0xb55c5cac5014c662fdbf21a2c59cd45403c482fd',
  blockHash: '0xaaaa',
  blockNumber: '0x1891830',
  transactionHash: '0xb2e086b1d87b420b53f65dc321c6f9d5a07dc83e8aa635be04d91945824a6ee4',
  transactionIndex: '0x1d8',
  logIndex: '0x1f7',
  removed: false,
  data: '0x',
  topics: [
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    '0x0000000000000000000000000000000000000000000000000000000000000000',
    '0x000000000000000000000000B55C5cAc5014C662fDBF21A2C59Cd45403C482Fd',
    '0x0000000000000000000000000000000055556aa566956a656995665555555555'
  ]
}

// ---------------------------------------------------------------------------
// decodeLog
// ---------------------------------------------------------------------------

test('decodeLog reproduces the exact stored format', () => {
  const log = chain.decodeLog(REAL_LOG)

  assert.equal(log.name, 'Clovers_Transfer')
  assert.equal(log.blockNumber, 25761840)
  assert.equal(log.transactionIndex, 472)
  assert.equal(log.logIndex, 503)

  // _tokenId is the clovers primary key: it must be 0x-hex, not decimal or padded
  assert.equal(log.data._tokenId, '0x55556aa566956a656995665555555555')
  assert.equal(log.data._from, '0x0000000000000000000000000000000000000000')
  assert.equal(log.data._to, '0xB55C5cAc5014C662fDBF21A2C59Cd45403C482Fd')

  // non-_tokenId numerics are stored as 64-char zero-padded decimal
  assert.equal(log.data['2'], '0000000000000000000000000113427887914506214866405545701419603285')
  assert.equal(log.data.length, 3)
})

test('decodeLog checksums the address to match existing rows', () => {
  const log = chain.decodeLog(REAL_LOG)
  assert.equal(log.address, '0xB55C5cAc5014C662fDBF21A2C59Cd45403C482Fd')
})

test('decodeLog extracts userAddresses lowercased', () => {
  const log = chain.decodeLog(REAL_LOG)
  const ids = log.userAddresses.map(u => u.id).sort()
  assert.deepEqual(ids, ['_from', '_to'])
  log.userAddresses.forEach(u => assert.equal(u.address, u.address.toLowerCase()))
})

test('decodeLog ignores logs from unwatched addresses', () => {
  const foreign = Object.assign({}, REAL_LOG, {
    address: '0x1111111111111111111111111111111111111111'
  })
  assert.equal(chain.decodeLog(foreign), null)
})

test('decodeLog ignores untracked event topics', () => {
  const other = Object.assign({}, REAL_LOG, {
    topics: ['0x' + 'ab'.repeat(32)].concat(REAL_LOG.topics.slice(1))
  })
  assert.equal(chain.decodeLog(other), null)
})

// ---------------------------------------------------------------------------
// catchUp — stubbed transport
// ---------------------------------------------------------------------------

function stubFetch (handler) {
  const calls = []
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body)
    const p = body.params[0] || {}
    const call = {
      url,
      method: body.method,
      from: p.fromBlock ? parseInt(p.fromBlock, 16) : null,
      to: p.toBlock ? parseInt(p.toBlock, 16) : null
    }
    calls.push(call)
    return handler(call, calls.length)
  }
  return calls
}

const jsonOk = result => ({ ok: true, status: 200, json: async () => ({ result }) })
const jsonErr = message => ({ ok: true, status: 200, json: async () => ({ error: { message } }) })

test('catchUp covers the whole range with no gaps', async () => {
  const calls = stubFetch(() => jsonOk([]))
  await chain.catchUp(1000, 45000, () => {})

  const ranges = calls.filter(c => c.method === 'eth_getLogs')
    .map(c => [c.from, c.to])
    .sort((a, b) => a[0] - b[0])

  assert.equal(ranges[0][0], 1000, 'starts at fromBlock')
  assert.equal(ranges[ranges.length - 1][1], 45000, 'ends at toBlock')
  for (let i = 1; i < ranges.length; i++) {
    assert.equal(ranges[i][0], ranges[i - 1][1] + 1, `no gap or overlap at range ${i}`)
  }
})

test('catchUp narrows the chunk on rejection and retries the SAME range', async () => {
  let rejected = 0
  const calls = stubFetch(call => {
    // reject anything wider than 2500 blocks, like a capped provider
    if (call.to - call.from + 1 > 2500) { rejected++; return jsonErr('range too large') }
    return jsonOk([])
  })

  await chain.catchUp(1, 5000, () => {})

  assert.ok(rejected > 0, 'provider actually rejected wide ranges')
  const ok = calls.filter(c => c.to - c.from + 1 <= 2500)
  assert.ok(ok.length > 0, 'narrowed and succeeded')
  assert.equal(Math.min(...ok.map(c => c.from)), 1,
    'retried from the same start block rather than skipping ahead')
})

test('catchUp never advances past a range it could not read', async () => {
  // Any range that reaches block 3000 fails, at every width -- so no amount of
  // narrowing gets past it. Keying on `from` would let the first wide range
  // through and never exercise this path.
  stubFetch(call => (call.to >= 3000 ? jsonErr('boom') : jsonOk([])))

  const delivered = []
  await assert.rejects(
    () => chain.catchUp(1, 9000, log => delivered.push(log)),
    /stuck at blocks/,
    'throws rather than silently skipping the unreadable range'
  )
})

test('catchUp rotates to another endpoint when one fails', async () => {
  const calls = stubFetch(call => {
    if (call.url.includes('a.example')) return jsonErr('rate limited')
    return jsonOk([])
  })

  await chain.catchUp(1, 100, () => {})

  const hosts = new Set(calls.map(c => new URL(c.url).host))
  assert.ok(hosts.size > 1, 'tried more than one endpoint')
  assert.ok(calls.some(c => !c.url.includes('a.example')), 'succeeded on a different endpoint')
})

test('catchUp delivers decoded logs in (block, logIndex) order', async () => {
  const mk = (blockNumber, logIndex) => Object.assign({}, REAL_LOG, {
    blockNumber: '0x' + blockNumber.toString(16),
    logIndex: '0x' + logIndex.toString(16)
  })

  stubFetch(() => jsonOk([mk(20, 5), mk(10, 9), mk(20, 1), mk(10, 2)]))

  const got = []
  await chain.catchUp(1, 100, log => got.push(log))

  const seq = got.map(l => [l.blockNumber, l.logIndex])
  assert.deepEqual(seq, [[10, 2], [10, 9], [20, 1], [20, 5]])
})

test('catchUp skips logs it does not track without failing the range', async () => {
  const foreign = Object.assign({}, REAL_LOG, {
    address: '0x2222222222222222222222222222222222222222'
  })
  stubFetch(() => jsonOk([foreign, REAL_LOG]))

  const got = []
  const stats = await chain.catchUp(1, 100, log => got.push(log))

  assert.equal(got.length, 1, 'only the tracked log is delivered')
  assert.equal(stats.delivered, 1)
})

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

test('endpoints are read from the environment', () => {
  assert.deepEqual(chain.HTTP_ENDPOINTS,
    ['https://a.example', 'https://b.example', 'https://c.example'])
})

test('every watched address is lowercase and tracked', () => {
  assert.ok(chain.WATCHED_ADDRESSES.length >= 4)
  chain.WATCHED_ADDRESSES.forEach(a => {
    assert.equal(a, a.toLowerCase())
    assert.match(a, /^0x[0-9a-f]{40}$/)
  })
})
