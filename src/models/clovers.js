import r from 'rethinkdb'
import {
  events
} from '../lib/ethers-utils'

export let cloversTransfer  = function({log, io, db}) {
  return Promise.all([
    new Promise(async (resolve, reject) => {
      if (log.data._from === '0x0000000000000000000000000000000000000000') {

        let cloverMoves = await events.Clovers.instance.getCloverMoves(log.data._tokenId)
        let cloverReward = await events.Clovers.instance.getReward(log.data._tokenId)
        let cloverSymmetries = await events.Clovers.instance.getSymmetries(log.data._tokenId)
        let cloverBlock = await events.Clovers.instance.getBlockMinted(log.data._tokenId)
        let cloverURI = await events.Clovers.instance.tokenURI(log.data._tokenId)

        let clover = {
          name: log.data._tokenId,
          board: log.data._tokenId,
          owner: log.data._to
          moves: cloverMoves,
          reward: cloverReward,
          symmetries: cloverSymmetries,
          created: cloverBlock,
          modified: cloverBlock,
          URI: cloverURI
        }
        console.log(clover)
        r.db('clovers_v2').table('clovers').insert(clover).run(db, (err, result) => {
          if (err) return reject(err)
          io && io.emit('addClover', clover);
          resolve()
        })
      } else {
        r.db('clovers_v2').table('clovers').get(log.data._tokenId).run(db, (err, clover) => {
          if (err) return reject(err)
          if (!clover) return reject('clover ' + log.data._tokenId + ' not found')
          // clover.modified = log.data.modified
          clovers.owner = log.data._to
          r.db('clovers_v2').table('clovers').get(log.data._tokenId).update(clover).run(db, (err, result) => {
            if (err) return reject(err)
            io && io.emit('updateClover', clover)
            r.db('clovers_v2').table('users').get(log.data._from).run(db, (err, user) => {
              if (user) {
                user.clovers.splice(user.clovers.indexOf(log.data._tokenId), 1)
                r.db('clovers_v2').table('users').get(log.data._to).update(user).run(db, (err, result) => {
                  if (err) return reject(err)
                  io && io.emit('updateUser', user)
                  resolve()
                })
              } else {
                // this should not happen
                reject(new Error('looking for user ' + log.data._from + ' but not found'))
              }
            })
          })
        })
      }
    }),
    new Promise((resolve, reject) => {
      r.db('clovers_v2').table('users').get(log.data._to).run(db, (err, user) => {
        if (user) {
          user.clovers.push(log.data._tokenId)
          r.db('clovers_v2').table('users').get(log.data._to).update(user).run(db, (err, result) => {
            if (err) return reject(err)
            io && io.emit('updateUser', user)
            resolve()
          })
        } else {
          user = {
            name: log.data._to,
            address: log.data._to,
            clovers: [log.data._tokenId]
          }
          r.db('clovers_v2').table('users').insert(user).run(db, (err, result) => {
            if (err) return reject(err)
            io && io.emit('addUser', user)
            resolve()
          })
        }
      })
    })
  ])
}
export let cloversApproval = function({log, io, db}) {
  console.log(log)
}
export let cloversApprovalForAll = function({log, io, db}) {
  console.log(log)
}
export let cloversOwnershipTransferred = function({log, io, db}) {
  console.log(log)
}