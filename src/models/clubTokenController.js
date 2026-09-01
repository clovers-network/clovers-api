const debug = require('debug')('app:models:clubTokenController')
import { padBigNum } from '../lib/util'
import { getStore } from '../lib/store'
// event Buy(address buyer, uint256 tokens, uint256 value, uint256 poolBalance, uint256 tokenSupply);
export let clubTokenControllerBuy = async function({ log, io, db }) {
  await addBuySell(log, log.data.buyer, 'buy', io, db)
}
// event Sell(address seller, uint256 tokens, uint256 value, uint256 poolBalance, uint256 tokenSupply);
export let clubTokenControllerSell = async function({ log, io, db }) {
  await addBuySell(log, log.data.seller, 'sell', io, db)
}
async function addBuySell(log, user, isBuy, io, db) {
  debug('clubTokenController', isBuy, 'user', user)
  isBuy = isBuy === 'buy'
  const store = getStore()

  // Was: getAll([txHash, logIndex], {index:'unique_log'}).coerceTo('array')
  // and a length check. The SQLite schema makes (transactionHash, logIndex) a
  // real UNIQUE index rather than RethinkDB's non-unique one, so this check is
  // now belt-and-braces -- a concurrent insert would be rejected rather than
  // silently duplicated, which is how the one duplicate order in production
  // got there.
  if (store.findOrder(log.transactionHash, log.logIndex)) {
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
  // RethinkDB generated the `id` primary key; SQLite does not, so the store
  // assigns one. See store.insertOrder.
  store.insertOrder(order)
  io && io.emit('addOrder', order)
}

export let clubTokenControllerOwnershipTransferred = function ({ log, io, db }) {
  debug(log)
}
