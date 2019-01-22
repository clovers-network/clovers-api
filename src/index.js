const debug = require('debug')('app:index')
import http from 'http'
import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import bodyParser from 'body-parser'
import compression from 'compression'
import initializeDb from './db'
import middleware from './middleware'
import api from './api'
import config from './config.json'
import { socketing } from './socketing'
import { build, mine } from './lib/build'
import { commentListener } from './api/chats'

let app = express()

const port = process.env.PORT || 4444
const host = process.env.HOST || 'localhost'

app.server = http.createServer(app)

// logger
app.use(morgan('dev'))

// 3rd party middleware
app.use(cors({
  exposedHeaders: config.corsHeaders
}))

app.use(bodyParser.json({
  limit : config.bodyLimit
}))

app.use(compression())

// connect to db
initializeDb((db) => {
  if (process.argv.findIndex((c) => c === 'build') > -1) {
    build(db)
  } else {
    const io = require('socket.io')(app.server)
    commentListener(app.server, db)

    // internal middleware
    app.use(middleware({ config, db }))

    // api router
    app.use('/', api({ config, db, io }))

    app.server.listen(port, () => {
      debug(`Started on port ${app.server.address().port}`)
    })
    socketing({_db: db, _io: io})

    if (process.argv.findIndex((c) => c === 'mine') > -1) {
      mine(db, io)
    }
  }
})

export default app
