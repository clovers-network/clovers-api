import { version } from '../../package.json'
import { Router } from 'express'

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

  // perhaps expose some API metadata at the root
  api.get('/', (req, res) => {
    res.json({ version })
  })

  return api
}
