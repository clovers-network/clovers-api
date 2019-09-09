const debug = require('debug')('app:api:search')
import resource from 'resource-router-middleware'
import r from 'rethinkdb'

export default ({ config, db, io }) => {
  return resource({
    id: 'search',
    async index ({ query }, res) {
      const { s } = query
      debug(`searching... ${s}`)

      if (!s) {
        res.status(400).json([]).end()
        return
      }

      let [users, albums] = await Promise.all([
        r.table('users').filter((doc) => {
          return doc('name').match(`(?i)${s}`)
        }).map((doc) => {
          return doc.merge({
            cloverCount: r.table('clovers').getAll(doc('address'), { index: 'owner' }).count(),
            albumCount: r.table('albums').getAll(doc('address'), { index: 'userAddress' }).count()
          })
        }).coerceTo('array').run(db, (err, data) => {
          if (err) throw new Error(err)
          return data
        }),
        r.table('albums').filter((doc) => {
          return doc('name').match(`(?i)${s}`)
        }).coerceTo('array').run(db, (err, data) => {
          if (err) throw new Error(err)
          return data
        })
      ]).catch((err) => {
        debug('search error')
        debug(err)
        return res.status(500).end()
      })

      const response = {
        query: s,
        queryResults: users.length + albums.length,
        userCount: users.length,
        albumCount: albums.length,
        users,
        albums
      }

      res.status(200).json(response).end()
    }
  })
}
