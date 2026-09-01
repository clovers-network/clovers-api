/**
 * The store singleton.
 *
 * Exposed as a module-level singleton rather than threaded through call sites
 * so the RethinkDB port can proceed file by file: a ported file imports this,
 * an unported one keeps using the `db` connection it is already handed, and
 * both work against the same process. Once every file is ported, the RethinkDB
 * connection in src/db.js can go.
 *
 * FUTURE (Node >= 22 / current OS): `node:sqlite` is built in from Node 22.4
 * and this module can drop the better-sqlite3 branch below entirely. The server
 * currently runs Node 16 (capped by Ubuntu 16.04's glibc -- see
 * NODE-UPGRADE.md), which has no node:sqlite, so a driver is required there.
 */

const debug = require('debug')('app:store')
import path from 'path'
import config from '../../config.json'
import { createStore } from './sqlite'

let instance = null

/**
 * Open the database and build the store.
 *
 * `node:sqlite` is preferred where available (Node >= 22.4) because it needs no
 * native build; better-sqlite3 is the fallback for Node 16. Both expose the
 * prepare/get/all/run surface that createStore uses, so nothing downstream
 * changes.
 */
function openDatabase (file) {
  // SQLITE_DRIVER=better-sqlite3 forces the fallback even where node:sqlite
  // exists. This is not a tuning knob -- it is how the driver production
  // actually uses gets tested. Production runs Node 16.20.2, which has no
  // node:sqlite, so every test run on a modern Node exercises a code path the
  // server will never take. See migration/sqlite/README.md.
  const forced = process.env.SQLITE_DRIVER

  if (forced !== 'better-sqlite3') {
    try {
      const { DatabaseSync } = require('node:sqlite')
      debug('using built-in node:sqlite')
      return new DatabaseSync(file)
    } catch (e) {
      debug('node:sqlite unavailable, falling back to better-sqlite3')
    }
  } else {
    debug('SQLITE_DRIVER=better-sqlite3, skipping node:sqlite')
  }

  let Database
  try {
    Database = require('better-sqlite3')
  } catch (e) {
    throw new Error(
      'No SQLite driver. This runtime has no node:sqlite, which needs Node ' +
      '>= 22.4 -- see package.json engines. The deployment target is Ubuntu ' +
      '24.04 with Node 22, where it is built in and nothing else is required. ' +
      'To run on an older Node instead, `npm install better-sqlite3@9.6.0`; ' +
      'it is deliberately not a declared dependency, because it is a native ' +
      'module with no usable prebuilt binary below Node 18 (see ' +
      'NODE-UPGRADE.md) and declaring it would make every install compile it.'
    )
  }
  return new Database(file)
}

/** The file the store opens, absent an explicit override. */
export function defaultDbPath () {
  return process.env.SQLITE_PATH ||
    path.join(process.env.HOME || '.', `clovers_chain_${config.network.chainId}.db`)
}

let currentPath = null

/** Where the open store is reading from. */
export function getDbPath () {
  return currentPath
}

/**
 * Close the database.
 *
 * Only the rebuild path needs this: it renames the live file aside and creates
 * a fresh one, which must not happen while a handle is open to it.
 */
export function closeStore () {
  if (!instance) return
  debug(`closing ${currentPath}`)
  try {
    if (typeof instance.raw.close === 'function') instance.raw.close()
  } catch (err) {
    debug(`error closing database: ${err.message}`)
  }
  instance = null
  currentPath = null
}

export function initStore (file) {
  if (instance) return instance

  const dbFile = file || defaultDbPath()

  debug(`opening ${dbFile}`)
  const db = openDatabase(dbFile)
  currentPath = dbFile

  // WAL lets the HTTP handlers read while the chain listener writes. Without
  // it a single writer blocks every reader, which matters here because the
  // subscription can write at any moment.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  // Wait rather than fail if the listener holds the write lock.
  db.exec('PRAGMA busy_timeout = 5000')

  // SQLite's default page cache is 2 MB, which is the wrong order of magnitude
  // for a 371 MB database whose hot set is the clover indexes. Negative means
  // KiB rather than pages, so this is 64 MB. It is a ceiling, not a
  // reservation: the process idles at ~95 MB and only grows if the workload
  // touches that many distinct pages.
  db.exec('PRAGMA cache_size = -65536')

  // Read pages by mapping the file instead of read(2). This shows up in RSS but
  // is file-backed and reclaimable -- the kernel drops it under pressure, which
  // is exactly what happened in the 256 MB container test.
  db.exec('PRAGMA mmap_size = 268435456')

  // Sorts and temp b-trees in memory rather than on disk. Nearly all of them
  // were designed out (see the query audit), so this is cheap insurance for
  // the substring search, which cannot avoid one.
  db.exec('PRAGMA temp_store = MEMORY')

  // NOTE: `synchronous` is deliberately left at FULL. NORMAL is the usual
  // recommendation with WAL and it is a real write speedup -- but this
  // application writes roughly one row a day, so there is nothing to win, and
  // FULL means a power failure cannot lose an indexed event.

  // Keep the write-ahead log from growing without bound in a process that runs
  // for months. The default autocheckpoint is 1000 pages; being explicit means
  // the .db on disk stays close to complete, which matters because the nightly
  // backup copies it. See the note in migration/sqlite/import.mjs.
  db.exec('PRAGMA wal_autocheckpoint = 1000')

  const { events } = require('../chain')
  instance = createStore(db, { cloversAddress: events.Clovers.address })
  return instance
}

/** Throws rather than lazily opening, so a missing initStore is loud. */
export function getStore () {
  if (!instance) throw new Error('store not initialised -- call initStore() first')
  return instance
}

export default { initStore, getStore, closeStore, getDbPath, defaultDbPath }
