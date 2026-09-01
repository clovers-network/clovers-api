import resource from 'resource-router-middleware'

import { getStore } from '../lib/store'

export default ({ config, db, io }) =>
  resource({
    /** Property name to store preloaded entity on `request`. */
    id: 'order',

    /** For requests with an `id`, you can auto-load the entity.
     *  Errors terminate the request, success sets `req[id] = data`.
     */
    load (req, id, callback) {
      // The `id` here is a market, not an order id: the original ranged over
      // the [market, created, logIndex] `ordered` index with min/max bounds,
      // which is a "all orders in this market, newest first" query.
      try {
        callback(null, getStore().ordersForMarket(id, { limit: 2000 }))
      } catch (err) {
        callback(err)
      }
    },

    /** GET / - List all entities */
    index ({ query }, res) {
      let limit = parseInt(query.limit) || 100
      let offset = parseInt(query.offset) || 0
      limit = Math.min(limit, 500)
      res.json(getStore().listOrders({ limit, offset }))
    },

    /** GET /:id - Return a given entity */
    read ({ order }, res) {
      res.json(order)
    }
  })
