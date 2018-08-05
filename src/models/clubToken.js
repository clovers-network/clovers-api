import r from 'rethinkdb'
import { dodb } from '../lib/util'
let db, io
export let clubTokenBurn = async function({ log, io: _io, db: _db }) {
	db = _db
	io = _io
	console.log(log.name + ' called')
	let user = log.data.burner
	let amount = log.data.value
	await changeUserBalance(user, amount, 'sub', log)
}
export let clubTokenMint = async function({ log, io, _db }) {
	db = _db
	io = _io
	console.log(log.name + ' called')
	let user = log.data.burner
	let amount = log.data.value
	await changeUserBalance(user, amount, 'add', log)
}
export let clubTokenApproval = async function({ log, io, _db }) {
	// db = _db
	//  io = _io

	console.log(log.name + ' does not affect the database')
}
// event Transfer(address indexed from, address indexed to, uint256 value);
export let clubTokenTransfer = async ({ log, io, _db }) => {
	db = _db
	io = _io
	console.log(log.name + ' called')
	let from = log.data.from
	let to = log.data.to
	let amount = log.data.value
	await changeUserBalance(to, amount, 'add', log)
	await changeUserBalance(from, amount, 'sub', log)
}
export let clubTokenOwnershipTransferred = async ({ log, io, _db }) => {
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
	user.balance = padBigNum(
		add
			? new BigNumber(user.balance).add(amount).toString(16)
			: new BigNumber(user.balance).sub(amount).toString(16)
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
