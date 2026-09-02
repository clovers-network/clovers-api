/**
 * Load a RethinkDB backup into SQLite.
 *
 * Reads the gzipped JSON-lines dumps produced by ~/backup-clovers.js and writes
 * them into the schema in schema.sql. Field formats are preserved verbatim --
 * padded decimal strings stay strings, block numbers stay integers, nested
 * objects become JSON text. Nothing is normalised or "improved", because the
 * dapp reads several of these values as-is.
 *
 * Usage:
 *   node import.mjs <backup-dir> [out.db]
 */

import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import readline from 'readline'
import { DatabaseSync } from 'node:sqlite'

const backupDir = process.argv[2]
const outPath = process.argv[3] || path.join(process.cwd(), 'clovers.db')

if (!backupDir) {
  console.error('usage: node import.mjs <backup-dir> [out.db]')
  process.exit(1)
}

/**
 * Stream one table's rows, one parsed object at a time.
 *
 * This used to gunzip the whole file, .toString() it, split it and map
 * JSON.parse over the lot -- three full copies of the table resident at once.
 * On a laptop with a 4 GB default heap that is merely wasteful; on the 1 GB
 * machine this actually deploys to it is fatal, and `logs` (152k rows, 30 MB
 * gzipped) killed the import with a V8 OOM inside JsonParse.
 *
 * Streaming keeps one line in memory at a time. Peak RSS for the whole import
 * drops from over a gigabyte to tens of megabytes, and it is no slower --
 * the work was always the JSON parsing, not the I/O.
 */
async function * readTable (name) {
  const file = path.join(backupDir, `${name}.jsonl.gz`)
  if (!fs.existsSync(file)) return
  const lines = readline.createInterface({
    input: fs.createReadStream(file).pipe(zlib.createGunzip()),
    crlfDelay: Infinity
  })
  for await (const line of lines) {
    if (line) yield JSON.parse(line)
  }
}

const json = v => (v === undefined || v === null) ? null : JSON.stringify(v)
// Truthiness is the wrong test here. RethinkDB is schemaless and 7,873 clover
// rows store `kept` as `[false]` -- an array containing false, not a boolean --
// with another 2,190 holding `[true]`. `v ? 1 : 0` sees a non-empty array,
// which is truthy regardless of contents, so every one of those 7,873 rows
// imported as kept = true. The 2,190 were right by luck.
//
// That is 17.7% of the table silently inverted, and no row count would show it:
// the corruption is inside a column, so counts matched exactly at 44,589. It
// was found by comparing field values between the two hosts, which is a
// different question from comparing which rows exist.
//
// Unwrap a single-element array before testing. Longer arrays are not a shape
// this field ever takes, and would be a new kind of drift worth failing on.
const bool = v => {
  if (Array.isArray(v)) {
    if (v.length > 1) throw new Error(`bool() got a ${v.length}-element array: ${JSON.stringify(v)}`)
    v = v[0]
  }
  return v ? 1 : 0
}
// RethinkDB rows are schemaless; a field can simply be absent.
const val = v => v === undefined ? null : v

// `foundBy` is written by the API as `hasFoundBy[0].address` -- a string. But
// 105 rows hold an entire embedded user document instead, drift a schemaless
// store permitted and a typed column will not. Collapse those to the address,
// which is unambiguously what was meant.
let foundByNormalised = 0
const foundBy = v => {
  if (v && typeof v === 'object' && typeof v.address === 'string') {
    foundByNormalised++
    return v.address
  }
  return val(v)
}

// `price` is documented as a 64-char zero-padded decimal, and padBigNum in the
// API always writes it that way -- but 3,795 legacy clovers hold a bare '0'.
// That matters because every price sort is a sort on this TEXT column, where
// lexicographic order is numeric order *only* if every value is the same width:
// '0' sorts below the 64-char zero-padded value it is numerically equal to, so
// zero-priced clovers split into two blocks instead of tying. RethinkDB sorted
// on price.coerceTo('number'), where they tie and fall through to the primary
// key. Padding restores the invariant the schema already declares.
//
// Deliberately not applied to originalPrice and reward, which have unpadded
// values of many widths: nothing sorts on them, so padding would change
// payloads to no purpose.
let pricesPadded = 0
const price = v => {
  if (typeof v === 'string' && v.length < 64 && /^[0-9]+$/.test(v)) {
    pricesPadded++
    return v.padStart(64, '0')
  }
  return val(v)
}

if (fs.existsSync(outPath)) fs.unlinkSync(outPath)
const db = new DatabaseSync(outPath)
db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'))

const TABLES = {
  clovers: {
    cols: ['board','name','owner','price','originalPrice','reward','created','modified',
           'commentCount','kept','foundBy','moves','symmetries'],
    row: r => [val(r.board), val(r.name), val(r.owner), price(r.price), val(r.originalPrice),
               val(r.reward), val(r.created), val(r.modified), val(r.commentCount) ?? 0,
               bool(r.kept), foundBy(r.foundBy), json(r.moves), json(r.symmetries)]
  },
  users: {
    cols: ['address','name','balance','created','modified','cloverCount','albumCount','image','curationMarket'],
    row: r => [val(r.address), val(r.name), val(r.balance), val(r.created), val(r.modified),
               val(r.cloverCount) ?? 0, val(r.albumCount) ?? 0, val(r.image), json(r.curationMarket)]
  },
  logs: {
    cols: ['id','name','address','blockNumber','transactionHash','transactionIndex','logIndex',
           'blockHash','removed','topics','data','args','event','eventSignature','userAddresses','userAddress'],
    row: r => [val(r.id), val(r.name), val(r.address), val(r.blockNumber), val(r.transactionHash),
               val(r.transactionIndex), val(r.logIndex), val(r.blockHash), bool(r.removed),
               json(r.topics), json(r.data), json(r.args), val(r.event), val(r.eventSignature),
               json(r.userAddresses), typeof r.userAddress === 'string' ? r.userAddress : null]
  },
  orders: {
    cols: ['id','market','type','user','created','transactionHash','transactionIndex','logIndex',
           'tokens','value','poolBalance','tokenSupply'],
    row: r => [val(r.id), val(r.market), val(r.type), val(r.user), val(r.created),
               val(r.transactionHash), val(r.transactionIndex), val(r.logIndex),
               val(r.tokens), val(r.value), val(r.poolBalance), val(r.tokenSupply)]
  },
  albums: {
    cols: ['id','name','userAddress','created','modified','clovers'],
    row: r => [val(r.id), val(r.name), val(r.userAddress), val(r.created), val(r.modified), json(r.clovers)]
  },
  chats: {
    cols: ['id','board','comment','userAddress','userName','created','edited','deleted','flagged'],
    row: r => [val(r.id), val(r.board), val(r.comment), val(r.userAddress), val(r.userName),
               val(r.created), val(r.edited), bool(r.deleted), bool(r.flagged)]
  }
}

console.log(`importing from ${backupDir}\n`)
const summary = []

for (const [name, spec] of Object.entries(TABLES)) {
  const placeholders = spec.cols.map(() => '?').join(',')
  const stmt = db.prepare(`INSERT INTO ${name} (${spec.cols.join(',')}) VALUES (${placeholders})`)

  let ok = 0
  let seen = 0
  const dupes = []      // rejected by a UNIQUE index -- a data-quality finding
  const errors = []     // anything else -- a real problem with the migration
  db.exec('BEGIN')
  for await (const r of readTable(name)) {
    seen++
    try { stmt.run(...spec.row(r)); ok++ }
    catch (err) {
      const id = r.id || r.board || r.address
      if (/UNIQUE constraint/.test(err.message)) dupes.push(id)
      else errors.push({ id, error: err.message })
    }
  }
  db.exec('COMMIT')

  summary.push({ name, source: seen, imported: ok, dupes: dupes.length, errors: errors.length })
  console.log(`  ${name.padEnd(9)} ${String(seen).padStart(7)} source → ${String(ok).padStart(7)} imported` +
              (dupes.length ? `   ${dupes.length} duplicate-key` : '') +
              (errors.length ? `   ${errors.length} ERRORS` : ''))
  errors.slice(0, 3).forEach(f => console.log(`      ${f.id}: ${f.error}`))
}

db.exec('ANALYZE')

if (pricesPadded) {
  console.log(`  zero-padded ${pricesPadded} clover prices that were stored unpadded`)
}
if (foundByNormalised) {
  console.log(`\n  normalised ${foundByNormalised} clovers whose foundBy held a user object instead of an address`)
}

console.log('\nverifying row counts against source...')
let mismatch = 0
for (const s of summary) {
  const n = db.prepare(`SELECT count(*) AS n FROM ${s.name}`).get().n
  // Duplicate-key rejections are expected and desirable: the UNIQUE indexes
  // exist to stop the duplication that RethinkDB's non-unique index allowed.
  const expected = s.source - s.dupes
  const good = n === expected
  if (!good) mismatch++
  console.log(`  ${s.name.padEnd(9)} source ${String(s.source).padStart(7)}  sqlite ${String(n).padStart(7)}` +
              (s.dupes ? `  (-${s.dupes} dupes)` : '') +
              `  ${good ? 'match' : '*** MISMATCH ***'}`)
}

// Fold the write-ahead log back into the main file and close cleanly, so what
// this leaves behind is a single self-contained .db. Without it the import
// leaves a 225 MB -wal alongside a .db that looks complete but is missing most
// of its rows -- copy or scp just the .db and you get a database that reports
// 2,457 albums as 0. The reported size below would lie about it too.
// Collect index statistics. Without them SQLite picks between overlapping
// partial indexes by rule of thumb, and it picked a broad one over the exact
// one for the Sym filter -- an index scan plus a temp b-tree where a seek would
// do. ANALYZE is cheap here and the stats ship inside the .db file.
db.exec('ANALYZE')
db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
db.close()

const bytes = fs.statSync(outPath).size
const walPath = outPath + '-wal'
const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0
console.log(`\n  database: ${outPath}  (${(bytes / 1024 / 1024).toFixed(1)} MB)`)
if (walBytes > 0) {
  console.log(`  WARNING: ${walPath} still holds ${(walBytes / 1024 / 1024).toFixed(1)} MB -- do not copy the .db alone`)
}
console.log(mismatch ? `  ${mismatch} TABLE(S) MISMATCHED` : '  all tables match')
process.exit(mismatch ? 1 : 0)
