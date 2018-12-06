const debug = require('debug')('app:api:chats')
import resource from 'resource-router-middleware'
import r from 'rethinkdb'
import { toRes, commentTemplate } from '../lib/util'
import basicAuth from 'express-basic-auth'
import { auth } from '../middleware/auth'
import xss from 'xss'

const whitelist = []

export default ({ config, db, io }) => {
  /** For requests with an `id`, you can auto-load the entity.
   *  Errors terminate the request, success sets `req[id] = data`.
   */
  const load = (req, id, callback) => {
    if (typeof id === 'string') {
      id = id.toLowerCase()
    }
    r.db('clovers_v2')
      .table('chats')
      .get(id)
      .default({})
      .run(db, callback)
  }

  // const pageSize = 12;

  let router = resource({
    load,

    /** Property name to store preloaded entity on `request`. */
    id: 'chat',

    /** GET / - List all entities */
    index({ query }, res) {
      let limit = parseInt(query.limit) || 100
      let offset = parseInt(query.offset) || 0
      limit = Math.min(limit, 500)
      r.db('clovers_v2')
        .table('chats')
        .slice(offset, offset + limit)
        .run(db, toRes(res))
    },

    /** POST / - Create a new entity */
    // create({ body }, res) {
    //   res.json(body)
    // },

    /** GET /:id - Return a given entity */
    read({ user }, res) {
      res.json(user)
    }
  })

  // Basic authentication
  router.use(
    basicAuth({
      authorizer: auth
    })
  )

  router.post('/:board', async (req, res) => {
    const { board } = req.params
    const userAddress = req.auth && req.auth.user
    if (!userAddress) {
      res.status(401).end()
      return
    }

    const user = await r.db('clovers_v2').table('users')
      .get(userAddress.toLowerCase()).pluck('address', 'name').run(db)
    const comment = xss(req.body.comment || '').trim()

    if (!comment.length) {
      res.status(400).end()
      return
    }

    // generate the chat
    const chat = commentTemplate(user, board.toLowerCase(), comment)
    // save it
    r.db('clovers_v2').table('chats')
      .insert(chat).run(db, (err, { generated_keys }) => {
        if (err) {
          debug('db run error')
          res.sendStatus(500).end()
          return
        }
        res.json({ ...chat, id: generated_keys[0] }).end()
      })
  })

  router.delete('/:id', async (req, res) => {
    const { id } = req.params
    const userAddress = req.auth && req.auth.user
    if (!userAddress) {
      res.status(401).end()
      return
    }

    const comment = await r.db('clovers_v2').table('chats')
      .get(id).default({}).without('clovers').run(db)

    if (!comment.id) {
      res.status(404).end()
      return
    }

    if (userAddress.toLowerCase() === comment.userAddress) {
      await r.db('clovers_v2').table('chats')
      .get(id).update({
        deleted: true,
        comment: 'Deleted',
        edited: r.now()
      }).run(db)
    } else {
      const board = await r.db('clovers_v2').table('clovers')
      .get(comment.board).run(db)

      if (
        userAddress.toLowerCase() === board.owner ||
        whitelist.includes(userAddress.toLowerCase())
      ) {
        await r.db('clovers_v2').table('chats')
        .get(id).update({
          flagged: true,
          edited: r.now()
        }).run(db)
      } else {
        res.status(401).end()
        return
      }
    }
    res.status(200).end()
  })

  return router
}
