const debug = require('debug')('app:api:search')
import resource from 'resource-router-middleware'
import escapeRegex from 'escape-string-regexp'
import { getStore } from '../lib/store'

export default ({ config, db, io }) => {
  return resource({
    id: 'search',
    async index ({ query }, res) {
      let { s } = query

      if (!s) {
        res.status(200).json({
          query: '',
          queryResults: 0,
          userCount: 0,
          albumCount: 0,
          users: [],
          albums: []
        }).end()
        return
      }

      // The store searches for the literal needle, so it gets the raw string.
      // `escaped` exists only because the response has always echoed back the
      // regex-escaped form; kept so the payload is byte-identical.
      const escaped = escapeRegex(s)

      let clovers, users, albums
      try {
        const store = getStore()
        clovers = store.searchClovers(s)
        users = store.searchUsers(s)
        albums = store.searchAlbums(s)
      } catch (err) {
        debug('search error')
        debug(err)
        return res.status(500).end()
      }

      const response = {
        query: escaped,
        queryResults: users.length + albums.length + clovers.length,
        cloverCount: clovers.length,
        userCount: users.length,
        albumCount: albums.length,
        clovers,
        users,
        albums
      }

      res.status(200).json(response).end()
    }
  })
}
