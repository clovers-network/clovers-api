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

export const EVENT_SIGNATURES = {
  Clovers: {
    Transfer: 'Transfer(address indexed from, address indexed to, uint256 tokenId)'
  },
  ClubToken: {
    Transfer: 'Transfer(address indexed from, address indexed to, uint256 value)'
  },
  SimpleCloversMarket: {
    updatePrice: 'updatePrice(uint256 _tokenId, uint256 price)'
  },
  ClubTokenController: {
    Buy: 'Buy(address buyer, uint256 tokens, uint256 value, uint256 poolBalance, uint256 tokenSupply)',
    Sell: 'Sell(address seller, uint256 tokens, uint256 value, uint256 poolBalance, uint256 tokenSupply)'
  },
  CloversController: {}
}

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

function buildQueryParams (signatures, sql, chain = 1) {
  const params = new URLSearchParams()
  params.set('chain', chain)

  // signatures can be a single string or array
  const sigs = Array.isArray(signatures) ? signatures : [signatures]
  sigs.forEach(s => params.append('signatures', s))

  params.set('query', sql)

  if (INDEXSUPPLY_API_KEY) {
    params.set('api_key', INDEXSUPPLY_API_KEY)
  }

  return params
}

/**
 * Execute a query against IndexSupply /v2/query endpoint.
 * Returns an array of row objects.
 */
export async function queryIndexSupply (signatures, sql, chain = 1) {
  const params = buildQueryParams(signatures, sql, chain)
  const url = `${INDEXSUPPLY_BASE}/v2/query?${params.toString()}`

  debug('IndexSupply query:', sql.substring(0, 120))

  const response = await fetch(url, {
    headers: { 'Accept': 'application/json' }
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`IndexSupply query failed (${response.status}): ${text}`)
  }

  const data = await response.json()

  // IndexSupply returns { result: [{ columns: [...], data: [[...], ...] }] }
  if (!data.result || !data.result.length) {
    return []
  }

  const result = data.result[0]
  const columns = result.columns || []
  const rows = result.data || []

  return rows.map(row => {
    const obj = {}
    columns.forEach((col, i) => {
      obj[col] = row[i]
    })
    return obj
  })
}

/**
 * Open an SSE stream via IndexSupply /v2/query-live endpoint.
 * Calls `onEvent(rows)` for each batch of new events.
 * Returns an abort controller to stop the stream.
 */
export function queryLiveIndexSupply (signatures, sql, onEvent, chain = 1) {
  const params = buildQueryParams(signatures, sql, chain)
  const url = `${INDEXSUPPLY_BASE}/v2/query-live?${params.toString()}`

  const abortController = new AbortController()

  debug('IndexSupply live query starting:', sql.substring(0, 120))

  ;(async () => {
    try {
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

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Parse SSE events from buffer
        const parts = buffer.split('\n\n')
        buffer = parts.pop() // keep incomplete part

        for (const part of parts) {
          const dataLines = part
            .split('\n')
            .filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).trim())

          if (dataLines.length === 0) continue

          try {
            const data = JSON.parse(dataLines.join(''))
            if (data.result && data.result.length) {
              const result = data.result[0]
              const columns = result.columns || []
              const rows = (result.data || []).map(row => {
                const obj = {}
                columns.forEach((col, i) => {
                  obj[col] = row[i]
                })
                return obj
              })
              if (rows.length > 0) {
                onEvent(rows)
              }
            }
          } catch (e) {
            debug('SSE parse error:', e.message)
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        debug('IndexSupply live query error:', err.message)
        // Reconnect after delay
        setTimeout(() => {
          if (!abortController.signal.aborted) {
            debug('Reconnecting live query...')
            queryLiveIndexSupply(signatures, sql, onEvent, chain)
          }
        }, 5000)
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

  const address = CONTRACT_ADDRESSES[contractName]
  const allLogs = []

  for (let i = 0; i < eventTypes.length; i++) {
    const eventName = eventTypes[i]
    const sig = EVENT_SIGNATURES[contractName][eventName]
    if (!sig) {
      debug(`No signature for ${contractName}.${eventName}, skipping`)
      continue
    }

    // Table name is the lowercase event name in IndexSupply
    const tableName = eventName.toLowerCase()

    // Build SQL to fetch events filtered by contract address and block range
    const sql = `
      SELECT ${tableName}.*, logs.block_num, logs.tx_hash, logs.log_addr, logs.log_idx, logs.tx_idx
      FROM ${tableName}
      INNER JOIN logs ON ${tableName}.log_idx = logs.log_idx
        AND ${tableName}.block_num = logs.block_num
        AND ${tableName}.tx_hash = logs.tx_hash
      WHERE logs.log_addr = '${address}'
        AND logs.block_num >= ${fromBlock}
        ${toBlock ? `AND logs.block_num <= ${toBlock}` : ''}
      ORDER BY logs.block_num ASC, logs.log_idx ASC
    `.trim()

    try {
      const rows = await queryIndexSupply(sig, sql)
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

  return {
    blockNumber: Number(row.block_num),
    transactionHash: row.tx_hash,
    transactionIndex: Number(row.tx_idx || 0),
    logIndex: Number(row.log_idx || 0),
    address: (row.log_addr || CONTRACT_ADDRESSES[contractName]).toLowerCase(),
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
        'tokenid': '_tokenId',
        'tokenId': '_tokenId'
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
        '_tokenId': '_tokenId',
        'tokenid': '_tokenId',
        'tokenId': '_tokenId',
        'price': 'price'
      }
    },
    ClubTokenController: {
      Buy: {
        'buyer': 'buyer',
        'tokens': 'tokens',
        'value': 'value',
        'poolbalance': 'poolBalance',
        'poolBalance': 'poolBalance',
        'tokensupply': 'tokenSupply',
        'tokenSupply': 'tokenSupply'
      },
      Sell: {
        'seller': 'seller',
        'tokens': 'tokens',
        'value': 'value',
        'poolbalance': 'poolBalance',
        'poolBalance': 'poolBalance',
        'tokensupply': 'tokenSupply',
        'tokenSupply': 'tokenSupply'
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
 * Calls onLog(log) for each new event, in the standard log format.
 * Returns an array of AbortControllers (one per stream).
 */
export function startLiveStreams (onLog) {
  const controllers = []
  const contractNames = ['Clovers', 'ClubToken', 'SimpleCloversMarket', 'ClubTokenController']

  for (const contractName of contractNames) {
    const eventTypes = events[contractName].eventTypes
    const address = CONTRACT_ADDRESSES[contractName]

    for (let i = 0; i < eventTypes.length; i++) {
      const eventName = eventTypes[i]
      const sig = EVENT_SIGNATURES[contractName][eventName]
      if (!sig) continue

      const tableName = eventName.toLowerCase()

      const sql = `
        SELECT ${tableName}.*, logs.block_num, logs.tx_hash, logs.log_addr, logs.log_idx, logs.tx_idx
        FROM ${tableName}
        INNER JOIN logs ON ${tableName}.log_idx = logs.log_idx
          AND ${tableName}.block_num = logs.block_num
          AND ${tableName}.tx_hash = logs.tx_hash
        WHERE logs.log_addr = '${address}'
        ORDER BY logs.block_num DESC
        LIMIT 1
      `.trim()

      const controller = queryLiveIndexSupply(sig, sql, (rows) => {
        for (const row of rows) {
          try {
            const log = indexSupplyRowToLog(row, contractName, eventName, i)
            debug(`Live event: ${log.name} block=${log.blockNumber}`)
            onLog(log)
          } catch (err) {
            debug(`Error processing live event for ${contractName}.${eventName}:`, err.message)
          }
        }
      })

      controllers.push(controller)
      debug(`Live stream started for ${contractName}.${eventName}`)
    }
  }

  return controllers
}

// Re-export ethers for modules that still need it
export { ethers }
export let iface = ethers.Interface
