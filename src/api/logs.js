import resource from 'resource-router-middleware'

import r from 'rethinkdb'
import { toRes } from '../lib/util'

export default ({ config, db, io }) =>
  resource({
    id: 'log',

    load(req, id, callback) {
      r.db('clovers_v2')
        .table('logs')
        .get(id)
        .run(db, (err, log) => {
          callback(err, log)
        })
    },

    index({ query }, res) {
      let limit = parseInt(query.limit) || 50
      let offset = parseInt(query.offset) || 0
      limit = Math.min(limit, 150)
      r.db('clovers_v2')
        .table('logs')
        .getAll('pub', { index: 'activity' })
        .orderBy(r.desc('blockNumber'))
        .slice(offset, offset + limit)
        .run(db, toRes(res))
    },

    // create({ body }, res) {
    //   res.json(body)
    // },

    read({ log }, res) {
      res.json(log)
    },

    // update({ log, body }, res) {
    //   for (let key in body) {
    //     if (key !== 'id') {
    //       log[key] = body[key]
    //     }
    //   }
    //   res.sendStatus(204)
    // },

    // delete({ log }, res) {
    //   res.sendStatus(204)
    // }
  })
