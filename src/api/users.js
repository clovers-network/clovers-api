const debug = require('debug')('app:api:users')
import resource from 'resource-router-middleware'
import r from 'rethinkdb'
import { toRes, userTemplate } from '../lib/util'
import basicAuth from 'express-basic-auth'
import { auth } from '../middleware/auth'
import xss from 'xss'
import { provider } from '../lib/ethers-utils'

export default ({ config, db, io }) => {
  /** For requests with an `id`, you can auto-load the entity.
   *  Errors terminate the request, success sets `req[id] = data`.
   */
  const load = (req, id, callback) => {
    if (typeof id === 'string') {
      id = id.toLowerCase()
    }
    r.db('clovers_v2')
      .table('users')
      .get(id)
      .default({})
      .do((doc) => {
        return r.branch(
          doc.hasFields('clovers'),
          doc,
          doc.merge({ clovers: [] })
        )
      })
      .run(db, callback)
  }

  // const pageSize = 12;

  let router = resource({
    load,

    /** Property name to store preloaded entity on `request`. */
    id: 'user',

    /** GET / - List all entities */
    async index({ query }, res) {
      const pageSize = 12
      const asc = query.asc === 'true'
      const start = Math.max(((parseInt(query.page) || 1) - 1), 0) * pageSize
      debug('get users')

      let [results, count] = await Promise.all([
        r.db('clovers_v2').table('users')
          // .getAll(true, { index })
          .orderBy(asc ? r.asc('modified') : r.desc('modified'))
          .slice(start, start + pageSize)
          .run(db, (err, data) => {
            if (err) throw new Error(err)
            return data
          }),
        r.db('clovers_v2').table('users')
          // .getAll(true, { index })
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
        filterBy: null,
        orderBy: asc ? 'ascending' : 'descending',

        results
      }

      const status = results.length ? 200 : 404

      res.status(status).json(response).end()

      // let limit = parseInt(query.limit) || 100
      // let offset = parseInt(query.offset) || 0
      // limit = Math.min(limit, 500)
      // r.db('clovers_v2')
      //   .table('users')
      //   .slice(offset, offset + limit)
      //   .run(db, toRes(res))
    },

    /** GET /:id - Return a given entity */
    read({ user }, res) {
      res.json(user)
    }
  })

  router.get('/:id/clovers', async (req, res) => {
    const { id } = req.params
    const pageSize = 12
    const asc = req.query.asc === 'true'
    const start = Math.max(((parseInt(req.query.page) || 1) - 1), 0) * pageSize
    const index = 'owner'
    debug('get user clovers', start)

    let [results, count] = await Promise.all([
      r.db('clovers_v2').table('clovers')
        .getAll(id.toLowerCase(), { index })
        .orderBy(asc ? r.asc('modified') : r.desc('modified'))
        .slice(start, start + pageSize)
        .map((doc) => {
          return doc.merge({
            commentCount: r.db('clovers_v2').table('chats')
              .getAll(doc('board'), { index: 'board' }).count(),
            lastOrder: r.db('clovers_v2').table('orders')
              .getAll(doc('board'), { index: 'market' })
              .orderBy(r.desc('created'), r.desc('transactionIndex'))
              .limit(1).fold(null, (l, r) => r)
          })
        }).run(db, (err, data) => {
          if (err) throw new Error(err)
          return data
        }),
      r.db('clovers_v2').table('clovers')
        .getAll(id.toLowerCase(), { index })
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
      orderBy: asc ? 'ascending' : 'descending',

      results
    }

    const status = results.length ? 200 : 404

    res.status(status).json(response).end()
  })

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
    name = xss(name).substring(0, 34)
    load(req, id, async (err, dbUser) => {
      const modified = await provider.getBlockNumber()
      if (!dbUser.address) {
        dbUser = userTemplate(id.toLowerCase())
        dbUser.name = name
        dbUser.created = modified
        dbUser.modified = modified
      } else {
        dbUser.name = name
        dbUser.modified = modified
      }

      const owner = dbUser.address.toLowerCase() === user.toLowerCase()
      if (err || !owner) {
        res.sendStatus(401).end()
        return
      }

      // db update
      r.db('clovers_v2')
        .table('users')
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
