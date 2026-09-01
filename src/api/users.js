const debug = require('debug')('app:api:users')
import resource from 'resource-router-middleware'
import { userTemplate } from '../lib/util'
import { getStore } from '../lib/store'
import basicAuth from 'express-basic-auth'
import { auth } from '../middleware/auth'
import xss from 'xss'
import { provider } from '../lib/chain'
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
    try {
      // ReQL's .default() here means a miss returns a synthetic user rather
      // than a 404, which PUT /:id relies on to create one.
      callback(null, getStore().getUser(id) || userTemplate(id))
    } catch (err) {
      callback(err)
    }
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

        res.status(200).json(getStore().searchUsers(s)).end()
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

      const currentPage = Math.max((parseInt(query.page) || 1), 1)

      let results, count
      try {
        const store = getStore()
        // Every all-* index shares the same address <> ZERO predicate, so the
        // count does not depend on which one the sort picked.
        count = store.countUsers()
        results = store.listUsers({ sort, asc, page: currentPage, pageSize })
      } catch (err) {
        debug('query error')
        debug(err)
        return res.status(500).end()
      }
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

    const cloverFilter = (!filter || filter === '' || !indexes.includes(filter)) ? null : filter
    const currentPage = Math.max((parseInt(req.query.page) || 1), 1)

    let results, count
    try {
      const store = getStore()
      count = store.countCloversByOwner(owner, cloverFilter)
      results = store.cloversByOwner(owner, {
        page: currentPage, pageSize, sort: sort.substr(1), asc, filter: cloverFilter
      }).map(c => {
        const u = store.getUser(c.owner)
        if (u) { delete u.clovers; delete u.curationMarket }
        // Left join, not the inner eqJoin the original used -- see
        // store.listCloversWithUsers for why that silently shortened pages.
        return { ...c, lastOrder: store.lastOrderForMarket(c.board) || null, user: u || null }
      })
    } catch (err) {
      debug('query error')
      debug(err)
      return res.status(500).end()
    }
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

    const currentPage = Math.max((parseInt(query.page) || 1), 1)

    let results, count
    try {
      const store = getStore()
      count = store.countAlbumsByUser(id)
      results = store.albumsByUser(id, { sort, asc, page: currentPage, pageSize })
    } catch (err) {
      debug('query error')
      debug(err)
      return res.status(500).end()
    }
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
      const tokens = getStore().allCloversByOwner(id)

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
      try {
        const written = getStore().insertUser(dbUser, { conflict: 'update' })
        if (written.new_val) {
          dbUser = written.new_val
        }
      } catch (err) {
        debug(err)
        res.sendStatus(500).end()
        return
      }
      io.emit('updateUser', dbUser)
      res.json(dbUser).end()
    })
  })
  return router
}
