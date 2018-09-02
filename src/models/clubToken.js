import r from 'rethinkdb'
import { events } from '../lib/ethers-utils'
import { dodb, padBigNum, userTemplate, ZERO_ADDRESS } from '../lib/util'
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

  if (from !== ZERO_ADDRESS) {
    console.log('decrease user ' + from + ' by ' + amount.toString())
    await changeUserBalance(from, amount, 'sub', log)
  } else {
    console.log('bank just minted ' + amount.toString() + ' clovers for ' + to)
  }
  if (to !== ZERO_ADDRESS) {
    console.log('increase user ' + to + ' by ' + amount.toString())
    await changeUserBalance(to, amount, 'add', log)
  } else {
    console.log(
      'bank just burned ' + amount.toString() + ' clovers for ' + from
    )
  }
}
export let clubTokenOwnershipTransferred = async ({
  log,
  io: _io,
  db: _db
}) => {
  console.log(log.name + ' does not affect the database')
}

async function changeUserBalance(user_id, amount, add, log) {
  user_id = user_id.toLowerCase()
  amount = typeof amount == 'object' ? amount : new BigNumber(amount)
  add = add == 'add'
  let command = r
    .db('clovers_v2')
    .table('users')
    .get(user_id)
  let user = await dodb(db, command)
  if (!user) {
    user = userTemplate()
    user.address = user_id
  } else if (!user.balance) {
    user.balance = await events.ClubToken.instance.balanceOf(user.address)
  }
  let balance = await events.ClubToken.instance.balanceOf(user.address)
  console.log('contract balance is ' + balance.toString())

  let _balance = new BigNumber(user.balance)
  _balance = add ? _balance.plus(amount) : _balance.minus(amount)
  console.log('db balance is ' + _balance.toString())

  user.balance = padBigNum(balance)

  user.modified = log.blockNumber
  command = r
    .db('clovers_v2')
    .table('users')
    .insert(user, { returnChanges: true, conflict: 'update' })
  let changes = await dodb(db, command)
  console.log('update user!')
  io && io.emit('updateUser', user)
}
