/** Load a backup into a scratch RethinkDB, with the real index set. */
import fs from 'fs'; import path from 'path'; import zlib from 'zlib'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const r = require('rethinkdb')
const tables = require(process.env.TABLES_PATH || '/tmp/clovers-before/dist/lib/db-tables.js')

const dir = process.argv[2]
const DB = 'clovers_chain_1'
const conn = await new Promise((res, rej) => r.connect({host:'localhost',port:28017}, (e,c)=>e?rej(e):res(c)))

const dbs = await r.dbList().run(conn)
if (dbs.includes(DB)) await r.dbDrop(DB).run(conn)
await r.dbCreate(DB).run(conn)
console.log('created', DB)

const read = (n) => zlib.gunzipSync(fs.readFileSync(path.join(dir, `${n}.jsonl.gz`)))
  .toString().split('\n').filter(Boolean).map(l => JSON.parse(l))

for (const t of tables) {
  await r.db(DB).tableCreate(t.name, { primaryKey: t.index }).run(conn)
  const rows = read(t.name)
  for (let i = 0; i < rows.length; i += 2000) {
    await r.db(DB).table(t.name).insert(rows.slice(i, i + 2000), { conflict: 'replace' }).run(conn)
  }
  const n = await r.db(DB).table(t.name).count().run(conn)
  console.log(`  ${t.name.padEnd(8)} ${rows.length} source -> ${n} loaded`)
}

let made = 0
for (const t of tables) {
  if (!t.indexes) continue
  for (const idx of t.indexes) {
    const func = Array.isArray(idx) ? idx[1] : undefined
    const name = func ? idx[0] : idx
    await r.db(DB).table(t.name).indexCreate(name, func).run(conn)
    made++
  }
  await r.db(DB).table(t.name).indexWait().run(conn)
  console.log(`  ${t.name} indexes ready`)
}
console.log(`\n  ${made} secondary indexes built`)
conn.close()
