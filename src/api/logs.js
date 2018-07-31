import resource from 'resource-router-middleware'

import r from 'rethinkdb'
import {toRes} from '../lib/util'

export default ({ config, db, io}) => resource({

  /** Property name to store preloaded entity on `request`. */
  id : 'log',

  /** For requests with an `id`, you can auto-load the entity.
   *  Errors terminate the request, success sets `req[id] = data`.
   */
  load(req, id, callback) {
    r.db('clovers_v2').table('logs').get(id).run(db, (err, log) => {
      callback(err, log)
    })
  },

  /** GET / - List all entities */
  index({ query }, res) {
    let limit = parseInt(query.limit) || 100
    let offset = parseInt(query.offset) || 0
    limit = Math.min(limit, 500)
    r.db('clovers_v2').table('logs').slice(offset, offset + limit).run(db, toRes(res))
  },

  /** POST / - Create a new entity */
  create({ body }, res) {
    res.json(body)
  },

  /** GET /:id - Return a given entity */
  read({ log }, res) {
    res.json(log)
  },

  /** PUT /:id - Update a given entity */
  update({ log, body }, res) {
    for (let key in body) {
      if (key!=='id') {
        log[key] = body[key]
      }
    }
    res.sendStatus(204)
  },

  /** DELETE /:id - Delete a given entity */
  delete({ log }, res) {
    // logs.splice(logs.indexOf(log), 1)
    res.sendStatus(204)
  }
})
