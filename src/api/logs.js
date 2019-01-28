const debug = require('debug')('app:api:logs')
import resource from 'resource-router-middleware'
import r from 'rethinkdb'
import { toRes } from '../lib/util'


export default ({ config, db, io }) => {
  const id = 'log'
  const load = (req, id, callback) => {
    r.db('clovers_v2')
      .table('logs')
      .get(id)
      .run(db, callback)
  }
  const router = resource({
    id,
    load,

    async index ({ query }, res) {
      const pageSize = 24
      const asc = query.asc === 'true'
      const page = ((parseInt(query.page) || 1) - 1) * pageSize
      const filter = !query.filter || query.filter === '' ? 'pub' : query.filter
      const index = filter !== 'pub' ? 'name' : 'activity'

      let [results, count] = await Promise.all([
        r.db('clovers_v2').table('logs')
          .getAll(filter, { index })
          .orderBy(asc ? r.asc('blockNumber') : r.desc('blockNumber'))
          .slice(page, page + pageSize)
          .run(db, (err, data) => {
            if (err) throw new Error(err)
            return data
          }),
        r.db('clovers_v2').table('logs')
          .getAll(filter, { index })
          .count().run(db, (err, data) => {
            if (err) throw new Error(err)
            return data
          })
      ]).catch((err) => {
        debug('query error')
        debug(err)
      })

      const currentPage = parseInt(query.page) || 1
      const hasNext = page + pageSize < count

      let response = {
        page: currentPage,
        allResults: count,
        pageResults: results.length,
        filterBy: filter,
        orderBy: asc ? 'ascending' : 'descending',
        prevPage: currentPage - 1 || false,
        nextPage: hasNext ? currentPage + 1 : false,
        results
      }

      const status = results.length ? 200 : 404

      res.status(status).json(response).end()
    }
  })

  return router
}

// export function toRes(res, status = 200) {
//   return (err, thing) => {
//     if (err) return res.status(500).send(err)

//     if (thing && typeof thing.toObject === 'function') {
//       thing = thing.toObject()
//     }
//     thing
//       .toArray()
//       .then(results => {
//         res.status(status).json(results)
//       })
//       .error(console.log)
//   }
// }
