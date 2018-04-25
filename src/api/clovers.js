import resource from 'resource-router-middleware';
// import clovers from '../models/clovers';
import r from 'rethinkdb'
import toRes from '../lib/util'

export default ({ config, db, io}) => resource({

  /** Property name to store preloaded entity on `request`. */
  id : 'clover',

  /** For requests with an `id`, you can auto-load the entity.
   *  Errors terminate the request, success sets `req[id] = data`.
   */
  load(req, id, callback) {
    r.db('clovers_v2').table('clovers').get(id).run(db, (err, clover) => {
      callback(err, clover);
    })
  },

  /** GET / - List all entities */
  index({ params }, res) {
    r.db('clovers_v2').table('clovers').run(db, toRes(res))
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
});
