import resource from 'resource-router-middleware'
// import clovers from '../models/clovers'
import r from 'rethinkdb'
import { toRes, toSVG, toPNG } from '../lib/util'
import fs from 'fs'
import path from 'path'

export default ({ config, db, io}) => {
  var load = (req, id, callback) => {
    r.db('clovers_v2').table('clovers').get(id).run(db, (err, clover) => {
      clover.image = {svg: 'https://metadata.clovers.network/svg/' + id + '.svg'}
      clover.image.png = 'https://metadata.clovers.network/png/' + id + '.png'
      callback(err, clover);
    })
  }
  var router = resource({

    /** Property name to store preloaded entity on `request`. */
    id : 'clover',

    /** For requests with an `id`, you can auto-load the entity.
     *  Errors terminate the request, success sets `req[id] = data`.
     */
    load,

    /** GET / - List all entities */
    index({ query }, res) {
      var limit = parseInt(query.limit) || 100
      limit = limit > 500 ? 500 : limit
      var offset = parseInt(query.offset) || 0
      r.db('clovers_v2').table('clovers').slice(offset, offset + limit).run(db, toRes(res))
    },

    /** POST / - Create a new entity */
    create({ body }, res) {
      // check token to see if id is legit
      // check if actually owns clover
      // update clover w new name
      //    r.db('clovers_v2').table('clovers').get(id).update(clover).run(db, (err, result) => {
      //      io.emit('updateClover', clover)
      // emit updated clover for all connected to have
      // body.id = clovers.length.toString(36);
      // clovers.push(body);
      res.json(body);
    },

    /** GET /:id - Return a given entity */
    read({ clover }, res) {
      console.log('???')
      res.json(clover);
    },

    /** PUT /:id - Update a given entity */
    update({ clover, body }, res) {
      for (let key in body) {
        if (key!=='id') {
          clover[key] = body[key];
        }
      }
      res.sendStatus(204);
    },

    /** DELETE /:id - Delete a given entity */
    delete({ clover }, res) {
      // clovers.splice(clovers.indexOf(clover), 1);
      res.sendStatus(204);
    }
  })
  router.get('/svg/:id/:size?', async (req, res) => {
    try {
      let id = req.params.id || res.sendStatus(404)
      let size = req.params.size || 400

      let svg = path.resolve(__dirname + '/../../public/svg/' + size + '/' + id + '.svg')
      // if (!fs.existsSync(svg)) {
        await toSVG(id, size)
      // }
      res.sendFile(id + '.svg', {root: './public/svg/' + size})
    } catch (error) {
      console.log('this error' + error)
      res.sendStatus(404).send(error)
    }
  })
  router.get('png/:id', async (req, res) => {
    let png = path.resolve(__dirname + '/../../public/png/' + id + '.png')
    try {
      if (!fs.existsSync(png)) {
        await toPNG(id)
      }
      res.sendFile(id + '.png', {root: './public/png'})
    } catch (error) {
      res.sendStatus(404).json(error)
    }
  })
  return router
}
