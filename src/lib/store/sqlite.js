/**
 * SQLite-backed store.
 *
 * Replaces direct ReQL from the application code. Deliberately NOT a ReQL
 * emulator: the codebase composes ReQL chains arbitrarily, and faithfully
 * reimplementing that lazy-chain semantics would be a large interpreter with
 * many places to be subtly wrong. Instead this exposes the operations the app
 * actually performs, which is a much smaller and checkable surface.
 *
 * Semantics deliberately preserved from RethinkDB:
 *   - insert with conflict:'update'  -> INSERT ... ON CONFLICT DO UPDATE
 *   - update with r.row('x').add(1)  -> UPDATE ... SET x = COALESCE(x,0)+1
 *   - update from a subquery count   -> UPDATE ... SET n = (SELECT count(*) ...)
 *   - returnChanges:true             -> RETURNING
 *   - a missing field is NULL, not an error (RethinkDB rows are schemaless)
 *
 * Values are stored exactly as RethinkDB held them; see migration/sqlite/schema.sql.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// Filter predicates, mirroring the ReQL secondary indexes one-for-one. The
// asymmetry between Sym and NonSym is intentional and matches the original --
// see migration/sqlite/README.md.
export function cloverFilterSql (filter, cloversAddress) {
  const C = String(cloversAddress).toLowerCase()
  switch (filter) {
    case 'contract':  return `owner_lc = '${C}'`
    case 'public':    return `owner_lc NOT IN ('${C}','${ZERO_ADDRESS}')`
    case 'market':    return `price_is_zero = 0`
    case 'pending':   return `owner_lc = '${C}' AND price_is_zero = 1`
    case 'Sym':       return `sym_total > 0`
    case 'NonSym':    return `sym_total = 0 AND owner_lc <> '${ZERO_ADDRESS}'`
    case 'RotSym':    return `json_extract(symmetries,'$.RotSym') = 1`
    case 'X0Sym':     return `json_extract(symmetries,'$.X0Sym') = 1`
    case 'XYSym':     return `json_extract(symmetries,'$.XYSym') = 1`
    case 'XnYSym':    return `json_extract(symmetries,'$.XnYSym') = 1`
    case 'Y0Sym':     return `json_extract(symmetries,'$.Y0Sym') = 1`
    case 'commented': return `commentCount > 0`
    case 'multi':     return `owner_lc <> '${ZERO_ADDRESS}'`
    case 'all':
    default:          return `owner_lc <> '${ZERO_ADDRESS}'`
  }
}

const JSON_FIELDS = {
  clovers: ['moves', 'symmetries'],
  users: ['curationMarket'],
  logs: ['topics', 'data', 'args', 'userAddresses'],
  albums: ['clovers']
}

// Columns that exist as GENERATED in the schema and must never be written.
const GENERATED = {
  clovers: new Set(['owner_lc', 'sym_total', 'price_is_zero', 'is_named']),
  logs: new Set(['data_to', 'data_tokenId', 'data_board', 'feed_type', 'is_active', 'clover_key']),
  albums: new Set(['cloverCount'])
}

/** Rehydrate JSON columns so callers see the same shape RethinkDB returned. */
function decode (table, row) {
  if (!row) return null
  const out = { ...row }
  for (const f of JSON_FIELDS[table] || []) {
    if (typeof out[f] === 'string') {
      try { out[f] = JSON.parse(out[f]) } catch (e) { /* leave as-is */ }
    }
  }
  if (table === 'clovers') {
    out.kept = !!out.kept
    delete out.owner_lc; delete out.sym_total; delete out.price_is_zero; delete out.is_named
  }
  if (table === 'logs') {
    out.removed = !!out.removed
    delete out.data_to; delete out.data_tokenId; delete out.data_board
    delete out.feed_type; delete out.is_active; delete out.clover_key
  }
  if (table === 'chats') { out.deleted = !!out.deleted; out.flagged = !!out.flagged }
  // cloverCount is generated here but computed by an index in RethinkDB, so it
  // is not part of the document shape callers expect.
  if (table === 'albums') delete out.cloverCount
  return out
}

/** Serialise a document for writing: JSON columns stringified, booleans to 0/1. */
function encode (table, doc) {
  const out = {}
  for (const [k, v] of Object.entries(doc)) {
    if (v === undefined) continue
    if ((GENERATED[table] || new Set()).has(k)) continue
    if ((JSON_FIELDS[table] || []).includes(k)) out[k] = v === null ? null : JSON.stringify(v)
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0
    else if (v !== null && typeof v === 'object') out[k] = JSON.stringify(v)
    else out[k] = v
  }
  return out
}

export function createStore (db, { cloversAddress }) {
  const one = (table, sql, ...args) => decode(table, db.prepare(sql).get(...args))
  const many = (table, sql, ...args) => db.prepare(sql).all(...args).map(r => decode(table, r))

  function insert (table, doc, { conflict } = {}) {
    const enc = encode(table, doc)
    const cols = Object.keys(enc)
    if (!cols.length) return { inserted: 0 }
    const ph = cols.map(() => '?').join(',')
    const pk = table === 'clovers' ? 'board' : table === 'users' ? 'address' : 'id'

    const sql = conflict === 'update'
      ? `INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph})
         ON CONFLICT(${pk}) DO UPDATE SET ${cols.filter(c => c !== pk).map(c => `${c}=excluded.${c}`).join(',')}
         RETURNING *`
      : `INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph}) RETURNING *`

    const row = db.prepare(sql).get(...cols.map(c => enc[c]))
    return { inserted: 1, new_val: decode(table, row) }
  }

  function update (table, pk, pkValue, patch) {
    const enc = encode(table, patch)
    const cols = Object.keys(enc)
    if (!cols.length) return { replaced: 0 }
    const sets = cols.map(c => `${c}=?`).join(',')
    const row = db.prepare(`UPDATE ${table} SET ${sets} WHERE ${pk}=? RETURNING *`)
      .get(...cols.map(c => enc[c]), pkValue)
    return { replaced: row ? 1 : 0, new_val: decode(table, row) }
  }

  return {
    raw: db,

    // ---- clovers ---------------------------------------------------------
    getClover: board => one('clovers', 'SELECT * FROM clovers WHERE board = ?', board),

    insertClover: (clover, opts) => insert('clovers', clover, opts),

    updateClover: (board, patch) => update('clovers', 'board', board, patch),

    /** r.row('commentCount').add(n).default(0) */
    bumpCommentCount: (board, delta) =>
      db.prepare('UPDATE clovers SET commentCount = MAX(0, COALESCE(commentCount,0) + ?) WHERE board = ?')
        .run(delta, board),

    countClovers: (filter, x) => {
      const where = cloverFilterSql(filter, cloversAddress)
      if (filter === 'multi') {
        return db.prepare(`SELECT count(*) n FROM clovers WHERE ${where} AND sym_total = ?`).get(x || 1).n
      }
      return db.prepare(`SELECT count(*) n FROM clovers WHERE ${where}`).get().n
    },

    /**
     * `board` is appended to ORDER BY as a deterministic tiebreaker. RethinkDB
     * left ties unordered -- 100 of the 109 `pending` clovers share
     * modified = 0 -- so pagination there was stable only by accident.
     */
    listClovers ({ filter = 'all', sort = 'modified', asc = false, page = 1, pageSize = 24, x }) {
      const where = cloverFilterSql(filter, cloversAddress)
      const extra = filter === 'multi' ? ` AND sym_total = ${Number(x) || 1}` : ''
      const dir = asc ? 'ASC' : 'DESC'
      const col = sort === 'price' ? 'price' : 'modified'
      const offset = Math.max(0, page - 1) * pageSize
      return many('clovers',
        `SELECT * FROM clovers WHERE ${where}${extra} ORDER BY ${col} ${dir}, board ${dir} LIMIT ? OFFSET ?`,
        pageSize, offset)
    },

    cloversByOwner: (owner, { page = 1, pageSize = 24, sort = 'modified', asc = false } = {}) =>
      many('clovers',
        `SELECT * FROM clovers WHERE owner_lc = ? ORDER BY ${sort === 'price' ? 'price' : 'modified'} ${asc ? 'ASC' : 'DESC'}, board LIMIT ? OFFSET ?`,
        String(owner).toLowerCase(), pageSize, Math.max(0, page - 1) * pageSize),

    countCloversByOwner: owner =>
      db.prepare('SELECT count(*) n FROM clovers WHERE owner_lc = ?').get(String(owner).toLowerCase()).n,

    // ---- users -----------------------------------------------------------
    getUser: address => one('users', 'SELECT * FROM users WHERE lower(address) = ?', String(address).toLowerCase()),

    insertUser: (user, opts) => insert('users', user, opts),

    updateUser: (address, patch) => update('users', 'address', address, patch),

    /** cloverCount: r.table('clovers').getAll(address,{index:'owner'}).count() */
    recomputeCloverCount: address =>
      db.prepare(`UPDATE users SET cloverCount =
                    (SELECT count(*) FROM clovers WHERE clovers.owner_lc = lower(users.address))
                  WHERE lower(address) = ?`).run(String(address).toLowerCase()),

    recomputeAlbumCount: address =>
      db.prepare(`UPDATE users SET albumCount =
                    (SELECT count(*) FROM albums WHERE lower(albums.userAddress) = lower(users.address))
                  WHERE lower(address) = ?`).run(String(address).toLowerCase()),

    countUsers: () =>
      db.prepare(`SELECT count(*) n FROM users WHERE lower(address) <> ?`).get(ZERO_ADDRESS).n,

    // ---- logs ------------------------------------------------------------
    insertLog: (log, opts) => insert('logs', log, opts),

    getLogById: id => one('logs', 'SELECT * FROM logs WHERE id = ?', id),

    findLog: (transactionHash, logIndex) =>
      one('logs', 'SELECT * FROM logs WHERE transactionHash = ? AND logIndex = ?', transactionHash, logIndex),

    maxLogBlock: () => db.prepare('SELECT MAX(blockNumber) b FROM logs').get().b,

    countLogs: filter => filter
      ? db.prepare('SELECT count(*) n FROM logs WHERE feed_type = ?').get(filter).n
      : db.prepare('SELECT count(*) n FROM logs WHERE is_active = 1').get().n,

    listLogs ({ filter, page = 1, pageSize = 24, asc = false } = {}) {
      const where = filter ? 'feed_type = ?' : 'is_active = 1'
      const args = filter ? [filter] : []
      const dir = asc ? 'ASC' : 'DESC'
      return many('logs',
        `SELECT * FROM logs WHERE ${where} ORDER BY blockNumber ${dir}, logIndex ${dir} LIMIT ? OFFSET ?`,
        ...args, pageSize, Math.max(0, page - 1) * pageSize)
    },

    logsForClover: (board, { page = 1, pageSize = 12, asc = false } = {}) =>
      many('logs',
        `SELECT * FROM logs WHERE clover_key = ? ORDER BY blockNumber ${asc ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`,
        String(board).toLowerCase(), pageSize, Math.max(0, page - 1) * pageSize),

    // ---- chats -----------------------------------------------------------
    insertChat: (chat, opts) => insert('chats', chat, opts),
    getChat: id => one('chats', 'SELECT * FROM chats WHERE id = ?', id),
    updateChat: (id, patch) => update('chats', 'id', id, patch),
    deleteChat: id => db.prepare('DELETE FROM chats WHERE id = ?').run(id),
    chatsForBoard: board =>
      many('chats', 'SELECT * FROM chats WHERE lower(board) = ? ORDER BY created', String(board).toLowerCase()),

    // ---- albums ----------------------------------------------------------
    insertAlbum: (album, opts) => insert('albums', album, opts),
    getAlbum: id => one('albums', 'SELECT * FROM albums WHERE id = ?', id),
    updateAlbum: (id, patch) => update('albums', 'id', id, patch),
    deleteAlbum: id => db.prepare('DELETE FROM albums WHERE id = ?').run(id),
    albumsByName: name =>
      many('albums', 'SELECT * FROM albums WHERE lower(name) = ?', String(name).toLowerCase()),
    countAlbums: () => db.prepare('SELECT count(*) n FROM albums WHERE cloverCount > 0').get().n,

    // ---- orders ----------------------------------------------------------
    insertOrder: (order, opts) => insert('orders', order, opts),
    ordersForMarket: (market, { pageSize = 24 } = {}) =>
      many('orders', 'SELECT * FROM orders WHERE market = ? ORDER BY created DESC LIMIT ?', market, pageSize)
  }
}
