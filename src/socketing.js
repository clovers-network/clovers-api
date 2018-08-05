import { provider, events } from './lib/ethers-utils'
import ethers from 'ethers'
import * as clovers from './models/clovers'
import * as clubToken from './models/clubToken'
import * as cloversController from './models/cloversController'
import { parseLogForStorage } from './lib/util'
import r from 'rethinkdb'

let io, db

export var socketing = function({ _io, _db }) {
  io = _io
  db = _db
  var connections = 0
  io.on('connection', function(socket) {
    connections += 1
    console.log('opened, now ' + connections + ' connections')

    socket.on('data', function(data) {
      console.log(data)
    })
    socket.on('disconnect', function() {
      connections -= 1
      console.log('closed, now ' + connections + ' connections')
    })
    socket.on('error', function(err) {
      console.log('error')
    })
  })
  beginListen('Clovers')
  beginListen('ClubToken')
  beginListen('CloversController')
  beginListen('SimpleCloversMarket')
  beginListen('CurationMarket')
}

async function beginListen(contract, key = 0) {
  let eventTypes = events[contract].eventTypes
  if (key > eventTypes.length - 1) return
  beginListen(contract, key + 1)
  let eventType = events[contract].instance.interface.events[eventTypes[key]]
  if (!eventType) return
  // let listen = "on" + eventType().name.toLowerCase();
  // events[contract].instance[listen] = (...log) => {
  //   console.log("!!!!!");
  //   console.log(log);
  // };
  // var address =
  //   "0x000000000000000000000000" + events[contract].address.substring(2);
  let topics = eventType().topics
  // topics.push(address);
  console.log('make a listener on ' + contract + ' ' + eventType().name)
  provider.on(topics, log => {
    let address = events[contract].address
    if (log.address.toLowerCase() !== address.toLowerCase()) {
      return
    }
    let abi = events[contract].abi
    let iface = new ethers.Interface(abi)

    log.name = contract + '_' + eventType().name

    let transferCoder = iface.events[eventTypes[key]]
    log.data = transferCoder.parse(log.topics, log.data)
    if (false) {
      let event = events[contract].abi.find(a => a.name === eventType().name)
      let names = event.inputs.map(o => o.name)
      let types = event.inputs.map(o => o.type)
      log.data = iface.decodeParams(names, types, log.data)
    } else {
      try {
        let transferCoder = iface.events[eventTypes[key]]
        log.data = transferCoder.parse(log.topics, log.data)
      } catch (err) {
        if (err.message.indexOf('invalid arrayify value') == -1) {
          console.log('didnt work')
          console.log(log)
          console.error(err)
        } else {
          // console.log("why invalid arrify?");
        }
      }

      log.data = parseLogForStorage(log.data)
      r.db('clovers_v2')
        .table('logs')
        .insert(log)
        .run(db, (err, results) => {
          console.log((err ? 'ERROR ' : 'SUCCESS ') + 'saving ' + log.name)
          if (err) throw new Error(err)
          handleEvent({ io, db, log })
        })
    }
  })
}

export var handleEvent = async function({ io, db, log }) {
  io && io.emit('addEvent', log)
  console.log('handleEvent ' + log.name)
  let foo = log.name.split('_')
  let contract = foo[0]
  let name = foo[1]

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
