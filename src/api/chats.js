const debug = require('debug')('app:api:chats')
import resource from 'resource-router-middleware'
import { commentTemplate, makeUser as createUser } from '../lib/util'
import { getStore } from '../lib/store'
import { onChange } from '../lib/store/changes'
import basicAuth from 'express-basic-auth'
import { auth } from '../middleware/auth'
import xss from 'xss'
import uuid from 'uuid/v4'
import { provider } from '../lib/chain'

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

      // debug('get chat by board id', boardId, before)

      let results, count
      try {
        const store = getStore()
        count = store.countChatsForBoard(boardId)
        results = store.chatsBefore(boardId, before.toISOString(), { pageSize })
      } catch (err) {
        debug('query error')
        debug(err)
        return res.status(500).end()
      }

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

    const store = getStore()
    const dbUser = store.getUser(userAddress)
    let user = dbUser ? { address: dbUser.address, name: dbUser.name } : {}

    if (!user.address) {
      user = await  makeUser(userAddress)
    }

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
    // save it. RethinkDB generated the chat's primary key and handed it back
    // as generated_keys[0]; the store assigns one up front instead, so it is
    // already on the row it returns.
    let saved
    try {
      saved = store.insertChat(chat).new_val
    } catch (err) {
      debug('db run error')
      debug(err)
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
      },
      userAddresses: []
    }

    try {
      store.bumpCommentCount(chat.board, 1)
      store.updateClover(chat.board, { modified: blockNum })
    } catch (err) {
      debug(err.message)
    }

    try {
      store.insertLog(log)
      io.emit('newLog', log)
    } catch (err) {
      debug('chat log not saved')
      debug(err)
    }
    res.json(saved).end()
  })

  router.delete('/:id', async (req, res) => {
    const { id } = req.params
    const userAddress = req.auth && req.auth.user
    if (!userAddress) {
      res.status(401).end()
      return
    }

    const store = getStore()
    const comment = store.getChat(id)

    if (!comment) {
      res.status(404).end()
      return
    }

    // r.now() is a RethinkDB timestamp; `edited` is stored as an ISO string
    // everywhere else in this table, so write one.
    const now = new Date().toISOString()

    if (userAddress.toLowerCase() === comment.userAddress) {
      store.updateChat(id, { deleted: true, comment: 'Deleted', edited: now })
    } else {
      const board = store.getClover(comment.board)

      if (
        (board && userAddress.toLowerCase() === board.owner) ||
        whitelist.includes(userAddress.toLowerCase())
      ) {
        store.updateChat(id, { flagged: true, edited: now })
      } else {
        res.status(401).end()
        return
      }
    }
    res.status(200).end()
  })


  // The previous version called res.sendStatus(500) from inside .catch(), but
  // `res` is not in scope here -- so an insert failure raised ReferenceError,
  // and the swallowed error left `changes` undefined for the line below.
  async function makeUser (userAddress) {
    const modified = await provider.getBlockNumber()
    return createUser(db, io, userAddress, modified)
  }

  return router
}

export function commentListener (server, db) {
  const { Server: SocketServer } = require('socket.io')
  const io = new SocketServer(server, { path: '/comments', cors: { origin: '*' } })
  // let connections = 0
  // io.on('connection', (socket) => {
  //   debug('+1 comment subscribers: ', connections += 1)

  //   socket.on('disconnect', () => {
  //     debug('-1 comment subscribers: ', connections -= 1)
  //   })
  // })

  // listen to chat changes :)
  //
  // This was r.table('chats').changes(). The store now emits the same
  // {new_val, old_val} shape after every write, so the body below is unchanged
  // -- see lib/store/changes.js for what that does and does not cover.
  onChange('chats', (doc) => {
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
}
