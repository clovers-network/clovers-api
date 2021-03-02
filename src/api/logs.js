const debug = require('debug')('app:api:logs')
import resource from 'resource-router-middleware'
import r from 'rethinkdb'
// import { toRes } from '../lib/util'


export default ({ config, db, io }) => {
  // const load = (req, id, callback) => {
  //   r.table('logs')
  //     .get(id)
  //     .run(db, callback)
  // }
  const router = resource({
    id: 'log',
    // load,

    async index ({ query }, res) {
      const indexes = ['Comment_Added', 'CloverName_Changed', 'Clovers_Transfer', 'SimpleCloversMarket_updatePrice', 'Coin_Activity']

      const pageSize = 24
      const asc = query.asc === 'true'
      const start = Math.max(((parseInt(query.page) || 1) - 1), 0) * pageSize
      const index = (query.filter && indexes.includes(query.filter)) ? 'type' : 'active' // 'activity'
      const val = index === 'type' ? query.filter : true

      // debug('filter by', val)

      let [results, count] = await Promise.all([
        r.table('logs')
          .between([val, r.minval], [val, r.maxval], { index })
          .orderBy({ index: asc ? r.asc(index) : r.desc(index)})
          .slice(start, start + pageSize)
          .map((doc) => {
            return doc.merge({
              userAddresses:  r.branch(
                doc.hasFields('userAddresses'),
                doc('userAddresses').map(u => {
                  return {
                    id: u('id'),
                    address: r.table('users')
                      .get(u('address'))
                      .default({address: u('address')})
                      .without('clovers', 'curationMarket')
                  }
                }),
                doc.hasFields('userAddress'),
                doc('userAddress'),
                []
              )
            })
          })
          .coerceTo('array')
          .run(db, (err, data) => {
            if (err) throw new Error(err)
            return data
          }),
        r.table('logs')
          .between([val, r.minval], [val, r.maxval], { index })
          .pluck('id').coerceTo('array').run(db)
      ]).catch((err) => {
        debug('query error')
        debug(err)
        return res.status(500).end()
      })

      count = count.length

      debug('results count', count)

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
