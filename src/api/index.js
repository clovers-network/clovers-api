import { version } from '../../package.json'
import { Router } from 'express'
import { toSVG } from '../lib/util'

import clovers from './clovers'
import orders from './orders'
import albums from './albums'
import users from './users'
import chats from './chats'
import search from './search'
import logs from './logs'

export default ({ config, db, io }) => {
  let api = Router()

  api.use('/clovers', clovers({ config, db, io }))
  api.use('/orders', orders({ config, db, io }))
  api.use('/albums', albums({ config, db, io }))
  api.use('/users', users({ config, db, io }))
  api.use('/chats', chats({ config, db, io }))
  api.use('/search', search({ config, db, io }))
  api.use('/logs', logs({ config, db, io }))

  /**
   * Top-level /svg/:id/:size, so this API is a drop-in for img.clovers.network.
   *
   * Three hostnames serve clover SVGs today -- api.clovers.network at
   * /clovers/svg/:id, api2.clovers.network at the same path, and
   * img.clovers.network at /svg/:id/:size -- and all three run this same code
   * and return byte-identical output. api-images and api2 exist for no other
   * reason.
   *
   * api2 can be retired by pointing its DNS here, because the path already
   * matches. img.clovers.network could not, because its path is shallower and
   * the dapp hardcodes `${imgBase}/svg/...` in src/utils.js. Rather than change
   * the dapp and wait for a redeploy, this alias makes the path match too, so
   * retiring both hosts is a DNS change and nothing else.
   *
   * Same handler as /clovers/svg -- see api/clovers.js -- deliberately not a
   * redirect, because these URLs are embedded in NFT metadata that OpenSea and
   * others have cached.
   */
  api.get('/svg/:id/:size?', async (req, res) => {
    try {
      let { id, size } = req.params
      if (typeof id !== 'string') id = '0'
      id = id.replace(/\s+/g, '')
      const svg = await toSVG(id, size || 400)
      res.setHeader('Content-Type', 'image/svg+xml')
      res.send(svg)
    } catch (err) {
      res.sendStatus(400)
    }
  })

  // perhaps expose some API metadata at the root
  api.get('/', (req, res) => {
    res.json({ version })
  })

  return api
}
