const debug = require('debug')('app:models:clovers')
import { events, provider } from '../lib/chain'
import { sym, padBigNum, userTemplate, ZERO_ADDRESS } from '../lib/util'
import { getStore } from '../lib/store'
import Reversi from 'clovers-reversi'
import { changeCloverPrice } from './simpleCloversMarket'
import { getLogs, transformLog, processLog } from '../lib/build.js'
// import axios from 'axios'
// import { BigNumber, parseEther, formatEther } from 'ethers/utils'
import { parseEther, formatEther } from 'ethers/utils'
// import clovers from '../api/clovers'
import config from '../config.json'

// Attempts before a clover's view calls are treated as a hard failure.
const MAX_VIEW_CALL_RETRIES = 5

// const oneGwei = '1000000000'
// `db` is still threaded through this module's exported signatures because
// build.js and the sync scripts pass it. It is unused now that reads and writes
// go through the store; the parameter stays so callers do not all have to
// change at once. FUTURE: drop `db` from these signatures once nothing passes it.
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
    // debug(error.stack)
  }
  try {
    // update the clover
    if (log.data._from === ZERO_ADDRESS) {
      debug('new clover minted!')
      await addNewClover(log, skipOracle)
    } else {
      await updateClover(log)
    }
  } catch (error) {
    debug('error while adding/updating clovers')
    debug(error)
  }
}
export const cloversApproval = async function ({ log, io, _db }) {
  // db = _db
  // io = _io
  debug(log.name + ' does not affect the database')
}
export const cloversApprovalForAll = async function ({ log, io, _db }) {
  // db = _db
  // io = _io
  debug(log.name + ' does not affect the database')
}
export const cloversOwnershipTransferred = async function ({ log, io, _db }) {
  // db = _db
  // io = _io
  debug(log.name + ' does not affect the database')
}

function isValid (tokenId, cloverMoves, cloverSymmetries) {
  let reversi = new Reversi()
  if (cloverMoves.length === 1) {
    cloverMoves = cloverMoves[0]
  }
  debug('cloverMoves', cloverMoves[0], cloverMoves[1])
  reversi.playGameByteMoves(cloverMoves[0], cloverMoves[1])

  // check if game had an error or isn't complete
  if (!reversi.complete || reversi.error || reversi.moves[0].toLowerCase() !== 'c4') {
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

export async function syncClover (_db, _io, clover) {
  db = _db
  io = _io
  debug('checking clover')
  debug(clover.board)

  const mod = clover.modified || await provider.getBlockNumber()

  let log = {
    data: { _tokenId: clover.board },
    blockNumber: mod
  }
  debug(log)
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
  padPrice = padPrice.padStart(64, '0')

  debug('prices', salePrice, padPrice, clover.price)

  if (padPrice !== clover.price) {
    debug('sale price wrong')
    log.data.price = salePrice
    await changeCloverPrice(db, io, clover.board, log)
  } else {
    debug(`sale price ok ${padPrice}`)
  }

  // test for owner
  try {
    let owner = await events.Clovers.instance.ownerOf(clover.board)
    if (Array.isArray(owner)) {
      owner = owner[0]
    }
    if (owner.toLowerCase() !== clover.owner.toLowerCase()) {
      debug(`owner seems to be ${clover.owner} but is actually ${owner}`)
      debug('owner is wrong')
      log.data._to = owner
      log.data._from = clover.owner
      await updateClover(log)
      // this is called at the end of update..
      // await updateUser(log, owner, 'add', db)
    } else {
      debug(`owner is ok ${owner}`)
    }

    // test for moves
    let moves = await events.Clovers.instance.getCloverMoves(clover.board)
    if (moves.length === 1) {
      moves = moves[0]
    }
    let cloverMoves = clover.moves.length === 1 ? clover.moves[0] : clover.moves
    if (moves.join(",") !== cloverMoves.join(",")) {
      debug(`moves don't match making an update to board`)
      debug(`from ${cloverMoves.join(',')} to ${moves.join(',')}`)
      clover.moves = moves
      getStore().updateClover(clover.board, { moves })
    } else {
      debug('moves are ok')
    }
  } catch (err) {
    debug(err.toString())
    debug('invalid address probably, continue')
  }
}

export async function syncOracle (_db, _io, totalSupply, key = 1) {
  db = _db
  io = _io

  if (key >= totalSupply) {
    return
  }
  try {
    const index = totalSupply - key
    debug(`------------------------------------------------------ syncing oracle ${index} / ${totalSupply}`)
    let tokenId = await events.Clovers.instance.tokenOfOwnerByIndex(events.Clovers.address, index)
    tokenId = tokenId._hex

    await doSyncOracle(db, io, tokenId)

    await syncOracle(db, io, totalSupply, key + 1)
    return 'done'
  } catch (error) {
    debug(error)
  }
}

export async function doSyncOracle (_db, _io, tokenId) {
  db = _db
  io = _io
  const store = getStore()
  let clover = store.getClover(tokenId.toLowerCase()) || null
  // const exists = await events.Clovers.instance.exists(tokenId)
  if (clover) {
    await syncClover(db, io, clover)
  }
  const movesHash = await events.CloversController.instance.getMovesHash(tokenId)
  const commits = await events.CloversController.instance.commits(movesHash)
  console.log({commits})
  if (!commits.collected) {
    if (!clover) {
      console.log("dont have clover yet")
      await doSyncContract(db, tokenId)
    }
    clover = store.getClover(tokenId.toLowerCase()) || null
    if (!clover) {
      debug('still no clover')
      return
    }
    const symmetries = await events.Clovers.instance.getSymmetries(tokenId)
    // await oracleVerify(clover, symmetries)
  } else {
    debug(`${tokenId} already collected`)
  }

  // `clover` is null whenever the token is already collected, or when
  // doSyncContract could not build a row. Dereferencing .owner here threw a
  // TypeError that syncOracle swallowed into debug(), so the sweep looked like
  // it had run and had in fact stopped at the first such token.
  if (!clover) {
    debug(`no clover row for ${tokenId}; cannot check its sale price`)
    return
  }

  const salePrice = await events.SimpleCloversMarket.instance.sellPrice(tokenId)
  if (salePrice.eq(parseEther('3')) && clover.owner.toLowerCase() === events.Clovers.address.toLowerCase()) {
    const flatFee = parseEther('10')
    debug(`contract clover sale price wrong, changing from ${formatEther(salePrice.toString(10))} to ${formatEther(flatFee.toString(10))}`)
    if (typeof events.CloversController.instance['fixSalePrice(uint256,uint256)'] !== 'undefined') {
      await events.CloversController.instance.fixSalePrice(tokenId, flatFee)
    } else {
      console.log(`CloversController Contract not updated yet`)
    }
  } else {
    debug(`sale price ok ${formatEther(salePrice)} or not for sale by contract but ${clover.owner}`)
  }

}

export async function syncPending (_db, _io, pending, key = 0) {
  try {
    if (key >= pending.length) return
    db = _db
    io = _io
    let clover = pending[key]
    await doSyncOracle(db, io, clover.board)
    await syncPending(db, io, pending, key + 1)

  } catch (error) {
    debug(error)
  }
}

export async function syncContract (_db, _io, totalSupply, key = 1) {
  try {
    if (key >= totalSupply) return
    db = _db
    io = _io

    const index = totalSupply - key
    let tokenId = await events.Clovers.instance.tokenByIndex(index)
    // so mad idk why tokenId.toString(16) returns in decimal format
    tokenId = tokenId._hex

    const exists = getStore().getClover(tokenId.toLowerCase()) || false
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

async function doSyncContract (db, tokenId) {
  let blockMinted = await events.Clovers.instance.getBlockMinted(tokenId)
  blockMinted = parseInt(blockMinted.toString())

  if (blockMinted === 0) {
    const dbLogs = getStore().logsForTokenId('Clovers_Transfer', tokenId)
    if (dbLogs.length > 0) {
      debug(`found ${dbLogs.length} with this tokenID`)
      blockMinted = dbLogs[0].blockNumber
    } else {
      debug(`using genesis as log`)
      blockMinted = config.genesisBlock[config.networkId]
    }
  }
  const eventType = events.Clovers.instance.interface.events.Transfer

  const topics = [eventType.topic]

  const address = events.Clovers.address.toLowerCase()
  const genesisBlock = blockMinted
  const latest = blockMinted
  const limit = 1
  const offset = 0
  const previousLogs = []
  // debug({address, topics, genesisBlock, latest, limit, offset, previousLogs})
  let logs = await getLogs({address, topics, genesisBlock, latest, limit, offset, previousLogs})
  console.log(`# of logs before filter ${logs.length}`)
  logs = logs.map(l => transformLog(l, 'Clovers', 0))
  logs = logs.filter(l => {
    return l.data._tokenId === tokenId
  })
  debug('# of logs after filter', logs.length)
  if (logs.length === 0) {
    debug({logs})
    debug({address,topics, genesisBlock, latest, limit, offset, previousLogs})
    throw new Error('Log 404')
  }
  getStore().insertLogs(logs)
  const skipOracle = true
  await processLog(logs, 0, db, skipOracle)
}

async function updateUser (log, user_id, add, _db) {
  debug('updateUser', user_id)
  if (_db) {
    db = _db
  }
  const store = getStore()
  user_id = user_id.toLowerCase()
  if (user_id === ZERO_ADDRESS.toLowerCase()) {
    debug('just update zero address')
    // Recount only -- no insert. The original used .update(), which ReQL treats
    // as a no-op on a missing document, so the zero-address user is never
    // created here. recomputeCloverCount is an UPDATE for the same reason.
    store.recomputeCloverCount(user_id)
    return
  }
  add = add === 'add'
  let user = store.getUser(user_id)
  if (add) {
    if (!user) {
      user = userTemplate(user_id, log)
      // user.created = log.blockNumber
    }
  } else {
    if (user) {
      user.modified = log.blockNumber
    } else {
      // user isn't in the DB for some reason (logs missing)
      user = userTemplate(user_id, log)
    }
  }
  store.insertUser(user, { conflict: 'update' })
  io && io.emit('updateUser', user)

  // update counts
  debug('update user\'s clover counts')
  store.recomputeCloverCount(user.address)
}

async function updateUsers (log, _db) {
  if (_db) {
    db = _db
  }
  debug('update users for clover ' + log.data._tokenId)
  debug('add to:' + log.data._to.toLowerCase())
  debug('remove from:' + log.data._from.toLowerCase())
  await updateUser(log, log.data._to, 'add', db)
  await updateUser(log, log.data._from, 'remove', db)
}

async function updateClover (log) {
  const store = getStore()
  let clover = store.getClover(log.data._tokenId)
  if (!clover) throw new Error('clover ' + log.data._tokenId + ' not found')

  const modified = log.blockNumber || clover.modified || await provider.getBlockNumber()
  clover.modified = modified
  debug('updateClover: new modifed', modified)

  clover.owner = log.data._to.toLowerCase()
  store.insertClover(clover, { conflict: 'update' })

  // re-read with the new owner and latest order attached
  const result = store.getCloverWithUser(log.data._tokenId)
  io && io.emit('updateClover', result)
  debug(io ? 'emit updateClover' : 'do not emit updateClover')

  debug('update users after updateClover()')
  if (log.data._to) {
    await updateUser(log, log.data._to)
  }
  if (log.data._from) {
    await updateUser(log, log.data._from)
  }
}

async function addNewClover (log, skipOracle = false) {
  // debug(log)
  debug('adding new Clover', log.data._tokenId)
  let tokenId = log.data._tokenId
  let hasFoundBy = log.userAddresses.filter(u => u.id === '_to')

  // These five view calls are retried in a loop rather than by recursing from
  // inside .catch(). The previous version did:
  //
  //   let [a, b, ...] = await Promise.all([...]).catch(async () => {
  //     retry = true
  //     return addNewClover(log, skipOracle)   // resolves to undefined
  //   })
  //
  // Destructuring the catch's return value throws "is not iterable" the moment
  // any one call fails, before the `if (retry) return` guard is ever reached.
  // So every transient RPC hiccup raised a TypeError instead of retrying
  // cleanly -- a likely contributor to the ~314 clovers missing from the
  // database, 96% of which are contract-owned.
  let cloverKept, cloverMoves, cloverReward, cloverSymmetries, price

  for (let attempt = 0; ; attempt++) {
    try {
      const viewCalls = await Promise.all([
        events.Clovers.instance.getKeep(tokenId),
        events.Clovers.instance.getCloverMoves(tokenId),
        events.Clovers.instance.getReward(tokenId),
        events.Clovers.instance.getSymmetries(tokenId),
        events.SimpleCloversMarket.instance.sellPrice(tokenId)
      ])
      cloverKept = viewCalls[0]
      cloverMoves = viewCalls[1]
      cloverReward = viewCalls[2]
      cloverSymmetries = viewCalls[3]
      price = viewCalls[4]
      break
    } catch (err) {
      debug(`view calls failed for ${tokenId} (attempt ${attempt + 1}): ${err.message}`)
      if (attempt >= MAX_VIEW_CALL_RETRIES) {
        // Surface it rather than silently dropping the clover.
        throw new Error(
          `addNewClover: view calls for ${tokenId} failed after ` +
          `${attempt + 1} attempts: ${err.message}`
        )
      }
      await sleep(Math.min(30000, 2000 * Math.pow(2, attempt)))
    }
  }

  let foundBy = cloverKept && hasFoundBy.length > 0 ? hasFoundBy[0].address : null
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
    created: Number(log.blockNumber),
    modified: Number(log.blockNumber),
    // store price as hex, padded for sorting/filtering in DB
    originalPrice: padBigNum(price),
    price: padBigNum(price),
    commentCount: 0
  }
  // console.log(clover)
  const store = getStore()
  store.insertClover(clover)

  // Note this attaches the *whole* user, unlike updateClover's payload which
  // strips curationMarket. Left as-is: the dapp already handles both shapes.
  clover.user = store.getUser(clover.owner)
  debug('emit new clover info')

  io && io.emit('addClover', clover)

  // wait til afterwards so the clover shows up (even if it's just pending)
  if (log.data._to.toLowerCase() === events.Clovers.address.toLowerCase()) {
    // cancel if initial build
    if (checkFlag('build') || skipOracle) return
    // oracleVerify(clover, cloverSymmetries)
  } else {
    // debug(log)
  }
}

function checkFlag (flag) {
  return process.argv.findIndex(c => c === flag) > -1
}

function sleep (ms = 1000) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// async function oracleVerify (clover, symmetries) {
//   // console.log({clover})
//   let { board, moves } = clover
//   debug(board + ' is being verified')
//   // console.log({board}, {moves})

//   var doneish = false

//   var currentOwner = await events.Clovers.instance.ownerOf(board)
//   if (currentOwner.toLowerCase() !== events.Clovers.address.toLowerCase()) {
//     debug(`token no longer owned by contract, no need to verify ${board}`)
//     return
//   }

//   var movesHash = await events.CloversController.instance.getMovesHash(board)
//   var commits = await events.CloversController.instance.commits(movesHash)
//   if (commits.collected) {
//     debug(`token has already been collected, no need to verify ${board}`)
//     return
//   }

//   let fast, average, safeLow
//   try {
//     const gasPricesResponse = await axios('https://ethgasstation.info/json/ethgasAPI.json')
//     const gasPrices = gasPricesResponse.data
//     // console.log({gasPrices})
//     fast = new BigNumber(gasPrices.fast).div(10).mul(oneGwei)
//     average = new BigNumber(gasPrices.average).div(10).mul(oneGwei)
//     safeLow = new BigNumber(gasPrices.safeLow).div(10).mul(oneGwei)
//   } catch (error) {
//     debug(error)
//     fast = (new BigNumber(10)).mul(oneGwei)
//     average = (new BigNumber(5)).mul(oneGwei)
//     safeLow = (new BigNumber(1)).mul(oneGwei)
//   }

//   // console.log({fast: formatEther(fast), average: formatEther(average), safeLow: formatEther(safeLow)})
//   let tx
//   try {
//     // console.log(fast.toString(16), fast.toString(10), fast.toHexString())
//     const options = {
//       gasPrice: fast.toHexString()
//     }
//     // console.log({fast: fast.toString(10), gasPriceEth: formatEther(fast)})
//     // dont verify clovers from the initial build
//     if (isValid(board, moves, symmetries)) {
//       debug(board + ' is valid, move to new owner')
//       if (typeof wallet.CloversController['retrieveStakeWithGas(uint256,uint256,uint256,uint256)'] !== 'undefined' ) {
//         debug('retrieve stake exists')
//         debug(board, fast.toString(10), average.toString(10), safeLow.toString(10))
//         tx = await wallet.CloversController.retrieveStakeWithGas(board, fast.toString(10), average.toString(10), safeLow.toString(10), options)
//       } else {
//         debug('use legacy')
//         tx = await wallet.CloversController.retrieveStake(board, options)
//       }
//       debug('started tx:' + tx.hash)
//       await tx.wait()
//       doneish = true
//       debug(board + ' moved to new owner')
//     } else {
//       debug(board + ' is not valid, please burn')
//       if (typeof wallet.CloversController['challengeCloverWithGas(uint256,uint256,uint256,uint256)'] !== 'undefined' ) {
//         debug('challenge clover exists')
//         tx = await wallet.CloversController.challengeCloverWithGas(board, fast.toString(10), average.toString(10), safeLow.toString(10), options)
//       } else {
//         debug('use legacy')
//         tx = await wallet.CloversController.challengeClover(board, options)
//       }
//       debug('started tx:' + tx.hash)
//       await tx.wait()
//       doneish = true
//       debug(board + ' has been burned')
//     }
//   } catch (err) {
//     debug(`error on clover ${board} with tx ${tx}`)
//     debug(err)
//     setTimeout(() => {
//       debug(board + ': waited 3 minutes')
//       if (!doneish) {
//         debug(board + ': try again')
//         oracleVerify({ board, moves}, symmetries)
//       } else {
//         debug(board + ': already succeeded')
//       }
//     }, 1000 * 60 * 3)
//   }
// }
