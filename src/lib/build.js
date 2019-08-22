import r from 'rethinkdb'
import xss from 'xss'
import config from '../config.json'
import { handleEvent } from '../socketing'
import ethers from 'ethers'
import reversi from 'clovers-reversi'
import { parseLogForStorage } from './util'
import uuid from 'uuid/v4'
import { provider, events, web3, web3mode } from '../lib/ethers-utils'
const tables = [
  {
    name: 'clovers',
    index: 'board',
    indexes: [
      [
        'all-modified',
        [
          true,
          r.row('modified')
        ]
      ],
      [
        'all-price',
        [
          true,
          r.row('price')
        ]
      ],

      [
        'Sym-modified',
        [
          r.row('symmetries').values().reduce((a, c) => a.add(c)).gt(0),
          r.row('modified')
        ]
      ],
      [
        'Sym-price',
        [
          r.row('symmetries').values().reduce((a, c) => a.add(c)).gt(0),
          r.row('price')
        ]
      ],
      [
        'RotSym-modified',
        [
          r.row('symmetries')('RotSym').eq(1),
          r.row('modified')
        ]
      ],
      [
        'RotSym-price',
        [
          r.row('symmetries')('RotSym').eq(1),
          r.row('price')
        ]
      ],
      [
        'X0Sym-modified',
        [
          r.row('symmetries')('X0Sym').eq(1),
          r.row('modified')
        ]
      ],
      [
        'X0Sym-price',
        [
          r.row('symmetries')('X0Sym').eq(1),
          r.row('price')
        ]
      ],
      [
        'XYSym-modified',
        [
          r.row('symmetries')('XYSym').eq(1),
          r.row('modified')
        ]
      ],
      [
        'XYSym-price',
        [
          r.row('symmetries')('XYSym').eq(1),
          r.row('price')
        ]
      ],
      [
        'XnYSym-modified',
        [
          r.row('symmetries')('XnYSym').eq(1),
          r.row('modified')
        ]
      ],
      [
        'XnYSym-price',
        [
          r.row('symmetries')('XnYSym').eq(1),
          r.row('price')
        ]
      ],
      [
        'Y0Sym-modified',
        [
          r.row('symmetries')('Y0Sym').eq(1),
          r.row('modified')
        ]
      ],
      [
        'Y0Sym-price',
        [
          r.row('symmetries')('Y0Sym').eq(1),
          r.row('price')
        ]
      ],

      [
        'market-modified',
        [
          r.row('price').ne('0'),
          r.row('modified')
        ]
      ],
      [
        'market-price',
        [
          r.row('price').ne('0'),
          r.row('price')
        ]
      ],

      [
        'owner-modified',
        [
          r.row('owner').downcase(),
          r.row('modified')
        ]
      ],
      [
        'owner-price',
        [
          r.row('owner').downcase(),
          r.row('price')
        ]
      ],

      [
        'commented-modified',
        [
          r.row('commentCount').gt(0),
          r.row('modified')
        ]
      ],
      [
        'commented-price',
        [
          r.row('commentCount').gt(0),
          r.row('price')
        ]
      ],

      [
        'contract-modified',
        [
          r.row('owner').eq(events.Clovers.address.toLowerCase()),
          r.row('modified')
        ]
      ],
      [
        'contract-price',
        [
          r.row('owner').eq(events.Clovers.address.toLowerCase()),
          r.row('price')
        ]
      ],

      [
        'public-modified',
        (doc) => {
          return [
            r.expr([
              events.Clovers.address.toLowerCase(),
              '0x0000000000000000000000000000000000000000'
            ]).contains(doc('owner')).eq(false),
            doc('modified')
          ]
        }
      ],
      [
        'public-price',
        (doc) => {
          return [
            r.expr([
              events.Clovers.address.toLowerCase(),
              '0x0000000000000000000000000000000000000000'
            ]).contains(doc('owner')).eq(false),
            doc('price')
          ]
        }
      ],
      [
        'ownerfilter',
        (doc) => {
          return [
            doc('owner').downcase(),
            r.branch(
              doc('price').ne('0'),
              'forsale',
              false
            )
          ]
        }
      ],
      [
        'ownersym',
        (doc) => {
          return [
            doc('owner').downcase(),
            doc('symmetries').values().reduce((a, c) => a.add(c)).gt(0)
          ]
        }
      ],

      // old ones
      [
        'Sym',
        (doc) => {
          return doc('symmetries').values().reduce((a, c) => a.add(c)).gt(0)
        }
      ],
      [
        'RotSym',
        (doc) => {
          return doc('symmetries')('RotSym').eq(1)
        }
      ],
      [
        'X0Sym',
        (doc) => {
          return doc('symmetries')('X0Sym').eq(1)
        }
      ],
      [
        'XYSym',
        (doc) => {
          return doc('symmetries')('XYSym').eq(1)
        }
      ],
      [
        'XnYSym',
        (doc) => {
          return doc('symmetries')('XnYSym').eq(1)
        }
      ],
      [
        'Y0Sym',
        (doc) => {
          return doc('symmetries')('Y0Sym').eq(1)
        }
      ],
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
      // [
      //   'rft',
      //   (doc) => {
      //     // curation market address
      //     return doc('owner').eq('0x9b8e917d6a511d4a22dcfa668a46b508ac26731e')
      //   }
      // ],
      [
        'public',
        (doc) => {
          return r.expr([
            // clovers and null address
            events.Clovers.address.toLowerCase(),
            '0x0000000000000000000000000000000000000000'
          ]).contains(doc('owner')).eq(false)
        }
      ],
      [
        'contract',
        (doc) => {
          return doc('owner').eq(events.Clovers.address.toLowerCase())
        }
      ],
      [
        'commented',
        (doc) => {
          return doc('commentCount').gt(0)
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
      ],
      [
        'dates',
        (doc) => {
          return [doc('board'), doc('created')]
        }
      ]
    ]
  },
  {
    name: 'albums',
    index: 'id',
    indexes: [
      [
        'name',
        (doc) => {
          return doc('name')
        }
      ],
      [
        'userAddress',
        (doc) => {
          return doc('userAddress')
        }
      ],
      [
        'dates',
        (doc) => {
          return [doc('id'), doc('modified')]
        }
      ],
      [
        'cloverCount',
        (doc) => {
          return doc('clovers').count()
        }
      ],
      [
        'all',
        () => true
      ]
    ]
  },
  {
    name: 'logs',
    indexes: [
      // updated ones
      [
        'active',
        (doc) => {
          return [
            r.branch(
              // log.name is not in this list
              // if
              r.expr(['ClubToken_Transfer','CurationMarket_Transfer']).contains(doc('name')),
              false,
              // else if
              doc('name').ne('Clovers_Transfer'),
              true,
              // not going to Clovers Contract
              // else if
              doc('data')('_to').downcase().ne(events.Clovers.address.toLowerCase()),
              true,
              // else
              false
            ),
            doc('blockNumber')
          ]
        }
      ],
      [
        'type',
        (doc) => {
          return [
            r.branch(
              r.expr(['ClubTokenController_Buy','ClubTokenController_Sell']).contains(doc('name')),
              'Coin_Activity',
              doc('name')
            ),
            doc('blockNumber')
          ]
        }
      ],
      [
        'clovers',
        (doc) => {
          return [
            r.branch(
              doc.hasFields({ data: 'board' }),
              doc('data')('board').downcase(),
              r.branch(
                doc.hasFields({ data: '_tokenId' }),
                r.branch(
                  doc('name').ne('CurationMarket_Transfer'),
                  doc('data')('_tokenId').downcase(),
                  null
                ),
                null
              )
            ),
            doc('blockNumber')
          ]
        }
      ],

      // older
      'name',
      'userAddresses',
      [
        'activity',
        (doc) => {
          return r.branch(
            // log.name is not in this list
            // if
            r.expr(['ClubToken_Transfer','CurationMarket_Transfer']).contains(doc('name')),
            'priv',
            // else if
            doc('name').ne('Clovers_Transfer'),
            'pub',
            // not going to Clovers Contract
            // else if
            doc('data')('_to').downcase().ne(events.Clovers.address.toLowerCase()),
            'pub',
            // else
            'priv'
          )
        }
      ],
      [
        'clover',
        (doc) => {
          return r.branch(
            doc.hasFields({ data: 'board' }),
            doc('data')('board').downcase(),
            r.branch(
              doc.hasFields({ data: '_tokenId' }),
              r.branch(
                doc('name').ne('CurationMarket_Transfer'),
                doc('data')('_tokenId').downcase(),
                null
              ),
              null
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
  .then(moveChats)
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
    const chainId = config.network.chainId
    const dbName = `clovers_chain_${chainId}`
    r.dbList().run(db, (err, res) => {
      if (err) return reject(err)
      if (res.findIndex(a => a === dbName) > -1) {
        console.log(`dbDrop ${dbName}`)
        r.dbDrop(dbName).run(db, (err, res) => {
          if (err) return reject(err)
          createDB().then(resolve)
        })
      } else {
        console.log(`dbCreate ${dbName}`)
        r.dbCreate(dbName).run(db, (err, res) => {
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

// untested :)
async function createIndexes (i = 0) {
  console.log(`create index #${i}`)
  if (i >= tables.length) {
    return
  } else {
    let table = tables[i]
    if (!table.indexes) {
      console.log(`table ${table.name} has no indexes`)
    } else {
      console.log('createIndexes', table.name)
      await asyncForEach(table.indexes, async (index) => {
        const func = index.constructor === Array ? index[1] : undefined
        const name = func ? index[0] : index
        await r.table(table.name)
          .indexCreate(name, func)
          .run(db)
        console.log('done', table.name)
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

let currBlock = null

async function populateLogs() {
  console.log('populateLogs')
  let blockNumber = await provider.getBlockNumber()
  currBlock = blockNumber
  console.log('Current block number: ' + blockNumber)
  await populateLog('Clovers')
  // await populateLog('CloversController') // dont actually watch for any events here
  await populateLog('ClubToken')
  await populateLog('ClubTokenController')
  await populateLog('SimpleCloversMarket')
}

async function testLogs({address, topics, genesisBlock}) {
  return new Promise((resolve, reject) => {
    provider.getLogs({
      address,
      topics,
      fromBlock: genesisBlock,
      toBlock: 'latest'
    }).then((logs, err) => {
      if (err) {
        reject(err)
      } else {
        resolve(logs)
      }
    })
  })
}

export async function getLogs({address, topics, genesisBlock, latest, limit, offset, previousLogs}){
  return new Promise((resolve, reject) => {

    var fromBlock = genesisBlock + limit * offset
    var toBlock = genesisBlock + limit * (offset + 1)
    console.log({fromBlock, toBlock})
    if (toBlock > latest) {
      toBlock = 'latest'
    }

    provider
    .getLogs({
      address,
      topics,
      fromBlock,
      toBlock
    }).then((logs, err) => {
      console.log({logs: logs.length})

      if (err) {
        reject(err)
      } else {
        if (logs.length > 0) {
          previousLogs = previousLogs.concat(logs)
        }
        if (toBlock === 'latest') {
          resolve(previousLogs)
        } else {
          getLogs({address, topics, genesisBlock, latest, limit, offset: offset + 1, previousLogs}).then(resolve)
        }
      }
    }).catch(reject)
  })
}

function populateLog(contract, key = 0) {
  return new Promise(async (resolve, reject) => {
    let eventTypes = events[contract].eventTypes
    if (key >= eventTypes.length) {
      resolve()
    } else {
      try {
        if (!eventTypes[key]) {
          console.log('dont watch this event' + eventTypes[key])
          return resolve()
        }
        console.log('populateLog - ' + contract + ' - ' + eventTypes[key])
        let address = events[contract].address.toLowerCase()
        // let abi = events[contract].abi
        // let iface = new ethers.Interface(abi)

        let eventType =
          events[contract].instance.interface.events[eventTypes[key]]
        // let transferCoder = iface.events[eventTypes[key]]
        if (!eventType) {
          throw new Error('no ' + contract + ' - ' + eventTypes[key])
        }

        var topics = eventType().topics
        var genesisBlock = config.genesisBlock[config.network.chainId]

        let logs = await testLogs({
          address,
          topics,
          genesisBlock
        })
        console.log(logs.length)
        if (logs.length === 1000) {
          logs = await getLogs({
            address: address.toLowerCase(),
            topics: eventType().topics,
            genesisBlock: config.genesisBlock[config.network.chainId],
            latest: currBlock,
            limit: 10,
            offset: 0,
            previousLogs: []
          })
        }

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

        logs = logs.map(l => transformLog(l, contract, key))

        return r.table('logs')
          .insert(logs, {  returnChanges: true, conflict: 'update' })
          .run(db, (err, results) => {
            if (err) return reject(err)
            console.log(results)
            return populateLog(contract, key + 1)
              .then(resolve)
              .catch(reject)
          })
      } catch(error) {
        console.log('error!!!')
        console.log(error)
      }
    }
  })
}

export function transformLog(l, contract, key) {

  let address = events[contract].address.toLowerCase()

  if (l.address.toLowerCase() !== address.toLowerCase()) {
    console.error({l})
    throw new Error('Why did I get a log from another address?')
  }

  let eventTypes = events[contract].eventTypes
  let abi = events[contract].abi
  let iface = new ethers.Interface(abi)
  let transferCoder = iface.events[eventTypes[key]]
  let eventType = events[contract].instance.interface.events[eventTypes[key]]

  const userKeys = ['_to', '_from', 'owner', 'buyer', 'seller']
  try {
    let userAddresses = []
    l.name = contract + '_' + eventType().name
    l.data = transferCoder.parse(l.topics, l.data)
    l.data = parseLogForStorage(l.data)
    // if (l.transactionHash) {
      // l.id = l.transactionHash + '-' + l.data.logIndex
    // }
    for (let k of Object.keys(l.data)) {
      if (userKeys.includes(k)) {
        userAddresses.push({id: k, address: l.data[k].toLowerCase()})
      }
    }
    l.userAddresses = userAddresses
  } catch (err) {
    console.error(err)
  }
  return l
}

function processLogs() {
  console.log('processLogs')
  return new Promise((resolve, reject) => {
    r.table('logs')
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

export function processLog(logs, i = 0, _db, skipOracle = false) {
  if (_db) {
    db = _db
  }
  console.log('processing log ' + i + '/' + logs.length)
  return new Promise((resolve, reject) => {
    if (i >= logs.length) {
      resolve()
    } else {
      let log = logs[i]
      console.log(`blockNumber ${log.blockNumber}`)
      handleEvent({ log, db}, skipOracle)
        .then(() => {
          processLog(logs, i + 1, db, skipOracle)
            .then(resolve)
            .catch(reject)
        })
        .catch(reject)
    }
  })
}


async function moveChats(){
  console.log('move Chats!')
  var v3_db = await new Promise((resolve, reject) => {
    r.connect({ host: 'localhost', port: 28015, db: 'clovers_v3' }, (err, conn) => {
      if (err) reject(err)
      resolve(conn)
    })
  })

  var chats = await new Promise((resolve, reject) => {
    r.table('chats')
    .filter((c) => true)
    .orderBy('created')
    .run(v3_db, (err, chats) => {
      if (err) reject(err)
      chats.toArray((err, result) => {
        if (err) reject(err)
        resolve(result)
      })
    })
  })
  console.log(`moving ${chats.length} chats`)
  await asyncForEach(chats, async (chat) => {
    return new Promise((resolve, reject) => {
        // save it
      r.table('chats')
      .insert(chat).run(db, async (err, { generated_keys }) => {
        if (err) reject(err)
        // emit an event pls
        const log = {
          id: uuid(),
          name: 'Comment_Added',
          removed: false,
          blockNumber: 0,
          userAddress: null, // necessary data below
          data: {
            userAddress: chat.userAddress,
            userName: chat.userName,
            board: chat.board,
            createdAt: new Date()
          },
          userAddresses: []
        }

        r.table('logs').insert(log)
        .run(db, (err) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      })
    })
  })
  console.log("done w chats")
}

async function nameClovers(){
  console.log("rename Clovers!")
  try {
    var v3_db = await new Promise((resolve, reject) => {
      r.connect({ host: 'localhost', port: 28015, db: 'clovers_v3' }, (err, conn) => {
        if (err) reject(err)
        resolve(conn)
      })
    })
    var clovers = await new Promise((resolve, reject) => {
      r.table('clovers')
      .filter((c) => {
        return c('name').match("^0x").not()
      })
      .pluck('board', 'name', 'commentCount')
      .run(v3_db, (err, clovers) => {
        if (err) reject(err)
        clovers.toArray((err, result) => {
          if (err) reject(err)
          resolve(result)
        })
      })
    })
    console.log(`naming ${clovers.length} clovers`)
    await asyncForEach(clovers, async (oldClover) => {
      return new Promise((resolve, reject) => {
        r.table('clovers')
        .get(oldClover.board)
        .run(db, (err, newClover) => {
          if (err) reject(err)
          if (!newClover) {
            console.log('newClover ' + oldClover.board + ' with name ' + oldClover.name + ' not found')
            resolve()
          } else {
            console.log('naming ' + oldClover.name)
            newClover.name = xss(oldClover.name)
            newClover.commentCount = oldClover.commentCount
            r.table('clovers')
            .get(oldClover.board)
            .update(newClover)
            .run(db, (err, result) => {
              if (err) reject(err)
              resolve()
            })
          }
        })
      })
    })
  } catch (error) {
    console.error(error)
  }
  console.log("done naming Clovers")
}


async function nameUsers(){
  console.log("name Users!")
  try {
    var v3_db = await new Promise((resolve, reject) => {
      r.connect({ host: 'localhost', port: 28015, db: 'clovers_v3' }, (err, conn) => {
        if (err) reject(err)
        resolve(conn)
      })
    })

    var users = await new Promise((resolve, reject) => {
      r.table('users')
      .filter((u) => {
        return u('name').ne("")
      })
      .pluck('address', 'name')
      .run(v3_db, (err, users) => {
        if (err) reject(err)
        users.toArray((err, result) => {
          if (err) reject(err)
          resolve(result)
        })
      })
    })
    console.log(`naming ${users.length} users`)
    await asyncForEach(users, async (oldUser) => {
      return new Promise((resolve, reject) => {
        r.table('users')
        .get(oldUser.address)
        .run(db, (err, newUser) => {
          if (err) reject(err)
          if (!newUser) {
            console.log('newUser ' + oldUser.address + ' with old name ' + oldUser.name + ' not found')
            resolve()
          } else {
            console.log('naming ' + oldUser.name)
            newUser.name = xss(oldUser.name)
            r.table('users')
            .get(oldUser.address)
            .update(newUser)
            .run(db, (err, result) => {
              if (err) reject(err)
              resolve()
            })
          }
        })
      })
    })
  } catch (error) {
    console.error(error)
  }
  console.log("done naming users")
}

// function nameClovers() {
//   console.log('nameClovers')
//   return new Promise((resolve, reject) => {
//     r.table('logs')
//       .filter({ name: 'newCloverName' })
//       .orderBy('blockNumber')
//       .run(db, (err, logs) => {
//         if (err) return reject(err)
//         console.log('newCloverName:', logs.length)
//         if (!logs.length) resolve()
//         logs.toArray((err, result) => {
//           if (err) return reject(err)
//           nameClover(result)
//             .then(resolve)
//             .catch(reject)
//         })
//       })
//   })
// }

// function nameClover(logs, key = 0) {
//   return new Promise((resolve, reject) => {
//     if (logs.length === key) resolve()
//     let log = logs[key]
//     r.table('clovers')
//       .get(log.data.board)
//       .run(db, (err, clover) => {
//         if (err) return reject(err)
//         if (!clover) {
//           console.log('clover ' + log.data.board + ' not found')
//           // return reject(new Error('clover ' + log.data.board + ' not found'))
//           nameClover(logs, key + 1)
//             .then(resolve)
//             .catch(reject)
//         } else {
//           clover.name = xss(log.data.name)
//           r.table('clovers')
//             .get(log.data.board)
//             .update(clover)
//             .run(db, (err, result) => {
//               if (err) return reject(err)
//               nameClover(logs, key + 1)
//                 .then(resolve)
//                 .catch(reject)
//             })
//         }
//       })
//   })
// }

// function nameUsers() {
//   console.log('nameUsers')
//   return new Promise((resolve, reject) => {
//     r.table('logs')
//       .filter({ name: 'newUserName' })
//       .orderBy('blockNumber')
//       .run(db, (err, logs) => {
//         if (err) return reject(err)
//         logs.toArray((err, result) => {
//           if (err) return reject(err)
//           nameUser(result)
//             .then(resolve)
//             .catch(reject)
//         })
//       })
//   })
// }

// function nameUser(logs, key = 0) {
//   return new Promise((resolve, reject) => {
//     if (logs.length === key) resolve()
//     let log = logs[key]
//     r.table('users')
//       .get(log.data.player)
//       .run(db, (err, user) => {
//         if (err) return reject(err)
//         if (!user) {
//           console.log('user ' + log.data.player + ' not found')
//           // return reject(new Error('user ' + log.data.player + ' not found'))
//           nameUser(logs, key + 1)
//             .then(resolve)
//             .catch(reject)
//         } else {
//           user.name = xss(log.data.name)
//           r.table('users')
//             .get(log.data.player)
//             .update(user)
//             .run(db, (err, result) => {
//               if (err) return reject(err)
//               nameUser(logs, key + 1)
//                 .then(resolve)
//                 .catch(reject)
//             })
//         }
//       })
//   })
// }
