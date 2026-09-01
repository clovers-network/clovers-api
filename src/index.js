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
import { build, mine, syncChain, copyLogs, syncBalances } from './lib/build'
import { reconcile } from './lib/reconcile'
import { audit as auditLogs, backfill as backfillLogs, cleanup as cleanupLogs } from './lib/logs-repair'
import { commentListener } from './api/chats'

let app = express()

const port = process.env.PORT || 4444

app.server = http.createServer(app)

// logger
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'))
}

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
  if (process.argv.findIndex(c => c.includes('sync')) > -1) {
    process.argv.forEach(v => {
      if (v.includes('sync')) {
        syncChain(db)
      }
    })
  } else if (process.argv.findIndex((c) => c === 'build') > -1) {
    build(db)
  } else if (process.argv.findIndex(c => c === 'logs') > -1) {
    copyLogs(db)
  } else if (process.argv.findIndex(c => c === 'users') > -1) {
    syncBalances(db)
  } else if (process.argv.findIndex(c => c === 'audit-logs') > -1) {
    auditLogs(db)
      .then(() => process.exit(0))
      .catch(err => {
        // console.error, not debug: a disabled DEBUG namespace made a real
        // RethinkDB error vanish and the command look like a silent crash.
        console.error('\n  COMMAND FAILED: ' + (err && err.message ? err.message : err))
        if (err && err.stack) console.error(err.stack)
        process.exit(1)
      })
  } else if (process.argv.findIndex(c => c === 'backfill-logs') > -1) {
    backfillLogs(db, { write: process.argv.indexOf('--write') > -1 })
      .then(() => process.exit(0))
      .catch(err => {
        // console.error, not debug: a disabled DEBUG namespace made a real
        // RethinkDB error vanish and the command look like a silent crash.
        console.error('\n  COMMAND FAILED: ' + (err && err.message ? err.message : err))
        if (err && err.stack) console.error(err.stack)
        process.exit(1)
      })
  } else if (process.argv.findIndex(c => c === 'cleanup-logs') > -1) {
    cleanupLogs(db, { write: process.argv.indexOf('--write') > -1 })
      .then(() => process.exit(0))
      .catch(err => {
        console.error('\n  COMMAND FAILED: ' + (err && err.message ? err.message : err))
        if (err && err.stack) console.error(err.stack)
        process.exit(1)
      })
  } else if (process.argv.findIndex(c => c === 'reconcile') > -1) {
    reconcile(db, { write: process.argv.indexOf('--write') > -1 })
      .then(() => process.exit(0))
      .catch(err => {
        // console.error, not debug: a disabled DEBUG namespace made a real
        // RethinkDB error vanish and the command look like a silent crash.
        console.error('\n  COMMAND FAILED: ' + (err && err.message ? err.message : err))
        if (err && err.stack) console.error(err.stack)
        process.exit(1)
      })
  } else {
    // socket.io 4. The dapp has shipped socket.io-client 4.x for a while and
    // the server was still on 2.1.1, which the v4 client refuses to talk to --
    // so realtime has been dead in production, not just here. v3+ also needs
    // CORS stated explicitly; `*` matches the express cors() above.
    const { Server: SocketServer } = require('socket.io')
    const io = new SocketServer(app.server, { cors: { origin: '*' } })
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

process.on('SIGINT', () => {
  debug('do SIGINT')
  process.exit()
})
