import fs from 'fs'
import path from 'path'
import config from '../config.json'
import { handleEvent } from '../socketing'
import reversi from 'clovers-reversi'
import { parseLogForStorage } from './util'
import { provider, events, fetchHistoricalEvents } from './chain'
import { checkUserBalance } from '../models/clubToken'
import { getStore, initStore, closeStore, getDbPath, defaultDbPath } from './store'

const debug = require('debug')('app:build')

let db, io, running, syncing

/**
 * Where the pre-rebuild snapshot lives.
 *
 * RethinkDB's rebuild renamed the live database aside, built a fresh one, and
 * copied the human-authored rows back out of a `sync` database. SQLite has no
 * server to hold two databases, but it does have ATTACH -- so the snapshot is
 * a second file and the copy-back queries are unchanged in shape.
 *
 * `build` sets this when it renames the live file. The `logs` and `users`
 * commands run against an already-live database and need to be told where the
 * snapshot is; SYNC_DB_PATH is that.
 */
let syncDbPath = process.env.SYNC_DB_PATH || null

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

/*
 * NOTE: this function cannot run. It uses Web Worker globals (`self`,
 * `postMessage`) that do not exist in Node, reads `hashRate` and `data` which
 * are never declared in scope, and recurses into `mine()` with no arguments.
 * Invoking `node dist/index.js mine` throws immediately. It looks like it was
 * pasted from a browser worker and never adapted.
 *
 * Left in place rather than deleted because `mine` is still wired into
 * src/index.js -- removing it is a product decision, not a lint fix. The lint
 * suppression below is scoped to this function only.
 */
/* eslint-disable no-undef, no-inner-declarations */
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
/* eslint-enable no-undef, no-inner-declarations */

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

// ---------------------------------------------------------------------------
// Rebuild helpers -- none of these are reachable.
//
// `build` calls rebuildDatabases(), which calls processLogs() and nothing else.
// createDB/createTables/createIndexes/copySyncData and the four copy-back steps
// (moveChats, moveAlbums, nameClovers, nameUsers) have no callers anywhere in
// the tree; an earlier version of rebuildDatabases must have chained them. So
// `build` today replays logs into whatever database is already there rather
// than recreating one.
//
// They are ported rather than deleted because they are the only written record
// of what a full rebuild is supposed to do, and wiring them up would make
// `build` destructive -- a product decision, not a migration one. Anyone
// restoring the rebuild should read the note on nameClovers first.
// ---------------------------------------------------------------------------

/**
 * Move the live database aside and open a fresh one.
 *
 * The three RethinkDB steps -- rename the database, create the tables, create
 * the 74 secondary indexes -- collapse into "apply schema.sql to a new file",
 * because the schema and its 30 partial indexes are one declarative artifact
 * rather than something built imperatively at startup. That also removes the
 * drift risk the old code had: db-tables.js was the only definition of the
 * indexes, and it was only ever executed on a full rebuild.
 *
 * The renamed file is not deleted. It is the snapshot the copy-back steps read
 * from, and it is the only way back if a rebuild goes wrong.
 */
function createFreshDatabase () {
  const live = getDbPath() || defaultDbPath()

  // The store holds an open handle; renaming the file under it would leave
  // every later read pointing at the snapshot.
  closeStore()

  if (fs.existsSync(live)) {
    syncDbPath = `${live}.${new Date().getTime()}`
    debug(`moving ${live} aside to ${syncDbPath}`)
    fs.renameSync(live, syncDbPath)
    // WAL and shared-memory sidecars belong to the file that was moved.
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(live + ext)) fs.renameSync(live + ext, syncDbPath + ext)
    }
  } else {
    debug(`no existing database at ${live}`)
  }

  debug(`creating ${live}`)
  const store = initStore(live)
  store.raw.exec(fs.readFileSync(schemaPath(), 'utf8'))
  return store
}

function schemaPath () {
  // dist/lib/build.js -> the repo's migration/sqlite/schema.sql
  return path.join(__dirname, '..', '..', 'migration', 'sqlite', 'schema.sql')
}

/** The snapshot to copy human-authored rows back from, or null if there is none. */
function snapshot () {
  if (!syncDbPath) {
    debug('no snapshot to copy from (set SYNC_DB_PATH to name one)')
    return null
  }
  if (!fs.existsSync(syncDbPath)) {
    debug(`snapshot ${syncDbPath} does not exist`)
    return null
  }
  return syncDbPath
}

async function asyncForEach (array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array)
  }
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

          // Deduplicate against existing logs. insertLogs does the same
          // (transactionHash, logIndex) check the loop here used to do, in one
          // transaction, and against a column pair that is actually UNIQUE.
          const { inserted, skipped } = getStore().insertLogs(logs)
          if (inserted) {
            debug(`New logs for ${contract}: ${inserted}`)
          } else {
            debug(`No new logs for ${contract} in this range (${skipped} already stored)`)
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

  const genesisBlock = config.genesisBlock[config.network.chainId]
  // No arrayLimit to raise here: SQLite has no cap on how many rows a query
  // may return, which is what forced { arrayLimit: 200000 } before.
  const logs = getStore().logsFromBlock(genesisBlock)
  debug('got', logs.length, 'logs')
  return processLog(logs)
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
    const from = snapshot()
    if (!from) return
    debug('move Chats')
    getStore().withAttached(from, (raw) => {
      raw.exec('INSERT OR IGNORE INTO chats SELECT * FROM sync.chats')
    })
  } catch (err) {
    debug('move chats error')
    debug(err)
  }
}

async function moveAlbums () {
  if (syncing) return

  try {
    const from = snapshot()
    if (!from) return
    debug('move Albums')
    // Column list is explicit because `cloverCount` is a generated column here
    // and cannot be written; SELECT * would try.
    getStore().withAttached(from, (raw) => {
      raw.exec(`INSERT OR IGNORE INTO albums (id, name, userAddress, created, modified, clovers)
                SELECT id, name, userAddress, created, modified, clovers FROM sync.albums`)
    })
  } catch (err) {
    debug('move albums error')
    debug(err)
  }
}

async function nameClovers () {
  if (syncing) return

  try {
    const from = snapshot()
    if (!from) return
    debug('rename Clovers')
    // The original built this query and never called .run() -- the only one of
    // the four copy-back steps missing it, so even if the rebuild had been
    // wired up, clover names would have been dropped. Written to actually run
    // here, since restoring names is the entire point of the step.
    getStore().withAttached(from, (raw) => {
      raw.exec(`UPDATE clovers SET
                  name = (SELECT s.name FROM sync.clovers s WHERE s.board = clovers.board),
                  modified = (SELECT s.modified FROM sync.clovers s WHERE s.board = clovers.board)
                WHERE EXISTS (SELECT 1 FROM sync.clovers s WHERE s.board = clovers.board)`)
    })
  } catch (err) {
    debug('rename clovers error')
    debug(err)
  }
}

async function nameUsers () {
  if (syncing) return

  try {
    const from = snapshot()
    if (!from) return
    debug('name Users')
    getStore().withAttached(from, (raw) => {
      raw.exec(`UPDATE users SET
                  name = (SELECT s.name FROM sync.users s WHERE s.address = users.address)
                WHERE EXISTS (SELECT 1 FROM sync.users s WHERE s.address = users.address)`)
    })
  } catch (err) {
    debug('name users error')
    debug(err)
  }
}

async function restoreLogs () {
  if (syncing) return

  try {
    const from = snapshot()
    if (!from) return
    debug('insert missing logs')
    // OR IGNORE rather than a plain insert: (transactionHash, logIndex) is
    // UNIQUE now, so re-running this is idempotent instead of duplicating
    // every row it touches.
    getStore().withAttached(from, (raw) => {
      raw.exec('INSERT OR IGNORE INTO logs SELECT * FROM sync.logs')
    })
    debug('done!')
    process.exit()
  } catch (err) {
    debug('add logs error')
    debug(err)
  }
}

async function syncUsers () {
  if (syncing) return

  const users = getStore().allUserAddresses()

  for (const address of users) {
    debug('sync', address)

    try {
      const u = await checkUserBalance(address, db)
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
