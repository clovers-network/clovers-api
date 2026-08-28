import r from 'rethinkdb'
import config from '../config.json'
import { handleEvent } from '../socketing'
import reversi from 'clovers-reversi'
import { parseLogForStorage } from './util'
import { provider, events, fetchHistoricalEvents } from './indexsupply'
import tables from './db-tables'
import { checkUserBalance } from '../models/clubToken'

const debug = require('debug')('app:build')

const CLOVER_DB = `clovers_chain_${config.network.chainId}`

let db, io, running, syncing

export function build (_db) {
  db = _db
  rebuildDatabases()
}

export function syncChain (_db) {
  db = _db
  syncing = true
  syncLogs()
}

export function copyLogs (_db) {
  db = _db
  restoreLogs()
}

export function syncBalances (_db) {
  db = _db
  syncUsers()
}

export function mine (_db, _io) {
  if (!db) db = _db
  io = _io
  running = true
  io.on('mine', data => {
    running = data
  })
  if (running) {
    running = true
    run()
    function run() {
      reversi.mine()
      if (reversi.symmetrical) {
        self.postMessage(reversi)
      }
      if (running) {
        setTimeout(() => {
          mine()
        }, 0)
      }
    }
    setInterval(() => {
      self.postMessage({ hashRate })
      hashRate = 0
    }, 1000)
  } else if (data === 'stop') {
    running = false
    self.close()
  } else {
    self.close()
  }
}

function rebuildDatabases () {
  debug('rebuildDatabases')
  processLogs()
  .then(() => {
    debug('done!')
    process.exit()
  })
  .catch(err => {
    debug(err)
  })
}

function syncLogs () {
  debug('syncing logs')
  populateLogs(config.genesisBlock[config.network.chainId])
  .then(processLogs)
  .then(() => {
    debug('done sync...')
    process.exit()
  })
  .catch(err => {
    debug(err)
  })
}

let newDBName = null

function createDB () {
  debug('createDB')
  return new Promise((resolve, reject) => {
    r.dbList().run(db, (err, res) => {
      if (err) return reject(err)
      if (res.findIndex(a => a === CLOVER_DB) > -1) {
        debug(`rename ${CLOVER_DB}`)
        newDBName = `${CLOVER_DB}_${new Date().getTime()}`
        r.db(CLOVER_DB).config().update({
          name: newDBName
        }).run(db, (err) => {
          if (err) return reject(err)
          createDB().then(resolve)
        })
      } else {
        debug(`dbCreate ${CLOVER_DB}`)
        r.dbCreate(CLOVER_DB).run(db, (err, res) => {
          if (err) return reject(err)
          resolve()
        })
      }
    })
  })
}

function createTables (i = 0) {
  debug('createTables')
  return new Promise((resolve, reject) => {
    if (i >= tables.length) {
      resolve()
    } else {
      let table = tables[i]
      debug('tableCreate ' + table.name)
      r.tableCreate(table.name, { primaryKey: table.index })
        .run(db, (err, result) => {
          if (err) return reject(err)
          createTables(i + 1).then(() => {
            resolve()
          })
        })
    }
  })
}

async function createIndexes (i = 0) {
  debug(`create index #${i}`)
  if (i >= tables.length) {
    return
  } else {
    let table = tables[i]
    if (!table.indexes) {
      debug(`table ${table.name} has no indexes`)
    } else {
      debug('createIndexes', table.name)
      await asyncForEach(table.indexes, async (index) => {
        const func = index.constructor === Array ? index[1] : undefined
        const name = func ? index[0] : index
        await r.table(table.name)
          .indexCreate(name, func)
          .run(db)
        debug('done', table.name)
      })
    }
    await createIndexes(i + 1)
  }
}

async function asyncForEach (array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array)
  }
}

async function copySyncData () {
  const sb = 'sync'
  await r.dbCreate(sb).run(db)
  await r.db(sb).tableCreate('logs').run(db)
  await r.db(sb).tableCreate('chats').run(db)
  await r.db(sb).tableCreate('users', { primaryKey: 'address' }).run(db)
  await r.db(sb).tableCreate('albums').run(db)
  await r.db(sb).tableCreate('clovers', { primaryKey: 'board' }).run(db)

  // do copy
  await r.db(sb).table('logs').insert(r.db(newDBName).table('logs')).run(db)
  await r.db(sb).table('chats').insert(r.db(CLOVER_DB).table('chats')).run(db)
  await r.db(sb).table('users').insert(r.db(CLOVER_DB).table('users')).run(db)
  await r.db(sb).table('albums').insert(r.db(CLOVER_DB).table('albums')).run(db)
  await r.db(sb).table('clovers').insert(r.db(CLOVER_DB).table('clovers')).run(db)

  debug('did the copying')
  return
}

// Block range size for IndexSupply queries
const BLOCK_BATCH_SIZE = 50000
const MAX_RANGE_RETRIES = 5

/**
 * Populate logs using IndexSupply instead of direct RPC getLogs.
 * Fetches historical events in batches by block range.
 */
async function populateLogs (block) {
  debug('populateLogs via IndexSupply')

  let blockNumber
  try {
    blockNumber = await provider.getBlockNumber()
  } catch (err) {
    debug('Could not get current block number from RPC, using fallback')
    blockNumber = 21000000 // reasonable fallback for mainnet
  }

  const fromBlock = block || config.genesisBlock[config.network.chainId]
  debug('Current block number: ' + blockNumber)
  debug('Fetching from block: ' + fromBlock)

  const contracts = ['Clovers', 'ClubToken', 'ClubTokenController', 'SimpleCloversMarket']

  // Process in block range batches
  let currentFrom = fromBlock
  while (currentFrom <= blockNumber) {
    const currentTo = Math.min(currentFrom + BLOCK_BATCH_SIZE - 1, blockNumber)
    debug(`Fetching events for blocks ${currentFrom} to ${currentTo}`)

    for (const contract of contracts) {
      // Retry the range rather than moving on: silently skipping a failed
      // range loses those events permanently, since currentFrom advances
      // whether or not the fetch succeeded.
      for (let attempt = 0; ; attempt++) {
        try {
          const logs = await fetchHistoricalEvents(contract, currentFrom, currentTo)
          debug(`${contract}: ${logs.length} events in range`)

          if (logs.length === 0) break

          // Deduplicate against existing logs
          const newOnes = []
          for (const log of logs) {
            const existing = await new Promise((resolve, reject) => {
              r.table('logs')
                .getAll([log.transactionHash, log.logIndex], { index: 'unique_log' })
                .coerceTo('array')
                .run(db, (err, res) => {
                  if (err) reject(err)
                  resolve(res[0])
                })
            })

            if (!existing) {
              newOnes.push(log)
            }
          }

          if (newOnes.length) {
            debug(`New logs for ${contract}: ${newOnes.length}`)
            await new Promise((resolve, reject) => {
              r.table('logs')
                .insert(newOnes, { returnChanges: true, conflict: 'update' })
                .run(db, (err, results) => {
                  if (err) return reject(err)
                  resolve(results)
                })
            })
          } else {
            debug(`No new logs for ${contract} in this range`)
          }
          break
        } catch (err) {
          debug(`Error fetching ${contract} events (attempt ${attempt + 1}):`, err.message)
          if (attempt >= MAX_RANGE_RETRIES) {
            throw new Error(
              `Giving up on ${contract} blocks ${currentFrom}-${currentTo}: ${err.message}`
            )
          }
          await sleep(Math.min(60000, 5000 * Math.pow(2, attempt)))
        }
      }
    }

    currentFrom = currentTo + 1
  }
}

/**
 * Legacy getLogs function - now wraps IndexSupply queries.
 * Kept for backward compatibility with doSyncContract in clovers.js.
 */
export async function getLogs({ address, topics, genesisBlock, latest, limit, offset, previousLogs }) {
  debug('getLogs via IndexSupply (legacy compat)')

  // Determine which contract this is for
  let contractName = null
  for (const [name, info] of Object.entries(events)) {
    if (info.address.toLowerCase() === address.toLowerCase()) {
      contractName = name
      break
    }
  }

  if (!contractName) {
    debug('Unknown contract address:', address)
    return previousLogs || []
  }

  const fromBlock = genesisBlock + (limit * offset)
  const toBlock = latest === genesisBlock ? genesisBlock + limit : (genesisBlock + limit * (offset + 1) > latest ? null : genesisBlock + limit * (offset + 1))

  try {
    const logs = await fetchHistoricalEvents(contractName, fromBlock, toBlock)

    // Convert to a format compatible with the old transformLog
    // These logs are already in the right format from fetchHistoricalEvents
    const combinedLogs = (previousLogs || []).concat(logs.map(log => ({
      ...log,
      // Add raw log fields for compatibility with old transformLog
      data: log.data,
      topics: topics
    })))

    return combinedLogs
  } catch (err) {
    debug('getLogs error:', err.message)
    return previousLogs || []
  }
}

let logsInserted = 0

/**
 * transformLog - kept for backward compatibility.
 * With IndexSupply, logs come pre-transformed from indexSupplyRowToLog.
 * This function handles the legacy case where raw ethers logs need decoding.
 */
export function transformLog (_l, contract, key) {
  // If the log already has a 'name' field, it's already transformed (from IndexSupply)
  if (_l.name && _l.name.includes('_')) {
    return _l
  }

  // Legacy path: decode raw ethers log
  let address = events[contract].address.toLowerCase()

  if (_l.address.toLowerCase() !== address.toLowerCase()) {
    debug({_l})
    throw new Error('Why did I get a log from another address?')
  }

  let eventTypes = events[contract].eventTypes
  let abi = events[contract].abi
  let iface = events[contract].instance.interface
  let transferCoder = iface.events[eventTypes[key]]
  let eventType = iface.events[eventTypes[key]]
  const userKeys = ['_to', '_from', 'owner', 'buyer', 'seller']
  let l = JSON.parse(JSON.stringify(_l))
  try {
    let userAddresses = []
    l.name = contract + '_' + eventType.name
    l.data = (transferCoder.decode(l.data, l.topics))
    l.data = parseLogForStorage(l.data)

    for (let k of Object.keys(l.data)) {
      if (userKeys.includes(k)) {
        userAddresses.push({id: k, address: l.data[k].toLowerCase()})
      }
    }
    l.userAddresses = userAddresses
  } catch (err) {
    debug(err)
  }
  return l
}

function processLogs () {
  debug('processLogs')

  return new Promise((resolve, reject) => {
    const genesisBlock = config.genesisBlock[config.network.chainId]
    r.table('logs')
      .between(genesisBlock, r.maxval, { index: 'blockNumber' })
      .orderBy({ index: 'blockNumber' })
      .coerceTo('array')
      .run(db, { arrayLimit: 200000 }, (err, logs) => {
        if (logs) {
          debug('got', logs.length, 'logs')
        }
        if (err) return reject(err)
        processLog(logs)
          .then(() => {
            debug('processLog resolved')
            resolve()
          })
          .catch((err) => {
            debug('processLog rejected')
            debug(err)
            reject(err)
          })
      })
  })
}

export function processLog (logs, i = 0, _db, skipOracle = false) {
  if (_db) {
    db = _db
  }
  debug('processing log ' + i + '/' + logs.length)
  return new Promise((resolve, reject) => {
    if (i >= logs.length) {
      resolve()
    } else {
      let log = logs[i]
      debug('process Log', [log.transactionHash, log.logIndex])
      debug(`blockNumber ${log.blockNumber}`)
      handleEvent({ log, db }, skipOracle)
        .then(() => {
          processLog(logs, i + 1, db, skipOracle)
            .then(resolve)
            .catch((err) => {
              debug('processLog err')
              debug(err)
              return processLog(logs, i, db, skipOracle)
            })
        })
        .catch(async (err) => {
          debug('handleEvent err')
          debug(err.responseText || err.message)
          await sleep(1500)
          return processLog(logs, i, _db, skipOracle)
        })
    }
  })
}

async function moveChats () {
  if (syncing) return

  try {
    debug('move Chats')
    await r.db(CLOVER_DB).table('chats').insert(
      r.db('sync').table('chats')
    ).run(db)
  } catch (err) {
    debug('move chats error')
    debug(err)
  }
}

async function moveAlbums () {
  if (syncing) return

  try {
    debug('move Albums')
    await r.db(CLOVER_DB).table('albums').insert(
      r.db('sync').table('albums')
    ).run(db)
  } catch (err) {
    debug('move albums error')
    debug(err)
  }
}

async function nameClovers () {
  if (syncing) return

  try {
    debug('rename Clovers')
    await r.db('sync').table('clovers').pluck('board', 'name', 'modified').forEach((row) => {
      return r.db(CLOVER_DB).table('clovers').get(row('board')).update({
        name: row('name'),
        modified: row('modified')
      })
    })
  } catch (err) {
    debug('rename clovers error')
    debug(err)
  }
}

async function nameUsers () {
  if (syncing) return

  try {
    debug('name Users')
    await r.db('sync').table('users').pluck('address', 'name').forEach((row) => {
      return r.db(CLOVER_DB).table('users').get(row('address')).update({ name: row('name') })
    }).run(db)
  } catch (err) {
    debug('name users error')
    debug(err)
  }
}

async function restoreLogs () {
  if (syncing) return

  try {
    debug('insert missing logs')
    await r.db('sync').table('logs').forEach((log) => {
      return r.db(CLOVER_DB).table('logs').insert(log)
    }).run(db)
    debug('done!')
    process.exit()
  } catch (err) {
    debug('add logs error')
    debug(err)
  }
}

async function syncUsers () {
  if (syncing) return

  const users = await r.db(CLOVER_DB).table('users').pluck('address')
    .coerceTo('array').run(db)

  for await (const user of users) {
    debug('sync', user.address)

    try {
      const u = await checkUserBalance(user.address, db)
      debug('done. balance is', u.balance)
    } catch (err) {
      debug(err)
      // probably a rate limit
      await sleep(5000)
    }
  }
}

function sleep (ms = 1000) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
