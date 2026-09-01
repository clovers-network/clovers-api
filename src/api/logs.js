const debug = require('debug')('app:api:logs')
import resource from 'resource-router-middleware'
import { getStore } from '../lib/store'

export default ({ config, db, io }) => {
  const router = resource({
    id: 'log',

    async index ({ query }, res) {
      const indexes = ['Comment_Added', 'CloverName_Changed', 'Clovers_Transfer', 'SimpleCloversMarket_updatePrice', 'Coin_Activity']

      const pageSize = 24
      const asc = query.asc === 'true'
      const page = Math.max((parseInt(query.page) || 1), 1)
      const start = (page - 1) * pageSize
      // The ReQL `type` and `active` indexes are the feed_type and is_active
      // generated columns; the store picks between them on `filter`.
      const filter = (query.filter && indexes.includes(query.filter)) ? query.filter : null

      let results, count
      try {
        const store = getStore()
        count = store.countLogs(filter)
        results = store.listLogs({ filter, page, pageSize, asc })
          .map(l => store.hydrateLogUsers(l))
      } catch (err) {
        debug('query error')
        debug(err)
        return res.status(500).end()
      }

      const currentPage = page
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
