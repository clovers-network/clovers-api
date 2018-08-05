import resource from 'resource-router-middleware'

import r from 'rethinkdb'
import { toRes } from '../lib/util'
import basicAuth from 'express-basic-auth'
import { auth } from '../middleware/auth'
import xss from 'xss'

export default ({ config, db, io }) => {
  /** For requests with an `id`, you can auto-load the entity.
   *  Errors terminate the request, success sets `req[id] = data`.
   */
  const load = (req, id, callback) => {
    r.db('clovers_v2')
      .table('users')
      .get(id)
      .default({})
      .merge({
        clovers: r
          .db('clovers_v2')
          .table('clovers')
          .getAll(r.args(r.row('clovers').default([])))
          .coerceTo('array')
      })
      .run(db, callback)
  }

  // const pageSize = 12;

  let router = resource({
    /** Property name to store preloaded entity on `request`. */
    id: 'user',

    /** GET / - List all entities */
    index({ query }, res) {
      let limit = parseInt(query.limit) || 100
      let offset = parseInt(query.offset) || 0
      limit = Math.min(limit, 500)
      r.db('clovers_v2')
        .table('users')
        .slice(offset, offset + limit)
        .run(db, toRes(res))
    },

    /** POST / - Create a new entity */
    create({ body }, res) {
      // r.db('clovers_v2').table('users').get(id).update(user).run(db, (err, result) => {
      //   io.emit('updateUser', user)
      // })
      res.json(body)
    },

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

  router.put('/:id', async (req, res) => {
    const { id } = req.params
    const { user } = req.auth
    let name = req.body.name || ''
    name = xss(name).substring(0, 34)
    load(req, id, (err, dbUser) => {
      if (!dbUser) {
        dbUser = {
          name,
          address: user.toLowerCase(),
          clovers: [],
          created: null,
          modified: null
        }
      } else {
        dbUser.name = name
      }

      dbUser.clovers = dbUser.clovers.map(c => c.board)

      const owner = dbUser.address.toLowerCase() === user.toLowerCase()
      if (err || !owner) {
        res.sendStatus(401).end()
        return
      }
      // db update
      r.db('clovers_v2')
        .table('users')
        .insert(dbUser, { returnChanges: true, conflict: 'update' })
        .run(db, (err, { changes }) => {
          if (err) {
            res.sendStatus(500).end()
            return
          }
          if (changes[0]) {
            newUser = changes[0].new_val
          }
          io.emit('updateUser', newUser)
          res.sendStatus(200).end()
        })
    })
  })
  return router
}
