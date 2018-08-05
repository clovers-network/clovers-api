import r from 'rethinkdb'
import { dodb, padBigNum, userTemplate } from '../lib/util'
let db, io
const BigNumber = require('bignumber.js')

export let clubTokenBurn = async function({ log, io: _io, db: _db }) {
  console.log(log.name + ' does not affect the database')
  //taken care of w transfer
  // await changeUserBalance(user, amount, 'sub', log)
}
export let clubTokenMint = async function({ log, io: _io, db: _db }) {
  console.log(log.name + ' does not affect the database')
  //taken care of w transfer
  // await changeUserBalance(user, amount, 'add', log)
}
export let clubTokenApproval = async function({ log, io, _db }) {
  console.log(log.name + ' does not affect the database')
}

// event Transfer(address indexed from, address indexed to, uint256 value);
export let clubTokenTransfer = async ({ log, io: _io, db: _db }) => {
  db = _db
  io = _io
  let from = log.data.from
  let to = log.data.to
  let amount = log.data.value

  if (!new BigNumber(from).eq(0)) {
    await changeUserBalance(from, amount, 'sub', log)
  }
  if (!new BigNumber(to).eq(0)) {
    await changeUserBalance(to, amount, 'add', log)
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
  user_id = user_id.toLowerCase()
  amount = typeof amount == 'object' ? amount : new BigNumber(amount)
  add = add == 'add'
  let command = r
    .db('clovers_v2')
    .table('users')
    .get(user_id.toLowerCase())
  let user = await dodb(db, command)
  if (!user) {
    user = userTemplate()
    user.address = user_id
  } else if (!user.balance) {
    user.balance = userTemplate().balance
  }
  let balance = new BigNumber(user.balance)
  balance = add ? balance.plus(amount) : balance.minus(amount)
  user.balance = padBigNum(balance)

  user.modified = log.blockNumber
  command = r
    .db('clovers_v2')
    .table('users')
    .insert(user, { returnChanges: true, conflict: 'update' })
  let changes = await dodb(db, command)
  // console.log(changes.changes)
  io && io.emit('updateUser', user)
}
