import r from 'rethinkdb'
import utils from 'web3-utils'
import BigNumber from 'bignumber.js'
import { dodb, padBigNum, getLowestPrice, oneEthInWei } from '../lib/util'
import { events } from '../lib/ethers-utils'

let db, io
// event Burn(uint256 _tokenId, address indexed burner, uint256 value);
export let curationMarketBurn = async function({ log, io: _io, db: _db }) {
	db = _db
	io = _io

	console.log(log.name + ' called')
	let _tokenId = log.data._tokenId
	let user = log.data.burner
	let amount = log.data.value
	await changeUserBalance(user, amount, _tokenId, 'sub', log)
	await updateCurationMarket(_tokenId, amount, 'sub', log)
}

// event Mint(uint256 _tokenId, address indexed to, uint256 amount);
export let curationMarketMint = async function({ log, io: _io, db: _db }) {
	db = _db
	io = _io

	console.log(log.name + ' called')
	let _tokenId = log.data._tokenId
	let user = log.data.to
	let amount = log.data.amount
	await changeUserBalance(user, amount, _tokenId, 'add', log)
	await updateCurationMarket(_tokenId, amount, 'sub', log)
}

// event Transfer(uint256 _tokenId, address indexed from, address indexed to, uint256 value);
export let curationMarketTransfer = async function({ log, io: _io, db: _db }) {
	db = _db
	io = _io
	console.log(log.name + ' called')
	let _tokenId = log.data._tokenId
	let from = log.data.from
	let to = log.data.to
	let amount = new BigNumber(log.data.vaulue)
	// get the user who is sending the token and remove to their balance
	await changeUserBalance(from, amount, _tokenId, 'sub', log)
	// get the user who is receiving the token and add to their balance
	await changeUserBalance(to, amount, _tokenId, 'add', log)
}
export let curationMarketOwnershipTransferred = async function({
	log,
	io: _io,
	db: _db
}) {
	// db = _db
	console.log(log.name + ' does not affect the database')
}

async function updateCurationMarket(_tokenId, amount, add, log) {
	amount = typeof amount == 'object' ? amount : new BigNumber(amount)
	add = add == 'add'
	let command = r
		.db('clovers_v2')
		.table('clovers')
		.get(_tokenId)
	let clover = await dodb(db, command)
	if (!clover.curationMarket) {
		clover.curationMarket = {
			totalSupply: null,
			poolBalance: null,
			buys: [],
			nexBuy: null,
			sells: [],
			nextSell: null
		}
	}

	// update totalSupply
	let totalSupply = await events.CurationMarket.instance.totalSupply(_tokenId)
	clover.curationMarket.totalSupply = padBigNum(totalSupply)

	// update poolBalance
	let poolBalance = await events.CurationMarket.instance.poolBalance(_tokenId)
	clover.curationMarket.poolBalance = padBigNum(poolBalance)

	// add to previous buys or sells
	if (add) {
		let boughtFor = await events.CurationMarket.instance.getSell(
			_tokenId,
			amount
		)
		clover.curationMarket.buys.push({ amount, boughtFor })
	} else {
		let soldFor = await events.CurationMarket.instance.getBuy(_tokenId, amount)
		clover.curationMarket.sells.push({ amount, soldFor })
	}

	// update price of nextBuy & nextSell (average would be current price?)
	let nextBuy = await getLowestPrice(
		events.CurationMarket.instance,
		_tokenId,
		oneEthInWei
	)
	clover.curationMarket.nextBuy = nextBuy

	let nextSell = await events.CurationMarket.instance.getSell(
		_tokenId,
		oneEthInWei
	)
	clover.curationMarket.nextSell = nextSell

	command = r
		.db('clovers_v2')
		.table('clovers')
		.get(_tokenId)
		.update(clover)
	await dodb(rb, command)
	io && io.emit('updateClover', clover)
}

async function changeUserBalance(user_id, amount, _tokenId, add, log) {
	amount = typeof amount == 'object' ? amount : new BigNumber(amount)
	add = add == 'add'
	let command = r
		.db('clovers_v2')
		.table('users')
		.get(user_id)
	let user = await dodb(db, command)
	if (!user.curationMarket[_tokenId]) {
		user.curationMarket[_tokenId] = '0x0'
	}
	user.curationMarket[_tokenId] = padBigNum(
		add
			? new BigNumber(user.curationMarket[_tokenId]).add(amount).toString(16)
			: new BigNumber(user.curationMarket[_tokenId]).sub(amount).toString(16)
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
