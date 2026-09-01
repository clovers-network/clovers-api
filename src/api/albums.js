const debug = require('debug')('app:api:albums')
import resource from 'resource-router-middleware'
import { albumTemplate, makeUser } from '../lib/util'
import { getStore } from '../lib/store'
import { onChange } from '../lib/store/changes'
import basicAuth from 'express-basic-auth'
import { auth } from '../middleware/auth'
import xss from 'xss'
import uuid from 'uuid/v4'
import { provider } from '../lib/chain'
import escapeRegex from 'escape-string-regexp'

// addresses that can moderate comments :)
// const whitelist = []

export default ({ config, db, io }) => {
  // This ran a query and then passed its result into run()'s *error* argument
  // -- `(res) => callback(res)` where the signature is (err, result). On
  // success that argument is null, so the query's result was thrown away and
  // req.id was never set; `read` below re-fetches by req.params.id anyway. It
  // was a no-op that cost a join per request, so it is one openly now.
  const load = (req, id, callback) => callback()

  let router = resource({
    load,
    id: 'id',

    // GET /
    async index ({ query }, res) {
      // see ./search.js
      let { s } = query
      if (s) {
        // debug('search albums')

        return res.status(200).json(getStore().searchAlbums(s)).end()
      }

      const { clover } = query
      if (clover) {
        // debug('albums by clover')

        const results = getStore().albumsContainingClover(clover)
          .map(({ id, clovers, name, userAddress }) => ({ id, clovers, name, userAddress }))
        return res.status(200).json(results).end()
      }

      // debug('get albums')

      const indexes = ['all', 'name', 'userAddress', 'dates', 'cloverCount']
      const pageSize = 12
      const sort = query.sort || 'modified'
      const asc = query.asc === 'true'
      const start = Math.max(((parseInt(query.page) || 1) - 1), 0) * pageSize
      const index = !query.filter || query.filter === '' || !indexes.includes(query.filter) ? 'all' : query.filter
      // debug('filter by', index, sort)

      // Every filter selects the same rows now. `name`, `userAddress`,
      // `dates` and `cloverCount` used to select nothing at all -- see
      // store.countAlbums. Where the filter names a real column it doubles as
      // the sort key, so ?filter=cloverCount orders by clover count instead of
      // returning an empty 404.
      const SORTABLE = ['name', 'userAddress', 'created', 'modified', 'cloverCount']
      const orderBy = SORTABLE.includes(query.sort) ? query.sort
        : SORTABLE.includes(index) ? index
        : sort
      const currentPage = Math.max((parseInt(query.page) || 1), 1)

      let results, count
      try {
        const store = getStore()
        count = store.countAlbums()
        results = store.listAlbums({ sort: orderBy, asc, page: currentPage, pageSize })
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
        orderBy,

        results
      }

      const status = results.length ? 200 : 404

      res.status(status).json(response).end()
    },
    // GET
    async read (req, res) {
      const { id } = req.params

      let result
      try {
        const store = getStore()
        // .default({}) -- a miss is an empty object, not a 404. Preserved
        // because the status below tests truthiness, and {} is truthy.
        result = store.withAlbumUser(store.getAlbum(id)) || {}
      } catch (err) {
        debug('query error')
        debug(err)
        return res.status(500).end()
      }

      const status = result ? 200 : 404
      res.status(status).json(result).end()
    }
  })

  router.get('/list/:index', async (req, res) => {
    let { index } = req.params
    index = index || 'all'
    try {
      const store = getStore()
      const result = store.listAlbums({ pageSize: -1 })
        .map(a => {
          const { id, clovers, name, userAddress } = a
          return { ...store.withAlbumUser({ id, clovers, name, userAddress }) }
        })
      res.status(200).json(result).end()
    } catch (err) {
      console.error(err)
      res.status(500).end()
    }
  })

  // Authentication header required
  // Format: btoa(Basic address:signedmessage)
  router.use(
    basicAuth({
      authorizer: auth
    })
  )

  // new album
  router.post('/', async (req, res) => {
    var { clovers, albumName } = req.body
    const userAddress = req.auth && req.auth.user
    if (!userAddress) {
      return res.status(401).end()
    }

    const store = getStore()
    const existing = store.getUser(userAddress)
    let user = existing ? { address: existing.address, name: existing.name } : {}

    // if user doesn't exist make them
    if (!user.address) {
      // The local makeUser was scoped inside the POST handler, so the PUT
      // handler below called an undefined name. Both now use the shared helper.
      user = await makeUser(db, io, userAddress, await provider.getBlockNumber())
    }

    if (!albumName) {
      return res.status(400).send('No album name provided')
    }

    const albumExists = store.albumsByName(albumName).length

    if (albumExists > 0) {
      // album already named this
      return res.status(400).send(`Album already exists`)
    }

    try {
      verifyClovers(clovers)
    } catch (error) {
      res.status(400).send(error.message)
      return
    }

    const album = albumTemplate(user, albumName, clovers)
    const blockNum = await provider.getBlockNumber().catch((err) => {
      debug(err.toString())
      return 0
    })
    // save it. The store assigns the primary key, so there is no
    // generated_keys to read back -- the saved row already carries it.
    let saved
    try {
      saved = store.insertAlbum(album).new_val
    } catch (err) {
      debug('db run error')
      debug(err)
      res.sendStatus(500).end()
      return
    }

    // DELIBERATE CHANGE, not a port artifact: the original recomputed
    // albumCount on PUT and DELETE but not on POST, so creating an album left
    // the owner's count stale until they next edited or deleted one -- which
    // is what /users?filter=albums sorts on. Recomputing here is idempotent
    // and makes the three write paths agree. Revert this one line to restore
    // the old behaviour exactly.
    store.recomputeAlbumCount(album.userAddress)

    // emit an event pls
    const log = {
      id: uuid(),
      name: 'Album_Created',
      removed: false,
      blockNumber: blockNum,
      userAddress: null, // necessary data below
      data: {
        id: saved.id,
        userAddress: album.userAddress,
        name: album.name,
        // `x.length > 0 && x[0]` yields the boolean `false` for an empty
        // album, not a missing field. 2,388 rows in production carry
        // `board: false`, and ReQL's clovers index called .downcase() on it,
        // errored, and dropped the row -- so album logs are silently absent
        // from every clover's activity feed. null keeps them out of a board's
        // feed without lying about the type.
        board: album.clovers.length > 0 ? album.clovers[0] : null,
        createdAt: new Date()
      },
      userAddresses: []
    }
    try {
      store.insertLog(log)
      io.emit('newLog', log)
    } catch (err) {
      debug('album log not saved')
      debug(err)
    }
    res.json(saved).end()
  })

  router.put('/:id', async (req, res) => {
    let { albumName, clovers } = req.body
    if (!albumName || !clovers) {
      return res.status(500).end()
    }
    const { id } = req.params

    const userAddress = req.auth && req.auth.user
    if (!userAddress) {
      console.error("no userAddress")
      res.status(401).end()
      return
    }

    const store = getStore()
    const existingUser = store.getUser(userAddress)
    let user = existingUser ? { address: existingUser.address, name: existingUser.name } : {}

    // if user doesnt exist add them to db
    if (!user.address) {
      // The local makeUser was scoped inside the POST handler, so the PUT
      // handler below called an undefined name. Both now use the shared helper.
      user = await makeUser(db, io, userAddress, await provider.getBlockNumber())
    }

    const albums = store.albumsByName(albumName)

    // check if album already exists with name but with different id
    if (albums.length > 0 && albums[0].id !== id) {
      return res.status(401).send('Different album with that name already exists')
    }

    const album = store.getAlbum(id)
    if (!album) {
      return res.status(404).end()
    }

    albumName = xss(albumName)
    // check if albumName was changed
    if (album.name !== albumName && album.userAddress !== user.address) {
      // cant change name of album unless you are owner
      return res.status(401).send('Only owner can change name')
    }

    try {
      verifyClovers(clovers)
    } catch (error) {
      return res.status(500).send(error.message)
    }

    // check if any clovers were removed...
    let cloversCopy = JSON.parse(JSON.stringify(album.clovers))
    clovers.forEach(c => {
      let i = cloversCopy.indexOf(c)
      cloversCopy.splice(i, 1)
    });
    if (cloversCopy.length > 0 && album.userAddress !== user.address) {
      // can't remove clovers unless you own the album
      return res.status(401).send('Only owner can remove clovers')
    }

    // must update something
    if (album.name === albumName && album.clovers.join('') === clovers.join('')) {
      return res.status(400).send('Must update something')
    }

    const blockNum = await provider.getBlockNumber().catch((err) => {
      debug(err.toString())
      return 0
    })
    album.name = albumName
    album.clovers = clovers
    // `modified` is an ISO string everywhere else in this table; a Date object
    // only worked because the driver serialised it. Write the string.
    album.modified = new Date().toISOString()
    // update it
    try {
      store.updateAlbum(id, {
        name: album.name,
        clovers: album.clovers,
        modified: album.modified
      })
    } catch (err) {
      console.error('db run error')
      console.error(err)
      res.status(500).end()
      return
    }

    // update the user
    store.recomputeAlbumCount(user.address)

    // emit an event pls
    const log = {
      id: uuid(),
      name: 'Album_Updated',
      removed: false,
      blockNumber: blockNum,
      userAddress: null, // necessary data below
      data: {
        id,
        userAddress: user.address,
        name: albumName,
        board: clovers.length > 0 ? clovers[0] : null,
        createdAt: new Date()
      },
      userAddresses: []
    }

    try {
      store.insertLog(log)
      io.emit('newLog', log)
    } catch (err) {
      debug('album log not saved')
      debug(err)
    }
    res.status(200).json({ ...album, id }).end()
  })

  router.delete('/:id', async (req, res) => {
    const { id } = req.params
    const userAddress = req.auth && req.auth.user
    if (!userAddress) {
      return res.status(401).end()
    }

    const store = getStore()
    const album = store.getAlbum(id)

    if (!album || !album.id || album.userAddress !== userAddress.toLowerCase()) {
      return res.status(404).end()
    }

    store.deleteAlbum(id)

    // update the user
    store.recomputeAlbumCount(userAddress)

    res.status(200).end()
  })

  return router
}

export function albumListener (server, db) {
  const { Server: SocketServer } = require('socket.io')
  const io = new SocketServer(server, { path: '/albums', cors: { origin: '*' } })
  // let connections = 0
  // io.on('connection', (socket) => {
  //   debug('+1 album subscribers: ', connections += 1)

  //   socket.on('disconnect', () => {
  //     debug('-1 album subscribers: ', connections -= 1)
  //   })
  // })

  // listen to album changes :)
  //
  // Was r.table('albums').changes(); the store emits the same {new_val,
  // old_val} shape after every write. See lib/store/changes.js.
  onChange('albums', (doc) => {
    if (doc.new_val && !doc.old_val) {
      debug('new album', doc.new_val.id)
      io.emit('new album', doc.new_val)
    } else if (!doc.new_val) {
      // deleted comment
      debug('album deleted', doc.old_val.id)
      io.emit('delete album', doc.old_val)
    } else {
      // probably an update
      debug('update album', doc.new_val.id)
      io.emit('edit album', doc.new_val)
    }
  })

}

function verifyClovers (clovers) {
  const regex = /\b(0x[0-9a-fA-F]+|[0-9]+)\b/g;
  clovers.forEach(c => {
    if (c.slice(0, 2) !== '0x') {
      throw new Error(c + ' is not a valid format')
    }
    if (c.length !== 34) {
      throw new Error(c + ' is not a valid Clover')
    }
    if (!c.match(regex)) {
      throw new Error(c + ' is not hex')
    }
    if (clovers.filter(cc => cc.toLowerCase() === c.toLowerCase()).length !== 1) {
      throw new Error(c + ' is included multiple times')
    }

  })

  const store = getStore()
  clovers.forEach(c => {
    if (store.cloverExists(c) !== 1) {
      throw new Error(c + ' does not exist')
    }
  })
}
