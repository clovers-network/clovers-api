/**
 * The replacement for RethinkDB's `.changes()` changefeeds.
 *
 * Two endpoints used them -- the comment feed and the album feed -- to push
 * realtime updates over socket.io. SQLite has no equivalent, and the usual
 * substitutes (polling, a triggers-plus-outbox table) are heavier than this
 * needs to be: the API is a single process and it is the only writer, so a
 * write and the notification about it are already in the same place.
 *
 * So the store emits here on every write, and the listeners subscribe. The
 * payload deliberately mirrors a changefeed document -- {new_val, old_val},
 * with a null on either side meaning an insert or a delete -- so the listeners
 * needed almost no change and still read like changefeed handlers.
 *
 * The one behavioural difference worth knowing: a changefeed also fires for
 * writes made by another process (an admin in the RethinkDB shell, a second
 * app server). This fires only for writes made through this store in this
 * process. That is fine today -- pm2 runs one instance and nothing else writes
 * -- but it is the assumption to check first if a future deployment adds a
 * second writer.
 *
 * FUTURE: if the API is ever scaled to more than one process, this needs to
 * become a real fan-out -- Redis pub/sub, or SQLite's update_hook plus a poll
 * of a monotonically increasing rowid.
 */

import { EventEmitter } from 'events'

const emitter = new EventEmitter()
// Each connected socket client adds listeners; the default cap of 10 is for
// catching leaks in small programs and is not meaningful here.
emitter.setMaxListeners(0)

/** Called by the store after a write. `table` is the table name. */
export function emitChange (table, change) {
  emitter.emit(table, change)
}

/** Subscribe to writes on one table. Returns an unsubscribe function. */
export function onChange (table, handler) {
  emitter.on(table, handler)
  return () => emitter.removeListener(table, handler)
}

export default { emitChange, onChange }
