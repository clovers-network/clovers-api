import r from 'rethinkdb'
import utils from 'web3-utils'
import BigNumber from 'bignumber.js'
import { padBigNum, dodb } from '../lib/util'
let db, io
// event updatePrice(uint256 _tokenId, uint256 price); // NOTE: lowercase u
export let simpleCloversMarketupdatePrice = async function({
  log,
  io: _io,
  db: _db
}) {
  db = _db
  io = _io

  console.log(log.name + ' called')
  let _tokenId = log.data._tokenId
  await changeCloverPrice(db, io, _tokenId, log)
}

export let simpleCloversMarketOwnershipTransferred = async function({
  log,
  io,
  db
}) {
  console.log(log.name + ' does not affect the database')
}

export async function changeCloverPrice(db, io, _tokenId, log) {
  let price = log.data.price
  console.log(price)
  if (Array.isArray(price)) {
    price = price[0]
  }
  price = typeof price == 'object' ? price : new BigNumber(price)

  let command = r
    .db('clovers_v2')
    .table('clovers')
    .get(_tokenId)
  let clover = await dodb(db, command)
  console.log(price)
  if (price.eq(0)) {
    console.log('removed from market or sold (set to 0)')
  }
  clover.price = padBigNum(price)
  clover.modified = log.blockNumber
  command = r
    .db('clovers_v2')
    .table('clovers')
    .insert(clover, { returnChanges: true, conflict: 'update' })
  await dodb(db, command)
  io && io.emit('updateClover', clover)
  console.log(io ? 'emit updateClover' : 'do not emit updateClover')
}
