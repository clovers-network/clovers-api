import resource from 'resource-router-middleware'
// import clovers from '../models/clovers'
import r from 'rethinkdb'
import { toRes, toSVG } from '../lib/util'
import basicAuth from 'express-basic-auth'
import { auth } from '../middleware/auth'
import xss from 'xss'

export default ({ config, db, io }) => {
	const load = (req, id, callback) => {
		r.db('clovers_v2')
			.table('clovers')
			.get(id)
			.run(db, callback)
	}

	const pageSize = 12

	let router = resource({
		id: 'clover',

		load,

		index({ query }, res) {
			r.db('clovers_v2')
				.table('clovers')
				.orderBy(r.desc('modified'))
				.run(db, toRes(res))

			/* -------- paginated version ---------------- */
			// const before = parseInt(query.before) || false
			// const page = Math.min((parseInt(query.page) || 1), 1e6)
			// const all = query.all && query.all === 'true'
			// if (before) {
			//   r.db('clovers_v2').table('clovers')
			//     .orderBy(r.desc('modified'))
			//     .filter(r.row('modified').lt(before))
			//     .limit(pageSize).run(db, toRes(res))
			// } else {
			//   const offset = all ? 0 : pageSize * (page - 1)
			//   const newLimit = all ? (pageSize * page) : pageSize
			//   r.db('clovers_v2').table('clovers')
			//     .orderBy(r.desc('modified'))
			//     .skip(offset).limit(newLimit).run(db, toRes(res))
			// }
		},

		read({ clover }, res) {
			res.json(clover)
		}
	})

	router.get('/svg/:id/:size?', async (req, res) => {
		try {
			let { id, size } = req.params
			const svg = await toSVG(id, size || 400)

			res.setHeader('Content-Type', 'image/svg+xml')
			res.send(svg)
		} catch (err) {
			console.log('No ID, or invalid')
			res.sendStatus(404)
		}
	})

	// Basic authentication
	router.use(
		basicAuth({
			authorizer: auth
		})
	)

	router.put('/:id', async (req, res) => {
		const { id } = req.params
		const { user } = req.auth
		let name = req.body.name || ''
		name = xss(name).substring(0, 34)
		load(req, id, (err, clover) => {
			const owner = clover.owner.toLowerCase() === user.toLowerCase()
			if (err || !owner) {
				res.sendStatus(401).end()
				return
			}

			// db update
			r.db('clovers_v2')
				.table('clovers')
				.get(clover.board)
				.update({ name }, { returnChanges: true })
				.run(db, (err, { changes }) => {
					if (err) {
						res.sendStatus(500).end()
						return
					}
					if (changes[0]) {
						clover = changes[0].new_val
					}
					io.emit('updateClover', clover)
					res.sendStatus(200).end()
				})
		})
	})

	return router
}

function isOwner(wallet, record) {
	return record.owner === wallet
}
