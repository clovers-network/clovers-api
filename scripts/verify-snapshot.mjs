/**
 * Check a pulled-down snapshot is intact.
 *
 *   node scripts/verify-snapshot.mjs <file.db>
 *
 * This lives in a file rather than inline in the workflow because the inline
 * version was `node -e '...'` in single quotes containing SQL with
 * `type='index'` -- whose inner quotes closed the shell string, so SQLite
 * received `WHERE type=index` and answered `near "index": syntax error`. Two of
 * the three failures in getting this workflow running were shell-level, not
 * logic: that one and calling `fly` where the runner installs `flyctl`. Neither
 * is possible in a committed script that can be run locally.
 *
 * The snapshot was already verified on the machine before it was kept. This
 * checks it survived the transfer, which is a different failure and the one an
 * artifact upload would otherwise hide.
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'fs'

const file = process.argv[2]
if (!file || !fs.existsSync(file)) {
  console.error(`usage: verify-snapshot.mjs <file.db>  (no file at ${file})`)
  process.exit(1)
}

const db = new DatabaseSync(file)

const integrity = Object.values(db.prepare('PRAGMA integrity_check').get())[0]
if (integrity !== 'ok') {
  console.error(`integrity_check: ${integrity}`)
  process.exit(1)
}

const fk = db.prepare('PRAGMA foreign_key_check').all().length
if (fk) {
  console.error(`${fk} foreign-key violations`)
  process.exit(1)
}

const counts = {}
for (const t of ['clovers', 'users', 'chats', 'albums', 'logs', 'orders']) {
  counts[t] = db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n
}

// A snapshot that opens cleanly but holds no clovers is a restore that would
// look fine until someone loaded the site.
if (!counts.clovers) {
  console.error('no clovers in the snapshot')
  process.exit(1)
}

// Indexes are the thing most likely to be quietly absent, and their absence
// turns a working restore into one that times out under load rather than
// failing outright.
const indexes = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'index'").get().n
if (indexes < 60) {
  console.error(`only ${indexes} indexes; expected ~69`)
  process.exit(1)
}

const mb = (fs.statSync(file).size / 1024 / 1024).toFixed(1)
console.log(`${file}  ${mb}MB  integrity ok  ${fk} fk violations  ${indexes} indexes`)
console.log(Object.entries(counts).map(([k, v]) => `  ${k}: ${v}`).join('\n'))
db.close()
