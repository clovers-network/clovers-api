const debug = require('debug')('app:models:simpleCloversMarket')
import utils from 'web3-utils'
import BigNumber from 'bignumber.js'
import { padBigNum } from '../lib/util'
import { getStore } from '../lib/store'

let db, io

// event updatePrice(uint256 _tokenId, uint256 price); // NOTE: lowercase u
export let simpleCloversMarketupdatePrice = async function({
  log,
  io: _io,
  db: _db
}) {
  db = _db
  io = _io

  debug(log.name + ' called')
  let _tokenId = log.data._tokenId
  await changeCloverPrice(db, io, _tokenId, log)
}

export let simpleCloversMarketOwnershipTransferred = async function({
  log,
  io,
  db
}) {
  debug(log.name + ' does not affect the database')
}

export async function changeCloverPrice (db, io, _tokenId, log) {
  let price = log.data.price
  if (Array.isArray(price)) {
    price = price[0]
  }
  price = typeof price == 'object' ? price : new BigNumber(price)

  debug('changeCloverPrice', price.toString(10))

  // price = BigInt(price.toString()).toString(16)

  const store = getStore()
  let clover = store.getClover(_tokenId)
  if (!clover) {
    console.log("no clover " + _tokenId)
    return
  }
  debug(`Clover price changed from ${price}`)
  if (price.eq(0)) {
    debug('removed from market or sold (set to 0)')
    price = '0'
  } else {
    price = price.toString(10).padStart(64, '0')
  }
  debug(`Clover price changed to ${price}`)
  clover.price = price
  clover.modified = log.blockNumber
  store.insertClover(clover, { conflict: 'update' })

  // re-read with the owner and latest order attached, as the socket payload
  // expects. getCloverWithUser runs the real lastOrder lookup -- see the note
  // there for why four call sites used to hardcode it.
  const result = store.getCloverWithUser(_tokenId)
  io && io.emit('updateClover', result)
  debug(io ? 'emit updateClover' : 'do not emit updateClover')
}
