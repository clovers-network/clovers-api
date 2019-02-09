import r from 'rethinkdb'
import xss from 'xss'
import config from '../config.json'
import { handleEvent } from '../socketing'
import ethers from 'ethers'
import reversi from 'clovers-reversi'
import { parseLogForStorage } from './util'

import { provider, events, web3, web3mode } from '../lib/ethers-utils'

const tables = [
  {
    name: 'clovers',
    index: 'board',
    indexes: [
      [
        'owner',
        (doc) => {
          return doc('owner').downcase()
        }
      ],
      [
        'all',
        () => true
      ],
      [
        'market',
        (doc) => {
          return doc('price').ne('0')
        }
      ],
      [
        'rft',
        (doc) => {
          // curation market address
          return doc('owner').eq('0x9b8e917d6a511d4a22dcfa668a46b508ac26731e')
        }
      ]
    ]
  },
  {
    name: 'users',
    index: 'address'
  },
  {
    name: 'chats',
    index: 'id',
    indexes: [
      [
        'board',
        (doc) => {
          return doc('board').downcase()
        }
      ]
    ]
  },
  {
    name: 'logs',
    indexes: [
      'name',
      [
        'activity',
        (doc) => {
          return r.branch(
            // log.name is not in this list
            r.expr(['ClubToken_Transfer','CurationMarket_Transfer']).contains(doc('name')),
            'priv',
            r.branch(
              doc('name').ne('Clovers_Transfer'),
              'pub',
              r.branch(
                // not going to Clovers Contract
                doc('data')('_to').ne('0x8A0011ccb1850e18A9D2D4b15bd7F9E9E423c11b'),
                'pub',
                'priv'
              )
            )
          )
        }
      ]
    ]
  },
  {
    name: 'orders',
    index: 'id',
    indexes: ['market']
  }
]

let usernames = []
let clovernames = []
let db, io, running

export function build(_db) {
  db = _db
  rebuildDatabases()
}

export function mine(_db, _io) {
  if (!db) db = _db
  io = _io
  running = true
  io.on('mine', running => {
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

function rebuildDatabases() {
  // testEvent()

  console.log('rebuildDatabases')
  createDB()
    .then(createTables)
    .then(createIndexes)
    .then(populateLogs)
    .then(processLogs)
    .then(nameClovers)
    .then(nameUsers)
    .then(res => {
      console.log('done!')
      process.exit()
    })
    .catch(err => {
      console.log(err)
    })
}
//
// function testEvent() {
//   let tx = "0x634f90048c1cac22becfe5953a9e63f932a4eaf690d9156011ec85a7d1997de0";
//   let topics = [
//     "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
//     "0x0000000000000000000000000000000000000000000000000000000000000000",
//     "0x00000000000000000000000035b701e4550f0fcc45d854040562e35a4600e4ee"
//   ];
//   let address = "0x345ca3e014aaf5dca488057592ee47305d9b3e10";
//   if (web3mode) {
//     // console.log(events['Clovers'].instance)
//     // events['Clovers'].instance['Transfer']({x: null}, {
//     //   startBlock: 0,
//     //   endBlock: 'latest'
//     // }).get((error, result) => {
//     //   console.log(result)
//     // })
//     var filter = web3.eth.filter({
//       fromBlock: 0,
//       address: address.toLowerCase()
//     });
//     filter.get((err, result) => {
//       console.log(result);
//     });
//   } else {
//     console.log("not web3");
//     provider.getTransactionReceipt(tx).then(resp => {
//       console.log(resp);
//       resp.logs.map(log => {
//         let logInfo = {
//           address: address.toLowerCase(),
//           fromBlock: 1,
//           toBlock: 120
//         };
//         console.log(logInfo);
//         provider.send("eth_getLogs", logInfo).then(result => {
//           console.log("provider - eth_getLogs", result.length);
//         });
//         provider.getLogs(logInfo).then(logs => {
//           console.log("provider - getLogs", logs.length);
//         });
//         provider.getLogs(logInfo).then(logs => {
//           console.log("provider - getLogs", logs.length);
//         });
//       });
//     });
//   }
// }
function createDB() {
  console.log('createDB')
  return new Promise((resolve, reject) => {
    r.dbList().run(db, (err, res) => {
      if (err) return reject(err)
      if (res.findIndex(a => a === 'clovers_v2') > -1) {
        console.log('dbDrop clovers_v2')
        r.dbDrop('clovers_v2').run(db, (err, res) => {
          if (err) return reject(err)
          createDB().then(resolve)
        })
      } else {
        console.log('dbCreate clovers_v2')
        r.dbCreate('clovers_v2').run(db, (err, res) => {
          if (err) return reject(err)
          resolve()
        })
      }
    })
  })
}
function createTables(i = 0) {
  console.log('createTables')
  return new Promise((resolve, reject) => {
    if (i >= tables.length) {
      resolve()
    } else {
      let table = tables[i]
      console.log('tableCreate ' + table.name)
      r.db('clovers_v2')
        .tableCreate(table.name, { primaryKey: table.index })
        .run(db, (err, result) => {
          if (err) return reject(err)
          createTables(i + 1).then(() => {
            resolve()
          })
        })
    }
  })
}

// untested :)
async function createIndexes (i = 0) {
  if (i >= tables.length) {
    resolve()
  } else {
    let table = tables[i]
    if (!table.indexes) resolve()

    console.log('createIndexes', table.name)
    await asyncForEach(table.indexes, async (index) => {
      const func = index.constructor === Array ? index[1] : undefined
      const name = func ? index[0] : index
      await r.db('clovers_v2')
        .table(table.name)
        .indexCreate(index, func)
        .run(db)
      console.log('done', table.name)
    })

    createIndexes(i + 1)
  }
}

async function asyncForEach (array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array)
  }
}

let currBlock = null

async function populateLogs() {
  console.log('populateLogs')
  let blockNumber = await provider.getBlockNumber()
  currBlock = blockNumber
  console.log('Current block number: ' + blockNumber)
  await populateLog('Clovers')
  await populateLog('CloversController')
  await populateLog('ClubToken')
  await populateLog('ClubTokenController')
  await populateLog('CurationMarket')
  await populateLog('SimpleCloversMarket')
}

function populateLog(contract, key = 0) {
  return new Promise((resolve, reject) => {
    let eventTypes = events[contract].eventTypes
    if (key >= eventTypes.length) {
      resolve()
    } else {
      if (!eventTypes[key]) {
        console.log('dont watch this event' + eventTypes[key])
        return resolve()
      }
      console.log('populateLog - ' + contract + ' - ' + eventTypes[key])
      let address = events[contract].address
      let abi = events[contract].abi
      let iface = new ethers.Interface(abi)

      let eventType =
        events[contract].instance.interface.events[eventTypes[key]]
      let transferCoder = iface.events[eventTypes[key]]
      if (!eventType) {
        throw new Error('no ' + contract + ' - ' + eventTypes[key])
      }

      provider
        .getLogs({
          address: address.toLowerCase(),
          topics: eventType().topics,
          fromBlock: 0,
          fromBlock: config.genesisBlock,
          toBlock: 'latest'
        })
        .then((logs, err) => {
          if (err) return reject(err)

          console.log(eventType().name + ': ' + logs.length + ' logs')
          logs = logs.filter(log => {
            if (log.address.toLowerCase() !== address.toLowerCase()) {
              console.log(log.address)
              console.log('not my contract!!!!!')
              return false
            } else {
              return true
            }
          })
          logs = logs.map(l => {
            try {
              l.name = contract + '_' + eventType().name
              l.data = transferCoder.parse(l.topics, l.data)
              l.data = parseLogForStorage(l.data)
            } catch (err) {
              reject(err)
            }
            return l
          })
          return r
            .db('clovers_v2')
            .table('logs')
            .insert(logs)
            .run(db, (err, results) => {
              if (err) return reject(err)
              return populateLog(contract, key + 1)
                .then(resolve)
                .catch(reject)
            })
        })
        .catch(error => {
          console.log('error!!!')
          console.log(error)
        })
    }
  })
}

function processLogs() {
  console.log('processLogs')
  return new Promise((resolve, reject) => {
    r.db('clovers_v2')
      .table('logs')
      .orderBy(
        r.asc('blockNumber'),
        r.asc('transactionIndex'),
        r.asc('logIndex')
      )
      .run(db, (err, logs) => {
        if (err) return reject(err)
        processLog(logs)
          .then(() => {
            console.log('processLog resolved')
            resolve()
          })
          .catch(error => {
            console.log('processLog rejected')
            reject(error)
          })
      })
  })
}

function processLog(logs, i = 0) {
  console.log('processing log ' + i + '/' + logs.length)
  return new Promise((resolve, reject) => {
    if (i >= logs.length) {
      resolve()
    } else {
      let log = logs[i]
      handleEvent({ log, db })
        .then(() => {
          processLog(logs, i + 1)
            .then(resolve)
            .catch(reject)
        })
        .catch(reject)
    }
  })
}

function nameClovers() {
  console.log('nameClovers')
  return new Promise((resolve, reject) => {
    r.db('clovers')
      .table('logs')
      .filter({ name: 'newCloverName' })
      .orderBy('blockNumber')
      .run(db, (err, logs) => {
        if (err) return reject(err)
        console.log('newCloverName:', logs.length)
        if (!logs.length) resolve()
        logs.toArray((err, result) => {
          if (err) return reject(err)
          nameClover(result)
            .then(resolve)
            .catch(reject)
        })
      })
  })
}

function nameClover(logs, key = 0) {
  return new Promise((resolve, reject) => {
    if (logs.length === key) resolve()
    let log = logs[key]
    r.db('clovers_v2')
      .table('clovers')
      .get(log.data.board)
      .run(db, (err, clover) => {
        if (err) return reject(err)
        if (!clover) {
          console.log('clover ' + log.data.board + ' not found')
          // return reject(new Error('clover ' + log.data.board + ' not found'))
          nameClover(logs, key + 1)
            .then(resolve)
            .catch(reject)
        } else {
          clover.name = xss(log.data.name)
          r.db('clovers_v2')
            .table('clovers')
            .get(log.data.board)
            .update(clover)
            .run(db, (err, result) => {
              if (err) return reject(err)
              nameClover(logs, key + 1)
                .then(resolve)
                .catch(reject)
            })
        }
      })
  })
}

function nameUsers() {
  console.log('nameUsers')
  return new Promise((resolve, reject) => {
    r.db('clovers')
      .table('logs')
      .filter({ name: 'newUserName' })
      .orderBy('blockNumber')
      .run(db, (err, logs) => {
        if (err) return reject(err)
        logs.toArray((err, result) => {
          if (err) return reject(err)
          nameUser(result)
            .then(resolve)
            .catch(reject)
        })
      })
  })
}

function nameUser(logs, key = 0) {
  return new Promise((resolve, reject) => {
    if (logs.length === key) resolve()
    let log = logs[key]
    r.db('clovers_v2')
      .table('users')
      .get(log.data.player)
      .run(db, (err, user) => {
        if (err) return reject(err)
        if (!user) {
          console.log('user ' + log.data.player + ' not found')
          // return reject(new Error('user ' + log.data.player + ' not found'))
          nameUser(logs, key + 1)
            .then(resolve)
            .catch(reject)
        } else {
          user.name = xss(log.data.name)
          r.db('clovers_v2')
            .table('users')
            .get(log.data.player)
            .update(user)
            .run(db, (err, result) => {
              if (err) return reject(err)
              nameUser(logs, key + 1)
                .then(resolve)
                .catch(reject)
            })
        }
      })
  })
}
