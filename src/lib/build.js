import r from 'rethinkdb'
import config from '../config.json'
import { handleEvent } from '../socketing'
import reversi from 'clovers-reversi'
import { parseLogForStorage } from './util'
import { provider, events } from '../lib/ethers-utils'
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
  // createDB()
  // .then(createTables)
  // .then(createIndexes)
  // copySyncData()
  // .then(populateLogs)
  // .then(processLogs)
  processLogs()
  // .then(nameClovers)
  // .then(nameUsers)
  // .then(moveChats)
  // .then(moveAlbums)
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
  // .then(processLogs)
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
        // r.dbDrop(dbName).run(db, (err, res) => {
        //   if (err) return reject(err)
        //   createDB().then(resolve)
        // })
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

let currBlock = null
let fromBlock = null
let maxBlock = null

async function populateLogs (block) {
  debug('populateLogs')
  let blockNumber = await provider.getBlockNumber()
  currBlock = blockNumber
  fromBlock = block || config.genesisBlock[config.network.chainId]
  maxBlock = fromBlock + 10000

  debug('Current block number: ' + blockNumber)
  await populateLog('Clovers')
  // await populateLog('CloversController') // dont actually watch for any events here
  await populateLog('ClubToken')
  await populateLog('ClubTokenController')
  await populateLog('SimpleCloversMarket')

  if (maxBlock < currBlock) {
    debug('getting more logs from', maxBlock + 1)
    try {
      return populateLogs(maxBlock + 1)
    } catch (err) {
      debug(err)
      return populateLogs(fromBlock)
    }
  }
}

async function testLogs ({ address, topics, genesisBlock }) {
  debug('testLogs', genesisBlock, maxBlock)
  await sleep(1000)
  const logs = await provider.getLogs({
    address,
    topics,
    fromBlock: genesisBlock,
    toBlock: maxBlock
  }).catch(async (err) => {
    // console.error(err.responseText)
    debug('testLogs err', err.responseText)
    await sleep(30000)
    return testLogs({ address, topics, genesisBlock })
  })
  return logs
}

export async function getLogs({address, topics, genesisBlock, latest, limit, offset, previousLogs}){
  return new Promise((resolve, reject) => {
    debug({ genesisBlock })
    var fromBlock = genesisBlock + limit * offset
    var toBlock = genesisBlock + limit * (offset + 1)

    if (genesisBlock !== latest && toBlock > latest) {
      toBlock = 'latest'
    }
    debug({fromBlock, toBlock})
    provider
    .getLogs({
      address,
      topics,
      fromBlock,
      toBlock
    }).then((logs, err) => {
      debug({logs: logs.length})

      if (err) {
        reject(err)
      } else {
        if (logs.length > 0) {
          debug(`concat ${previousLogs.length} previous logs with ${logs.length} new logs`)
          previousLogs = previousLogs.concat(logs)
        }
        if (toBlock === 'latest' || genesisBlock === latest) {
          resolve(previousLogs)
        } else {
          getLogs({address, topics, genesisBlock, latest, limit, offset: offset + 1, previousLogs}).then(resolve)
        }
      }
    }).catch(reject)
  })
}

let logsInserted = 0

function populateLog (contract, key = 0) {
  return new Promise(async (resolve, reject) => {
    let eventTypes = events[contract].eventTypes
    if (key >= eventTypes.length) {
      resolve()
    } else {
      try {
        if (!eventTypes[key]) {
          debug('dont watch this event' + eventTypes[key])
          return resolve()
        }
        debug('populateLog - ' + contract + ' - ' + eventTypes[key])
        let address = events[contract].address.toLowerCase()
        // let abi = events[contract].abi
        // let iface = new ethers.Interface(abi)

        let eventType =
          events[contract].instance.interface.events[eventTypes[key]]
        // let transferCoder = iface.events[eventTypes[key]]
        if (!eventType) {
          throw new Error('no ' + contract + ' - ' + eventTypes[key])
        }

        const topics = [eventType.topic]
        const genesisBlock = fromBlock

        debug('getting logs from', genesisBlock)
        let logs = await testLogs({
          address,
          topics,
          genesisBlock
        })
        debug('logs.length', logs.length)

        debug(eventType.name + ': ' + logs.length + ' logs')

        logs = logs.filter(log => {
          if (log.address.toLowerCase() !== address.toLowerCase()) {
            debug(log.address)
            debug('not my contract!!!!!')
            return false
          } else {
            return true
          }
        })

        logs = logs.map(l => transformLog(l, contract, key))

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
          debug('New logs:', newOnes.length)
          logsInserted += newOnes.length
        } else {
          debug(`No new logs for "${eventType.name}"`)
        }

        return r.table('logs')
          .insert(newOnes, { returnChanges: true, conflict: 'update' })
          .run(db, (err, results) => {
            if (err) return reject(err)
            return populateLog(contract, key + 1)
              .then(resolve)
              .catch(reject)
          })
      } catch(error) {
        debug('error!!!')
        debug(error)
      }
    }
  })
}

export function transformLog (_l, contract, key) {
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
  // if (logsInserted === 0) {
  //   return Promise.resolve()
  // }

  return new Promise((resolve, reject) => {
    const genesisBlock = config.genesisBlock[config.network.chainId]
    r.table('logs')
      .between(genesisBlock, r.maxval, { index: 'blockNumber' })
      // .between(genesisBlock, genesisBlock + 10000, { index: 'blockNumber' })
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
              return proccessLog(logs, i, db, skipOracle)
            })
        })
        .catch(async (err) => {
          debug('handleEvent err')
          debug(err.responseText)
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

async function moveChats () {
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
      // probably a infura rate limit?
      await sleep(5000)
    }
  }
}

function sleep (ms = 1000) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
