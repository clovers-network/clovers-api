const debug = require('debug')('app:socketing')
import { events, startLiveStreams } from './lib/chain'
import { network } from './config'
import * as clovers from './models/clovers'
import * as clubToken from './models/clubToken'
import * as cloversController from './models/cloversController'
import * as clubTokenController from './models/clubTokenController'
// import * as curationMarket from './models/curationMarket'
import * as simpleCloversMarket from './models/simpleCloversMarket'
import { Clovers } from 'clovers-contracts'
import { getStore } from './lib/store'

// `db` is kept only because the exported signatures still take it; every read
// and write below now goes through the store.
// FUTURE: drop it from socketing()/handleEvent() once no caller passes it.
let io, db

// Keep track of live stream controllers for cleanup
let liveControllers = []

/**
 * Whether to run the chain listener in this process.
 *
 * This was `process.env.HOME !== '/home/billy'` -- a check against one
 * developer's home directory on one server. Anywhere else, and that is every
 * container, every new droplet and Fly (HOME=/root), the listener silently did
 * nothing: the API answered reads perfectly and never ingested another event.
 * Confirmed on the Fly deploy, where it was off and nothing said so.
 *
 * Now explicit, and defaulting to ON so a forgotten variable cannot silently
 * stop indexing. Set CHAIN_LISTENER=off to disable -- which is what tests and
 * local development want, since otherwise every run opens websockets to public
 * RPC providers and writes to whatever database it is pointed at.
 */
function listenerEnabled () {
  return String(process.env.CHAIN_LISTENER || '').toLowerCase() !== 'off'
}

export var socketing = function ({ _io, _db }) {
  // console.log, not debug: the decision has to be visible in the startup log
  // whether or not a DEBUG namespace happens to be enabled. A disabled debug
  // namespace is exactly how this stayed invisible.
  if (!listenerEnabled()) {
    console.log('chain listener DISABLED (CHAIN_LISTENER=off)')
    return
  }
  console.log('chain listener enabled')

  io = _io
  db = _db

  io.on('connection', (socket) => {
    socket.on('error', (err) => {
      debug('socketing error')
      debug(err)
    })
  })

  // Use IndexSupply SSE live streams instead of ethers.js event listeners
  beginLiveListening().catch(err => {
    debug('Failed to start live streams')
    debug(err)
  })
}

/**
 * Highest block already persisted, so live streams resume exactly where the
 * historical sync left off instead of replaying history or skipping a gap.
 */
async function lastStoredBlock () {
  try {
    const res = getStore().maxLogBlock()
    return res === null || res === undefined ? undefined : Number(res)
  } catch (err) {
    debug('Could not read last stored block, starting from chain head')
    debug(err)
    return undefined
  }
}

/**
 * Start live event streaming via IndexSupply SSE.
 * Routes decoded events to the same model handlers as before.
 */
async function beginLiveListening () {
  debug('Starting IndexSupply live event streams...')

  const fromBlock = await lastStoredBlock()

  liveControllers = await startLiveStreams(async (log) => {
    try {
      // Filter out events from wrong contract addresses
      const contractName = log.name.split('_')[0]
      const expectedAddress = events[contractName]
        ? events[contractName].address.toLowerCase()
        : null

      if (expectedAddress && log.address.toLowerCase() !== expectedAddress) {
        debug('heard event from wrong address')
        return
      }

      // Check for duplicates. (transactionHash, logIndex) is a UNIQUE index in
      // SQLite, so this is now a guard rather than the only line of defence --
      // a racing insert is rejected instead of silently duplicated.
      const store = getStore()
      if (store.findLog(log.transactionHash, log.logIndex)) {
        debug('Log already stored')
        return
      }

      debug('Inserting new log', log.transactionHash)

      store.insertLog(log)
      debug('SUCCESS saving ' + log.name)
      log.userAddresses = getUsers(log.userAddresses)
      // Awaited now. The insert callback fired handleEvent without awaiting it,
      // so a handler that threw produced an unhandled rejection instead of
      // being caught by the try/catch this sits in.
      await handleEvent({ io, db, log })
    } catch (err) {
      debug('Error handling live event:', err.message)
    }
  }, fromBlock)

  debug(`Started ${liveControllers.length} live streams`)
}

function getUsers (userAddresses) {
  try {
    const store = getStore()
    // Note the shape: `address` becomes the whole user document, or null when
    // the user is unknown. That is what the socket payload has always carried.
    return userAddresses.map(u => ({ id: u.id, address: store.getUser(u.address) }))
  } catch (error) {
    debug({ error })
    return userAddresses
  }
}

const ignoredTypes = ['ClubToken_Transfer','CurationMarket_Transfer']

export var handleEvent = async ({ io, db, log }, skipOracle = false) => {
  if (io && !ignoredTypes.includes(log.name)) {
    if (log.name !== 'Clovers_Transfer' || log.data._to.toLowerCase() !== Clovers.networks[network.chainId].address.toLowerCase()) {
      io.emit('newLog', log)
    }
  }
  let foo = log.name.split('_')
  let contract = foo[0]
  let name = foo[1]
  debug('handle ' + name + ' from ' + contract)

  switch (contract) {
    case 'Clovers':
      if (typeof clovers['clovers' + name] === 'function') {
        await clovers['clovers' + name]({ log, io, db }, skipOracle)
      } else {
        throw new Error('Event ' + name + ' not found in ' + contract)
      }
      break
    case 'ClubToken':
      if (typeof clubToken['clubToken' + name] === 'function') {
        await clubToken['clubToken' + name]({ log, io, db })
      } else {
        throw new Error('Event ' + name + ' not found in ' + contract)
      }
      break
    case 'ClubTokenController':
      if (
        typeof clubTokenController['clubTokenController' + name] === 'function'
      ) {
        await clubTokenController['clubTokenController' + name]({
          log,
          io,
          db
        })
      } else {
        throw new Error('Event ' + name + ' not found in ' + contract)
      }
      break
    case 'SimpleCloversMarket':
      if (
        typeof simpleCloversMarket['simpleCloversMarket' + name] === 'function'
      ) {
        await simpleCloversMarket['simpleCloversMarket' + name]({
          log,
          io,
          db
        })
      } else {
        throw new Error('Event ' + name + ' not found in ' + contract)
      }
      break
    // case 'CurationMarket':
    //   if (typeof curationMarket['curationMarket' + name] === 'function') {
    //     await curationMarket['curationMarket' + name]({ log, io, db })
    //   } else {
    //     throw new Error('Event ' + name + ' not found in ' + contract)
    //   }
    //   break
    case 'CloversController':
      if (typeof cloversController['cloversController' + name] === 'function') {
        await cloversController['cloversController' + name]({ log, io, db })
      } else {
        throw new Error('Event ' + name + ' not found in ' + contract)
      }
      break
    case 'Comment':
    case 'CloverName':
    case 'Album':
      await modifyClover(log, db)
      break
    default:
      // Returned rather than thrown, so an event from an unknown contract was
      // reported by resolving with an Error object -- which every caller here
      // treats as success. Thrown now, so processLog's retry and the live
      // listener's catch actually see it.
      throw new Error('Contract ' + contract + ' not found')
  }
}

async function modifyClover ({ name, data, blockNumber }, db) {
  const { board } = data
  if (!board || !blockNumber) return

  debug('updating clover modified value after', name)
  getStore().updateClover(board, { modified: blockNumber })
}
