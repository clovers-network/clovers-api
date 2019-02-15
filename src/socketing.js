const debug = require('debug')('app:socketing')
import { provider, events } from './lib/ethers-utils'
import ethers from 'ethers'
import * as clovers from './models/clovers'
import * as clubToken from './models/clubToken'
import * as cloversController from './models/cloversController'
import * as clubTokenController from './models/clubTokenController'
import * as curationMarket from './models/curationMarket'
import * as simpleCloversMarket from './models/simpleCloversMarket'
import { parseLogForStorage } from './lib/util'
import r from 'rethinkdb'

let io, db

export var socketing = function ({ _io, _db }) {
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
  beginListen('CloversController')
  beginListen('SimpleCloversMarket')
  beginListen('CurationMarket')
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
  // let listen = "on" + eventType().name.toLowerCase();
  // events[contract].instance[listen] = (...log) => {
  //   debug("!!!!!");
  //   debug(log);
  // };
  // var address =
  //   "0x000000000000000000000000" + events[contract].address.substring(2);
  let topics = eventType().topics
  // topics.push(address);
  debug('make a listener on ' + contract + ' ' + eventType().name)
  provider.on(topics, (log) => {
    let address = events[contract].address

    // filter out events from different contracts
    if (log.address.toLowerCase() !== address.toLowerCase()) {
      return
    }
    let abi = events[contract].abi
    let iface = new ethers.Interface(abi)

    log.name = contract + '_' + eventType().name

    // method below works better :)
    // let event = events[contract].abi.find(a => a.name === eventType().name)
    // let names = event.inputs.map(o => o.name)
    // let types = event.inputs.map(o => o.type)
    // log.data = iface.decodeParams(names, types, log.data)

    try {
      let transferCoder = iface.events[eventTypes[key]]
      log.data = transferCoder.parse(log.topics, log.data)
    } catch (err) {
      debug(err)
      return
    }

    log.data = parseLogForStorage(log.data)

    const userKeys = ['_to', 'owner', 'buyer', 'seller']
    let userAddress = null
    for (let k of Object.keys(log.data)) {
      if (userKeys.includes(k)) {
        userAddress = log.data[k].toLowerCase()
      }
    }

    log.userAddress = userAddress

    r.table('logs')
      .insert(log)
      .run(db, (err, results) => {
        debug((err ? 'ERROR ' : 'SUCCESS ') + 'saving ' + log.name)
        if (err) throw new Error(err)
        handleEvent({ io, db, log })
      })
  })
}

const ignoredTypes = ['ClubToken_Transfer','CurationMarket_Transfer']

export var handleEvent = async ({ io, db, log }) => {
  if (io && !ignoredTypes.includes(log.name)) {
    if (log.name !== 'Clovers_Transfer' || log.data._to !== '0x8A0011ccb1850e18A9D2D4b15bd7F9E9E423c11b') {
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
        await clovers['clovers' + name]({ log, io, db })
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
    case 'CurationMarket':
      if (typeof curationMarket['curationMarket' + name] === 'function') {
        await curationMarket['curationMarket' + name]({ log, io, db })
      } else {
        throw new Error('Event ' + name + ' not found in ' + contract)
      }
      break
    case 'CloversController':
      if (typeof cloversController['cloversController' + name] === 'function') {
        await cloversController['cloversController' + name]({ log, io, db })
      } else {
        throw new Error('Event ' + name + ' not found in ' + contract)
      }
      break
    default:
      return new Error('Contract ' + contract + ' not found')
  }
}
