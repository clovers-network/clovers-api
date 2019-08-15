const debug = require('debug')('app:api:albums')
import resource from 'resource-router-middleware'
import r from 'rethinkdb'
import { toRes, sanitizeClovers, albumTemplate } from '../lib/util'
import basicAuth from 'express-basic-auth'
import { auth } from '../middleware/auth'
import xss from 'xss'
import uuid from 'uuid/v4'
import { provider } from '../lib/ethers-utils'

// addresses that can moderate comments :)
const whitelist = []

export default ({ config, db, io }) => {
  const load = (req, id, callback) => {
    console.log('load album', id)
    if (typeof id === 'string') {
      id = id.toLowerCase()
    }
    r.table('albums')
    .get(id)
    .default({})
    .run(db, (res) => {
      console.log({res})
      callback(res)
    })
  }

  let router = resource({
    load,
    id: 'albums',
    // GET /
    async index ({query}, res) {
      console.log('albums index')
      const indexes = ['all', 'name', 'userAddress', 'dates', 'cloverCount']
      const pageSize = 12
      const sort = query.sort || 'modified'
      const asc = query.asc === 'true'
      const start = Math.max(((parseInt(query.page) || 1) - 1), 0) * pageSize
      const index = !query.filter || query.filter === '' || !indexes.includes(query.filter) ? 'all' : query.filter
      debug('filter by', index, sort)

      let [results, count] = await Promise.all([
        r.table('albums')
          .getAll(true, { index })
          .orderBy(asc ? r.asc(sort) : r.desc(sort))
          .slice(start, start + pageSize)
          .run(db, (err, data) => {
            if (err) throw new Error(err)
            return data
          }),
        r.table('albums')
          .getAll(true, { index })
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
    },
    // GET
    async read ({id}, res) {
      debug('???', id)
      console.log({req})
      console.log('albums read')

      const result = await new Promise((resolve, reject) => {
        r.table('albums').get(id)
        .default({})
        .run(db, (err, data) => {
          if (err) reject(err)
          console.log({data})
          resolve(data)
          return
        })
      }).catch((err) => {
        debug('query error')
        debug(err)
        return res.status(500).end()
      })
      // console.log({result})

      const response = {
        result
      }

      // const status = results.length ? 200 : 404
      const status = 200

      res.status(status).end()//json(response).end()
    }

    // read({ clover }, res) {
    //   res.json(clover)
    // }
  })

  // Authentication header required
  // Format: btoa(Basic address:signedmessage)
  router.use(
    basicAuth({
      authorizer: auth
    })
  )

  router.put('/:albumName', async (req, res) => {
    console.log('albums new')
    var {clovers} = req.body
    var {albumName} = req.params
    console.log({albumName, clovers})

    const userAddress = req.auth && req.auth.user
    if (!userAddress) {
      console.log('no user')
      res.status(401).end()
      return
    }

    const user = await r.table('users')
      .get(userAddress.toLowerCase()).default({})
      .pluck('address', 'name').run(db)
    console.log({user})
    if (!user.address) {
      res.status(400).end()
      return
    }

    const albumExists = await r.table('albums')
    .get(albumName).run(db)

    if (albumExists) {
      // album already named this
      res.status(401).end()
      return
    }

    const album = albumTemplate(user, albumName, albumName)
    const blockNum = await provider.getBlockNumber().catch((err) => {
      debug(err.toString())
      return 0
    })
    // save it
    r.table('albums')
    .insert(album).run(db, async (err, { generated_keys }) => {
      if (err) {
        debug('db run error')
        res.sendStatus(500).end()
        return
      }
      // emit an event pls
      const log = {
        id: uuid(),
        name: 'Album_Created',
        removed: false,
        blockNumber: blockNum,
        userAddress: null, // necessary data below
        data: {
          userAddress: album.userAddress,
          name: album.name,
          board: album.clovers.length > 0 && album.clovers[0],
          createdAt: new Date()
        }
      }
      r.table('logs').insert(log)
        .run(db, (err) => {
          if (err) {
            debug('album log not saved')
            debug(err)
          } else {
            io.emit('newLog', log)
          }
          res.json({ ...album, id: generated_keys[0] }).end()
        })
    })
  })

  router.put('/:id', async (req, res) => {
    debug('albums id')

    let { albumName, clovers } = req.params
    const userAddress = req.auth && req.auth.user
    if (!userAddress) {
      res.status(401).end()
      return
    }

    const user = await r.table('users')
      .get(userAddress.toLowerCase()).default({})
      .pluck('address', 'name').run(db)
        
    // album must r
    if (!user.address) {
      res.status(400).end()
      return
    }

    const album = await r.table('albums')
      .getAll(albumName, {index: 'name'}).run(db)

    // check if album already exists with name but with different id
    if (album.id !== id) {
      // album already named this
      res.status(401).end()
      return
    }

 

    albumName = xss(albumName)
    // check if albumName was changed
    if (album.name !== albumName && album.userAddress !== user.address) {
      // cant change name of album unless you are owner
      res.status(401).end()
      return
    }

    clovers = sanitizeClovers(clovers)

    // check if any clovers were removed... 
    let cloversCopy = JSON.parse(JSON.stringify(album.clovers))
    clovers.forEach(c => {
      let i = cloversCopy.indexOf(c)
      cloversCopy.splice(i, 1)
    });
    if(cloversCopy.length > 0 && album.userAddress !== user.address) {
      // can't remove clovers unless you own the album
      res.status(401).end()
      return
    }

    // must update something
    if (album.name === albumName && album.clovers.join('') === clovers.join('')) {
      res.status(400).end()
      return
    }

    const blockNum = await provider.getBlockNumber().catch((err) => {
      debug(err.toString())
      return 0
    })
    // update it
    r.table('albums').get(album.id).update({
      name: albumName,
      clovers: clovers,
      modified: new Date()
    }).run(db, async (err,  res) => {
      if (err) {
        debug('db run error')
        res.sendStatus(500).end()
        return
      }
      // emit an event pls
      const log = {
        id: uuid(),
        name: 'Album_Updated',
        removed: false,
        blockNumber: blockNum,
        userAddress: null, // necessary data below
        data: {
          userAddress: user.address,
          name: albumName,
          board: clovers.length > 0 && clovers[0],
          createdAt: new Date()
        }
      }
    
      r.table('logs').insert(log)
        .run(db, (err) => {
          if (err) {
            debug('album log not saved')
            debug(err)
          } else {
            io.emit('newLog', log)
          }
          res.json({ ...album, id }).end()
        })
      })
  })

  router.delete('/:id', async (req, res) => {
    console.log('albums delete')
    const { id } = req.params
    const userAddress = req.auth && req.auth.user
    if (!userAddress) {
      res.status(401).end()
      return
    }

    const album = await r.table('albums')
      .get(id).run(db)

    if (!album.id || album.userAddress !== userAddress.toLowerCase()) {
      res.status(404).end()
      return
    }

    await r.table('albums')
      .get(id).delete().run(db)

    res.status(200).end()
  })

  return router
}

export function albumListener (server, db) {
  const io = require('socket.io')(server, { path: '/albums' })
  let connections = 0
  io.on('connection', (socket) => {
    debug('+1 album subscribers: ', connections += 1)

    socket.on('disconnect', () => {
      debug('-1 album subscribers: ', connections -= 1)
    })
  })

  // listen to album changes :)
  r.table('albums').changes().run(db, (err, cursor) => {
    if (err) {
      console.error(err)
      return
    }
    cursor.each((err, doc) => {
      if (err) {
        console.error(err)
        return
      }
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
  })
}
