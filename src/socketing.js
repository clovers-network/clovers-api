const debug = require('debug')('app:socketing')
import { provider, events } from './lib/ethers-utils'
import { network } from './config'
import ethers from 'ethers'
import * as clovers from './models/clovers'
import * as clubToken from './models/clubToken'
import * as cloversController from './models/cloversController'
import * as clubTokenController from './models/clubTokenController'
// import * as curationMarket from './models/curationMarket'
import * as simpleCloversMarket from './models/simpleCloversMarket'
import { transformLog } from './lib/build'
import r from 'rethinkdb'
import {Clovers} from 'clovers-contracts'

const CLOVER_DB = `clovers_chain_${network.chainId}`

let io, db

export var socketing = function ({ _io, _db }) {
  debug('socketing?')
  if (process.env.HOME !== '/home/billy') {
    debug('do not socket')
    return
  }

  debug('yes')

  io = _io
  db = _db
  var connections = 0
  io.on('connection', (socket) => {
    connections += 1
    debug('opened, now ' + connections + ' connections')
    socket.on('data', (data) => {
      debug(data)
    })
    socket.on('disconnect', () => {
      connections -= 1
      debug('closed, now ' + connections + ' connections')
    })
    socket.on('error', (err) => {
      debug('error', err)
    })
  })
  beginListen('Clovers')
  beginListen('ClubToken')
  // beginListen('CloversController') // no events to listen to
  beginListen('SimpleCloversMarket')
  // beginListen('CurationMarket')
  beginListen('ClubTokenController')
}

async function beginListen (contract, key = 0) {
  let eventTypes = events[contract].eventTypes
  if (key > eventTypes.length - 1) return
  beginListen(contract, key + 1)
  let eventType = events[contract].instance.interface.events[eventTypes[key]]
  if (!eventType) {
    debug(eventTypes[key] + ' doesnt exists')
    return
  }
  const eventName = events[contract].eventTypes[key]
  if (!eventName) {
    debug('key ' + key + ' doesnt exists on contract events')
    debug(events[contract].eventTypes)
    return
  }
  debug('make a listener on ' + contract + ' ' + eventName)
  events[contract].instance.on(eventName, async (...foo) => {
    let log = foo[foo.length - 1]
    // filter out events from different contracts
    let address = events[contract].address.toLowerCase()
    if (log.address.toLowerCase() !== address) {
      console.log('heard event from wrong address')
      return
    }
    log = transformLog(log, contract, key)

    // no duplicates, hopefully
    const check = r.table('logs').getAll([
      log.transactionHash,
      log.logIndex
    ], { index: 'unique_log' }).coerceTo('array')
    const res = await dodb(db, check)

    if (res.length) {
      debug('Log already stored')
      return
    }

    r.table('logs')
      .insert(log)
      .run(db, async (err, results) => {
        debug((err ? 'ERROR ' : 'SUCCESS ') + 'saving ' + log.name)
        if (err) throw new Error(err)
        log.userAddresses = await getUsers(log.userAddresses)
        handleEvent({ io, db, log })
      })
  })
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
