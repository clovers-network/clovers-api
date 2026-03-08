const debug = require('debug')('app:socketing')
import { events, startLiveStreams } from './lib/indexsupply'
import { network } from './config'
import * as clovers from './models/clovers'
import * as clubToken from './models/clubToken'
import * as cloversController from './models/cloversController'
import * as clubTokenController from './models/clubTokenController'
// import * as curationMarket from './models/curationMarket'
import * as simpleCloversMarket from './models/simpleCloversMarket'
import r from 'rethinkdb'
import { Clovers } from 'clovers-contracts'
import { dodb } from './lib/util'

const CLOVER_DB = `clovers_chain_${network.chainId}`

let io, db

// Keep track of live stream controllers for cleanup
let liveControllers = []

export var socketing = function ({ _io, _db }) {
  debug('socketing?')
  if (process.env.HOME !== '/home/billy') {
    debug('do not socket')
    return
  }

  debug('yes')

  io = _io
  db = _db

  io.on('connection', (socket) => {
    socket.on('error', (err) => {
      debug('socketing error')
      debug(err)
    })
  })

  // Use IndexSupply SSE live streams instead of ethers.js event listeners
  beginLiveListening()
}

/**
 * Start live event streaming via IndexSupply SSE.
 * Routes decoded events to the same model handlers as before.
 */
function beginLiveListening () {
  debug('Starting IndexSupply live event streams...')

  liveControllers = startLiveStreams(async (log) => {
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

      // Check for duplicates
      const check = r.table('logs').getAll([
        log.transactionHash,
        log.logIndex
      ], { index: 'unique_log' }).coerceTo('array')
      const res = await dodb(db, check)

      if (res.length) {
        debug('Log already stored')
        return
      }

      debug('Inserting new log', log.transactionHash)

      r.table('logs')
        .insert(log)
        .run(db, async (err, results) => {
          debug((err ? 'ERROR ' : 'SUCCESS ') + 'saving ' + log.name)
          if (err) throw new Error(err)
          log.userAddresses = await getUsers(log.userAddresses)
          handleEvent({ io, db, log })
        })
    } catch (err) {
      debug('Error handling live event:', err.message)
    }
  })

  debug(`Started ${liveControllers.length} live streams`)
}

async function getUsers(userAddresses, key = 0, newUserAddresses = []) {
  try {
    if (key >= userAddresses.length) {
      return newUserAddresses
    }
    const user = userAddresses[key]
    const u = await r.table('users').get(user.address).run(db)
    newUserAddresses.push({id: user.id, address: u})
    return await getUsers(userAddresses, key + 1, newUserAddresses)
  } catch (error) {
    debug({error})
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
      return new Error('Contract ' + contract + ' not found')
  }
}

async function modifyClover ({ name, data, blockNumber }, db) {
  const { board } = data
  if (!board || !blockNumber) return

  debug('updating clover modified value after', name)
  await r.db(CLOVER_DB).table('clovers').get(board).update({
    modified: blockNumber
  }).run(db)
}
