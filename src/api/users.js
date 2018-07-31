import resource from 'resource-router-middleware'

import r from 'rethinkdb'
import {toRes} from '../lib/util'

export default ({ config, db, io}) => resource({

  /** Property name to store preloaded entity on `request`. */
  id : 'user',

  /** For requests with an `id`, you can auto-load the entity.
   *  Errors terminate the request, success sets `req[id] = data`.
   */
  load(req, id, callback) {
    r.db('clovers_v2').table('users').get(id).run(db, (err, user) => {
      callback(err, user)
    })
  },

  /** GET / - List all entities */
  index({ query }, res) {
    let limit = parseInt(query.limit) || 100
    let offset = parseInt(query.offset) || 0
    limit = Math.min(limit, 500)
    r.db('clovers_v2').table('users').slice(offset, offset + limit).run(db, toRes(res))
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
  },

  /** PUT /:id - Update a given entity */
  update({ user, body }, res) {
    for (let key in body) {
      if (key!=='id') {
        user[key] = body[key]
      }
    }
    res.sendStatus(204)
  },

  /** DELETE /:id - Delete a given entity */
  delete({ user }, res) {
    // users.splice(users.indexOf(user), 1)
    res.sendStatus(204)
  }
})
