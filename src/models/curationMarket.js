const debug = require('debug')('app:models:curationMarket')
import utils from 'web3-utils'
import BigNumber from 'bignumber.js'
import {
  padBigNum,
  getLowestPrice,
  oneEthInWei,
  userTemplate
} from '../lib/util'
import { getStore } from '../lib/store'
import { events } from '../lib/chain'

let db, io

// event Buy(uint256 _tokenId, address buyer, uint256 tokens, uint256 value, uint256 poolBalance, uint256 tokenSupply);
export let curationMarketBuy = async function({ log, io, db }) {
  await addBuySell(log, log.data.buyer, 'buy', io, db)
}
// event Sell(uint256 _tokenId, address seller, uint256 tokens, uint256 value, uint256 poolBalance, uint256 tokenSupply);
export let curationMarketSell = async function({ log, io, db }) {
  await addBuySell(log, log.data.seller, 'sell', io, db)
}

async function addBuySell(log, user, isBuy, io, db) {
  isBuy = isBuy === 'buy'
  let order = {
    market: log.data._tokenId,
    created: log.blockNumber,
    transactionIndex: log.transactionIndex,
    type: isBuy ? 'buy' : 'sell',
    user,
    tokens: padBigNum(log.data.tokens),
    value: padBigNum(log.data.value),
    poolBalance: padBigNum(log.data.poolBalance),
    tokenSupply: padBigNum(log.data.tokenSupply)
  }
  const store = getStore()
  store.insertOrder(order)
  // io && io.emit('addOrder', order)

  // This is the path that makes lastOrder mean something: curation-market
  // orders store the tokenId -- which is the board -- in `market`, so the order
  // written just above is findable. None exist in production because
  // CurationMarket events are commented out of socketing.js, not because the
  // query is wrong.
  //
  // The empty value is null, matching every other clover payload. The original
  // folded from `false` here and from `null` in simpleCloversMarket, so the
  // dapp received two different shapes for the same field depending on which
  // contract emitted the event.
  const clover = store.getCloverWithUser(log.data._tokenId)
  if (clover) {
    const result = { ...clover, commentCount: store.countChats(clover.board) }
    io && io.emit('updateClover', result)
  }
  debug(io ? 'emit updateClover' : 'do not emit updateClover')
}

// event Burn(uint256 _tokenId, address indexed burner, uint256 value);
export let curationMarketBurn = async function({ log, io: _io, db: _db }) {
  debug(log.name + ' does not affect the database')
  //takes place w transfer
}

// event Mint(uint256 _tokenId, address indexed to, uint256 amount);
export let curationMarketMint = async function({ log, io: _io, db: _db }) {
  debug(log.name + ' does not affect the database')
  //takes place w transfer
}

// event Transfer(uint256 _tokenId, address indexed from, address indexed to, uint256 value);
export let curationMarketTransfer = async function({ log, io: _io, db: _db }) {
  db = _db
  io = _io
  let _tokenId = log.data._tokenId
  let from = log.data.from
  let to = log.data.to
  let amount = log.data.value

  if (!new BigNumber(from).eq('0')) {
    // get the user who is sending the token and remove to their balance
    await changeUserBalance(from, amount, _tokenId, 'sub', log)
  }
  if (!new BigNumber(to).eq('0')) {
    // get the user who is receiving the token and add to their balance
    await changeUserBalance(to, amount, _tokenId, 'add', log)
  }
}
export let curationMarketOwnershipTransferred = async function({
  log,
  io: _io,
  db: _db
}) {
  debug(log.name + ' does not affect the database')
}

async function changeUserBalance(user_id, amount, _tokenId, add, log) {
  user_id = user_id.toLowerCase()
  amount = typeof amount == 'object' ? amount : new BigNumber(amount)
  add = add == 'add'
  const store = getStore()
  let user = store.getUser(user_id)
  if (!user) {
    user = userTemplate(user_id, log)
    user.balance = '0'
  }

  // curationMarket is a JSON column, so a row written before it existed reads
  // back null rather than the {} RethinkDB's schemaless documents carried.
  if (!user.curationMarket) user.curationMarket = {}
  if (!user.curationMarket[_tokenId]) {
    user.curationMarket[_tokenId] = 0
  }

  let balance = new BigNumber(user.curationMarket[_tokenId])
  balance = add ? balance.plus(amount) : balance.minus(amount)
  user.curationMarket[_tokenId] = padBigNum(balance)
  user.modified = log.blockNumber
  store.insertUser(user, { conflict: 'update' })
  io && io.emit('updateUser', user)
}
