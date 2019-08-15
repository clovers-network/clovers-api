const debug = require('debug')('app:api:chats')
import resource from 'resource-router-middleware'
import r from 'rethinkdb'
import { toRes, commentTemplate } from '../lib/util'
import basicAuth from 'express-basic-auth'
import { auth } from '../middleware/auth'
import xss from 'xss'
import uuid from 'uuid/v4'
import { provider } from '../lib/ethers-utils'

// addresses that can moderate comments :)
const whitelist = []

export default ({ config, db, io }) => {
  const load = (req, id, callback) => {
    if (typeof id === 'string') {
      id = id.toLowerCase()
    }
    req.boardId = id
    callback()
  }

  let router = resource({
    load,
    id: 'chat',
    index (req, res) {
      res.status(400).json({ error: 'Please provide a Clover ID' }).end()
    },

    async read ({ boardId, query }, res) {
      const pageSize = 16
      const before = query.before ? new Date(query.before) : new Date()

      debug('get chat by board id', boardId, before)

      const [results, count] = await Promise.all([
        r.table('chats').between(
          [boardId, r.minval],
          [boardId, before],
          { index: 'dates' }
        ).orderBy(r.desc('created'))
          .limit(pageSize)
          .run(db, (err, data) => {
            if (err) throw new Error(err)
            return data
          }),
        r.table('chats').getAll(boardId, { index: 'board' })
          .count().run(db, (err, data) => {
            if (err) throw new Error(err)
            return data
          })
      ]).catch((err) => {
        debug('query error')
        debug(err)
        return res.status(500).end()
      })

      const response = {
        before,

        allResults: count,
        pageResults: results.length,
        results: results // .reverse()
      }

      // const status = results.length ? 200 : 404
      const status = 200

      res.status(status).json(response).end()
    }
  })

  // Authentication header required
  // Format: btoa(Basic address:signedmessage)
  router.use(
    basicAuth({
      authorizer: auth
    })
  )

  router.post('/:board', async (req, res) => {
    console.log('posted to chats/:board')
    const { board } = req.params
    const userAddress = req.auth && req.auth.user
    if (!userAddress) {
      res.status(401).end()
      return
    }

    const user = await r.table('users')
      .get(userAddress.toLowerCase()).default({})
      .pluck('address', 'name').run(db)
    const comment = xss(req.body.comment || '').trim()

    if (!comment.length || !user.address) {
      res.status(400).end()
      return
    }

    // generate the chat
    const chat = commentTemplate(user, board.toLowerCase(), comment)
    const blockNum = await provider.getBlockNumber().catch((err) => {
      debug(err.toString())
      return 0
    })
    // save it
    r.table('chats')
      .insert(chat).run(db, async (err, { generated_keys }) => {
        if (err) {
          debug('db run error')
          res.sendStatus(500).end()
          return
        }
        // emit an event pls
        const log = {
          id: uuid(),
          name: 'Comment_Added',
          removed: false,
          blockNumber: blockNum,
          userAddress: null, // necessary data below
          data: {
            userAddress: chat.userAddress,
            userName: chat.userName,
            board: chat.board,
            createdAt: new Date()
          }
        }
        r.table('clovers').get(chat.board).update({
          commentCount: r.row('commentCount').add(1).default(0),
          modified: blockNum
        }).run(db, (err) => {
          if (err) {
            debug(err.message)
          }
          r.table('logs').insert(log)
            .run(db, (err) => {
              if (err) {
                debug('chat log not saved')
                debug(err)
              } else {
                io.emit('newLog', log)
              }
              res.json({ ...chat, id: generated_keys[0] }).end()
            })
        })
      })
  })

  router.delete('/:id', async (req, res) => {
    const { id } = req.params
    const userAddress = req.auth && req.auth.user
    if (!userAddress) {
      res.status(401).end()
      return
    }

    const comment = await r.table('chats')
      .get(id).default({}).without('clovers').run(db)

    if (!comment.id) {
      res.status(404).end()
      return
    }

    if (userAddress.toLowerCase() === comment.userAddress) {
      await r.table('chats')
      .get(id).update({
        deleted: true,
        comment: 'Deleted',
        edited: r.now()
      }).run(db)
    } else {
      const board = await r.table('clovers')
      .get(comment.board).run(db)

      if (
        userAddress.toLowerCase() === board.owner ||
        whitelist.includes(userAddress.toLowerCase())
      ) {
        await r.table('chats')
        .get(id).update({
          flagged: true,
          edited: r.now()
        }).run(db)
      } else {
        res.status(401).end()
        return
      }
    }
    res.status(200).end()
  })

  return router
}

export function commentListener (server, db) {
  const io = require('socket.io')(server, { path: '/comments' })
  let connections = 0
  io.on('connection', (socket) => {
    debug('+1 comment subscribers: ', connections += 1)

    socket.on('disconnect', () => {
      debug('-1 comment subscribers: ', connections -= 1)
    })
  })

  // listen to chat changes :)
  r.table('chats').changes().run(db, (err, cursor) => {
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
        debug('new comment', doc.new_val.id)
        io.emit('new comment', doc.new_val)
      } else if (!doc.new_val) {
        // deleted comment
        debug('comment deleted', doc.old_val.id)
        io.emit('delete comment', doc.old_val)
      } else {
        // probably an update
        debug('update comment', doc.new_val.id)
        io.emit('edit comment', doc.new_val)
      }
    })
  })
}
