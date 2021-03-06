import resource from 'resource-router-middleware'

import r from 'rethinkdb'
import { toRes } from '../lib/util'

export default ({ config, db, io }) =>
  resource({
    /** Property name to store preloaded entity on `request`. */
    id: 'order',

    /** For requests with an `id`, you can auto-load the entity.
     *  Errors terminate the request, success sets `req[id] = data`.
     */
    load(req, id, callback) {
      r.table('orders')
        .between([id, r.minval, r.minval], [id, r.maxval, r.maxval], { index: 'ordered' })
        .orderBy({ index: r.desc('ordered') })
        // .orderBy(r.desc('created'), r.desc('transactionIndex'))
        .slice(0, 2000)
        .coerceTo('array')
        .run(db, (err, order) => {
          callback(err, order)
        })
    },

    /** GET / - List all entities */
    index({ query }, res) {
      let limit = parseInt(query.limit) || 100
      let offset = parseInt(query.offset) || 0
      limit = Math.min(limit, 500)
      r.table('orders')
        .orderBy({ index: r.desc('created') })
        // .orderBy({ index: r.desc('created') })
        // .orderBy(r.desc('created'), r.desc('transactionIndex'))
        .slice(offset, offset + limit)
        .run(db, toRes(res))
    },

    /** GET /:id - Return a given entity */
    read({ order }, res) {
      res.json(order)
    }
  })
