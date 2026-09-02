/**
 * Back up the live SQLite database.
 *
 *   node scripts/backup-sqlite.mjs [--dir DIR] [--keep N] [--no-gzip]
 *
 * Replaces ~/backup-clovers.js, which streamed RethinkDB tables to gzipped
 * JSON-lines. That script had to exist because rethinkdb-dump was not installed
 * on the droplet and neither was the Python driver. None of that applies now:
 * the database is one file, and SQLite can snapshot itself.
 *
 * WHY `VACUUM INTO` AND NOT `cp`
 *
 * The obvious backup -- copy the .db -- is wrong here, and wrong in a way that
 * only shows up when you try to restore. The database runs in WAL mode, so
 * recent commits live in `clovers_chain_1.db-wal` and not yet in the .db. A
 * plain cp of the .db alone silently loses them; a cp of both files, taken
 * while a write is in flight, can capture a torn pair. The window is small --
 * this app writes about one row a day -- but a backup you cannot trust is not
 * meaningfully better than no backup, and the failure is silent.
 *
 * `VACUUM INTO` takes a read transaction, so it sees one consistent snapshot
 * including everything in the WAL, and writes a single standalone file with no
 * sidecar. It also rebuilds the b-trees, so the output is compact -- which is
 * why the .db shrinks noticeably in the numbers below. The app keeps serving
 * throughout: readers are never blocked in WAL mode, and the only thing that
 * would block is a concurrent VACUUM.
 *
 * The alternative is the backup API (better-sqlite3's `db.backup()`), which
 * copies page-by-page and retries on write. It is the better choice for a
 * database under continuous write load. Here `VACUUM INTO` is simpler, needs no
 * driver-specific method, and works identically under node:sqlite -- and one
 * write a day means there is nothing to retry around.
 *
 * WHAT THIS DOES NOT DO
 *
 * It writes to local disk. On Fly that is the same volume as the database, which
 * protects against corruption and bad deploys but not against losing the
 * volume. Getting a copy off the machine is a separate step and the one that
 * actually matters -- see .github/workflows/backup.yml, which pulls one nightly,
 * and RESTORE.md.
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { pipeline } from 'stream/promises'

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(name)
  return i === -1 ? dflt : argv[i + 1]
}
const has = (name) => argv.includes(name)

const src = arg('--db', process.env.SQLITE_PATH || path.join(process.env.HOME || '.', 'clovers_chain_1.db'))
const dir = arg('--dir', process.env.BACKUP_DIR || path.join(path.dirname(src), 'backups'))
// Three, not the droplet's fourteen. Local copies only need to cover fast
// rollback -- the real off-box window is the 90-day CI artifact. Retention also
// has to leave room for the snapshot itself: VACUUM INTO writes the full
// uncompressed file before gzip touches it, so peak usage is the database plus
// every retained copy plus one more uncompressed database. At fourteen that was
// ~1.8 GB on a 2.9 GB volume, which fits today and would not once the database
// grows. A full volume breaks the app, which is worse than a missed backup.
const keep = parseInt(arg('--keep', process.env.BACKUP_KEEP || '3'), 10)
const gzipIt = !has('--no-gzip')

if (!fs.existsSync(src)) {
  console.error(`no database at ${src}`)
  process.exit(1)
}
fs.mkdirSync(dir, { recursive: true })

// Colons are legal in a filename but a nuisance in scp targets and in Windows
// checkouts of the CI artifact, so the timestamp uses dashes throughout.
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d\d\dZ$/, 'Z')
const snapshot = path.join(dir, `clovers-${stamp}.db`)
const t0 = Date.now()

const db = new DatabaseSync(src)

// Row counts from the source, to compare against the snapshot. This is the
// check that would have caught a torn copy, so it is not optional.
const TABLES = ['clovers', 'users', 'chats', 'albums', 'logs', 'orders']
const before = {}
for (const t of TABLES) {
  try {
    before[t] = db.prepare(`SELECT count(*) n FROM ${t}`).get().n
  } catch (e) {
    before[t] = null // table absent in an older schema; not fatal
  }
}

// Refuse to start if the snapshot could not fit. statfs is not available
// without a native module, so shell out -- this runs once a night and the
// portability cost of `df -Pk` is lower than the cost of filling the volume.
try {
  const { execSync } = await import('child_process')
  const out = execSync(`df -Pk ${JSON.stringify(dir)}`, { encoding: 'utf8' })
  const availKb = parseInt(out.trim().split('\n')[1].split(/\s+/)[3], 10)
  const needKb = Math.ceil(fs.statSync(src).size / 1024 * 1.1) // +10% margin
  if (availKb && availKb < needKb) {
    console.error(`refusing to run: ${Math.round(availKb / 1024)}MB free at ${dir}, ` +
      `need ~${Math.round(needKb / 1024)}MB for the uncompressed snapshot. ` +
      'Lower --keep or grow the volume.')
    process.exit(1)
  }
} catch (e) {
  // Not fatal -- a df that cannot be parsed should not stop a backup, and
  // VACUUM INTO will fail cleanly on its own if the disk really is full.
  if (e.status !== undefined || e.code === 'ENOENT') console.error(`(space check skipped: ${e.message})`)
  else throw e
}

// VACUUM INTO refuses to overwrite, which is the behaviour we want -- a
// timestamp collision should fail rather than clobber a good snapshot.
db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`)
db.close()

// Verify by reopening the snapshot and re-counting. A backup that has never
// been opened is a guess.
const check = new DatabaseSync(snapshot)
const integrity = check.prepare('PRAGMA integrity_check').get()
const okIntegrity = Object.values(integrity)[0] === 'ok'
let mismatch = null
for (const t of TABLES) {
  if (before[t] === null) continue
  const after = check.prepare(`SELECT count(*) n FROM ${t}`).get().n
  if (after !== before[t]) mismatch = `${t}: ${before[t]} -> ${after}`
}
check.close()

if (!okIntegrity || mismatch) {
  console.error(`SNAPSHOT REJECTED: ${mismatch || 'integrity_check failed'}`)
  fs.unlinkSync(snapshot)
  process.exit(1)
}

let final = snapshot
if (gzipIt) {
  await pipeline(
    fs.createReadStream(snapshot),
    zlib.createGzip({ level: 6 }),
    fs.createWriteStream(`${snapshot}.gz`)
  )
  fs.unlinkSync(snapshot)
  final = `${snapshot}.gz`
}

const mb = (b) => (b / 1024 / 1024).toFixed(1)
const rows = TABLES.filter(t => before[t] !== null).map(t => `${t} ${before[t]}`).join(' · ')
console.log(`${new Date().toISOString()}  ${path.basename(final)}  ` +
  `${mb(fs.statSync(src).size)}MB db -> ${mb(fs.statSync(final).size)}MB  ` +
  `${((Date.now() - t0) / 1000).toFixed(1)}s  verified  ${rows}`)

// Prune oldest. Sorting by name works because the stamp is ISO-8601.
const old = fs.readdirSync(dir).filter(f => /^clovers-.*\.db(\.gz)?$/.test(f)).sort()
for (const f of old.slice(0, Math.max(0, old.length - keep))) {
  fs.unlinkSync(path.join(dir, f))
  console.log(`  pruned ${f}`)
}
