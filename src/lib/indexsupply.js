/**
 * IndexSupply integration module
 *
 * Replaces direct Ethereum full node connection (ethers-utils.js) with
 * IndexSupply's hosted event log API. Uses Infura free tier as a lightweight
 * RPC fallback for eth_call (view functions like balanceOf, ownerOf, etc).
 *
 * IndexSupply API: https://api.indexsupply.net
 */

const debug = require('debug')('app:indexsupply')
import config from '../config.json'
import { oraclePrivateKey } from './oracle-key'
import {
  Clovers,
  ClubToken,
  CloversController,
  SimpleCloversMarket,
  ClubTokenController
} from 'clovers-contracts'

var ethers = require('ethers')

// ---------------------------------------------------------------------------
// RPC provider (Infura free tier) for eth_call / view functions only
// ---------------------------------------------------------------------------

const INFURA_KEY = process.env.INFURA_API_KEY || config.infuraKey || config.infuraAPI || ''
const INFURA_URL = `https://mainnet.infura.io/v3/${INFURA_KEY}`
const INDEXSUPPLY_API_KEY = process.env.INDEXSUPPLY_API_KEY || ''
const INDEXSUPPLY_BASE = 'https://api.indexsupply.net'

const network = config.network

// Lightweight RPC provider for view function calls only
export const provider = INFURA_KEY
  ? new ethers.providers.JsonRpcProvider(INFURA_URL)
  : new ethers.providers.JsonRpcProvider('http://138.68.85.68:8545') // legacy fallback

// ---------------------------------------------------------------------------
// Contract instances (read-only, for eth_call via Infura)
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

const cloversInstance = new ethers.Contract(cloversAddress, cloversABI, provider)
const clubTokenInstance = new ethers.Contract(clubTokenAddress, clubTokenABI, provider)
const cloversControllerInstance = new ethers.Contract(cloversControllerAddress, cloversControllerABI, provider)
const simpleCloversMarketInstance = new ethers.Contract(simpleCloversMarketAddress, simpleCloversMarketABI, provider)
const clubTokenControllerInstance = new ethers.Contract(clubTokenControllerAddress, clubTokenControllerABI, provider)

// Oracle wallet (still needed for any signing operations)
let walletProvider
try {
  walletProvider = new ethers.Wallet(oraclePrivateKey(), provider)
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

// ---------------------------------------------------------------------------
// Events configuration – same shape as ethers-utils.js for backward compat
// ---------------------------------------------------------------------------

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
// IndexSupply event signatures (human-readable ABI format)
// ---------------------------------------------------------------------------

/**
 * Per-event IndexSupply spec.
 *
 * `signature` must match the deployed ABI *including* `indexed` markers. topic0
 * is unaffected by indexing, so a signature with the wrong indexed-ness still
 * matches the logs but decodes the mis-declared args out of the wrong section --
 * silently yielding zeros rather than an error.
 *
 * `table` is the event name lowercased. `columns` are the arg names lowercased
 * (Postgres folds unquoted identifiers), in signature order.
 */
export const EVENT_SIGNATURES = {
  Clovers: {
    // _tokenId IS indexed on the deployed Clovers contract. Dropping `indexed`
    // here decodes every tokenId as 0 -- and _tokenId is the clovers primary key.
    Transfer: {
      signature: 'Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
      table: 'transfer',
      columns: ['from', 'to', 'tokenid']
    }
  },
  ClubToken: {
    Transfer: {
      signature: 'Transfer(address indexed from, address indexed to, uint256 value)',
      table: 'transfer',
      columns: ['from', 'to', 'value']
    }
  },
  SimpleCloversMarket: {
    updatePrice: {
      signature: 'updatePrice(uint256 _tokenId, uint256 price)',
      table: 'updateprice',
      columns: ['_tokenid', 'price']
    }
  },
  ClubTokenController: {
    Buy: {
      signature: 'Buy(address buyer, uint256 tokens, uint256 value, uint256 poolBalance, uint256 tokenSupply)',
      table: 'buy',
      columns: ['buyer', 'tokens', 'value', 'poolbalance', 'tokensupply']
    },
    Sell: {
      signature: 'Sell(address seller, uint256 tokens, uint256 value, uint256 poolBalance, uint256 tokenSupply)',
      table: 'sell',
      columns: ['seller', 'tokens', 'value', 'poolbalance', 'tokensupply']
    }
  },
  CloversController: {}
}

// Log columns every event virtual table carries. IndexSupply has no
// transaction-index column; log_idx is monotonic within a block, so it orders
// events identically to (tx_idx, log-within-tx).
const LOG_COLUMNS = ['block_num', 'tx_hash', 'log_idx', 'address']

const CHAIN_ID = network.chainId

export const CONTRACT_ADDRESSES = {
  Clovers: cloversAddress.toLowerCase(),
  ClubToken: clubTokenAddress.toLowerCase(),
  SimpleCloversMarket: simpleCloversMarketAddress.toLowerCase(),
  ClubTokenController: clubTokenControllerAddress.toLowerCase(),
  CloversController: cloversControllerAddress.toLowerCase()
}

// ---------------------------------------------------------------------------
// IndexSupply query helpers
// ---------------------------------------------------------------------------

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function buildQueryParams (signature, sql, cursor) {
  const params = new URLSearchParams()
  params.set('chain', CHAIN_ID)

  const sigs = Array.isArray(signature) ? signature : [signature]
  sigs.forEach(sig => params.append('signatures', sig))

  params.set('query', sql)

  if (cursor) {
    params.set('cursor', cursor)
  }

  if (INDEXSUPPLY_API_KEY) {
    params.set('api_key', INDEXSUPPLY_API_KEY)
  }

  return params
}

/**
 * Build the SQL for one contract event.
 *
 * IndexSupply rejects `SELECT *` and `SELECT <table>.*`, requires a `chain`
 * predicate in the SQL itself (the URL param alone is not enough), and exposes
 * the log address as `address` on the event table -- there is no `log_addr`
 * column and no need to JOIN the `logs` base table.
 */
export function buildEventSQL (contractName, eventName, { fromBlock, toBlock, limit } = {}) {
  const spec = EVENT_SIGNATURES[contractName][eventName]
  const cols = spec.columns
    .map(c => `"${c}"`)
    .concat(LOG_COLUMNS)
    .join(', ')

  const where = [
    `chain = ${CHAIN_ID}`,
    `address = '${CONTRACT_ADDRESSES[contractName]}'`
  ]
  if (fromBlock !== undefined && fromBlock !== null) where.push(`block_num >= ${Number(fromBlock)}`)
  if (toBlock !== undefined && toBlock !== null) where.push(`block_num <= ${Number(toBlock)}`)

  return `SELECT ${cols} FROM ${spec.table}` +
    ` WHERE ${where.join(' AND ')}` +
    ` ORDER BY block_num ASC, log_idx ASC` +
    (limit ? ` LIMIT ${Number(limit)}` : '')
}

/**
 * Normalise an IndexSupply /v2 response body.
 *
 * The API returns a top-level ARRAY, one entry per query:
 *   [{ cursor, columns: [{ name, pgtype }], rows: [[...]] }]
 * Errors come back as { error, message }.
 */
function parseResult (body) {
  if (body && !Array.isArray(body) && (body.error || body.message)) {
    const err = new Error(`IndexSupply error: ${body.message || body.error}`)
    err.isUserError = body.error === 'user'
    throw err
  }

  const result = Array.isArray(body) ? body[0] : null
  if (!result) return { rows: [], cursor: null }

  const columns = (result.columns || []).map(c => (typeof c === 'string' ? c : c.name))
  const rows = (result.rows || []).map(row => {
    const obj = {}
    columns.forEach((col, k) => { obj[col] = row[k] })
    return obj
  })

  return { rows, cursor: result.cursor || null }
}

// The free tier allows 5 queries/min. Serialise requests behind a minimum
// interval so a long historical sync degrades to "slow" rather than "429s that
// get swallowed and silently skip block ranges".
const MIN_QUERY_INTERVAL_MS = Number(
  process.env.INDEXSUPPLY_MIN_INTERVAL_MS ||
  (INDEXSUPPLY_API_KEY ? 250 : 12500)
)
const MAX_QUERY_RETRIES = 5

let queryQueue = Promise.resolve()
let lastQueryAt = 0

function throttle () {
  const next = queryQueue.then(async () => {
    const wait = lastQueryAt + MIN_QUERY_INTERVAL_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastQueryAt = Date.now()
  })
  queryQueue = next.catch(() => {})
  return next
}

/**
 * Execute a query against IndexSupply /v2/query.
 * Returns { rows, cursor }; rows are column-name keyed objects.
 */
export async function queryIndexSupplyWithCursor (signature, sql, { cursor } = {}) {
  const url = `${INDEXSUPPLY_BASE}/v2/query?${buildQueryParams(signature, sql, cursor).toString()}`

  debug('IndexSupply query:', sql.substring(0, 160))

  for (let attempt = 0; ; attempt++) {
    await throttle()

    const response = await fetch(url, { headers: { 'Accept': 'application/json' } })

    if (response.status === 429 && attempt < MAX_QUERY_RETRIES) {
      const retryAfter = Number(response.headers.get('retry-after') || 0) * 1000
      const wait = retryAfter || Math.min(60000, 5000 * Math.pow(2, attempt))
      debug(`IndexSupply rate limited, retrying in ${wait}ms (attempt ${attempt + 1})`)
      await sleep(wait)
      continue
    }

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`IndexSupply query failed (${response.status}): ${text}`)
    }

    return parseResult(await response.json())
  }
}

/**
 * Convenience wrapper returning just the rows.
 */
export async function queryIndexSupply (signature, sql, opts = {}) {
  const { rows } = await queryIndexSupplyWithCursor(signature, sql, opts)
  return rows
}

/**
 * Open an SSE stream via IndexSupply /v2/query-live.
 *
 * The cursor is what makes a live query incremental: without one the query is
 * evaluated over all of history on connect. Do NOT bound the query with LIMIT --
 * the live stream re-evaluates the whole query per block, so a LIMIT truncates
 * each block's result set and silently drops events.
 *
 * Calls `onEvent(rows)` per batch. Returns an AbortController that stops the
 * stream, including across reconnects.
 */
export function queryLiveIndexSupply (signature, sql, onEvent, { cursor } = {}) {
  const abortController = new AbortController()
  let position = cursor || null

  debug('IndexSupply live query starting:', sql.substring(0, 160))

  ;(async () => {
    while (!abortController.signal.aborted) {
      try {
        const url = `${INDEXSUPPLY_BASE}/v2/query-live?${buildQueryParams(signature, sql, position).toString()}`

        const response = await fetch(url, {
          headers: { 'Accept': 'text/event-stream' },
          signal: abortController.signal
        })

        if (!response.ok) {
          const text = await response.text()
          throw new Error(`IndexSupply live query failed (${response.status}): ${text}`)
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          const parts = buffer.split('\n\n')
          buffer = parts.pop() // keep incomplete part

          for (const part of parts) {
            const dataLines = part
              .split('\n')
              .filter(l => l.startsWith('data:'))
              .map(l => l.slice(5).trim())

            if (dataLines.length === 0) continue

            let parsed
            try {
              parsed = parseResult(JSON.parse(dataLines.join('')))
            } catch (e) {
              if (e.isUserError) throw e // broken query; reconnecting will not help
              debug('SSE parse error:', e.message)
              continue
            }

            // Advance the cursor before dispatching so a throw still resumes.
            if (parsed.cursor) position = parsed.cursor
            if (parsed.rows.length) onEvent(parsed.rows)
          }
        }
      } catch (err) {
        if (abortController.signal.aborted || err.name === 'AbortError') return

        if (err.isUserError) {
          debug('IndexSupply live query rejected, not reconnecting:', err.message)
          return
        }

        debug('IndexSupply live query error, reconnecting in 5s:', err.message)
        await sleep(5000)
      }
    }
  })()

  return abortController
}

// ---------------------------------------------------------------------------
// Contract-specific query functions
// ---------------------------------------------------------------------------

/**
 * Fetch historical events for a contract from IndexSupply.
 * Returns events in the same log format the existing model handlers expect.
 */
export async function fetchHistoricalEvents (contractName, fromBlock, toBlock) {
  const eventTypes = events[contractName].eventTypes
  if (!eventTypes || eventTypes.length === 0) return []

  const allLogs = []

  for (let i = 0; i < eventTypes.length; i++) {
    const eventName = eventTypes[i]
    const spec = EVENT_SIGNATURES[contractName][eventName]
    if (!spec) {
      debug(`No signature for ${contractName}.${eventName}, skipping`)
      continue
    }

    const sql = buildEventSQL(contractName, eventName, { fromBlock, toBlock })

    try {
      const rows = await queryIndexSupply(spec.signature, sql)
      debug(`${contractName}.${eventName}: ${rows.length} events from block ${fromBlock}`)

      const logs = rows.map(row => indexSupplyRowToLog(row, contractName, eventName, i))
      allLogs.push(...logs)
    } catch (err) {
      debug(`Error fetching ${contractName}.${eventName}:`, err.message)
      throw err
    }
  }

  // Sort all logs by block number then log index
  allLogs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)

  return allLogs
}

/**
 * Convert an IndexSupply row into the log format expected by existing handlers.
 *
 * Existing log format:
 * {
 *   blockNumber,
 *   transactionHash,
 *   transactionIndex,
 *   logIndex,
 *   address,
 *   name: 'ContractName_EventName',
 *   data: { ... decoded fields ... },
 *   userAddresses: [{ id, address }]
 * }
 */
function indexSupplyRowToLog (row, contractName, eventName, eventTypeIndex) {
  const userKeys = ['_to', '_from', 'owner', 'buyer', 'seller', 'from', 'to']
  const data = {}
  const userAddresses = []

  // Map IndexSupply column names to expected field names
  const fieldMappings = getFieldMappings(contractName, eventName)

  for (const [isCol, logField] of Object.entries(fieldMappings)) {
    let value = row[isCol]
    if (value === undefined || value === null) continue

    // Keep addresses lowercase
    if (typeof value === 'string' && value.startsWith('0x') && value.length === 42) {
      value = value.toLowerCase()
    }

    // For uint fields, pad to 64 chars for consistency with existing code
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      // It's a numeric string - for _tokenId keep as hex, others pad
      if (logField === '_tokenId') {
        // Convert decimal to hex with 0x prefix
        const bn = new (require('bignumber.js'))(value)
        value = '0x' + bn.toString(16)
      } else {
        value = value.padStart(64, '0')
      }
    } else if (typeof value === 'number') {
      if (logField === '_tokenId') {
        const bn = new (require('bignumber.js'))(value)
        value = '0x' + bn.toString(16)
      } else {
        value = value.toString().padStart(64, '0')
      }
    }

    data[logField] = value

    if (userKeys.includes(logField) && typeof value === 'string' && value.startsWith('0x')) {
      userAddresses.push({ id: logField, address: value.toLowerCase() })
    }
  }

  // IndexSupply exposes no transaction-index column. log_idx is monotonic
  // within a block, so it sorts events in the same order tx_idx would.
  return {
    blockNumber: Number(row.block_num),
    transactionHash: row.tx_hash,
    transactionIndex: Number(row.log_idx || 0),
    logIndex: Number(row.log_idx || 0),
    address: (row.address || CONTRACT_ADDRESSES[contractName]).toLowerCase(),
    name: `${contractName}_${eventName}`,
    data,
    userAddresses
  }
}

/**
 * Map IndexSupply column names to the field names expected by existing handlers.
 */
function getFieldMappings (contractName, eventName) {
  const mappings = {
    Clovers: {
      Transfer: {
        'from': '_from',
        'to': '_to',
        'tokenid': '_tokenId'
      }
    },
    ClubToken: {
      Transfer: {
        'from': 'from',
        'to': 'to',
        'value': 'value'
      }
    },
    SimpleCloversMarket: {
      updatePrice: {
        '_tokenid': '_tokenId',
        'price': 'price'
      }
    },
    ClubTokenController: {
      Buy: {
        'buyer': 'buyer',
        'tokens': 'tokens',
        'value': 'value',
        'poolbalance': 'poolBalance',
        'tokensupply': 'tokenSupply'
      },
      Sell: {
        'seller': 'seller',
        'tokens': 'tokens',
        'value': 'value',
        'poolbalance': 'poolBalance',
        'tokensupply': 'tokenSupply'
      }
    },
    CloversController: {}
  }

  return (mappings[contractName] && mappings[contractName][eventName]) || {}
}

// ---------------------------------------------------------------------------
// Start live event streaming for all contracts
// ---------------------------------------------------------------------------

/**
 * Start live SSE streams for all tracked contracts/events.
 *
 * `fromBlock` seeds each stream's cursor. Pass the highest block already
 * persisted so the stream resumes exactly where the historical sync stopped;
 * omit it to start from chain head. Without a cursor IndexSupply evaluates the
 * query over all of history on connect, which times out.
 *
 * Calls onLog(log) for each new event, in the standard log format.
 * Returns an array of AbortControllers (one per stream).
 */
export async function startLiveStreams (onLog, fromBlock) {
  const controllers = []
  const contractNames = ['Clovers', 'ClubToken', 'SimpleCloversMarket', 'ClubTokenController']

  let startBlock = fromBlock
  if (startBlock === undefined || startBlock === null) {
    startBlock = await provider.getBlockNumber()
    debug(`No start block given, streaming from chain head ${startBlock}`)
  }

  const cursor = `${CHAIN_ID}-${Number(startBlock)}`

  for (const contractName of contractNames) {
    const eventTypes = events[contractName].eventTypes

    for (let i = 0; i < eventTypes.length; i++) {
      const eventName = eventTypes[i]
      const spec = EVENT_SIGNATURES[contractName][eventName]
      if (!spec) continue

      // No LIMIT: the live query is re-evaluated per block and a LIMIT would
      // truncate blocks that carry more than one matching event.
      const sql = buildEventSQL(contractName, eventName, { fromBlock: startBlock })

      const controller = queryLiveIndexSupply(spec.signature, sql, (rows) => {
        for (const row of rows) {
          try {
            const log = indexSupplyRowToLog(row, contractName, eventName, i)
            debug(`Live event: ${log.name} block=${log.blockNumber}`)
            onLog(log)
          } catch (err) {
            debug(`Error processing live event for ${contractName}.${eventName}:`, err.message)
          }
        }
      }, { cursor })

      controllers.push(controller)
      debug(`Live stream started for ${contractName}.${eventName} from block ${startBlock}`)
    }
  }

  return controllers
}

// Re-export ethers for modules that still need it
export { ethers }
export let iface = ethers.Interface
