import resource from 'resource-router-middleware'
// import clovers from '../models/clovers'
import r from 'rethinkdb'
import { toRes, toSVG } from '../lib/util'
import basicAuth from 'express-basic-auth'
import { auth } from '../middleware/auth'
import { syncClover } from '../models/clovers'
import xss from 'xss'
import Reversi from 'clovers-reversi'
import BigNumber from 'bignumber.js'

export default ({ config, db, io }) => {
  const load = (req, id, callback) => {
    id = id.toLowerCase()
    if (id.substr(0,2) !== '0x') {
      id = '0x' + new BigNumber(id).toString(16).toLowerCase()
    }
    r.db('clovers_v2')
      .table('clovers')
      .get(id)
      .run(db, callback)
  }

  const pageSize = 12

  let router = resource({
    id: 'clover',

    load,

    index({ query }, res) {
      r.db('clovers_v2')
        .table('clovers')
        .orderBy(r.desc('modified'))
        .run(db, toRes(res))

      /* -------- paginated version ---------------- */
      // const before = parseInt(query.before) || false
      // const page = Math.min((parseInt(query.page) || 1), 1e6)
      // const all = query.all && query.all === 'true'
      // if (before) {
      //   r.db('clovers_v2').table('clovers')
      //     .orderBy(r.desc('modified'))
      //     .filter(r.row('modified').lt(before))
      //     .limit(pageSize).run(db, toRes(res))
      // } else {
      //   const offset = all ? 0 : pageSize * (page - 1)
      //   const newLimit = all ? (pageSize * page) : pageSize
      //   r.db('clovers_v2').table('clovers')
      //     .orderBy(r.desc('modified'))
      //     .skip(offset).limit(newLimit).run(db, toRes(res))
      // }
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
        console.log(clover.moves[0])
        console.log(...clover.moves[0])
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
      const svg = await toSVG(id, size || 400)

      res.setHeader('Content-Type', 'image/svg+xml')
      res.send(svg)
    } catch (err) {
      console.log('No ID, or invalid')
      res.sendStatus(404)
    }
  })

  router.get('/sync/:id', async (req, res) => {
    const { id } = req.params
    load(req, id, (err, clover) => {
      if (err || !clover) {
        res.sendStatus(401).end()
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
    load(req, id, (err, clover) => {
      const owner = clover.owner.toLowerCase() === user.toLowerCase()
      if (err || !owner) {
        res.sendStatus(401).end()
        return
      }

      // db update
      r.db('clovers_v2')
        .table('clovers')
        .get(clover.board)
        .update({ name }, { returnChanges: true })
        .run(db, (err, { changes }) => {
          if (err) {
            res.sendStatus(500).end()
            return
          }
          if (changes[0]) {
            clover = changes[0].new_val
          }
          io.emit('updateClover', clover)
          res.sendStatus(200).end()
        })
    })
  })

  return router
}

function isOwner(wallet, record) {
  return record.owner === wallet
}
