const debug = require('debug')('app:api:clovers')
import resource from 'resource-router-middleware'
// import clovers from '../models/clovers'
import r from 'rethinkdb'
import { dodb, toSVG } from '../lib/util'
import basicAuth from 'express-basic-auth'
import { auth } from '../middleware/auth'
import { syncClover } from '../models/clovers'
import xss from 'xss'
import Reversi from 'clovers-reversi'
import BigNumber from 'bignumber.js'
import uuid from 'uuid/v4'
import { provider } from '../lib/ethers-utils'

const semiSecretToken = uuid()
console.log(`TOKEN ——— ${semiSecretToken}`)

export default ({ config, db, io }) => {
  const load = async (req, id, callback) => {
    id = id.toLowerCase()
    if (id.substr(0,2) !== '0x') {
      id = '0x' + new BigNumber(id).toString(16).toLowerCase()
    }
    const c = r.table('clovers')
    .get(id).do((doc) => {
      return r.branch(
        doc.eq(null),
        r.error('404 Not Found'),
        doc.merge({
          commentCount: r.table('chats')
            .getAll(doc('board'), { index: 'board' })
            .count(),
          lastOrder: r.table('orders')
            .getAll(doc('board'), { index: 'market' })
            .orderBy(r.desc('created'), r.desc('transactionIndex'))
            .limit(1).fold(null, (l, r) => r),
          user: r.table('users').get(doc('owner'))
            .without('clovers', 'curationMarket').default(null)
        })
      )
    })
    // .run(db, callback)
    try {
      const clover = await dodb(db, c)
      callback(null, clover)
    } catch (err) {
      callback(err.msg)
    }
  }

  let router = resource({
    id: 'clover',
    load,

    async index({ query }, res) {
      const indexes = ['all', 'forsale', 'rft', 'RotSym', 'X0Sym', 'Y0Sym', 'XYSym', 'XnYSym', 'Sym', 'public', 'contract']
      const pageSize = 12
      const sort = query.sort || 'modified'
      const asc = query.asc === 'true'
      const start = Math.max(((parseInt(query.page) || 1) - 1), 0) * pageSize
      const index = !query.filter || query.filter === '' || !indexes.includes(query.filter) ? 'all' : query.filter
      debug('filter by', index, sort)

      let [results, count] = await Promise.all([
        r.table('clovers')
          .getAll(true, { index })
          .orderBy(asc ? r.asc(sort) : r.desc(sort))
          .slice(start, start + pageSize)
          .map((doc) => {
            return doc.merge({
              commentCount: r.table('chats')
                .getAll(doc('board'), { index: 'board' }).count(),
              lastOrder: r.table('orders')
                .getAll(doc('board'), { index: 'market' })
                .orderBy(r.desc('created'), r.desc('transactionIndex'))
                .limit(1).fold(null, (l, r) => r)
            })
          }).eqJoin('owner', r.table('users'), { ordered: true })
          .without({ right: ['clovers', 'curationMarket'] })
          .map((doc) => {
            return doc('left').merge({
              user: doc('right').default(null)
            })
          })
          .run(db, (err, data) => {
            if (err) throw new Error(err)
            return data
          }),
        r.table('clovers')
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

    read({ clover }, res) {
      res.json(clover)
    }
  })

  router.get('/metadata/:id', async (req, res) => {
    const { id } = req.params
    load(req, id, (err, clover) => {
      if (err || !clover) {
        res.sendStatus(401).end()
        return
      } else {
        let reversi = new Reversi()
        let nft = {}
        debug(clover.moves[0])
        debug(...clover.moves[0])
        let game = reversi.playGameByteMoves(...clover.moves[0])
        nft.name = clover.name
        nft.description = 'This Clover ' + clover.board + ' was created with the moves: ' + reversi.byteMovesToStringMoves(...clover.moves[0])

        nft.image = 'https://api2.clovers.network/clovers/svg/' + id
        nft.image_url = nft.image

        nft.external_url = 'https://clovers.network/clovers/' + id
        nft.home_url = nft.external_url

        nft.background_color = game.blackScore > game.whiteScore ? '#ffffff' : (game.whiteScore > game.blackScore ? '#ffffff' : '#ffffff')
        nft.attributes = clover

        let properties = []
        Object.entries(nft.attributes).forEach((entry) => {
          properties.push({
            key: entry[0],
            value: entry[1],
            type: typeof entry[1]
          })
        })
        nft.properties = properties
        res.json(nft).end()
      }
    })
  })

  router.get('/svg/:id/:size?', async (req, res) => {
    try {
      let { id, size } = req.params

      if (typeof id !== 'string') {
        id = '0'
      }
      id = id.replace(/\s+/g, '')

      const svg = await toSVG(id, size || 400)

      res.setHeader('Content-Type', 'image/svg+xml')
      res.send(svg)
    } catch (err) {
      debug('No ID, or invalid', err)
      res.sendStatus(400)
    }
  })

  router.get('/:id/activity', async (req, res) => {
    const { id } = req.params
    debug(`getting activity for ${id}`)

    const pageSize = 12
    const asc = req.query.asc === 'true'
    const start = Math.max(((parseInt(req.query.page) || 1) - 1), 0) * pageSize
    const index = 'clover'
    debug('filter by', id)

    let [results, count] = await Promise.all([
      r.table('logs')
        .getAll(id, { index })
        .orderBy(asc ? r.asc('blockNumber') : r.desc('blockNumber'))
        .slice(start, start + pageSize)
        // include the users
        .map((doc) => {
          return doc.merge({
            user: r.branch(
              doc('userAddress').default(null).ne(null),
              r.table('users').get(doc('userAddress')).default({})
                .without('clovers', 'curationMarket'),
              null
            )
          })
        })
        .run(db, (err, data) => {
          if (err) throw new Error(err)
          return data
        }),
      r.table('logs')
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
      filterBy: id,
      sort: asc ? 'ascending' : 'descending',
      orderBy: 'blockNumber',

      results
    }

    const status = results.length ? 200 : 404

    res.status(status).json(response).end()
  })

  router.get('/sync/all', async (req, res) => {
    const { s } = req.query
    if (s !== semiSecretToken) return res.sendStatus(401).end()

    debug('sync all of em')
    const allClovers = await dodb(db, r.table('clovers').coerceTo('array'))

    debug(`updating ${allClovers.length} clover(s)`)

    await asyncForEach(allClovers, async (clover, index) => {
      debug(`syncing clover ${index}: ${clover.board}`)
      await syncClover(db, io, clover)
    })

    res.send('OK').end()
  })

  router.get('/sync/:id', async (req, res) => {
    const { s } = req.query
    if (s !== semiSecretToken) return res.sendStatus(401).end()

    const { id } = req.params
    load(req, id, (err, clover) => {
      if (err || !clover) {
        res.sendStatus(500).end()
        return
      } else {
        syncClover(db, io, clover)
        res.sendStatus(200).end()
      }
    })
  })

  // Basic authentication
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
    load(req, id, async (err, clover) => {
      const owner = clover.owner.toLowerCase() === user.toLowerCase()
      if (err || !owner) {
        return res.sendStatus(401).end()
      }

      if (name === clover.name) {
        return res.sendStatus(400).end()
      }

      // db update
      const modified = await provider.getBlockNumber()
      r.table('clovers')
      .get(clover.board)
      .update({ name, modified }, { returnChanges: true })
      .run(db, (err, { changes }) => {
        if (err) {
          return res.sendStatus(500).end()
        }

        const oldName = clover.name

        if (changes[0]) {
          // keep lastOrder, commentCount etc
          clover = { ...clover, ...changes[0].new_val }
        }

        // create log entry
        const log = {
          id: uuid(),
          name: 'CloverName_Changed',
          removed: false,
          blockNumber: modified,
          userAddress: null,
          data: {
            board: clover.board,
            owner: clover.owner,
            prevName: oldName,
            newName: clover.name,
            changedAt: new Date()
          }
        }

        r.table('logs').insert(log)
        .run(db, (err) => {
          if (err) {
            debug('chat log not saved')
            debug(err)
          } else {
            io.emit('newLog', log)
          }
        })

        io.emit('updateClover', clover)
        res.sendStatus(200).end()
      })
    })
  })

  return router
}

async function asyncForEach (array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array)
  }
}
