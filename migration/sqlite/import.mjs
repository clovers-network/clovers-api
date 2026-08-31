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
import { DatabaseSync } from 'node:sqlite'

const backupDir = process.argv[2]
const outPath = process.argv[3] || path.join(process.cwd(), 'clovers.db')

if (!backupDir) {
  console.error('usage: node import.mjs <backup-dir> [out.db]')
  process.exit(1)
}

function readTable (name) {
  const file = path.join(backupDir, `${name}.jsonl.gz`)
  if (!fs.existsSync(file)) return []
  return zlib.gunzipSync(fs.readFileSync(file))
    .toString()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
}

const json = v => (v === undefined || v === null) ? null : JSON.stringify(v)
const bool = v => v ? 1 : 0
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

if (fs.existsSync(outPath)) fs.unlinkSync(outPath)
const db = new DatabaseSync(outPath)
db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'))

const TABLES = {
  clovers: {
    cols: ['board','name','owner','price','originalPrice','reward','created','modified',
           'commentCount','kept','foundBy','moves','symmetries'],
    row: r => [val(r.board), val(r.name), val(r.owner), val(r.price), val(r.originalPrice),
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
  const rows = readTable(name)
  const placeholders = spec.cols.map(() => '?').join(',')
  const stmt = db.prepare(`INSERT INTO ${name} (${spec.cols.join(',')}) VALUES (${placeholders})`)

  let ok = 0
  const dupes = []      // rejected by a UNIQUE index -- a data-quality finding
  const errors = []     // anything else -- a real problem with the migration
  db.exec('BEGIN')
  for (const r of rows) {
    try { stmt.run(...spec.row(r)); ok++ }
    catch (err) {
      const id = r.id || r.board || r.address
      if (/UNIQUE constraint/.test(err.message)) dupes.push(id)
      else errors.push({ id, error: err.message })
    }
  }
  db.exec('COMMIT')

  summary.push({ name, source: rows.length, imported: ok, dupes: dupes.length, errors: errors.length })
  console.log(`  ${name.padEnd(9)} ${String(rows.length).padStart(7)} source → ${String(ok).padStart(7)} imported` +
              (dupes.length ? `   ${dupes.length} duplicate-key` : '') +
              (errors.length ? `   ${errors.length} ERRORS` : ''))
  errors.slice(0, 3).forEach(f => console.log(`      ${f.id}: ${f.error}`))
}

db.exec('ANALYZE')

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

const bytes = fs.statSync(outPath).size
console.log(`\n  database: ${outPath}  (${(bytes / 1024 / 1024).toFixed(1)} MB)`)
console.log(mismatch ? `  ${mismatch} TABLE(S) MISMATCHED` : '  all tables match')
process.exit(mismatch ? 1 : 0)
