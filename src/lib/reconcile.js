/**
 * Reconcile the `clovers` table against the chain.
 *
 * Why this exists: `addNewClover` used to recurse from inside `.catch()` and
 * then destructure the catch's return value, which is `undefined`. Any
 * transient RPC failure therefore threw "is not iterable", and
 * `cloversTransfer` swallowed that into `debug()` — so the clover was never
 * inserted and nothing ever retried it. Over six years on a flaky node that
 * silently dropped ~314 clovers, 96% of them owned by the Clovers contract.
 *
 * The bug is fixed, but the missing rows are still missing. This walks the
 * contract's own enumeration (`tokenByIndex`), diffs it against the database,
 * and re-runs the mint path for anything absent.
 *
 * Usage:
 *   node dist/index.js reconcile          # report only, changes nothing
 *   node dist/index.js reconcile --write  # actually insert the missing rows
 */

const debug = require('debug')('app:reconcile')
import r from 'rethinkdb'
import { events, provider } from './chain'
import { ZERO_ADDRESS } from './util'
import { cloversTransfer } from '../models/clovers'

// Concurrent view calls. Free RPC tiers rate-limit around 15/s, so stay under.
const CONCURRENCY = Number(process.env.RECONCILE_CONCURRENCY || 8)
const PROGRESS_EVERY = 2000

let db

async function mapWithConcurrency (count, worker, onProgress) {
  const out = new Array(count)
  let next = 0
  let done = 0

  const runners = Array.from({ length: Math.min(CONCURRENCY, count) }, async () => {
    for (;;) {
      const i = next++
      if (i >= count) return
      out[i] = await worker(i)
      if (++done % PROGRESS_EVERY === 0) onProgress && onProgress(done, count)
    }
  })

  await Promise.all(runners)
  return out
}

/**
 * Every tokenId the contract currently reports as existing.
 * This is ground truth, independent of the `logs` table — which matters,
 * because we cannot assume the logs are complete either.
 */
async function chainTokenIds () {
  const supply = (await events.Clovers.instance.totalSupply()).toNumber()
  debug(`on-chain totalSupply: ${supply}`)

  const ids = await mapWithConcurrency(supply, async i => {
    for (let attempt = 0; ; attempt++) {
      try {
        const id = await events.Clovers.instance.tokenByIndex(i)
        return (id._hex || id.toHexString()).toLowerCase()
      } catch (err) {
        if (attempt >= 4) throw new Error(`tokenByIndex(${i}) failed: ${err.message}`)
        await new Promise(res => setTimeout(res, 1000 * Math.pow(2, attempt)))
      }
    }
  }, (done, total) => debug(`enumerated ${done}/${total}`))

  return ids
}

/** Every board currently in the database, regardless of owner. */
async function dbBoards () {
  const boards = await r.table('clovers')
    .pluck('board')
    .map(d => d('board'))
    .coerceTo('array')
    .run(db)
  return boards.map(b => String(b).toLowerCase())
}

/**
 * Recover the original mint log for a token so `created` is the real block
 * rather than "whenever we noticed". The log row usually survives even when
 * the clover row does not — socketing inserts the log *before* calling the
 * handler that used to throw.
 */
async function findMintLog (tokenId) {
  const rows = await r.table('logs')
    .filter(l => l('name').eq('Clovers_Transfer')
      .and(l('data')('_tokenId').downcase().eq(tokenId)))
    .orderBy('blockNumber')
    .limit(1)
    .coerceTo('array')
    .run(db)
  return rows[0] || null
}

async function synthesizeLog (tokenId) {
  const stored = await findMintLog(tokenId)

  let owner
  try {
    owner = await events.Clovers.instance.ownerOf(tokenId)
    if (Array.isArray(owner)) owner = owner[0]
  } catch (err) {
    return null // burned or nonexistent; nothing to insert
  }

  const blockNumber = stored
    ? Number(stored.blockNumber)
    : await provider.getBlockNumber()

  if (!stored) {
    debug(`no stored mint log for ${tokenId}; using current block for created/modified`)
  }

  return {
    name: 'Clovers_Transfer',
    blockNumber,
    transactionHash: stored ? stored.transactionHash : null,
    transactionIndex: stored ? stored.transactionIndex : 0,
    logIndex: stored ? stored.logIndex : 0,
    address: events.Clovers.address,
    data: {
      _from: ZERO_ADDRESS,
      _to: owner,
      _tokenId: tokenId
    },
    userAddresses: [
      { id: '_from', address: ZERO_ADDRESS },
      { id: '_to', address: String(owner).toLowerCase() }
    ]
  }
}

export async function reconcile (_db, { write = false } = {}) {
  db = _db

  debug(write ? 'RECONCILE (writing)' : 'RECONCILE (dry run — pass --write to apply)')

  const [onChain, inDb] = await Promise.all([chainTokenIds(), dbBoards()])

  const dbSet = new Set(inDb)
  const chainSet = new Set(onChain)

  const missing = onChain.filter(id => !dbSet.has(id))
  const extra = inDb.filter(id => !chainSet.has(id))

  console.log('')
  console.log(`  on chain:            ${onChain.length}`)
  console.log(`  in database:         ${inDb.length}`)
  console.log(`  missing from db:     ${missing.length}`)
  console.log(`  in db but not chain: ${extra.length}  (burned, or stale rows)`)
  console.log('')

  if (!missing.length) {
    console.log('  nothing to backfill')
    return { missing, extra, inserted: 0 }
  }

  console.log('  missing tokenIds (first 20):')
  missing.slice(0, 20).forEach(id => console.log(`    ${id}`))
  if (missing.length > 20) console.log(`    ...and ${missing.length - 20} more`)
  console.log('')

  if (!write) {
    console.log('  dry run — re-run with --write to insert these')
    return { missing, extra, inserted: 0 }
  }

  let inserted = 0
  let failed = 0

  for (let i = 0; i < missing.length; i++) {
    const tokenId = missing[i]
    try {
      const log = await synthesizeLog(tokenId)
      if (!log) {
        debug(`${tokenId} does not exist on chain after all, skipping`)
        continue
      }
      // Reuse the real mint path so the row is built exactly like any other,
      // including user counts and the market/price fields.
      await cloversTransfer({ log, io: null, db }, true)
      inserted++
      if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${missing.length} processed`)
    } catch (err) {
      failed++
      console.log(`  FAILED ${tokenId}: ${err.message}`)
    }
  }

  console.log('')
  console.log(`  inserted: ${inserted}`)
  console.log(`  failed:   ${failed}`)

  // Verify rather than assume.
  const after = await dbBoards()
  const stillMissing = onChain.filter(id => !new Set(after).has(id))
  console.log(`  still missing after backfill: ${stillMissing.length}`)

  return { missing, extra, inserted, failed, stillMissing }
}
