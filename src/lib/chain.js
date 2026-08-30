/**
 * Chain data source.
 *
 * Replaces both the self-hosted Ethereum node (dead) and the IndexSupply vendor
 * (retired). Reads events from ordinary third-party RPC providers, using several
 * at once so that no single free endpoint is a point of failure.
 *
 * Three overlapping mechanisms, deliberately redundant:
 *
 *   1. Live `eth_subscribe` over WebSocket to N providers. Fast path.
 *   2. A slow reconciling poller on the HTTP providers. Catches anything every
 *      subscription missed, and repairs reorgs by re-scanning recent blocks.
 *   3. Catch-up on every startup, from the stored cursor to head.
 *
 * All three feed the same `onLog` callback and are deduplicated against each
 * other, so overlap is free and missing an event requires all three to fail.
 *
 * Exports the same surface as the old modules so call sites do not change.
 */

const debug = require('debug')('app:chain')
import config from '../config.json'
import {
  Clovers,
  ClubToken,
  CloversController,
  SimpleCloversMarket,
  ClubTokenController
} from 'clovers-contracts'
import { parseLogForStorage } from './util'

var ethers = require('ethers')

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

// Verified to accept anonymous `eth_subscribe` on mainnet logs, and to serve
// `eth_getLogs` over wide ranges. Override in production via env or config.
const DEFAULT_HTTP = [
  'https://eth.drpc.org',
  'https://ethereum-rpc.publicnode.com',
  'https://mainnet.gateway.tenderly.co'
]

const DEFAULT_WS = [
  'wss://ethereum-rpc.publicnode.com',
  'wss://eth.drpc.org',
  'wss://mainnet.gateway.tenderly.co'
]

function endpointList (envName, configKey, fallback) {
  const raw = process.env[envName] || (config.rpc && config.rpc[configKey])
  if (!raw) return fallback
  const list = Array.isArray(raw) ? raw : String(raw).split(',')
  const cleaned = list.map(s => String(s).trim()).filter(Boolean)
  return cleaned.length ? cleaned : fallback
}

export const HTTP_ENDPOINTS = endpointList('RPC_HTTP', 'http', DEFAULT_HTTP)
export const WS_ENDPOINTS = endpointList('RPC_WS', 'ws', DEFAULT_WS)

// How many WebSocket subscriptions to run at once. Two gives redundancy without
// paying for a third stream of identical data; the poller is the real backstop.
const SUBSCRIPTION_COUNT = Number(process.env.RPC_SUBSCRIPTIONS || 2)

// Block-range chunking for catch-up. Providers cap range width, and separately
// cap how many logs may come back at once. Clovers is quiet enough that the
// result cap is never the binding constraint, so we can start wide.
const MAX_CHUNK = Number(process.env.RPC_MAX_CHUNK || 10000)
const MIN_CHUNK = 500
const GROW_AFTER = 5 // successful calls before widening the chunk again

// Blocks near head that we refuse to treat as final, so a reorg cannot strand
// us with a cursor past rewritten history.
const CONFIRMATIONS = Number(process.env.RPC_CONFIRMATIONS || 12)

const POLL_INTERVAL_MS = Number(process.env.RPC_POLL_INTERVAL_MS || 60000)
const RECONNECT_DELAY_MS = Number(process.env.RPC_RECONNECT_DELAY_MS || 5000)
const REQUEST_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS || 30000)

const network = config.network

// ---------------------------------------------------------------------------
// Contracts — identical shape to the modules this replaces
// ---------------------------------------------------------------------------

const cloversABI = Clovers.abi
export const cloversAddress = Clovers.networks[network.chainId].address

const clubTokenABI = ClubToken.abi
const clubTokenAddress = ClubToken.networks[network.chainId].address

const cloversControllerABI = CloversController.abi
const cloversControllerAddress = CloversController.networks[network.chainId].address

const simpleCloversMarketABI = SimpleCloversMarket.abi
const simpleCloversMarketAddress = SimpleCloversMarket.networks[network.chainId].address

const clubTokenControllerABI = ClubTokenController.abi
const clubTokenControllerAddress = ClubTokenController.networks[network.chainId].address

/**
 * View-function provider. FallbackProvider tries each endpoint in turn, so a
 * single dead free endpoint degrades rather than breaks `eth_call`.
 */
export const provider = HTTP_ENDPOINTS.length > 1
  ? new ethers.providers.FallbackProvider(
      HTTP_ENDPOINTS.map(url => new ethers.providers.JsonRpcProvider(url, network))
    )
  : new ethers.providers.JsonRpcProvider(HTTP_ENDPOINTS[0], network)

const cloversInstance = new ethers.Contract(cloversAddress, cloversABI, provider)
const clubTokenInstance = new ethers.Contract(clubTokenAddress, clubTokenABI, provider)
const cloversControllerInstance = new ethers.Contract(cloversControllerAddress, cloversControllerABI, provider)
const simpleCloversMarketInstance = new ethers.Contract(simpleCloversMarketAddress, simpleCloversMarketABI, provider)
const clubTokenControllerInstance = new ethers.Contract(clubTokenControllerAddress, clubTokenControllerABI, provider)

let walletProvider
try {
  walletProvider = new ethers.Wallet(config.oraclePrivateKey, provider)
} catch (e) {
  debug('Oracle wallet not configured:', e.message)
  walletProvider = null
}

export { walletProvider }

export let wallet = walletProvider ? {
  CloversController: new ethers.Contract(
    cloversControllerAddress,
    cloversControllerABI,
    walletProvider
  )
} : {}

export let events = {
  SimpleCloversMarket: {
    abi: simpleCloversMarketABI,
    address: simpleCloversMarketAddress,
    instance: simpleCloversMarketInstance,
    eventTypes: ['updatePrice']
  },
  Clovers: {
    abi: cloversABI,
    address: cloversAddress,
    instance: cloversInstance,
    eventTypes: ['Transfer']
  },
  ClubToken: {
    abi: clubTokenABI,
    address: clubTokenAddress,
    instance: clubTokenInstance,
    eventTypes: ['Transfer']
  },
  ClubTokenController: {
    abi: clubTokenControllerABI,
    address: clubTokenControllerAddress,
    instance: clubTokenControllerInstance,
    eventTypes: ['Buy', 'Sell']
  },
  CloversController: {
    abi: cloversControllerABI,
    address: cloversControllerAddress,
    instance: cloversControllerInstance,
    eventTypes: []
  }
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

// Matches the legacy list exactly, so stored `userAddresses` keep their shape.
const USER_KEYS = ['_to', '_from', 'owner', 'buyer', 'seller']

// address -> topic0 -> { contractName, eventName, coder }
const TOPICS = {}

for (const contractName of Object.keys(events)) {
  const info = events[contractName]
  const address = info.address.toLowerCase()
  const iface = info.instance.interface
  TOPICS[address] = TOPICS[address] || {}

  for (const eventName of info.eventTypes) {
    const ev = iface.events[eventName]
    if (!ev) {
      debug(`WARNING: ${contractName}.${eventName} not found in ABI, skipping`)
      continue
    }
    TOPICS[address][ev.topic] = { contractName, eventName, coder: ev }
  }
}

/** Every address we ask providers about, in one filter. */
export const WATCHED_ADDRESSES = Object.keys(TOPICS).filter(a => Object.keys(TOPICS[a]).length)

function toNumber (v) {
  if (v === null || v === undefined) return 0
  if (typeof v === 'number') return v
  return parseInt(v, 16)
}

/**
 * Turn a raw JSON-RPC log into the record shape the models and the `logs` table
 * already expect. Returns null for logs we do not track.
 *
 * The decode path is deliberately identical to the legacy `transformLog`:
 * ethers decodes, then `parseLogForStorage` normalises BigNumbers. Changing
 * either would silently change the format of every stored log.
 */
export function decodeLog (raw) {
  const address = String(raw.address || '').toLowerCase()
  const byTopic = TOPICS[address]
  if (!byTopic) return null

  const topic0 = raw.topics && raw.topics[0]
  const entry = topic0 && byTopic[topic0]
  if (!entry) return null

  let data
  try {
    data = parseLogForStorage(entry.coder.decode(raw.data, raw.topics))
  } catch (err) {
    debug(`Failed to decode ${entry.contractName}_${entry.eventName}:`, err.message)
    return null
  }

  const userAddresses = []
  for (const k of Object.keys(data)) {
    if (USER_KEYS.includes(k) && typeof data[k] === 'string') {
      userAddresses.push({ id: k, address: data[k].toLowerCase() })
    }
  }

  // Existing rows store the checksummed address (ethers used to produce it) and
  // carry the raw log fields alongside. Match that exactly rather than leaving
  // the table in two formats.
  let checksummed = raw.address
  try {
    checksummed = ethers.utils.getAddress(address)
  } catch (err) {
    /* keep whatever the provider gave us */
  }

  return {
    address: checksummed,
    blockHash: raw.blockHash,
    blockNumber: toNumber(raw.blockNumber),
    transactionHash: raw.transactionHash,
    transactionIndex: toNumber(raw.transactionIndex),
    logIndex: toNumber(raw.logIndex),
    topics: raw.topics,
    removed: !!raw.removed,
    name: `${entry.contractName}_${entry.eventName}`,
    data,
    userAddresses
  }
}

// ---------------------------------------------------------------------------
// HTTP JSON-RPC, with provider rotation
// ---------------------------------------------------------------------------

let httpCursor = 0

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * POST a JSON body and resolve the parsed response.
 *
 * Prefers global `fetch`, but the production server runs Node 9, where
 * `fetch`, `WebSocket`, `URLSearchParams` and `AbortController` are all
 * undefined. Falling back to the `http`/`https` modules keeps this working
 * across every Node version in play without adding a dependency.
 */
function httpPostJson (url, payload) {
  if (typeof fetch !== 'undefined') {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    })
  }

  return new Promise((resolve, reject) => {
    // `url.parse` rather than `new URL`, which is not global until Node 10.
    const parsed = require('url').parse(url)
    const transport = parsed.protocol === 'http:' ? require('http') : require('https')
    const data = JSON.stringify(payload)

    const req = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { raw += chunk })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}`))
        }
        try {
          resolve(JSON.parse(raw))
        } catch (err) {
          reject(new Error(`invalid JSON from ${parsed.hostname}`))
        }
      })
    })

    req.on('error', reject)
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.abort()
      reject(new Error(`request to ${parsed.hostname} timed out`))
    })
    req.write(data)
    req.end()
  })
}

/**
 * Call every HTTP endpoint in turn until one answers. Rotates the starting
 * point on success so load spreads rather than always hammering the first.
 */
async function rpcCall (method, params) {
  let lastErr
  for (let i = 0; i < HTTP_ENDPOINTS.length; i++) {
    const idx = (httpCursor + i) % HTTP_ENDPOINTS.length
    const url = HTTP_ENDPOINTS[idx]
    try {
      const body = await httpPostJson(url, { jsonrpc: '2.0', id: 1, method, params })
      if (body.error) {
        throw Object.assign(new Error(body.error.message || 'rpc error'), {
          code: body.error.code
        })
      }

      httpCursor = idx
      return body.result
    } catch (err) {
      lastErr = err
      debug(`${method} failed on ${url}: ${err.message}`)
    }
  }
  throw lastErr || new Error(`${method}: all RPC endpoints failed`)
}

export async function getBlockNumber () {
  return toNumber(await rpcCall('eth_blockNumber', []))
}

function hex (n) {
  return '0x' + Number(n).toString(16)
}

async function getLogsRange (fromBlock, toBlock, addresses = WATCHED_ADDRESSES) {
  return rpcCall('eth_getLogs', [{
    address: addresses,
    fromBlock: hex(fromBlock),
    toBlock: hex(toBlock)
  }])
}

function byPosition (a, b) {
  return toNumber(a.blockNumber) - toNumber(b.blockNumber) ||
    toNumber(a.logIndex) - toNumber(b.logIndex)
}

// ---------------------------------------------------------------------------
// Catch-up
// ---------------------------------------------------------------------------

/**
 * Walk `fromBlock`..`toBlock` and hand every tracked log to `onLog`, in order.
 *
 * Chunk width adapts: it halves whenever a provider rejects a range and widens
 * again after sustained success. Crucially, a failed range is **retried, never
 * skipped** — the cursor only advances past blocks that were actually read.
 * Silently skipping a failed range is how you lose events permanently.
 */
export async function catchUp (fromBlock, toBlock, onLog, opts = {}) {
  const addresses = opts.addresses || WATCHED_ADDRESSES
  let chunk = Math.min(MAX_CHUNK, opts.chunk || MAX_CHUNK)
  let from = Number(fromBlock)
  const end = Number(toBlock)

  let calls = 0
  let delivered = 0
  let sinceShrink = 0
  let failures = 0

  while (from <= end) {
    const to = Math.min(from + chunk - 1, end)

    let raw
    try {
      raw = await getLogsRange(from, to, addresses)
      calls++
      failures = 0
    } catch (err) {
      failures++

      if (chunk > MIN_CHUNK) {
        chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2))
        sinceShrink = 0
        debug(`range ${from}-${to} failed (${err.message}); chunk -> ${chunk}`)
        continue // same range, narrower
      }

      if (failures >= 5) {
        throw new Error(
          `catchUp stuck at blocks ${from}-${to} after ${failures} attempts: ${err.message}`
        )
      }

      debug(`range ${from}-${to} failed at minimum chunk; backing off`)
      await sleep(RECONNECT_DELAY_MS)
      continue // same range, after a pause
    }

    for (const rawLog of raw.slice().sort(byPosition)) {
      const log = decodeLog(rawLog)
      if (!log) continue
      delivered++
      await onLog(log)
    }

    from = to + 1

    if (++sinceShrink >= GROW_AFTER && chunk < MAX_CHUNK) {
      chunk = Math.min(MAX_CHUNK, chunk * 2)
      sinceShrink = 0
    }
  }

  return { calls, delivered }
}

/**
 * Historical fetch for one contract, collected rather than streamed.
 * Compatibility shim for `build.js`.
 */
export async function fetchHistoricalEvents (contractName, fromBlock, toBlock) {
  const info = events[contractName]
  if (!info || !info.eventTypes.length) return []

  const address = info.address.toLowerCase()
  const collected = []

  const end = toBlock === null || toBlock === undefined
    ? await getBlockNumber()
    : Number(toBlock)

  await catchUp(fromBlock, end, log => { collected.push(log) }, { addresses: [address] })

  return collected.sort((a, b) =>
    a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Bounded set of recently seen `(txHash, logIndex)` pairs. Redundant sources
 * mean the same log arrives several times; this makes that free, and is what
 * lets every mechanism over-fetch without coordination.
 */
class SeenSet {
  constructor (limit = 5000) {
    this.limit = limit
    this.set = new Set()
    this.queue = []
  }

  key (raw) {
    return `${String(raw.transactionHash).toLowerCase()}:${toNumber(raw.logIndex)}`
  }

  seen (raw) {
    const k = this.key(raw)
    if (this.set.has(k)) return true
    this.set.add(k)
    this.queue.push(k)
    if (this.queue.length > this.limit) {
      this.set.delete(this.queue.shift())
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// WebSocket subscriptions
// ---------------------------------------------------------------------------

/**
 * Node 21+ exposes a global WebSocket; older runtimes fall back to `ws`, which
 * is already present as a socket.io dependency. Normalises both to the
 * browser-style event API.
 */
function openSocket (url) {
  if (typeof WebSocket !== 'undefined') return new WebSocket(url)

  let WS
  try {
    WS = require('ws')
  } catch (err) {
    throw new Error(
      'No WebSocket available: this runtime predates the global WebSocket ' +
      '(Node 21+) and the `ws` package could not be loaded. Run `npm install`, ' +
      'or upgrade Node.'
    )
  }

  const sock = new WS(url)
  const shim = {
    _sock: sock,
    send: data => sock.send(data),
    close: () => sock.close(),
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null
  }
  sock.on('open', () => shim.onopen && shim.onopen())
  sock.on('message', data => shim.onmessage && shim.onmessage({ data: data.toString() }))
  sock.on('error', err => shim.onerror && shim.onerror(err))
  sock.on('close', () => shim.onclose && shim.onclose())
  return shim
}

/**
 * Hold an `eth_subscribe("logs")` stream open against one provider, reconnecting
 * with backoff. Returns a controller with `.abort()`.
 */
function subscribeLogs (url, onRawLog) {
  const controller = { stopped: false, url, socket: null }

  const connect = () => {
    if (controller.stopped) return

    let socket
    try {
      socket = openSocket(url)
    } catch (err) {
      debug(`[${url}] could not open socket: ${err.message}`)
      return retry()
    }
    controller.socket = socket

    let settled = false
    const retryOnce = () => {
      if (settled) return
      settled = true
      retry()
    }

    socket.onopen = () => {
      debug(`[${url}] subscribing`)
      socket.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_subscribe',
        params: ['logs', { address: WATCHED_ADDRESSES }]
      }))
    }

    socket.onmessage = evt => {
      let msg
      try {
        msg = JSON.parse(typeof evt.data === 'string' ? evt.data : String(evt.data))
      } catch (err) {
        return
      }

      if (msg.error) {
        debug(`[${url}] rejected subscription: ${JSON.stringify(msg.error).slice(0, 160)}`)
        try { socket.close() } catch (e) {}
        return retryOnce()
      }

      if (msg.id === 1 && msg.result) {
        debug(`[${url}] subscribed (${String(msg.result).slice(0, 14)})`)
        return
      }

      if (msg.method === 'eth_subscription' && msg.params && msg.params.result) {
        onRawLog(msg.params.result, url)
      }
    }

    socket.onerror = err => {
      debug(`[${url}] socket error: ${(err && err.message) || 'unknown'}`)
      retryOnce()
    }

    socket.onclose = () => {
      debug(`[${url}] socket closed`)
      retryOnce()
    }
  }

  const retry = () => {
    if (controller.stopped) return
    setTimeout(connect, RECONNECT_DELAY_MS)
  }

  controller.abort = () => {
    controller.stopped = true
    try { controller.socket && controller.socket.close() } catch (e) {}
  }

  connect()
  return controller
}

// ---------------------------------------------------------------------------
// Live streaming
// ---------------------------------------------------------------------------

/**
 * Start live event delivery.
 *
 * `fromBlock` is the highest block already persisted. Everything after it is
 * caught up before live delivery begins, so an outage of any length is the same
 * code path as a routine restart — the recovery logic runs constantly instead
 * of being cold code that only executes during an incident.
 *
 * Returns an array of controllers, each with `.abort()`.
 */
export async function startLiveStreams (onLog, fromBlock) {
  const seen = new SeenSet()
  const state = { cursor: null }

  const deliver = async (raw, source) => {
    if (seen.seen(raw)) return
    const log = decodeLog(raw)
    if (!log) return
    debug(`[${source}] ${log.name} block=${log.blockNumber}`)
    try {
      await onLog(log)
    } catch (err) {
      debug(`onLog failed for ${log.name}:`, err.message)
    }
  }

  const head = await getBlockNumber()

  if (fromBlock === undefined || fromBlock === null) {
    debug(`No stored block; starting live from head ${head}`)
    state.cursor = head
  } else {
    const start = Number(fromBlock) + 1
    if (start <= head) {
      debug(`Catching up blocks ${start}-${head} (${head - start + 1} blocks)`)
      // Register catch-up logs in the dedupe set as well, or the reconciling
      // poller re-delivers everything catch-up just handled.
      const { calls, delivered } = await catchUp(start, head, async log => {
        seen.seen(log)
        await onLog(log)
      })
      debug(`Catch-up complete: ${delivered} events in ${calls} requests`)
    } else {
      debug('Already current')
    }
    state.cursor = head
  }

  const controllers = []

  for (const url of WS_ENDPOINTS.slice(0, SUBSCRIPTION_COUNT)) {
    controllers.push(subscribeLogs(url, (raw, src) => { deliver(raw, src) }))
  }
  debug(`${controllers.length} live subscriptions started`)

  controllers.push(startReconcilingPoller(deliver, state))

  return controllers
}

/**
 * Slow backstop. Re-reads the last `CONFIRMATIONS` blocks plus anything new,
 * which both catches events every subscription dropped and repairs reorgs —
 * re-delivered logs are deduplicated, and the cursor is held behind head so a
 * rewritten block is always re-read rather than assumed final.
 */
function startReconcilingPoller (deliver, state) {
  const controller = { stopped: false, timer: null }

  const tick = async () => {
    if (controller.stopped) return

    try {
      const head = await getBlockNumber()
      const from = Math.max(0, (state.cursor || head) - CONFIRMATIONS)

      if (from <= head) {
        const raw = await getLogsRange(from, head)
        for (const rawLog of raw.slice().sort(byPosition)) {
          await deliver(rawLog, 'poll')
        }
        state.cursor = head
      }
    } catch (err) {
      debug('poller error:', err.message)
    }

    if (!controller.stopped) {
      controller.timer = setTimeout(tick, POLL_INTERVAL_MS)
    }
  }

  controller.abort = () => {
    controller.stopped = true
    if (controller.timer) clearTimeout(controller.timer)
  }

  controller.timer = setTimeout(tick, POLL_INTERVAL_MS)
  return controller
}

export { ethers }
