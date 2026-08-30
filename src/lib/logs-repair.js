/**
 * Audit and repair the `logs` table against the chain.
 *
 * The clovers table was reconciled separately and is correct. This is about the
 * `logs` table, which powers the activity feed, and which turns out to carry
 * three symptoms of one historical bug — some rows were stored with the wrong
 * blockNumber and logIndex.
 *
 * Measured for Clovers_Transfer against real eth_getLogs on 2026-08-30
 * (chain: 52,325 events; db: 54,139 rows over 52,710 distinct coordinates):
 *
 *     genuinely absent from the db ............. 311
 *     present, but at wrong coordinates ........ 707
 *     duplicate rows (same tx + logIndex) .... 1,429
 *     absent at the right position yet present
 *       elsewhere under the same tx hash ....... 11
 *
 * Proof it is a coordinate problem rather than missing data: the row stored at
 * block 8766804 / logIndex 78 has transaction
 * 0x83c37cb9794c6fb6516c2596d638211351faf243a9bcc42981b1f43f0d42d3ce, which on
 * chain sits in block 8766824 with its Clovers logs at logIndexes 46 and 47.
 * Real transaction, real decoded data, wrong position.
 *
 * `backfill` only ever inserts. Removing the duplicate and misplaced rows is
 * destructive and deliberately not automated — see `audit` output and decide.
 *
 * Usage:
 *   node dist/index.js audit-logs                 # report, changes nothing
 *   node dist/index.js backfill-logs              # dry run
 *   node dist/index.js backfill-logs --write      # insert missing rows
 */

const debug = require('debug')('app:logs-repair')
import r from 'rethinkdb'
import config from '../config.json'
import { catchUp, getBlockNumber, events } from './chain'

// Clovers' first Transfer is at 8,364,713. config.genesisBlock is the last
// full-rebuild point and is far later, so it cannot be used here.
const DEFAULT_FROM_BLOCK = { 1: 8363000, 4: 4906267 }

let db

function fromBlockFor () {
  const chainId = config.network.chainId
  return Number(process.env.REPAIR_FROM_BLOCK || DEFAULT_FROM_BLOCK[chainId] || 0)
}

const coordKey = l => `${Number(l.blockNumber)}:${Number(l.logIndex)}`
const txKey = l => `${String(l.transactionHash).toLowerCase()}:${Number(l.logIndex)}`

/** Every tracked event on chain, keyed both ways. */
async function chainLogs (fromBlock, toBlock) {
  const byCoord = new Map()
  const byTx = new Set()
  let n = 0

  await catchUp(fromBlock, toBlock, log => {
    n++
    byCoord.set(coordKey(log), log)
    byTx.add(txKey(log))
    if (n % 10000 === 0) debug(`${n} chain logs`)
  })

  debug(`${n} chain logs total`)
  return { byCoord, byTx }
}

/** Every row in the logs table that came from a contract event. */
async function dbLogs () {
  const rows = await r.table('logs')
    .pluck('id', 'name', 'blockNumber', 'logIndex', 'transactionHash')
    .filter(l => l.hasFields('transactionHash'))
    .coerceTo('array')
    .run(db)
  return rows
}

export async function audit (_db) {
  db = _db
  const from = fromBlockFor()
  const head = await getBlockNumber()

  console.log(`\n  AUDIT logs table, blocks ${from.toLocaleString()} to ${head.toLocaleString()}`)
  console.log('  (walks the full chain history — a few minutes)\n')

  const [chain, rows] = await Promise.all([chainLogs(from, head), dbLogs()])

  // Only compare event types we actually track; synthetic rows (Comment_Added,
  // CloverName_Changed, Album_*) have no chain counterpart by design.
  const tracked = new Set()
  for (const l of chain.byCoord.values()) tracked.add(l.name)

  const candidates = rows.filter(x => tracked.has(x.name))

  const seenTx = new Map()
  const dupes = []
  const misplaced = []

  for (const row of candidates) {
    const tk = txKey(row)
    if (seenTx.has(tk)) dupes.push(row)
    else seenTx.set(tk, row)

    const atCoord = chain.byCoord.get(coordKey(row))
    if (!atCoord || String(atCoord.transactionHash).toLowerCase() !== String(row.transactionHash).toLowerCase()) {
      misplaced.push(row)
    }
  }

  const missing = []
  for (const [, log] of chain.byCoord) {
    if (!seenTx.has(txKey(log))) missing.push(log)
  }

  console.log(`  chain events (tracked types): ${chain.byCoord.size.toLocaleString()}`)
  console.log(`  db rows (tracked types):      ${candidates.length.toLocaleString()}`)
  console.log('')
  console.log(`  missing from db:              ${missing.length}`)
  console.log(`  duplicate rows:               ${dupes.length}`)
  console.log(`  wrong blockNumber/logIndex:   ${misplaced.length}`)
  console.log('')

  const byName = {}
  missing.forEach(l => { byName[l.name] = (byName[l.name] || 0) + 1 })
  if (missing.length) {
    console.log('  missing, by event:')
    Object.entries(byName).sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => console.log(`    ${k}: ${v}`))
  }

  console.log('')
  console.log('  Duplicates and misplaced rows are NOT removed by backfill-logs.')
  console.log('  Deleting rows is destructive; decide before acting on those two counts.')

  return { missing, dupes, misplaced }
}

export async function backfill (_db, { write = false } = {}) {
  db = _db

  const { missing } = await audit(db)

  if (!missing.length) {
    console.log('\n  nothing to insert')
    return { inserted: 0 }
  }

  if (!write) {
    console.log(`\n  dry run — would insert ${missing.length} log rows; pass --write to apply`)
    return { inserted: 0, missing: missing.length }
  }

  console.log(`\n  inserting ${missing.length} missing log rows...`)
  console.log('  (log rows only — the clovers table was already reconciled, so')
  console.log('   re-running the event handlers would double-apply state)')

  let inserted = 0
  let failed = 0

  for (let i = 0; i < missing.length; i++) {
    try {
      // Guard against a concurrent insert by the live listener.
      const existing = await r.table('logs')
        .getAll([missing[i].transactionHash, missing[i].logIndex], { index: 'unique_log' })
        .coerceTo('array')
        .run(db)

      if (existing.length) continue

      await r.table('logs').insert(missing[i]).run(db)
      inserted++
    } catch (err) {
      failed++
      console.log(`    FAILED ${coordKey(missing[i])}: ${err.message}`)
    }
    if ((i + 1) % 50 === 0) console.log(`    ${i + 1}/${missing.length}`)
  }

  console.log('')
  console.log(`  inserted: ${inserted}`)
  console.log(`  failed:   ${failed}`)

  // Verify rather than trust the counter.
  const after = await dbLogs()
  const afterTx = new Set(after.map(txKey))
  const still = missing.filter(l => !afterTx.has(txKey(l)))
  console.log(`  still missing after run: ${still.length}`)

  return { inserted, failed, stillMissing: still.length }
}
