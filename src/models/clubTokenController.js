const debug = require('debug')('app:models:clubTokenController')
import r from 'rethinkdb'
import { events } from '../lib/ethers-utils'
import { padBigNum, dodb } from '../lib/util'
// event Buy(address buyer, uint256 tokens, uint256 value, uint256 poolBalance, uint256 tokenSupply);
export let clubTokenControllerBuy = async function({ log, io, db }) {
  await addBuySell(log, log.data.buyer, 'buy', io, db)
}
// event Sell(address seller, uint256 tokens, uint256 value, uint256 poolBalance, uint256 tokenSupply);
export let clubTokenControllerSell = async function({ log, io, db }) {
  await addBuySell(log, log.data.seller, 'sell', io, db)
}
async function addBuySell(log, user, isBuy, io, db) {
  isBuy = isBuy === 'buy'

  const check = r.table('orders').getAll([
    log.transactionHash,
    log.logIndex
  ], { index: 'unique_log' }).coerceTo('array')
  const res = await dodb(db, check)

  if (res.length) {
    debug('order already exists')
    return
  }

  const order = {
    market: 'ClubToken',
    created: log.blockNumber,
    transactionIndex: log.transactionIndex,
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    type: isBuy ? 'buy' : 'sell',
    user,
    tokens: padBigNum(log.data.tokens),
    value: padBigNum(log.data.value),
    poolBalance: padBigNum(log.data.poolBalance),
    tokenSupply: padBigNum(log.data.tokenSupply)
  }
  const command = r.table('orders').insert(order)
  await dodb(db, command)
  io && io.emit('addOrder', order)
}

export let clubTokenControllerOwnershipTransferred = function ({ log, io, db }) {
  debug(log)
}
