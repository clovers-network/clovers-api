import r from 'rethinkdb'
import { events } from '../lib/ethers-utils'
import { padBigNum, dodb } from '../lib/util'
// event Buy(address buyer, uint256 tokens, uint256 value, uint256 poolBalance, uint256 tokenSupply);
export let clubTokenControllerBuy = async function({ log, io, db }) {
  await addBuySell(log, log.data.buyer, 'buy', db)
}
// event Sell(address seller, uint256 tokens, uint256 value, uint256 poolBalance, uint256 tokenSupply);
export let clubTokenControllerSell = async function({ log, io, db }) {
  await addBuySell(log, log.data.seller, 'sell', db)
}
async function addBuySell(log, user, isBuy, db) {
  isBuy = isBuy === 'buy'

  let order = {
    market: 'ClubToken',
    created: log.blockNumber,
    transactionIndex: log.transactionIndex,
    type: isBuy ? 'buy' : 'sell',
    user,
    tokens: padBigNum(log.data.tokens),
    value: padBigNum(log.data.value),
    poolBalance: padBigNum(log.data.poolBalance),
    tokenSupply: padBigNum(log.data.tokenSupply)
  }
  let command = r
    .db('clovers_v2')
    .table('orders')
    .insert(order)
  await dodb(db, command)
  io && io.emit('addOrder', order)
}
export let clubTokenControllerOwnershipTransferred = function({ log, io, db }) {
  console.log(log)
}
