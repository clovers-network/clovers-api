import r from 'rethinkdb'
import utils from 'web3-utils'
import BigNumber from 'bignumber.js'
import {
  dodb,
  padBigNum,
  getLowestPrice,
  oneEthInWei,
  userTemplate
} from '../lib/util'
import { events } from '../lib/ethers-utils'

let db, io

// event Buy(uint256 _tokenId, address buyer, uint256 tokens, uint256 value, uint256 poolBalance, uint256 tokenSupply);
export let curationMarketBuy = async function({ log, io, db }) {
  await addBuySell(log, log.data.buyer, 'buy', db)
}
// event Sell(uint256 _tokenId, address seller, uint256 tokens, uint256 value, uint256 poolBalance, uint256 tokenSupply);
export let curationMarketSell = async function({ log, io, db }) {
  await addBuySell(log, log.data.seller, 'sell', db)
}
async function addBuySell(log, user, isBuy, db) {
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
  let command = r
    .db('clovers_v2')
    .table('orders')
    .insert(order)
  await dodb(db, command)
  io && io.emit('addOrder', order)
}

// event Burn(uint256 _tokenId, address indexed burner, uint256 value);
export let curationMarketBurn = async function({ log, io: _io, db: _db }) {
  console.log(log.name + ' does not affect the database')
  //takes place w transfer
}

// event Mint(uint256 _tokenId, address indexed to, uint256 amount);
export let curationMarketMint = async function({ log, io: _io, db: _db }) {
  console.log(log.name + ' does not affect the database')
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
  console.log(log.name + ' does not affect the database')
}

async function changeUserBalance(user_id, amount, _tokenId, add, log) {
  user_id = user_id.toLowerCase()
  amount = typeof amount == 'object' ? amount : new BigNumber(amount)
  add = add == 'add'
  let command = r
    .db('clovers_v2')
    .table('users')
    .get(user_id)
  let user = await dodb(db, command)
  if (!user) {
    user = userTemplate(user_id)
    user.balance = '0'
  }

  if (!user.curationMarket[_tokenId]) {
    user.curationMarket[_tokenId] = 0
  }

  let balance = new BigNumber(user.curationMarket[_tokenId])
  balance = add ? balance.plus(amount) : balance.minus(amount)
  user.curationMarket[_tokenId] = padBigNum(balance)
  user.modified = log.blockNumber
  command = r
    .db('clovers_v2')
    .table('users')
    .insert(user, { returnChanges: true, conflict: 'update' })
  let changes = await dodb(db, command)
  io && io.emit('updateUser', user)
}
