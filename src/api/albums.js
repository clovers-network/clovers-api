const debug = require('debug')('app:api:albums')
import resource from 'resource-router-middleware'
import r from 'rethinkdb'
import { toRes, userTemplate, albumTemplate } from '../lib/util'
import basicAuth from 'express-basic-auth'
import { auth } from '../middleware/auth'
import xss from 'xss'
import uuid from 'uuid/v4'
import { provider } from '../lib/ethers-utils'

// addresses that can moderate comments :)
// const whitelist = []

export default ({ config, db, io }) => {
  const load = (req, id, callback) => {
    r.table('albums')
    .get(id)
    .default({})
    .do((doc) => {
      return doc.merge({
        user: r.table('users').get(doc('userAddress'))
        .without('clovers', 'curationMarket').default(null)
      })
    })
    .run(db, (res) => {
      callback(res)
    })
  }

  let router = resource({
    load,
    id: 'id',

    // GET /
    async index ({ query }, res) {
      // see ./search.js
      const { s } = query
      if (s) {
        debug('search albums')

        let results = await r.table('albums').filter((doc) => {
          return doc('name').match(`(?i)${s}`)
        }).coerceTo('array').run(db, (err, data) => {
          if (err) throw new Error(err)
          return data
        })

        return res.status(200).json(results).end()
      }

      const { clover } = query
      if (clover) {
        debug('albums by clover')

        let results = await r.table('albums').getAll(clover.toLowerCase(), { index: 'clovers' })
          .pluck('id', 'clovers', 'name', 'userAddress').coerceTo('array')
          .orderBy(r.desc('name'))
          .run(db, (err, data) => {
            if (err) throw new Error(err)
            return data
          })
        return res.status(200).json(results).end()
      }

      debug('get albums')

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
          .map((doc) => {
            return doc.merge({
              user: r.table('users').get(doc('userAddress'))
              .without('clovers', 'curationMarket').default(null)
            })
          })
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
    async read (req, res) {
      const { id } = req.params

      const result = await r.table('albums').get(id)
        .do((doc) => {
          return doc.merge({
            user: r.table('users').get(doc('userAddress'))
            .without('clovers', 'curationMarket').default(null)
          })
        })
        .default({})
        .run(db)
        .catch((err) => {
          debug('query error')
          debug(err)
          return res.status(500).end()
        })


      const status = result ? 200 : 404
      res.status(status).json(result).end()
    }
  })

  router.get('/list/:index', async (req, res) => {
    let { index } = req.params
    index = index || 'all'
    let result = await r.table('albums')
      .getAll(true, { index })
      .pluck('id', 'clovers', 'name', 'userAddress')
      .map((doc) => {
        return doc.merge({
          user: r.table('users').get(doc('userAddress'))
          .without('clovers', 'curationMarket').default(null)
        })
      }).coerceTo('array').run(db).catch((err) => {
        console.error(err)
        res.result(500).end()
      })
      res.status(200).json(result).end()
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

    let user = await r.table('users')
      .get(userAddress.toLowerCase()).default({})
      .pluck('address', 'name').run(db)

    // if user doesn't exist make them
    if (!user.address) {
      user = await makeUser(userAddress)
    }

    if (!albumName) {
      return res.status(400).send('No album name provided')
    }

    const albumExists = await r.table('albums')
    .getAll(albumName.toLowerCase(), { index: 'name' }).count().run(db).catch((err, data) => {
      if (err) console.error({err})
      return data
    })

    if (albumExists > 0) {
      // album already named this
      return res.status(400).send(`Album Exists`)
    }

    try {
      await verifyClovers(clovers, db)
    } catch(error) {
      res.status(400).send(error.message)
      return
    }

    const album = albumTemplate(user, albumName, clovers)
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
          id: generated_keys[0],
          userAddress: album.userAddress,
          name: album.name,
          board: album.clovers.length > 0 && album.clovers[0],
          createdAt: new Date()
        },
        userAddresses: []
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


    async function makeUser(userAddress) {
      const modified = await provider.getBlockNumber()
      var user = userTemplate(userAddress.toLowerCase())
      user.created = modified
      user.modified = modified

      // db update
      const { changes } = await r.table('users')
        .insert(user, { returnChanges: true })
        .run(db)
        .catch((err) => {
            console.error(err)
            res.sendStatus(500).end()
            return
        })
        if (changes[0]) {
          user = changes[0].new_val
        }
        io.emit('updateUser', user)
        return user
    }
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

    let user = await r.table('users')
      .get(userAddress.toLowerCase()).default({})
      .pluck('address', 'name').run(db)

    // if user doesnt exist add them to db
    if (!user.address) {
      user = await makeUser(userAddress)
    }

    let albums = await r.table('albums').getAll(albumName.toLowerCase(), { index: 'name' }).pluck('id').coerceTo('array').run(db)

    // check if album already exists with name but with different id
    if (albums.length > 0 && albums[0].id !== id) {
      return res.status(401).send('Different album with that name already exists')
    }

    let album = await r.table('albums').get(id).run(db)

    albumName = xss(albumName)
    // check if albumName was changed
    if (album.name !== albumName && album.userAddress !== user.address) {
      // cant change name of album unless you are owner
      return res.status(401).send('Only owner can change name')
    }

    try {
      await verifyClovers(clovers, db)
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
    album.modified = new Date()
    // update it
    r.table('albums').get(id).update({
      name: album.name,
      clovers: album.clovers,
      modified: album.modified
    }).run(db, async (err,  _) => {
      if (err) {
        console.error('db run error')
        res.status(500).end()
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
          id,
          userAddress: user.address,
          name: albumName,
          board: clovers.length > 0 && clovers[0],
          createdAt: new Date()
        },
        userAddresses: []
      }

      r.table('logs').insert(log)
        .run(db, (err) => {
          if (err) {
            debug('album log not saved')
            debug(err)
          } else {
            try {
              io.emit('newLog', log)
            } catch (error) {
              console.error(error)
            }
          }
          res.status(200).json({ ...album, id }).end()
        })
      })
  })

  router.delete('/:id', async (req, res) => {
    const { id } = req.params
    const userAddress = req.auth && req.auth.user
    if (!userAddress) {
      return res.status(401).end()
    }

    const album = await r.table('albums')
      .get(id).run(db)

    if (!album || !album.id || album.userAddress !== userAddress.toLowerCase()) {
      return res.status(404).end()
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

async function verifyClovers(clovers, db) {
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

  await asyncForEach(clovers, async (c) => {
    var count = await r.table('clovers').getAll(c).count().run(db)
    if (count !== 1) {
      throw new Error(c + ' does not exist')
    }
  })
}

async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
}
