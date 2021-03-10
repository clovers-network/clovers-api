const debug = require('debug')('app:api:users')
import resource from 'resource-router-middleware'
import r from 'rethinkdb'
import { toRes, userTemplate, ZERO_ADDRESS } from '../lib/util'
import basicAuth from 'express-basic-auth'
import { auth } from '../middleware/auth'
import xss from 'xss'
import { provider } from '../lib/ethers-utils'
import escapeRegex from 'escape-string-regexp'
import { checkUserBalance } from '../models/clubToken'
import { syncClover } from '../models/clovers'

const semiSecretToken = process.env.SYNC_TOKEN

export default ({ config, db, io }) => {
  /** For requests with an `id`, you can auto-load the entity.
   *  Errors terminate the request, success sets `req[id] = data`.
   */
  const load = (req, id, callback) => {
    if (typeof id === 'string') {
      id = id.toLowerCase()
    }
    const defaultUser = userTemplate(id)
    r.table('users')
      .get(id)
      .default(defaultUser)
      .run(db, callback)
  }

  // const pageSize = 12;

  let router = resource({
    load,

    /** Property name to store preloaded entity on `request`. */
    id: 'user',

    /** GET / - List all entities */
    async index({ query }, res) {
      const filters = ['clovers', 'albums', 'modified', 'balance']

      // see ./search.js!
      let { s } = query
      if (s) {
        // debug('search users')

        s = escapeRegex(s)

        let results = await r.table('users').filter((doc) => {
          return doc('name').match(`(?i)${s}`).and(doc('address').ne(ZERO_ADDRESS))
        }).coerceTo('array').run(db, (err, data) => {
          if (err) throw err
          return data
        })

        res.status(200).json(results).end()
        return
      }

      // debug('get users')

      const { filter } = query

      const pageSize = 24
      const asc = query.asc === 'true'
      const sort = (filter && filters.includes(filter)) ? filter : 'balance'
      const start = Math.max(((parseInt(query.page) || 1) - 1), 0) * pageSize

      const index = `all-${sort}`

      // debug('get', index, sort)

      let [results, count] = await Promise.all([
        r.table('users')
          .between([true, r.minval], [true, r.maxval], { index })
          .orderBy({ index: asc ? r.asc(index) : r.desc(index) })
          .slice(start, start + pageSize)
          .coerceTo('array')
          .run(db, (err, data) => {
            if (err) throw err
            return data
          }),
        r.table('users')
          .between([true, r.minval], [true, r.maxval], { index })
          .count().run(db, (err, data) => {
            if (err) throw err
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
        filterBy: null,
        sort: asc ? 'ascending' : 'descending',
        orderBy: sort,
        perPage: pageSize,

        results
      }

      res.status(200).json(response).end()

      // let limit = parseInt(query.limit) || 100
      // let offset = parseInt(query.offset) || 0
      // limit = Math.min(limit, 500)
      // r.table('users')
      //   .slice(offset, offset + limit)
      //   .run(db, toRes(res))
    },

    /** GET /:id - Return a given entity */
    read({ user }, res) {
      res.json(user)
    }
  })

  router.get('/:id/clovers', async (req, res) => {
    const indexes = ['forsale', 'Sym']
    const map = {
      forsale: ['ownersale', true],
      Sym: ['ownersym', true]
    }

    const { id } = req.params
    const { filter } = req.query

    const owner = id.toLowerCase()

    const pageSize = 12
    const asc = req.query.asc === 'true'
    const sort = req.query.sort === 'price' ? '-price' : '-modified'

    const start = Math.max(((parseInt(req.query.page) || 1) - 1), 0) * pageSize

    const index = (!filter || filter === '' || !indexes.includes(filter)) ? `owner${sort}` : map[filter][0] + sort

    const min = r.minval
    const max = r.maxval

    // debug(owner, index)

    let [results, count] = await Promise.all([
      r.table('clovers')
        .between([owner, true, min], [owner, true, max], { index })
        .orderBy({ index: asc ? r.asc(index) : r.desc(index) })
        .slice(start, start + pageSize)
        .map((doc) => {
          return doc.merge({
            lastOrder: r.table('orders')
              .getAll(doc('board'), { index: 'market' })
              .orderBy(r.desc('created'), r.desc('transactionIndex'))
              .limit(1).fold(null, (l, r) => r)
          })
        }).eqJoin('owner', r.table('users'), { ordered: true })
        .without({ right: ['clovers', 'curationMarket'] })
        .map((doc) => {
          return doc('left').merge({
            user: doc('right')
          })
        }).coerceTo('array').run(db, (err, data) => {
          if (err) throw new Error(err)
          return data
        }),
      r.table('clovers')
        .between([owner, true, min], [owner, true, max], { index })
        .count().run(db, (err, data) => {
          if (err) throw new Error(err)
          return data
        })
    ]).catch((err) => {
      debug('query error')
      debug(err)
      return res.status(500).end()
    })

    const currentPage = Math.max((parseInt(req.query.page) || 1), 1)
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
      filterBy: id.toLowerCase(),
      sort: asc ? 'ascending' : 'descending',
      orderBy: 'modified',
      perPage: pageSize,

      results
    }

    const status = results.length ? 200 : 404

    res.status(status).json(response).end()
  })

  router.get('/:id/albums', async ({ params, query }, res) => {
    const { id } = params
    const pageSize = 12
    const index = 'userAddress'
    const asc = query.asc === 'true'
    const sort = query.sort || 'modified'
    const start = Math.max(((parseInt(query.page) || 1) - 1), 0) * pageSize

    let [results, count] = await Promise.all([
      r.table('albums')
        .getAll(id, { index })
        .orderBy(asc ? r.asc(sort) : r.desc(sort))
        .slice(start, start + pageSize)
        .run(db, (err, data) => {
          if (err) throw new Error(err)
          return data
        }),
      r.table('albums')
        .getAll(id, { index })
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
      filterBy: index,
      sort: asc ? 'ascending' : 'descending',
      orderBy: sort,

      results
    }

    const status = results.length ? 200 : 404

    res.status(status).json(response).end()
  })

  // router.get('/:id/balance', async (req, res) => {
  //   const { id } = req.params
  //   try {
  //     const user = await checkUserBalance(id, db)
  //     res.status(200).json(user).end()
  //   } catch (err) {
  //     res.status(500).json({ err: err.toString() }).end()
  //   }
  // })

  router.get('/sync/:id', async (req, res) => {
    const { s } = req.query
    if (s !== semiSecretToken) return res.sendStatus(401).end()

    const { id } = req.params

    try {
      const tokens = await r.table('clovers').filter({
        owner: id.toLowerCase()
      }).coerceTo('array').run(db, (err, data) => {
        if (err) throw err
        return data
      })

      if (tokens && tokens.length) {
        res.status(200).json({ sync: `${tokens.length} tokens`}).end()

        // in bg
        await asyncForEach(tokens, async (clover, index) => {
          debug(`syncing clover ${index}: ${clover.board}`)
          await syncClover(db, io, clover)
        })
      }

      res.status(404).end()

    } catch (err) {
      debug(err)
      res.status(500).end()
    }
  })

  async function asyncForEach (array, callback) {
    for (let index = 0; index < array.length; index++) {
      await callback(array[index], index, array)
    }
  }

  // Authentication header required
  // Format: btoa(Basic address:signedmessage)
  router.use(
    basicAuth({
      authorizer: auth
    })
  )

  router.put('/:id', async (req, res) => {
    const { id } = req.params
    const { user } = req.auth
    let name = req.body.name || ''
    let image = req.body.image || null
    name = xss(name).substring(0, 34)
    image = image && xss(image).substring(0, 64)
    load(req, id, async (err, dbUser) => {
      const modified = await provider.getBlockNumber()
      if (!dbUser.created) {
        dbUser = userTemplate(id.toLowerCase())
        dbUser.name = name
        dbUser.image = image
        dbUser.created = modified
        dbUser.modified = modified
      } else {
        dbUser.name = name
        dbUser.image = image
        dbUser.modified = modified
      }

      const owner = dbUser.address.toLowerCase() === user.toLowerCase()
      if (err || !owner) {
        res.sendStatus(401).end()
        return
      }

      // db update
      r.table('users')
        .insert(dbUser, { returnChanges: true, conflict: 'update' })
        .run(db, (err, { changes }) => {
          if (err) {
            res.sendStatus(500).end()
            return
          }
          if (changes[0]) {
            dbUser = changes[0].new_val
          }
          io.emit('updateUser', dbUser)
          res.json(dbUser).end()
        })
    })
  })
  return router
}
