import r from 'rethinkdb'
import { events, wallet } from '../lib/ethers-utils'
import { dodb, sym, padBigNum, userTemplate, ZERO_ADDRESS } from '../lib/util'
import Reversi from 'clovers-reversi'
let db
let io
export const cloversTransfer = async ({ log, io: _io, db: _db }) => {
  db = _db
  io = _io
  // update the users
  await updateUsers(log)

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
      .toString(16)
      .replace('0x', '')
      .toLowerCase() !==
    cloverSymmetries
      .toString(16)
      .replace('0x', '')
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

async function updateUsers(log) {
  // update to user
  let command = r
    .db('clovers_v2')
    .table('users')
    .get(log.data._to.toLowerCase())
  let user = await dodb(db, command)
  if (!user) {
    user = userTemplate()
    user.name = log.data._to
    user.address = log.data._to.toLowerCase()
    user.created = log.blockNumber
  }
  user.clovers.push(log.data._tokenId)
  user.modified = log.blockNumber

  command = r
    .db('clovers_v2')
    .table('users')
    .insert(user, { returnChanges: true, conflict: 'update' })
  await dodb(db, command)
  io && io.emit('updateUser', user)

  // update from user
  if (log.data._from === ZERO_ADDRESS) return
  command = r
    .db('clovers_v2')
    .table('users')
    .get(log.data._from.toLowerCase())
  user = await dodb(db, command)
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
    command = r
      .db('clovers_v2')
      .table('users')
      .insert(user, { returnChanges: true, conflict: 'update' })
    await dodb(db, command)
    io && io.emit('updateUser', user)
  } else {
    // this should not happen
    throw new Error('cant find for user ' + log.data._from + ' but not found')
  }
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
