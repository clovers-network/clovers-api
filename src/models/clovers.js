import r from 'rethinkdb'
import { events, wallet } from '../lib/ethers-utils'
import { dodb, sym, padBigNum } from '../lib/util'
import Reversi from 'clovers-reversi'
let db
let io
export const cloversTransfer = async ({ log, io: _io, db: _db }) => {
	db = _db
	io = _io
	// update the user
	await updateUser(log)
	// update the clover
	if (log.data._from === '0x0000000000000000000000000000000000000000') {
		await addNewClover(log)
	} else {
		await updateClover(log)
	}
}
export const cloversApproval = async function({ log, io, _db }) {
	// db = _db
	// io = _io
	console.log(log.name + ' does not affect the database')
}
export const cloversApprovalForAll = async function({ log, io, _db }) {
	// db = _db
	// io = _io
	console.log(log.name + ' does not affect the database')
}
export const cloversOwnershipTransferred = async function({ log, io, _db }) {
	// db = _db
	// io = _io
	console.log(log.name + ' does not affect the database')
}

function isValid(tokenId, cloverMoves, cloverSymmetries) {
	let reversi = new Reversi()
	reversi.playGameByteMoves(cloverMoves[0], cloverMoves[1])

	// check if game had an error or isn't complete
	if (!reversi.complete || reversi.error) {
		return false
	}
	// check if boards don't match
	if (
		reversi.byteBoard.replace('0x', '').toLowerCase() !==
		tokenId
			.toString(16)
			.replace('0x', '')
			.toLowerCase()
	) {
		return false
	}
	// check if symmetries were wrong
	if (
		reversi
			.returnSymmetriesAsBN()
			.toString(16)
			.replace('0x', '')
			.toLowerCase() !==
		cloverSymmetries
			.toString(16)
			.replace('0x', '')
			.toLowerCase()
	) {
		return false
	}
}

async function updateUser(log) {
	let command = r
		.db('clovers_v2')
		.table('users')
		.get(log.data._to)
	let user = await dodb(db, command)
	if (user) {
		user.modified = log.blockNumber
		user.clovers.push(log.data._tokenId)
		command = r
			.db('clovers_v2')
			.table('users')
			.get(log.data._to)
			.update(user)
		await dodb(db, command)
		io && io.emit('updateUser', user)
	} else {
		user = {
			name: log.data._to,
			address: log.data._to,
			clovers: [log.data._tokenId],
			created: log.blockNumber,
			modified: log.blockNumber
		}
		command = r
			.db('clovers_v2')
			.table('users')
			.insert(user)
		await dodb(db, command)
		io && io.emit('addUser', user)
	}
}

async function updateClover(log) {
	let command = r
		.db('clovers_v2')
		.table('clovers')
		.get(log.data._tokenId)
	clover = await dodb(db, command)
	if (!clover) throw new Error('clover ' + log.data._tokenId + ' not found')
	clover.owner = log.data._to
	clover.modified = log.blockNumber
	command = r
		.db('clovers_v2')
		.table('clovers')
		.get(log.data._tokenId)
		.update(clover)
	await dodb(db, command)
	io && io.emit('updateClover', clover)

	command = r
		.db('clovers_v2')
		.table('users')
		.get(log.data._from)
	let user = await dodb(db, command)
	if (user) {
		user.clovers.splice(user.clovers.indexOf(log.data._tokenId), 1)
		user.modified = log.blockNumber
		command = r
			.db('clovers_v2')
			.table('users')
			.get(log.data._to)
			.update(user)
		await dodb(db, command)
		io && io.emit('updateUser', user)
	} else {
		// this should not happen
		throw new Error('looking for user ' + log.data._from + ' but not found')
	}
}

async function addNewClover(log) {
	let tokenId = log.data._tokenId
	let cloverMoves = await events.Clovers.instance.getCloverMoves(
		log.data._tokenId
	)
	let cloverReward = await events.Clovers.instance.getReward(log.data._tokenId)
	let cloverSymmetries = await events.Clovers.instance.getSymmetries(
		log.data._tokenId
	)
	let cloverBlock = await events.Clovers.instance.getBlockMinted(
		log.data._tokenId
	)
	let price = await events.SimpleCloversMarket.instance.sellPrice(
		log.data._tokenId
	)
	// var cloverURI = await events.Clovers.instance.tokenURI(log.data._tokenId)

	let clover = {
		name: tokenId,
		board: tokenId,
		owner: log.data._to,
		moves: cloverMoves,
		reward: padBigNum(cloverReward),
		symmetries: sym(cloverSymmetries),
		created: Number(cloverBlock),
		modified: Number(cloverBlock),
		// store price as hex, padded for sorting/filtering in DB
		price: padBigNum(price)
	}
	let command = r
		.db('clovers_v2')
		.table('clovers')
		.insert(clover)
	await dodb(db, command)
	io && io.emit('addClover', clover)

	// wait til afterwards so the clover shows up (even if it's just pending)
	if (log.data._to.toLowerCase().replace('0x', '') === events.Clovers.address) {
		console.log('this clover is in limbo and needs to be verified')
		let verified = isValid(tokenId, cloverMoves, cloverSymmetries)
		let initialBuild = process.argv.findIndex(c => c === 'build') > -1
		if (initialBuild) return
		if (verified) {
			await wallet.CloversController.retrieveStake(tokenId)
		} else {
			await wallet.CloversController.challengeClover(tokenId)
		}
	} else {
		console.log('this clover is fine')
	}
}
