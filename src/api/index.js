import { version } from '../../package.json'
import { Router } from 'express'

import clovers from './clovers'
import orders from './orders'
import users from './users'
import logs from './logs'

export default ({ config, db, io }) => {
  let api = Router()

  // mount the clovers resource
  api.use('/clovers', clovers({ config, db, io }))

  // mount the orders resource
  api.use('/orders', orders({ config, db, io }))

  // mount the users resource
  api.use('/users', users({ config, db, io }))

  // mount the logs resource
  api.use('/logs', logs({ config, db, io }))

  // perhaps expose some API metadata at the root
  api.get('/', (req, res) => {
    res.json({ version })
  })

  return api
}
