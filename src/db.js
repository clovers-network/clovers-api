import r from "rethinkdb"

export default callback => {
  // connect to a database if needed, then pass it to `callback`:
  try {
    r.connect(
      { host: "localhost", port: 28015 },
      function(err, conn) {
        if (err) throw new Error(err)
        callback(conn)
      }
    )
  } catch (err) {
    throw new Error(err)
  }
}
