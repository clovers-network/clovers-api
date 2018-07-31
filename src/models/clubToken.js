import r from 'rethinkdb'

export let clubTokenBurn = function({log, io, db}) {
  console.log(log)
  let user = log.data.burner
  let amount = log.data.value
  r.db('clovers_v2').table('users').get(user).run(db, (err, user) => {
    user.balance -= amount
    r.db('clovers_v2').table('users').get(user).update(user).run(db, (err, result) => {
      io && io.emit('updateUser', user)
    })
  })
}
export let clubTokenMint = function({log, io, db}) {
  console.log(log)
  let user = log.data.to
  let amount = log.data.amount
  r.db('clovers_v2').table('users').get(user).run(db, (err, user) => {
    user.balance += amount
    r.db('clovers_v2').table('users').get(user).update(user).run(db, (err, result) => {
      io && io.emit('updateUser', user)
    })
  })
}
export let clubTokenApproval = function({log, io, db}) {
  console.log(log)
}
export let clubTokenTransfer = function({log, io, db}) {
  console.log(log)
}
export let clubTokenOwnershipTransferred = function({log, io, db}) {
  console.log(log)
}
