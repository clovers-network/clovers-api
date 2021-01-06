import r from 'rethinkdb'
import config from './config.json'
export default (callback) => {
  // connect to a database if needed, then pass it to `callback`:
  try {
    const chainId = config.network.chainId
    const dbName = `clovers_chain_${chainId}`
    // const dbName = 'clovers_test'
    r.connect(
      { host: 'localhost', port: 28015, db: dbName },
      function (err, conn) {
        if (err) throw new Error(err)
        callback(conn)
      }
    )
  } catch (err) {
    throw new Error(err)
  }
}
