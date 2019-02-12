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
      const start = Math.max(((parseInt(query.page) || 1) - 1), 0) * pageSize
      const filter = !query.filter || query.filter === '' ? ['pub'] : query.filter.split(',')
      const index = filter[0] !== 'pub' ? 'name' : 'activity'
      debug('filter by', ...filter)

      let [results, count] = await Promise.all([
        r.db('clovers_v2').table('logs')
          .getAll(...filter, { index })
          .orderBy(asc ? r.asc('blockNumber') : r.desc('blockNumber'))
          .slice(start, start + pageSize)
          .run(db, (err, data) => {
            if (err) throw new Error(err)
            return data
          }),
        r.db('clovers_v2').table('logs')
          .getAll(...filter, { index })
          .count().run(db, (err, data) => {
            if (err) throw new Error(err)
            return data
          })
      ]).catch((err) => {
        debug('query error')
        debug(err)
        return res.status(500).end()
      })

      const currentPage = Math.max((parseInt(query.page) || 1), 1)
      const hasNext = start + pageSize < count
      let prevPage = currentPage - 1 || null
      if (start >= count) {
        prevPage = Math.ceil(count / pageSize)
      }

      const response = {
        prevPage,
        page: currentPage,
        nextPage: hasNext ? currentPage + 1 : null,
        allResults: count,
        pageResults: results.length,
        filterBy: filter,
        sort: asc ? 'ascending' : 'descending',
        orderBy: 'blockNumber',

        results
      }

      const status = results.length ? 200 : 404

      res.status(status).json(response).end()
    }
  })

  return router
}
