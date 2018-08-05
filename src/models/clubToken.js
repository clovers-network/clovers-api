import r from 'rethinkdb'
import { dodb, padBigNum, userTemplate } from '../lib/util'
let db, io
const BigNumber = require('bignumber.js')
export let clubTokenBurn = async function({ log, io: _io, db: _db }) {
  db = _db
  io = _io
  let user = log.data.burner
  let amount = log.data.value
  console.log(log.name + ' does not affect the database')

  //taken care of w transfer
  // await changeUserBalance(user, amount, 'sub', log)
}
export let clubTokenMint = async function({ log, io: _io, db: _db }) {
  db = _db
  io = _io
  let user = log.data.to
  let amount = log.data.amount
  console.log(log.name + ' does not affect the database')

  //taken care of w transfer
  // await changeUserBalance(user, amount, 'add', log)
}
export let clubTokenApproval = async function({ log, io, _db }) {
  // db = _db
  //  io = _io

  console.log(log.name + ' does not affect the database')
}
// event Transfer(address indexed from, address indexed to, uint256 value);
export let clubTokenTransfer = async ({ log, io: _io, db: _db }) => {
  db = _db
  io = _io
  let from = log.data.from
  let to = log.data.to
  let amount = log.data.value
  if (!new BigNumber(to).eq(0)) {
    await changeUserBalance(to, amount, 'add', log)
  }
  if (!new BigNumber(from).eq(0)) {
    await changeUserBalance(from, amount, 'sub', log)
  }
}
export let clubTokenOwnershipTransferred = async ({
  log,
  io: _io,
  db: _db
}) => {
  // db = _db
  // io = _io
  console.log(log.name + ' does not affect the database')
}

async function changeUserBalance(user_id, amount, add, log) {
  amount = typeof amount == 'object' ? amount : new BigNumber(amount)
  add = add == 'add'
  let command = r
    .db('clovers_v2')
    .table('users')
    .get(user_id)
  let user = await dodb(db, command)
  if (!user) {
    user = userTemplate()
  } else if (!user.balance) {
    user.balance = userTemplate().balance
  }
  console.log(user.balance)
  user.balance = new BigNumber(user.balance)
  console.log(user.balance)
  user.balance = padBigNum(
    add ? user.balance.plus(amount) : user.balance.sub(amount)
  )
  user.modified = log.blockNumber
  command = r
    .db('clovers_v2')
    .table('users')
    .get(user_id)
    .update(user)
  await dodb(db, command)
  io && io.emit('updateUser', user)
}
