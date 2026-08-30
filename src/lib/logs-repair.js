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

/**
 * Pass 1 over the chain: strings only.
 *
 * Deliberately does NOT retain the decoded log objects. Holding 52,000 of them
 * plus 155,000 database rows is what made the first version of this die.
 * Returns coordKey -> txHash and the set of txKeys; the handful of logs we
 * actually need to insert get refetched in pass 2.
 */
async function chainIndex (fromBlock, toBlock) {
  const coordToTx = new Map()
  const txKeys = new Set()
  const names = new Set()
  let n = 0

  await catchUp(fromBlock, toBlock, log => {
    n++
    coordToTx.set(coordKey(log), String(log.transactionHash).toLowerCase())
    txKeys.add(txKey(log))
    names.add(log.name)
    if (n % 10000 === 0) debug(`${n} chain logs`)
  })

  debug(`${n} chain logs over ${txKeys.size} distinct positions`)
  return { coordToTx, txKeys, names, total: n }
}

/**
 * Stream the logs table rather than coerceTo('array').
 *
 * RethinkDB caps arrays at 100,000 elements by default and the table holds
 * ~155,000 rows, so coercing threw -- and the CLI logged that into a disabled
 * debug namespace, so it looked like a silent crash. Streaming avoids both the
 * limit and the memory.
 */
async function scanDbLogs (chain) {
  const cursor = await r.table('logs')
    .pluck('id', 'name', 'blockNumber', 'logIndex', 'transactionHash')
    .run(db)

  const seenTx = new Set()
  const dupes = []
  const misplaced = []
  let considered = 0

  await cursor.eachAsync(row => {
    if (!row.transactionHash || !chain.names.has(row.name)) return
    considered++

    const tk = txKey(row)
    if (seenTx.has(tk)) dupes.push(row.id)
    else seenTx.add(tk)

    const txAtCoord = chain.coordToTx.get(coordKey(row))
    if (!txAtCoord || txAtCoord !== String(row.transactionHash).toLowerCase()) {
      misplaced.push(row.id)
    }
  })

  return { seenTx, dupes, misplaced, considered }
}

/** Pass 2: refetch only the blocks that actually contain missing events. */
async function refetchMissing (missingTxKeys, chain) {
  const blocks = new Set()
  for (const [coord, tx] of chain.coordToTx) {
    const idx = coord.split(':')[1]
    if (missingTxKeys.has(`${tx}:${idx}`)) blocks.add(Number(coord.split(':')[0]))
  }

  debug(`refetching ${blocks.size} blocks for ${missingTxKeys.size} missing events`)

  const out = []
  let done = 0
  for (const b of blocks) {
    await catchUp(b, b, log => {
      if (missingTxKeys.has(txKey(log))) out.push(log)
    })
    if (++done % 25 === 0) debug(`refetched ${done}/${blocks.size} blocks`)
  }
  return out
}

export async function audit (_db) {
  db = _db
  const from = fromBlockFor()
  const head = await getBlockNumber()

  console.log(`\n  AUDIT logs table, blocks ${from.toLocaleString()} to ${head.toLocaleString()}`)
  console.log('  (walks the full chain history - a few minutes)\n')

  const chain = await chainIndex(from, head)
  const scan = await scanDbLogs(chain)

  const missingTxKeys = new Set()
  for (const tk of chain.txKeys) if (!scan.seenTx.has(tk)) missingTxKeys.add(tk)

  console.log(`  chain events (tracked types): ${chain.total.toLocaleString()}`)
  console.log(`  db rows (tracked types):      ${scan.considered.toLocaleString()}`)
  console.log('')
  console.log(`  missing from db:              ${missingTxKeys.size}`)
  console.log(`  duplicate rows:               ${scan.dupes.length}`)
  console.log(`  wrong blockNumber/logIndex:   ${scan.misplaced.length}`)
  console.log('')
  console.log('  Duplicates and misplaced rows are NOT removed by backfill-logs.')
  console.log('  Deleting rows is destructive; decide before acting on those two counts.')

  return { chain, missingTxKeys, dupes: scan.dupes, misplaced: scan.misplaced }
}

export async function backfill (_db, { write = false } = {}) {
  db = _db

  const { chain, missingTxKeys } = await audit(db)

  if (!missingTxKeys.size) {
    console.log('\n  nothing to insert')
    return { inserted: 0 }
  }

  if (!write) {
    console.log(`\n  dry run - would insert ${missingTxKeys.size} log rows; pass --write to apply`)
    return { inserted: 0, missing: missingTxKeys.size }
  }

  const missing = await refetchMissing(missingTxKeys, chain)
  console.log(`\n  refetched ${missing.length} of ${missingTxKeys.size} missing events`)

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

  // Verify against the database rather than trusting the counter. Checked
  // per-row via the unique_log index, so no large array is materialised.
  let still = 0
  for (const l of missing) {
    const rows = await r.table('logs')
      .getAll([l.transactionHash, l.logIndex], { index: 'unique_log' })
      .coerceTo('array')
      .run(db)
    if (!rows.length) still++
  }
  console.log(`  still missing after run: ${still}`)

  return { inserted, failed, stillMissing: still }
}
