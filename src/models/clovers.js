const debug = require('debug')('app:models:clovers')
import r from 'rethinkdb'
import { events, wallet } from '../lib/ethers-utils'
import { dodb, sym, padBigNum, userTemplate, ZERO_ADDRESS } from '../lib/util'
import Reversi from 'clovers-reversi'
import { changeCloverPrice } from './simpleCloversMarket'
import { getLogs, transformLog, processLog } from '../lib/build.js'
let db
let io

export const cloversTransfer = async ({ log, io: _io, db: _db }, skipOracle = false) => {
  db = _db
  io = _io
  // update the users
  try {
    await updateUsers(log, db)
  } catch (error) {
    debug('error while updating users')
    debug(error.message)
    debug(error.stack)
  }
  try {
    // update the clover
    if (log.data._from === ZERO_ADDRESS) {
      debug('new clover minted!')
      await addNewClover(log, skipOracle)
    } else {
      await updateClover(log, skipOracle)
    }
  } catch (error) {
    debug('error while adding/updating clovers')
    debug(error.message)
    debug(error.stack)
  }
}
export const cloversApproval = async function({ log, io, _db }) {
  // db = _db
  // io = _io
  debug(log.name + ' does not affect the database')
}
export const cloversApprovalForAll = async function({ log, io, _db }) {
  // db = _db
  // io = _io
  debug(log.name + ' does not affect the database')
}
export const cloversOwnershipTransferred = async function({ log, io, _db }) {
  // db = _db
  // io = _io
  debug(log.name + ' does not affect the database')
}

function isValid(tokenId, cloverMoves, cloverSymmetries) {
  let reversi = new Reversi()
  debug('cloverMoves', cloverMoves[0][0], cloverMoves[0][1])
  reversi.playGameByteMoves(cloverMoves[0][0], cloverMoves[0][1])

  // check if game had an error or isn't complete
  if (!reversi.complete || reversi.error) {
    debug('not complete or has error', reversi)
    return false
  }
  // check if boards don't match
  if (
    reversi.byteBoard.replace('0x', '').toLowerCase() !==
    tokenId
      .toString(16)
      .replace('0x', '')
      .toLowerCase()
  ) {
    debug(
      "boards don't match",
      reversi.byteBoard.replace('0x', '').toLowerCase(),
      tokenId
        .toString(16)
        .replace('0x', '')
        .toLowerCase()
    )
    return false
  }
  // check if symmetries were wrong
  if (
    reversi
      .returnSymmetriesAsBN()
      .toString(10)
      .toLowerCase() !==
    cloverSymmetries
      .toString(10)
      .toLowerCase()
  ) {
    debug(
      'symmetricals were wrong',
      reversi
        .returnSymmetriesAsBN()
        .toString(16)
        .replace('0x', '')
        .toLowerCase(),
      cloverSymmetries
        .toString(16)
        .replace('0x', '')
        .toLowerCase()
    )
    return false
  }
  return true
}

export async function syncClover(_db, _io, clover) {
  db = _db
  io = _io
  debug('checking clover')
  debug(clover.board)
  // sync clover
  // test if exists
  let log = {
    data: { _tokenId: clover.board },
    blockNumber: null
  }
  const exists = await events.Clovers.instance.exists(clover.board)
  if (!exists) {
    debug('clover DOES NOT exist')
    log.data._from = clover.owner
    log.data._to = ZERO_ADDRESS
    // remove from current owner
    await updateUser(log, clover.owner, 'remove', db)
    // move clover to ZERO_ADDRESS
    await updateClover(log)
    return
  } else {
    debug('clover exists')
  }

  // test for salePrice
  const salePrice = await events.SimpleCloversMarket.instance.sellPrice(
    clover.board
  )
  let padPrice = salePrice.toString(10)
  if (padPrice !== '0') padPrice = padPrice.padStart(64, '0')
  if (padPrice !== clover.price) {
  // if (salePrice.toString(10) !== clover.price.toString(10)) {
  // let hexPrice = BigInt(salePrice.toString()).toString(16)
  // hexPrice = hexPrice === '0' ? '0' : hexPrice.padStart(64, '0')
  // if (hexPrice !== clover.price) {
    debug('sale price wrong')
    log.data.price = salePrice
    await changeCloverPrice(db, io, clover.board, log)
  } else {
    debug('sale price ok')
  }

  // test for owner
  try {
    let owner = await events.Clovers.instance.ownerOf(clover.board)
    if (Array.isArray(owner)) {
      owner = owner[0]
    }
    if (owner.toLowerCase() !== clover.owner.toLowerCase()) {
      debug('owner is wrong')
      log.data._to = owner
      await updateClover(log)
      await updateUser(log, owner, 'add', db)
    } else {
      debug('owner is ok')
    }
  } catch (err) {
    debug(err.toString())
    debug('invalid address probably, continue')
  }
}

export async function syncOracle(_db, _io, totalSupply, key = 1) {
  db = _db
  io = _io

  if (key >= totalSupply) {
    return
  }
  try {
    const index = totalSupply - key
    debug(index)
    debug(events.Clovers.address)
    let tokenId = await events.Clovers.instance.tokenOfOwnerByIndex(events.Clovers.address, index)
    tokenId = '0x' + JSON.stringify(tokenId).slice(9, -3)
    debug({tokenId})
    const movesHash = await events.CloversController.instance.getMovesHash(tokenId)
    debug({movesHash})
    const commits = await events.CloversController.instance.commits(movesHash[0])
    debug({commits})
    debug(commits.collected)
    if (!commits.collected) {
      let clover = await r.table('clovers').get(tokenId.toLowerCase()).default(false).run(db)
      if (!clover) {
        await doSyncContract(db, tokenId)
      }
      clover = await r.table('clovers').get(tokenId.toLowerCase()).default(false).run(db)
      if (!clover) {
        debug('still no clover')
        return
      }
      const symmetries = await events.Clovers.instance.getSymmetries(tokenId)
      await oracleVerify(clover, symmetries)
    }
    await syncOracle(db, io, totalSupply, key + 1)
    return 'done'
  } catch (error) {
    debug(error)
  }
}

export async function syncContract(_db, _io, totalSupply, key = 1) {
  try { 
    if (key >= totalSupply) return
    db = _db
    io = _io

    const index = totalSupply - key
    let tokenId = await events.Clovers.instance.tokenByIndex(index)
    // so mad idk why tokenId.toString(16) returns in decimal format
    tokenId = '0x' + JSON.stringify(tokenId).slice(9, -3)

    const exists = await r.table('clovers').get(tokenId.toLowerCase()).default(false).run(db)
    debug(`------------------------------------------------------------${key} / ${totalSupply}`)
    debug(`${tokenId}---------------------${(exists ? ' exists in db' : ' does not exist in db')}`)
    if (exists) {
      await syncContract(db, io, totalSupply, key + 1)
      return
    }
    await doSyncContract(db, tokenId)

    await syncContract(db, io, totalSupply, key + 1)
    return 'done'
  } catch (error) {
    debug(error)
  }
}

async function doSyncContract(db, tokenId) {
  let blockMinted = await events.Clovers.instance.getBlockMinted(tokenId)
  blockMinted = parseInt(blockMinted.toString())

  const eventType = events.Clovers.instance.interface.events.Transfer
  const topics = eventType().topics
  const address = events.Clovers.address.toLowerCase()
  const genesisBlock = blockMinted
  const latest = blockMinted
  const limit = 1
  const offset = 0
  const previousLogs = []
  let logs = await getLogs({address,topics, genesisBlock, latest, limit, offset, previousLogs})
  logs = logs.map(l => transformLog(l, 'Clovers', 0))
  logs = logs.filter(l => {
    return l.data._tokenId === tokenId
  })
  debug('# of logs', logs.length)
  if (logs.length === 0) {
    debug({logs})
    debug({address,topics, genesisBlock, latest, limit, offset, previousLogs})
    throw new Error('Log 404')
  }
  await r.table('logs').insert(logs, {  returnChanges: true, conflict: 'update' }).run(db)
  const skipOracle = true
  await processLog(logs, 0, db, skipOracle)
}

async function updateUser(log, user_id, add, _db) {
  if (_db) {
    db = _db
  }
  user_id = user_id.toLowerCase()
  if (user_id === ZERO_ADDRESS.toLowerCase()) return
  add = add === 'add'
  let command = r.table('users').get(user_id)
  let user = await dodb(db, command)
  if (add) {
    if (!user) {
      user = userTemplate(user_id)
      user.created = log.blockNumber
    }
    // let index = user.clovers.indexOf(log.data._tokenId)
    // if (index < 0) {
    //   user.clovers.push(log.data._tokenId)
    //   user.modified = log.blockNumber
    // } else {
    //   debug('for some reason this clover was added to a user who already owned it')
    //   debug(log)
    //   debug(user_id)
    // }
  } else {
    if (user) {
      // let index = user.clovers.indexOf(log.data._tokenId)
      // if (index < 0) {
      //   throw new Error(
      //     'cant remove clover ' +
      //       log.data._tokenId +
      //       ' if user ' +
      //       log.data._from +
      //       ' doesnt own it'
      //   )
      // }
      // user.clovers.splice(index, 1)
      user.modified = log.blockNumber
    } else {
      // this should not happen
      throw new Error('cant find for user ' + log.data._from + ' but not found')
    }
  }
  command = r.table('users')
    .insert(user, { returnChanges: true, conflict: 'update' })
  await dodb(db, command)
  io && io.emit('updateUser', user)
}

async function updateUsers(log, _db) {
  if (_db) {
    db = _db
  }
  debug('update users for clover ' + log.data._tokenId)
  debug('add to:' + log.data._to.toLowerCase())
  debug('remove from:' + log.data._from.toLowerCase())
  await updateUser(log, log.data._to, 'add', db)
  await updateUser(log, log.data._from, 'remove', db)
}

async function updateClover(log) {
  let command = r.table('clovers')
    .get(log.data._tokenId)
  let clover = await dodb(db, command)
  if (!clover) throw new Error('clover ' + log.data._tokenId + ' not found')
  clover.owner = log.data._to.toLowerCase()
  clover.modified = log.blockNumber
  command = r.table('clovers')
    .insert(clover, { returnChanges: true, conflict: 'update' })
  await dodb(db, command)

  // get clover again, with comments and orders
  r.table('clovers')
    .get(log.data._tokenId)
    .do((doc) => {
      return doc.merge({
        lastOrder: r.table('orders')
          .getAll(doc('board'), { index: 'market' })
          .orderBy(r.desc('created'), r.desc('transactionIndex'))
          .limit(1).fold(false, (l, r) => r),
        user: r.table('users').get(doc('owner'))
          .without('clovers', 'curationMarket').default(null)
      })
    })
    .run(db, (err, result) => {
      io && io.emit('updateClover', result)
      debug(io ? 'emit updateClover' : 'do not emit updateClover')
    })
}

async function addNewClover(log, skipOracle = false) {
  debug('adding new Clover', log.data._tokenId)
  let tokenId = log.data._tokenId
  let hasFoundBy = log.userAddresses.filter(u => u.id === '_to')
  let foundBy = cloverKept && hasFoundBy.length > 0 ? hasFoundBy[0].address : null

  let [
    cloverKept,
    cloverMoves,
    cloverReward,
    cloverSymmetries,
    cloverBlock,
    price
  ] = await Promise.all([
    events.Clovers.instance.getKeep(log.data._tokenId),
    events.Clovers.instance.getCloverMoves(log.data._tokenId),
    events.Clovers.instance.getReward(log.data._tokenId),
    events.Clovers.instance.getSymmetries(log.data._tokenId),
    events.Clovers.instance.getBlockMinted(log.data._tokenId),
    events.SimpleCloversMarket.instance.sellPrice(log.data._tokenId)
  ])
  // var cloverURI = await events.Clovers.instance.tokenURI(log.data._tokenId)

  let clover = {
    foundBy,
    name: tokenId,
    board: tokenId,
    kept: cloverKept,
    owner: log.data._to.toLowerCase(),
    moves: cloverMoves,
    reward: padBigNum(cloverReward),
    symmetries: sym(cloverSymmetries),
    created: Number(cloverBlock),
    modified: Number(cloverBlock),
    // store price as hex, padded for sorting/filtering in DB
    originalPrice: padBigNum(price),
    price: padBigNum(price),
    commentCount: 0
  }
  let command = r.table('clovers').insert(clover)
  await dodb(db, command)

  clover.user = await r.table('users').get(clover.owner).run(db)
  debug('emit new clover info')

  io && io.emit('addClover', clover)

  // wait til afterwards so the clover shows up (even if it's just pending)
  if (log.data._to.toLowerCase() === events.Clovers.address.toLowerCase()) {
    // cancel if initial build
    if (checkFlag('build') || skipOracle) return
    // oracleVerify(clover, cloverSymmetries)
  } else {
    console.log(log)
  }
}

function checkFlag(flag) {
  return process.argv.findIndex(c => c === flag) > -1
}

async function oracleVerify ({ name, moves }, symmetries) {
  debug(name + ' is being verified')
  const options = {
    gasPrice: 15000000000 // 15 GWEI
  }
  var doneish = false
  try {
    // dont verify clovers from the initial build
    if (isValid(name, moves, symmetries)) {
      debug(name + ' is valid, move to new owner')
      const tx = await wallet.CloversController.retrieveStake(name, options)
      debug('started tx:' + tx.hash)
      await tx.wait()
      doneish = true
      debug(name + ' moved to new owner')
    } else {
      debug(name + ' is not valid, please burn')
      const tx = await wallet.CloversController.challengeClover(name, options)
      debug('started tx:' + tx.hash)
      await tx.wait()
      doneish = true
      debug(name + ' has been burned')
    }
  } catch (err) {
    debug(err)
    setTimeout(() => {
      debug(name + ': waited 3 minutes')
      if (!doneish) {
        debug(name + ': try again')
        oracleVerify({ name, moves}, symmetries)
      } else {
        debug(name + ': already succeeded')
      }
    }, 1000 * 60 * 3)
  }
}
