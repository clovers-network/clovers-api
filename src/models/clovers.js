import r from 'rethinkdb'
import { events, wallet } from '../lib/ethers-utils'
import { dodb, sym, padBigNum, userTemplate, ZERO_ADDRESS } from '../lib/util'
import Reversi from 'clovers-reversi'
import { changeCloverPrice } from './simpleCloversMarket'
let db
let io
export const cloversTransfer = async ({ log, io: _io, db: _db }) => {
  db = _db
  io = _io
  // update the users
  try {
    await updateUsers(log)
  } catch (error) {
    console.log('error while updating users')
    console.log(error.message)
    console.log(error.stack)
  }

  // update the clover
  if (log.data._from === ZERO_ADDRESS) {
    console.log('new clover minted!')
    await addNewClover(log)
  } else {
    await updateClover(log)
  }
}
export const cloversApproval = async function({ log, io, _db }) {
  // db = _db
  // io = _io
  console.log(log.name + ' does not affect the database')
}
export const cloversApprovalForAll = async function({ log, io, _db }) {
  // db = _db
  // io = _io
  console.log(log.name + ' does not affect the database')
}
export const cloversOwnershipTransferred = async function({ log, io, _db }) {
  // db = _db
  // io = _io
  console.log(log.name + ' does not affect the database')
}

function isValid(tokenId, cloverMoves, cloverSymmetries) {
  let reversi = new Reversi()
  console.log('cloverMoves', cloverMoves[0][0], cloverMoves[0][1])
  reversi.playGameByteMoves(cloverMoves[0][0], cloverMoves[0][1])

  // check if game had an error or isn't complete
  if (!reversi.complete || reversi.error) {
    console.log('not complete or has error', reversi)
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
    console.log(
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
    console.log(
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
  console.log('checking clover')
  console.log(clover)
  // sync clover
  // test if exists
  let log = {
    data: { _tokenId: clover.board },
    blockNumber: null
  }
  const exists = await events.Clovers.instance.exists(clover.board)
  if (!exists) {
    console.log('clover DOES NOT exists')
    log.data._from = clover.owner
    log.data._to = ZERO_ADDRESS
    // remove from current owner
    await updateUser(log, clover.owner, 'remove')
    // move clover to ZERO_ADDRESS
    await updateClover(log)
    return
  } else {
    console.log('clover exists')
  }

  // test for salePrice
  const salePrice = await events.SimpleCloversMarket.instance.sellPrice(
    clover.board
  )
  if (salePrice.toString(10) !== clover.price.toString(10)) {
    console.log('sale price wrong')
    log.data.price = salePrice
    await changeCloverPrice(db, io, clover.board, log)
  } else {
    console.log('sale price ok')
  }

  // test for owner
  let owner = await events.Clovers.instance.ownerOf(clover.board)
  if (Array.isArray(owner)) {
    owner = owner[0]
  }
  if (owner.toLowerCase() !== clover.owner.toLowerCase()) {
    console.log('owner is wrong')
    log.data._to = owner
    await updateClover(log)
    await updateUser(log, owner, 'add')
  } else {
    console.log('owner is ok')
  }
}

async function updateUser(log, user_id, add) {
  if (user_id === ZERO_ADDRESS) return
  add = add == 'add'
  let command = r
    .db('clovers_v2')
    .table('users')
    .get(user_id.toLowerCase())
  let user = await dodb(db, command)
  if (add) {
    if (!user) {
      user = userTemplate()
      user.address = user_id.toLowerCase()
      user.created = log.blockNumber
    }
    user.clovers.push(log.data._tokenId)
    user.modified = log.blockNumber
  } else {
    if (user) {
      let index = user.clovers.indexOf(log.data._tokenId)
      if (index < 0) {
        throw new Error(
          'cant remove clover ' +
            log.data._tokenId +
            ' if user ' +
            log.data._from +
            ' doesnt own it'
        )
      }
      user.clovers.splice(index, 1)
      user.modified = log.blockNumber
    } else {
      // this should not happen
      throw new Error('cant find for user ' + log.data._from + ' but not found')
    }
  }
  command = r
    .db('clovers_v2')
    .table('users')
    .insert(user, { returnChanges: true, conflict: 'update' })
  await dodb(db, command)
  io && io.emit('updateUser', user)
}

async function updateUsers(log) {
  console.log('update users for clover ' + log.data._tokenId)
  console.log('add to:' + log.data._to.toLowerCase())
  console.log('remove from:' + log.data._from.toLowerCase())
  await updateUser(log, log.data._to, 'add')
  await updateUser(log, log.data._from, 'remove')
}

async function updateClover(log) {
  let command = r
    .db('clovers_v2')
    .table('clovers')
    .get(log.data._tokenId)
  let clover = await dodb(db, command)
  if (!clover) throw new Error('clover ' + log.data._tokenId + ' not found')
  clover.owner = log.data._to.toLowerCase()
  clover.modified = log.blockNumber
  command = r
    .db('clovers_v2')
    .table('clovers')
    .insert(clover, { returnChanges: true, conflict: 'update' })

  await dodb(db, command)
  io && io.emit('updateClover', clover)
}

async function addNewClover(log) {
  let tokenId = log.data._tokenId
  let cloverMoves = await events.Clovers.instance.getCloverMoves(
    log.data._tokenId
  )
  let cloverReward = await events.Clovers.instance.getReward(log.data._tokenId)
  let cloverSymmetries = await events.Clovers.instance.getSymmetries(
    log.data._tokenId
  )
  let cloverBlock = await events.Clovers.instance.getBlockMinted(
    log.data._tokenId
  )
  let price = await events.SimpleCloversMarket.instance.sellPrice(
    log.data._tokenId
  )
  // var cloverURI = await events.Clovers.instance.tokenURI(log.data._tokenId)

  let clover = {
    name: tokenId,
    board: tokenId,
    owner: log.data._to.toLowerCase(),
    moves: cloverMoves,
    reward: padBigNum(cloverReward),
    symmetries: sym(cloverSymmetries),
    created: Number(cloverBlock),
    modified: Number(cloverBlock),
    // store price as hex, padded for sorting/filtering in DB
    originalPrice: padBigNum(price),
    price: padBigNum(price)
  }
  let command = r
    .db('clovers_v2')
    .table('clovers')
    .insert(clover)
  await dodb(db, command)
  io && io.emit('addClover', clover)
  // wait til afterwards so the clover shows up (even if it's just pending)
  if (log.data._to.toLowerCase() === events.Clovers.address.toLowerCase()) {
    let initialBuild = process.argv.findIndex(c => c === 'build') > -1
    if (initialBuild) return
    console.log(tokenId + ' is being verified')
    let verified = isValid(tokenId, cloverMoves, cloverSymmetries)
    // dont verify clovers from the initial build
    if (verified) {
      console.log(tokenId + ' is valid, move to new owner')
      var tx = await wallet.CloversController.retrieveStake(tokenId)
      var doneish = await tx.wait()
      console.log(tokenId + ' moved to new owner  - tx:' + doneish.hash)
    } else {
      console.log(tokenId + ' is not valid, please burn')
      var tx = await wallet.CloversController.challengeClover(tokenId)
      var doneish = await tx.wait()
      console.log(tokenId + ' has been burned  - tx:' + doneish.hash)
    }
  }
}
