/**
 * Open the database and hand it to the app.
 *
 * This used to open a RethinkDB connection over TCP to localhost:28015 and
 * pass the connection object through every layer. SQLite is a file, so there
 * is no connection to hold -- the store singleton owns the handle and every
 * module reaches it with getStore(). The callback still receives something so
 * index.js and the commands it dispatches keep their existing signatures; what
 * it receives is the store itself, and the parameter is inert wherever it is
 * still named `db`.
 *
 * FUTURE: once no call site takes a `db` argument, this can become a plain
 * `initStore()` call at the top of index.js and the callback can go.
 */

import { initStore } from './lib/store'

export default (callback) => {
  callback(initStore())
}
