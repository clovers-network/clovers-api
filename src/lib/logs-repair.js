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
  // txHash -> [coordKey]. Needed by cleanup to prove that every chain event
  // belonging to a transaction already has a correctly-placed row before any
  // misplaced copy of it is deleted.
  const txToCoords = new Map()
  let n = 0

  await catchUp(fromBlock, toBlock, log => {
    n++
    const tx = String(log.transactionHash).toLowerCase()
    const ck = coordKey(log)
    coordToTx.set(ck, tx)
    txKeys.add(txKey(log))
    names.add(log.name)
    if (!txToCoords.has(tx)) txToCoords.set(tx, [])
    txToCoords.get(tx).push(ck)
    if (n % 10000 === 0) debug(`${n} chain logs`)
  })

  debug(`${n} chain logs over ${txKeys.size} distinct positions`)
  return { coordToTx, txKeys, names, txToCoords, total: n }
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

/**
 * Remove the duplicate rows and the rows stored at wrong coordinates.
 *
 * This deletes production rows, so it is built around one precondition and one
 * per-row proof:
 *
 *   PRECONDITION — every chain event must already have a correctly-placed row
 *   (audit reports `missing: 0`). Without that, deleting a misplaced row could
 *   drop the only copy of an event. Refuses to run otherwise.
 *
 *   PER-ROW PROOF — a misplaced row is only deleted once every chain event
 *   belonging to its transaction is confirmed present at its correct
 *   coordinates. Rows whose transaction has no tracked chain event at all are
 *   reported and never touched.
 *
 * Duplicates keep the first row seen and delete the rest, and only after
 * confirming the survivor sits at a genuine chain position.
 *
 * Every deleted id is written to ~/logs-cleanup-<timestamp>.json so the action
 * is auditable and reversible against a backup.
 *
 * Usage:
 *   node dist/index.js cleanup-logs           # dry run
 *   node dist/index.js cleanup-logs --write   # apply
 */
export async function cleanup (_db, { write = false } = {}) {
  db = _db

  const from = fromBlockFor()
  const head = await getBlockNumber()

  console.log(write
    ? '\n  CLEANUP LOGS — applying changes'
    : '\n  CLEANUP LOGS — dry run, pass --write to apply')
  console.log(`  blocks ${from.toLocaleString()} to ${head.toLocaleString()}\n`)

  const chain = await chainIndex(from, head)

  // ---- scan, classifying every tracked row -------------------------------
  const placed = new Map()      // coordKey -> [row ids] for rows at a real chain position
  const misplaced = []          // rows whose (block, logIndex) is not a chain position
  const orphaned = []           // rows whose tx has no tracked chain event at all
  let considered = 0

  const cursor = await r.table('logs')
    .pluck('id', 'name', 'blockNumber', 'logIndex', 'transactionHash')
    .run(db)

  await cursor.eachAsync(row => {
    if (!row.transactionHash || !chain.names.has(row.name)) return
    considered++

    const ck = coordKey(row)
    const tx = String(row.transactionHash).toLowerCase()

    if (chain.coordToTx.get(ck) === tx) {
      if (!placed.has(ck)) placed.set(ck, [])
      placed.get(ck).push(row.id)
    } else if (chain.txToCoords.has(tx)) {
      misplaced.push({ id: row.id, tx, ck })
    } else {
      orphaned.push({ id: row.id, tx, ck, name: row.name })
    }
  })

  // ---- precondition ------------------------------------------------------
  const uncovered = []
  for (const ck of chain.coordToTx.keys()) if (!placed.has(ck)) uncovered.push(ck)

  console.log(`  chain events:                 ${chain.total.toLocaleString()}`)
  console.log(`  db rows (tracked types):      ${considered.toLocaleString()}`)
  console.log(`  chain positions covered:      ${placed.size.toLocaleString()}`)
  console.log(`  chain positions NOT covered:  ${uncovered.length}`)
  console.log('')

  if (uncovered.length) {
    console.log('  REFUSING TO RUN: some chain events have no correctly-placed row.')
    console.log('  Run `backfill-logs --write` first, then retry.')
    uncovered.slice(0, 5).forEach(ck => console.log(`    uncovered: ${ck}`))
    return { refused: true, uncovered: uncovered.length }
  }

  // ---- decide deletions --------------------------------------------------
  const dupeIds = []
  for (const [, ids] of placed) {
    if (ids.length > 1) dupeIds.push(...ids.slice(1)) // keep the first
  }

  const misplacedDeletable = []
  const misplacedKept = []
  for (const m of misplaced) {
    const coords = chain.txToCoords.get(m.tx) || []
    const allCovered = coords.every(ck => placed.has(ck))
    if (allCovered) misplacedDeletable.push(m)
    else misplacedKept.push(m)
  }

  console.log(`  duplicate rows to delete:     ${dupeIds.length}`)
  console.log(`  misplaced rows to delete:     ${misplacedDeletable.length}`)
  console.log(`  misplaced rows KEPT (their tx`)
  console.log(`    is not fully covered):      ${misplacedKept.length}`)
  console.log(`  orphaned rows (tx has no`)
  console.log(`    tracked chain event) KEPT:  ${orphaned.length}`)
  console.log('')

  orphaned.slice(0, 6).forEach(o => console.log(`    orphan: ${o.name} at ${o.ck} tx=${o.tx.slice(0, 14)}`))
  if (orphaned.length > 6) console.log(`    ...and ${orphaned.length - 6} more orphans`)

  const toDelete = dupeIds.concat(misplacedDeletable.map(m => m.id))
  console.log('')
  console.log(`  TOTAL rows to delete: ${toDelete.length}`)
  console.log(`  rows remaining after: ${(considered - toDelete.length).toLocaleString()}  (chain has ${chain.total.toLocaleString()})`)

  if (!write) {
    console.log('\n  dry run — nothing deleted')
    return { dupeIds, misplacedDeletable, misplacedKept, orphaned, toDelete }
  }

  // ---- record before deleting -------------------------------------------
  const fs = require('fs')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const manifest = process.env.HOME + '/logs-cleanup-' + stamp + '.json'
  fs.writeFileSync(manifest, JSON.stringify({
    when: stamp,
    duplicates: dupeIds,
    misplaced: misplacedDeletable
  }, null, 1))
  console.log(`\n  wrote manifest of every id to be deleted: ${manifest}`)

  // ---- delete in batches -------------------------------------------------
  let deleted = 0
  let failed = 0
  const BATCH = 100

  for (let i = 0; i < toDelete.length; i += BATCH) {
    const batch = toDelete.slice(i, i + BATCH)
    try {
      const res = await r.table('logs').getAll(r.args(batch)).delete().run(db)
      deleted += res.deleted || 0
    } catch (err) {
      failed += batch.length
      console.log(`    FAILED batch at ${i}: ${err.message}`)
    }
    if ((i + BATCH) % 500 === 0) console.log(`    ${Math.min(i + BATCH, toDelete.length)}/${toDelete.length}`)
  }

  console.log('')
  console.log(`  deleted: ${deleted}`)
  console.log(`  failed:  ${failed}`)

  // ---- verify the invariant still holds ----------------------------------
  console.log('\n  re-checking that every chain position still has a row...')
  const after = new Set()
  const c2 = await r.table('logs').pluck('name', 'blockNumber', 'logIndex', 'transactionHash').run(db)
  await c2.eachAsync(row => {
    if (!row.transactionHash || !chain.names.has(row.name)) return
    const ck = coordKey(row)
    if (chain.coordToTx.get(ck) === String(row.transactionHash).toLowerCase()) after.add(ck)
  })

  const lost = []
  for (const ck of chain.coordToTx.keys()) if (!after.has(ck)) lost.push(ck)
  console.log(`  chain positions covered after: ${after.size.toLocaleString()} of ${chain.coordToTx.size.toLocaleString()}`)
  console.log(lost.length
    ? `  *** ${lost.length} POSITIONS LOST -- restore from ${manifest} and the backup ***`
    : '  no chain event lost')

  return { deleted, failed, lost: lost.length, manifest }
}
