/**
 * Reconcile the `clovers` table against the chain.
 *
 * Why this exists: `addNewClover` used to recurse from inside `.catch()` and
 * then destructure the catch's return value, which is `undefined`. Any
 * transient RPC failure therefore threw "is not iterable", and
 * `cloversTransfer` swallowed that into `debug()` — so the clover was never
 * written and nothing ever retried it.
 *
 * That bug is fixed, but the damage is still in the table, and it is not only
 * missing rows. Measured against mainnet on 2026-08-29:
 *
 *     exists on chain, no db row .............. 157
 *     db row exists, wrong owner .............. 254   (157 of them showing 0x0)
 *     db row for a token never minted ..........  2
 *
 * The 314-row shortfall the API reports is exactly 157 missing rows plus 157
 * rows wrongly showing owner 0x0. The other 97 are rows that still count, but
 * name the wrong holder — the dapp shows the wrong owner for those clovers.
 *
 * Ownership is rebuilt from the full Transfer log rather than by enumerating
 * `tokenByIndex`. Both are ground truth, but the log walk is roughly an order
 * of magnitude fewer requests (~1,750 getLogs against ~44,000 eth_calls) and
 * it yields the owner as well as the token id, which the enumeration does not.
 *
 * Usage:
 *   node dist/index.js reconcile           # report only, changes nothing
 *   node dist/index.js reconcile --write   # apply the repairs
 */

const debug = require('debug')('app:reconcile')
import r from 'rethinkdb'
import config from '../config.json'
import { catchUp, getBlockNumber, events } from './chain'
import { ZERO_ADDRESS } from './util'
import { cloversTransfer, syncClover } from '../models/clovers'

// The Clovers contract's first Transfer is at block 8,364,713. config's
// genesisBlock is the last full-rebuild point, which is much later, so it
// cannot be used here without silently skipping most of the history.
const DEFAULT_FROM_BLOCK = { 1: 8363000, 4: 4906267 }

let db

/**
 * tokenId -> current owner, rebuilt from every Clovers Transfer ever emitted.
 * catchUp delivers in (blockNumber, logIndex) order, so the last write per
 * token is by construction the current owner.
 */
async function chainOwnership (fromBlock, toBlock) {
  const owner = new Map()
  let seen = 0

  await catchUp(fromBlock, toBlock, log => {
    if (log.name !== 'Clovers_Transfer') return
    seen++
    owner.set(String(log.data._tokenId).toLowerCase(), String(log.data._to).toLowerCase())
    if (seen % 10000 === 0) debug(`${seen} transfers processed`)
  }, { addresses: [events.Clovers.address.toLowerCase()] })

  debug(`${seen} transfers over ${owner.size} distinct tokens`)
  return owner
}

/** board -> owner, for every row currently in the table. */
async function dbOwnership () {
  const rows = await r.table('clovers')
    .pluck('board', 'owner')
    .coerceTo('array')
    .run(db)

  const map = new Map()
  rows.forEach(row => {
    map.set(String(row.board).toLowerCase(), String(row.owner || '').toLowerCase())
  })
  return map
}

/**
 * Recover the original mint log so `created` is the real block rather than
 * "whenever we noticed". The log row usually survives even when the clover row
 * does not, because socketing inserts the log before calling the handler that
 * used to throw.
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

async function insertMissing (tokenId, chainOwner) {
  const stored = await findMintLog(tokenId)
  const blockNumber = stored ? Number(stored.blockNumber) : await getBlockNumber()

  if (!stored) debug(`no stored mint log for ${tokenId}; using current block`)

  const log = {
    name: 'Clovers_Transfer',
    blockNumber,
    transactionHash: stored ? stored.transactionHash : null,
    transactionIndex: stored ? stored.transactionIndex : 0,
    logIndex: stored ? stored.logIndex : 0,
    address: events.Clovers.address,
    data: { _from: ZERO_ADDRESS, _to: chainOwner, _tokenId: tokenId },
    userAddresses: [
      { id: '_from', address: ZERO_ADDRESS },
      { id: '_to', address: chainOwner }
    ]
  }

  // Reuse the real mint path so the row is built exactly like any other.
  await cloversTransfer({ log, io: null, db }, true)
}

/**
 * syncClover already knows how to correct a row against the chain — owner,
 * sale price and moves — and adjusts the users' clover counts as it goes.
 */
async function fixOwner (tokenId) {
  const clover = await r.table('clovers').get(tokenId).default(null).run(db)
  if (!clover) return false
  await syncClover(db, null, clover)
  return true
}

export async function reconcile (_db, { write = false } = {}) {
  db = _db

  console.log(write
    ? '\n  RECONCILE — applying changes'
    : '\n  RECONCILE — dry run, pass --write to apply')

  const chainId = config.network.chainId
  const fromBlock = Number(process.env.RECONCILE_FROM_BLOCK || DEFAULT_FROM_BLOCK[chainId] || 0)
  const head = await getBlockNumber()

  console.log(`  walking Clovers transfers, blocks ${fromBlock.toLocaleString()} to ${head.toLocaleString()}`)
  console.log('  (this is the slow part — roughly 1,750 requests)\n')

  const [onChain, inDb] = await Promise.all([
    chainOwnership(fromBlock, head),
    dbOwnership()
  ])

  const live = new Map()
  for (const [id, o] of onChain) if (o !== ZERO_ADDRESS) live.set(id, o)

  const missing = []
  const wrongOwner = []
  for (const [id, chainOwner] of live) {
    if (!inDb.has(id)) missing.push(id)
    else if (inDb.get(id) !== chainOwner) wrongOwner.push(id)
  }
  const ghost = [...inDb.keys()].filter(id => !onChain.has(id))

  console.log(`  tokens ever minted:        ${onChain.size.toLocaleString()}`)
  console.log(`  currently existing:        ${live.size.toLocaleString()}`)
  console.log(`  rows in database:          ${inDb.size.toLocaleString()}`)
  console.log('')
  console.log(`  missing rows:              ${missing.length}`)
  console.log(`  wrong owner:               ${wrongOwner.length}`)
  console.log(`  rows for unminted tokens:  ${ghost.length}   (reported only, never deleted)`)
  console.log('')

  ghost.forEach(id => console.log(`    unminted: ${id}`))
  missing.slice(0, 10).forEach(id => console.log(`    missing:  ${id}`))
  if (missing.length > 10) console.log(`    ...and ${missing.length - 10} more missing`)
  wrongOwner.slice(0, 10).forEach(id =>
    console.log(`    owner:    ${id}  db=${inDb.get(id)} chain=${live.get(id)}`))
  if (wrongOwner.length > 10) console.log(`    ...and ${wrongOwner.length - 10} more wrong owners`)

  if (!write) {
    console.log('\n  dry run — nothing written')
    return { missing, wrongOwner, ghost, inserted: 0, corrected: 0 }
  }

  let inserted = 0
  let corrected = 0
  let failed = 0

  console.log(`\n  inserting ${missing.length} missing clovers...`)
  for (let i = 0; i < missing.length; i++) {
    try {
      await insertMissing(missing[i], live.get(missing[i]))
      inserted++
    } catch (err) {
      failed++
      console.log(`    FAILED insert ${missing[i]}: ${err.message}`)
    }
    if ((i + 1) % 25 === 0) console.log(`    ${i + 1}/${missing.length}`)
  }

  console.log(`\n  correcting ${wrongOwner.length} owners...`)
  for (let i = 0; i < wrongOwner.length; i++) {
    try {
      await fixOwner(wrongOwner[i])
      corrected++
    } catch (err) {
      failed++
      console.log(`    FAILED owner ${wrongOwner[i]}: ${err.message}`)
    }
    if ((i + 1) % 25 === 0) console.log(`    ${i + 1}/${wrongOwner.length}`)
  }

  // Verify against the database rather than trusting the counters.
  const after = await dbOwnership()
  const stillMissing = [...live.keys()].filter(id => !after.has(id))
  const stillWrong = [...live.entries()].filter(([id, o]) => after.has(id) && after.get(id) !== o)

  console.log('')
  console.log(`  inserted:  ${inserted}`)
  console.log(`  corrected: ${corrected}`)
  console.log(`  failed:    ${failed}`)
  console.log(`  still missing after run: ${stillMissing.length}`)
  console.log(`  still wrong after run:   ${stillWrong.length}`)

  return { missing, wrongOwner, ghost, inserted, corrected, failed, stillMissing, stillWrong }
}
