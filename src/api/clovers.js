const debug = require('debug')('app:api:clovers')
import resource from 'resource-router-middleware'
// import clovers from '../models/clovers'
import r from 'rethinkdb'
import { dodb, toSVG } from '../lib/util'
import basicAuth from 'express-basic-auth'
import { auth } from '../middleware/auth'
import { syncClover, syncContract, syncOracle, syncPending } from '../models/clovers'
import xss from 'xss'
import Reversi from 'clovers-reversi'
import BigNumber from 'bignumber.js'
import uuid from 'uuid/v4'
import { provider, events, ethers, walletProvider, cloversAddress } from '../lib/ethers-utils'
import http from 'https'

const semiSecretToken = process.env.SYNC_TOKEN
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
        // hide NOBODY
        doc('owner').eq('0x0000000000000000000000000000000000000000'),
        r.error('404 Not Found'),
        doc.merge({
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
      const indexes = ['all', 'market', 'RotSym', 'X0Sym', 'Y0Sym', 'XYSym', 'XnYSym', 'Sym', 'NonSym', 'public', 'contract', 'commented', 'pending', 'multi']
      const pageSize = 24
      const asc = query.asc === 'true'
      const sort = query.sort === 'price' ? '-price' : '-modified'
      const start = Math.max(((parseInt(query.page) || 1) - 1), 0) * pageSize

      const index = (!query.filter || query.filter === '' || !indexes.includes(query.filter)) ? `all${sort}` : query.filter + sort

      const multi = query.filter === 'multi'
      const multis = (query.x && parseInt(query.x)) || 1 // 1, 3, 5

      const getVal = multi ? multis : true

      let [results, count] = await Promise.all([
        r.table('clovers')
          .between([getVal, r.minval], [getVal, r.maxval], { index })
          .orderBy({ index: asc ? r.asc(index) : r.desc(index) })
          .slice(start, start + pageSize)
          // .map((doc) => {
          //   return doc.merge({
          //     lastOrder: r.table('orders')
          //       .getAll(doc('board'), { index: 'market' })
          //       .orderBy(r.desc('created'), r.desc('transactionIndex'))
          //       .limit(1).fold(null, (l, r) => r)
          //   })
          // })
          .eqJoin('owner', r.table('users'), { ordered: true })
          .without({ right: ['clovers', 'curationMarket'] })
          .map((doc) => {
            return doc('left').merge({
              lastOrder: null,
              user: doc('right').default(null)
            })
          })
          .coerceTo('array')
          .run(db, (err, data) => {
            if (err) throw new Error(err)
            return data
          }),
        r.table('clovers')
          .between([getVal, r.minval], [getVal, r.maxval], { index })
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
        orderBy: sort.substr(1),
        perPage: pageSize,

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
    let { id } = req.params
    load(req, id, (err, clover) => {
      if (err || !clover) {
        // show the clover anyway since we've been having trouble keeping the database in sync
        id = id.toLowerCase()
        if (id.substr(0,2) !== '0x' && !isNaN(id)) {
            id = '0x' + new BigNumber(id).toString(16).toLowerCase()
        }
        let nft = {}
        nft.name = ''
        nft.description = 'This Clover ' + id + ' was created with the moves: n/a'
        nft.image = 'https://api2.clovers.network/clovers/svg/' + id
        nft.image_url = nft.image
        nft.external_url = 'https://clovers.network/clovers/' + id
        nft.home_url = nft.external_url
        res.json(nft).end()
//         res.sendStatus(404).end()
//         return
      } else {
        let reversi = new Reversi()
        let nft = {}
        if (clover.moves.length === 1) {
          clover.moves = clover.moves[0]
        }
        let game = reversi.playGameByteMoves(...clover.moves)
        nft.name = clover.name
        nft.description = 'This Clover ' + clover.board + ' was created with the moves: ' + reversi.byteMovesToStringMoves(...clover.moves)

        nft.image = 'https://api2.clovers.network/clovers/svg/' + clover.board
        nft.image_url = nft.image

        nft.external_url = 'https://clovers.network/clovers/' + clover.board
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
    // debug(`getting activity for ${id}`)

    const pageSize = 12
    const asc = req.query.asc === 'true'
    const start = Math.max(((parseInt(req.query.page) || 1) - 1), 0) * pageSize
    const index = 'clover'
    // debug('filter by', id)

    let [results, count] = await Promise.all([
      r.table('logs')
        .between([id, r.minval], [id, r.maxval], { index: 'clovers' })
        .orderBy({ index: asc ? r.asc('clovers') : r.desc('clovers') })
        .slice(start, start + pageSize)
        // include the users
        .map((doc) => {
          return doc.merge({
            userAddresses: r.branch(
              doc.hasFields('userAddresses'),
              doc('userAddresses').map(u => {
                return {
                  id: u('id'),
                  address: r.table('users')
                    .get(u('address'))
                    .default({address: u('address')})
                    .without('clovers', 'curationMarket')}
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
        .between([id, r.minval], [id, r.maxval], { index: 'clovers' })
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
      perPage: pageSize,

      results
    }

    const status = results.length ? 200 : 404

    res.status(status).json(response).end()
  })

  router.post('/verify', async (req, res) => {
    try {
      let {
        tokenId,
        moves,
        symmetries,
        keep,
        recepient
      } = req.body

      if (!moves || typeof keep === 'undefined' || !recepient ) return res.status(500).end(`Invalid moves, keep or recepient`)

      const reversi = new Reversi()
      reversi.playGameByteMoves(...moves)

      if (reversi.error || !reversi.complete) return res.status(500).end(`Invalid Game`)

      const _tokenId = `0x${reversi.byteBoard}`
      if (_tokenId !== tokenId) return res.status(500).end(`Invalid tokenId`)

      const _symmetries= reversi.returnSymmetriesAsBN().toString(10)
      if (_symmetries !== symmetries) return res.status(500).end(`Invalid symmetries need ${_symmetries.toString(10)} but got ${symmetries.toString(10)}`)

      const hashedMsg = ethers.utils.solidityKeccak256([
        'uint256', 'bytes28[2]', 'uint256', 'bool', 'address'
      ], [
        tokenId, moves, symmetries, keep, recepient
      ])

      const ethersSig = await walletProvider.signMessage(ethers.utils.arrayify(hashedMsg))
      return res.status(200).json(ethersSig).end()
    } catch (error) {
      return res.status(500).json(error).end()
    }
  })

  router.get('/sync/pending/:id', async (req, res) => {
    const { s } = req.query
    if (s !== semiSecretToken) return res.sendStatus(401).end()

    const { id } = req.params
    const clover = await r.table('clovers').get(id).default(false).run(db)
    await syncPending(db, io, [clover])
    return res.sendStatus(200).end()
  })

  router.get('/sync/pending', async (req, res) => {
    const { s } = req.query
    if (s !== semiSecretToken) return res.sendStatus(401).end()

    let pending = await r.table('clovers').between([true, r.minval], [true, r.maxval], {index: 'pending-modified'})
    .orderBy({ index: r.asc('pending-modified') }).default([]).run(db)
    pending = await pending.toArray()
    await syncPending(db, io, pending)
    return res.sendStatus(200).end()
  })


  router.get('/sync/contract', async (req, res) => {
    let { s, offset } = req.query
    // if (s !== semiSecretToken) return res.sendStatus(401).end()
    if (!offset) {
      offset = 1
    } else {
      offset = parseInt(offset)
    }
    const totalSupply = await events.Clovers.instance.totalSupply()
    await syncContract(db, io, totalSupply, offset)
    return res.sendStatus(200).end()
  })

  router.get('/sync/oracle', async (req, res) => {
    const { s } = req.query
    if (s !== semiSecretToken) return res.sendStatus(401).end()
    let { offset } = req.query
    if (!offset) {
      offset = 1
    } else {
      offset = parseInt(offset)
    }
    debug('start oracle')
    debug({offset})
    const totalSupply = await events.Clovers.instance.balanceOf(events.Clovers.address)
    await syncOracle(db, io, totalSupply, offset)
    return res.sendStatus(200).end()
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
          // keep lastOrder etc
          clover = { ...clover, ...changes[0].new_val }
        }

        // create log entry
        const log = {
          id: uuid(),
          name: 'CloverName_Changed',
          removed: false,
          blockNumber: modified,
          userAddresses: [],
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

        try {
          // force-update OpenSea
          const tokenId = new BigNumber(id).toFixed()
          const openseaUrl = `https://api.opensea.io/api/v1/asset/${cloversAddress}/${tokenId}/?force_update=true`
          http.get(openseaUrl)

          // debug('update OpenSea')
          // debug(openseaUrl)
        } catch (err) {
          console.log(err)
        }

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
