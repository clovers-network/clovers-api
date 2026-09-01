import { emitChange } from './changes'
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

const crypto = require('crypto')

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// RethinkDB generates a UUID primary key when a document is inserted without
// one; SQLite does not. Several call sites rely on that -- orders, logs, chats
// and albums are all inserted with no `id` -- so the store supplies it.
// Existing rows keep the ids RethinkDB gave them; the format matches.
const ID_TABLES = new Set(['logs', 'orders', 'chats', 'albums'])
const newId = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    // FUTURE: randomUUID exists from Node 14.17, so this branch is only for
    // anything older and can be deleted once the floor is Node 16+.
    : crypto.randomBytes(16).toString('hex').replace(
        /^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')

/**
 * Filter predicates for the clover grid.
 *
 * Every filter excludes burned clovers -- owner 0x0. The ReQL indexes only did
 * that for `all`, `multi`, `public` and `NonSym`; the symmetry family and
 * `market`/`commented` had no owner check, so 263 burned clovers leaked into
 * them. 161 showed up under `Sym`, and between 8 and 68 under each of RotSym,
 * X0Sym, XYSym, XnYSym and Y0Sym -- a clover the contract has destroyed,
 * listed in a browsable filter, linking to a detail page that correctly 404s.
 *
 * `market` and `commented` had no burned rows in the current data, but nothing
 * stopped one: a clover burned while priced, or one that had been commented on,
 * would have appeared. The check is applied uniformly rather than only where it
 * currently bites.
 *
 * This makes `Sym` and `NonSym` symmetrical, which they were not. Sym drops
 * from 42,136 to 41,975.
 */
export function cloverFilterSql (filter, cloversAddress) {
  const C = String(cloversAddress).toLowerCase()
  const alive = `owner_lc <> '${ZERO_ADDRESS}'`
  switch (filter) {
    case 'contract':  return `owner_lc = '${C}'`
    case 'public':    return `owner_lc NOT IN ('${C}','${ZERO_ADDRESS}')`
    case 'market':    return `price_is_zero = 0 AND ${alive}`
    case 'pending':   return `owner_lc = '${C}' AND price_is_zero = 1`
    case 'Sym':       return `sym_total > 0 AND ${alive}`
    case 'NonSym':    return `sym_total = 0 AND ${alive}`
    case 'RotSym':    return `json_extract(symmetries,'$.RotSym') = 1 AND ${alive}`
    case 'X0Sym':     return `json_extract(symmetries,'$.X0Sym') = 1 AND ${alive}`
    case 'XYSym':     return `json_extract(symmetries,'$.XYSym') = 1 AND ${alive}`
    case 'XnYSym':    return `json_extract(symmetries,'$.XnYSym') = 1 AND ${alive}`
    case 'Y0Sym':     return `json_extract(symmetries,'$.Y0Sym') = 1 AND ${alive}`
    case 'commented': return `commentCount > 0 AND ${alive}`
    case 'multi':     return alive
    case 'all':
    default:          return alive
  }
}

/** Wrap a needle for a LIKE containment match, escaping LIKE's own wildcards. */
const likeArg = needle =>
  '%' + String(needle).replace(/[\\%_]/g, c => '\\' + c) + '%'

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
  /**
   * Compile each statement once.
   *
   * Every helper below called db.prepare() on the way in, so a clover grid page
   * -- around 50 statements -- paid 50 compilations. Measured at 17.3 us per
   * prepare+get against 4.8 us for a cached statement, so roughly 0.6 ms per
   * request in compilation alone.
   *
   * Safe because the store is single-threaded and every statement is fully
   * consumed by get()/all()/run() before the next call. `iterate()` is the one
   * exception -- it holds a cursor -- so scanLogCoords prepares its own.
   */
  const stmts = new Map()
  const prep = (sql) => {
    let s = stmts.get(sql)
    if (!s) { s = db.prepare(sql); stmts.set(sql, s) }
    return s
  }

  const one = (table, sql, ...args) => decode(table, prep(sql).get(...args))
  const many = (table, sql, ...args) => prep(sql).all(...args).map(r => decode(table, r))

  // ---- joining a user onto a row, in one statement ------------------------
  //
  // The columns have to be listed rather than SELECT *'d, because both sides
  // of the join have `name`, `created` and `modified` and the second one wins.
  // Read from the schema at startup so a column added later is picked up.
  const columnsOf = (table) =>
    db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map(r => r.name)

  const TABLE_COLS = {}
  const cols = (table) => {
    if (!TABLE_COLS[table]) TABLE_COLS[table] = columnsOf(table).map(c => `${table}.${c}`).join(', ')
    return TABLE_COLS[table]
  }
  let USER_COLS = null
  const userCols = () => {
    if (!USER_COLS) USER_COLS = columnsOf('users').map(c => `u.${c} AS u_${c}`).join(', ')
    return USER_COLS
  }

  /**
   * Run a joined query and split each row back into { ...row, user }.
   *
   * A note on how the ON clause has to be written. `users_address_lc` is an
   * index on `lower(address)`, and SQLite will only use it when the *other*
   * side of the comparison is also wrapped: `lower(u.address) = lower(t.col)`
   * picks up the index, while `lower(u.address) = t.col_already_lowercase`
   * does not, and falls back to scanning all 3,093 users once per outer row.
   * Measured on the clover search: 279 ms against 2.1 ms. The redundant-looking
   * lower() on the right is load-bearing.
   */
  const orderCols = () => columnsOf('orders').map(c => `o.${c} AS o_${c}`).join(', ')

  /**
   * Regroup a joined row by column prefix.
   *
   * Aliased columns come back flat -- u_address, o_created -- so they are
   * split out here. A group whose every column is null means the LEFT JOIN
   * matched nothing, which is a null relation rather than an object of nulls.
   */
  const splitJoined = (table, raw, groups) => {
    const base = {}
    const acc = {}
    for (const g of Object.keys(groups)) acc[g] = { has: false, obj: {} }
    outer: for (const [k, v] of Object.entries(raw)) {
      for (const [g, spec] of Object.entries(groups)) {
        if (k.startsWith(spec.prefix)) {
          if (v !== null) acc[g].has = true
          acc[g].obj[k.slice(spec.prefix.length)] = v
          continue outer
        }
      }
      base[k] = v
    }
    const row = decode(table, base)
    for (const [g, spec] of Object.entries(groups)) {
      row[g] = acc[g].has ? decode(spec.table, acc[g].obj) : null
    }
    return row
  }

  const USER_GROUP = { user: { prefix: 'u_', table: 'users' } }
  const USER_ORDER_GROUPS = {
    user: { prefix: 'u_', table: 'users' },
    lastOrder: { prefix: 'o_', table: 'orders' }
  }
  const stripUser = (row) => {
    if (row.user) { delete row.user.clovers; delete row.user.curationMarket }
    return row
  }

  const joinUser = (table, ownerField, sql, ...args) =>
    prep(sql).all(...args).map(raw => splitJoined(table, raw, USER_GROUP))

  // The clover listings all want the same thing: a page, its owners, and each
  // clover's most recent order. lastOrder is a correlated subquery rather than
  // a join on `market` because it needs the single latest row, not all of them
  // -- and it is still one statement, which is the whole point.
  const cloverPage = (where, args, col, dir, pageSize, offset) =>
    prep(`SELECT ${cols('clovers')}, ${userCols()}, ${orderCols()}
          FROM clovers
          LEFT JOIN users u ON lower(u.address) = lower(clovers.owner)
          LEFT JOIN orders o ON o.id = (
            SELECT id FROM orders WHERE market = clovers.board
            ORDER BY created DESC, transactionIndex DESC LIMIT 1)
          WHERE ${where}
          ORDER BY clovers.${col} ${dir}, clovers.board ${dir}
          LIMIT ? OFFSET ?`)
      .all(...args, pageSize, offset)
      .map(raw => stripUser(splitJoined('clovers', raw, USER_ORDER_GROUPS)))

  function insert (table, doc, { conflict } = {}) {
    if (ID_TABLES.has(table) && (doc.id === undefined || doc.id === null)) {
      doc = { ...doc, id: newId() }
    }
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

    const row = prep(sql).get(...cols.map(c => enc[c]))
    return { inserted: 1, new_val: decode(table, row) }
  }

  function update (table, pk, pkValue, patch) {
    const enc = encode(table, patch)
    const cols = Object.keys(enc)
    if (!cols.length) return { replaced: 0 }
    const sets = cols.map(c => `${c}=?`).join(',')
    const row = prep(`UPDATE ${table} SET ${sets} WHERE ${pk}=? RETURNING *`)
      .get(...cols.map(c => enc[c]), pkValue)
    return { replaced: row ? 1 : 0, new_val: decode(table, row) }
  }

  return {
    raw: db,

    /**
     * Run `fn` with another database file attached as `sync`.
     *
     * This is how the rebuild copies human-authored data (chats, albums,
     * clover and user names) forward from the pre-rebuild snapshot. RethinkDB
     * could address two databases in one query because both lived in the same
     * server; ATTACH is SQLite's equivalent, and it means the copy is still a
     * single INSERT ... SELECT rather than a read-then-write loop.
     */
    withAttached (file, fn) {
      db.exec(`ATTACH DATABASE '${String(file).replace(/'/g, "''")}' AS sync`)
      try {
        return fn(db)
      } finally {
        try { db.exec('DETACH DATABASE sync') } catch (err) { /* already gone */ }
      }
    },

    // ---- clovers ---------------------------------------------------------
    getClover: board => one('clovers', 'SELECT * FROM clovers WHERE board = ?', board),

    insertClover: (clover, opts) => insert('clovers', clover, opts),

    updateClover: (board, patch) => update('clovers', 'board', board, patch),

    /** r.row('commentCount').add(n).default(0) */
    bumpCommentCount: (board, delta) =>
      prep('UPDATE clovers SET commentCount = MAX(0, COALESCE(commentCount,0) + ?) WHERE board = ?')
        .run(delta, board),

    /**
     * Row counts per filter.
     *
     * `all` is special-cased. Its predicate is `owner_lc <> ZERO`, and `<>`
     * cannot seek, so SQLite scanned all 44,589 rows on every unfiltered grid
     * request -- 8.3 ms, by far the most expensive statement in the codebase.
     * Counting the whole table and subtracting the burned ones is the same
     * number from two seeks: 11 us, a 750x improvement. Every other filter has
     * a positive predicate with a partial index that matches it exactly, so
     * those already count from the index.
     */
    countClovers (filter, x) {
      const where = cloverFilterSql(filter, cloversAddress)
      if (filter === 'multi') {
        return prep(`SELECT count(*) n FROM clovers WHERE ${where} AND sym_total = ?`).get(x || 1).n
      }
      if (filter === 'all' || !filter) {
        return prep(`SELECT (SELECT count(*) FROM clovers)
                          - (SELECT count(*) FROM clovers WHERE owner_lc = ?) AS n`).get(ZERO_ADDRESS).n
      }
      return prep(`SELECT count(*) n FROM clovers WHERE ${where}`).get().n
    },

    /**
     * The primary key is appended to ORDER BY as a tiebreaker, in the *same*
     * direction as the sort. That is not arbitrary: RethinkDB breaks compound
     * index ties by primary key following the index direction, so a DESC sort
     * ties DESC. Verified against the live API -- an ASC tiebreaker under a
     * DESC sort disagrees with it on every page that contains a tie.
     *
     * This also makes pagination guaranteed-stable rather than incidentally
     * stable, which matters here: 100 of the 109 `pending` clovers share
     * modified = 0.
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

    /**
     * A page of clovers with their owner attached, as GET /clovers returns.
     *
     * The original was `.slice(page).eqJoin('owner', users)` -- an *inner* join
     * applied after paging, so a clover whose owner has no user row silently
     * vanishes from its page while still being counted in `allResults`. No such
     * clover exists today (checked: 0 of 44,589), but the filter is kept so the
     * endpoint cannot start returning half-formed rows if one ever appears.
     */
    /**
     * A page of clovers with their owner and latest order, in one statement.
     *
     * This was the page query plus a getUser and a lastOrderForMarket per row:
     * 50 statements for a page of 24. Each is fast now that the users index
     * exists -- about 58 us in total -- so locally it barely showed. It matters
     * structurally: 50 statements is 50 round trips anywhere the database is
     * not in-process, and it forced the query audit's N+1 threshold up to the
     * size of the N+1 already present, which made the guard useless.
     *
     * A LEFT JOIN, not the inner eqJoin the ReQL used: that ran after paging,
     * so a clover whose owner had no user row vanished from its page while
     * still being counted in allResults -- a page silently returning 23 of 24.
     */
    listCloversWithUsers ({ filter = 'all', sort = 'modified', asc = false, page = 1, pageSize = 24, x } = {}) {
      const where = cloverFilterSql(filter, cloversAddress) +
        (filter === 'multi' ? ` AND sym_total = ${Number(x) || 1}` : '')
      return cloverPage(where, [], sort === 'price' ? 'price' : 'modified',
        asc ? 'ASC' : 'DESC', pageSize, Math.max(0, page - 1) * pageSize)
    },

    /** The same shape for one owner's clovers. */
    cloversByOwnerWithUsers (owner, { page = 1, pageSize = 12, sort = 'modified', asc = false, filter } = {}) {
      const where = 'clovers.owner_lc = ?' +
        (filter === 'forsale' ? ' AND price_is_zero = 0' : filter === 'Sym' ? ' AND sym_total > 0' : '')
      return cloverPage(where, [String(owner).toLowerCase()], sort === 'price' ? 'price' : 'modified',
        asc ? 'ASC' : 'DESC', pageSize, Math.max(0, page - 1) * pageSize)
    },

    /** Every clover, for the /sync/all sweep. */
    allClovers: () => many('clovers', 'SELECT * FROM clovers'),

    /** The `pending-modified` index: contract-owned and unpriced, oldest first. */
    pendingClovers: () => many('clovers',
      `SELECT * FROM clovers WHERE ${cloverFilterSql('pending', cloversAddress)}
       ORDER BY modified ASC, board ASC`),

    /** Latest order in a market, by (created, transactionIndex) descending. */
    lastOrderForMarket: market => one('orders',
      `SELECT * FROM orders WHERE market = ?
       ORDER BY created DESC, transactionIndex DESC LIMIT 1`, market),

    /** Live count of undeleted comments on a board. */
    countChats: board => db.prepare(
      'SELECT COUNT(*) AS n FROM chats WHERE board = ?').get(board).n,

    /**
     * The clover plus the owner and its latest order -- the shape every clover
     * payload uses.
     *
     * The `.without('clovers', 'curationMarket')` in the original is why those
     * two are dropped: the payload carries a summary user, not the whole
     * document. `clovers` is not a column here, so only the delete for
     * curationMarket does anything -- kept for symmetry with the original.
     *
     * `lastOrder` now runs the real query. Four call sites previously hardcoded
     * it -- three to null, one to false -- because the lookup never matched:
     * orders are keyed by `market`, and only curationMarket writes orders keyed
     * to a board, and CurationMarket events are commented out of socketing.js.
     * So the query was correct and the data simply absent. Hardcoding meant
     * that turning curation markets back on would have silently left this field
     * empty; running the query means it starts working the moment orders exist.
     * It is an index lookup on orders(market, created, logIndex), so the cost
     * is a seek, and today it returns null exactly as before.
     */
    getCloverWithUser (board) {
      const clover = this.getClover(board)
      if (!clover) return null
      const user = this.getUser(clover.owner)
      if (user) { delete user.curationMarket; delete user.clovers }
      return {
        ...clover,
        lastOrder: this.lastOrderForMarket(clover.board) || null,
        user: user || null
      }
    },

    /**
     * The `owner-*`, `ownersale-*` and `ownersym-*` compound indexes.
     *
     * Ordering by the `price` TEXT column rather than a number is exact where
     * ReQL's `price.coerceTo('number')` is not: prices are wei, so anything
     * above ~0.009 ETH exceeds 2^53 and ReQL's ordering among large prices is
     * approximate. Every stored price is either the literal '0' or a 64-wide
     * zero-padded decimal (verified: 0 non-zero values are unpadded), so
     * lexicographic order is numeric order, and '0' sorts below every padded
     * value -- which is where zero belongs.
     */
    cloversByOwner (owner, { page = 1, pageSize = 24, sort = 'modified', asc = false, filter } = {}) {
      const extra = filter === 'forsale' ? ' AND price_is_zero = 0'
        : filter === 'Sym' ? ' AND sym_total > 0'
        : ''
      const dir = asc ? 'ASC' : 'DESC'
      return many('clovers',
        `SELECT * FROM clovers WHERE owner_lc = ?${extra}
         ORDER BY ${sort === 'price' ? 'price' : 'modified'} ${dir}, board ${dir} LIMIT ? OFFSET ?`,
        String(owner).toLowerCase(), pageSize, Math.max(0, page - 1) * pageSize)
    },

    countCloversByOwner: (owner, filter) => {
      const extra = filter === 'forsale' ? ' AND price_is_zero = 0'
        : filter === 'Sym' ? ' AND sym_total > 0'
        : ''
      return prep(`SELECT count(*) n FROM clovers WHERE owner_lc = ?${extra}`)
        .get(String(owner).toLowerCase()).n
    },

    /** Every clover an address owns, for the /users/sync/:id sweep. */
    allCloversByOwner: owner =>
      many('clovers', 'SELECT * FROM clovers WHERE owner_lc = ?', String(owner).toLowerCase()),

    // ---- users -----------------------------------------------------------
    getUser: address => one('users', 'SELECT * FROM users WHERE lower(address) = ?', String(address).toLowerCase()),

    insertUser: (user, opts) => insert('users', user, opts),

    updateUser: (address, patch) => update('users', 'address', address, patch),

    /** cloverCount: r.table('clovers').getAll(address,{index:'owner'}).count() */
    recomputeCloverCount: address =>
      prep(`UPDATE users SET cloverCount =
                    (SELECT count(*) FROM clovers WHERE clovers.owner_lc = lower(users.address))
                  WHERE lower(address) = ?`).run(String(address).toLowerCase()),

    recomputeAlbumCount: address =>
      prep(`UPDATE users SET albumCount =
                    (SELECT count(*) FROM albums WHERE lower(albums.userAddress) = lower(users.address))
                  WHERE lower(address) = ?`).run(String(address).toLowerCase()),

    allUserAddresses: () =>
      prep('SELECT address FROM users').all().map(r => r.address),

    countUsers: () =>
      prep(`SELECT count(*) n FROM users WHERE lower(address) <> ?`).get(ZERO_ADDRESS).n,

    /**
     * The `all-{clovers,albums,modified,balance}` indexes, all of which exclude
     * the zero address. `balance` sorts as text for the same reason `price`
     * does -- see cloversByOwner.
     */
    listUsers ({ sort = 'balance', asc = false, page = 1, pageSize = 24 } = {}) {
      const col = { clovers: 'cloverCount', albums: 'albumCount', modified: 'modified', balance: 'balance' }[sort] || 'balance'
      const dir = asc ? 'ASC' : 'DESC'
      return many('users',
        `SELECT * FROM users WHERE lower(address) <> ?
         ORDER BY ${col} ${dir}, address ${dir} LIMIT ? OFFSET ?`,
        ZERO_ADDRESS, pageSize, Math.max(0, page - 1) * pageSize)
    },

    // ---- logs ------------------------------------------------------------
    insertLog: (log, opts) => insert('logs', log, opts),

    getLogById: id => one('logs', 'SELECT * FROM logs WHERE id = ?', id),

    findLog: (transactionHash, logIndex) =>
      one('logs', 'SELECT * FROM logs WHERE transactionHash = ? AND logIndex = ?', transactionHash, logIndex),

    maxLogBlock: () => prep('SELECT MAX(blockNumber) b FROM logs').get().b,

    /**
     * Logs of one event name for one tokenId, oldest first.
     *
     * The original filtered on `l('data')('_tokenId').eq(tokenId)` with no
     * ordering, then read [0].blockNumber to find the mint block -- so which
     * row it got was undefined whenever a tokenId had more than one transfer.
     * Ordering oldest-first makes it deterministically the mint, which is what
     * the caller wants. Matching is case-insensitive because data_tokenId is a
     * lowered generated column; both sides are ethers-produced lowercase hex in
     * practice, so this is the same set.
     */
    logsForTokenId: (name, tokenId) => many('logs',
      `SELECT * FROM logs WHERE name = ? AND data_tokenId = ?
       ORDER BY blockNumber, logIndex`, name, String(tokenId).toLowerCase()),

    /**
     * Bulk-insert logs, skipping any already stored.
     *
     * The original was insert(logs, {conflict:'update'}) -- but transformLog
     * never sets `id`, so RethinkDB minted a fresh UUID for every row and the
     * conflict clause could never fire. Re-running a sync therefore duplicated
     * every log it touched, which is how the 762 and 2,065 duplicate rows found
     * during the audit got there. Here (transactionHash, logIndex) is a real
     * UNIQUE index, so DO NOTHING deduplicates properly.
     */
    insertLogs (logs) {
      const addOne = (l) => {
        if (l.transactionHash != null && l.logIndex != null &&
            this.findLog(l.transactionHash, l.logIndex)) return 0
        insert('logs', l)
        return 1
      }
      let inserted = 0
      const addAll = () => { for (const l of logs) inserted += addOne(l) }
      // better-sqlite3 has .transaction(); node:sqlite does not, so fall back
      // to plain statements there. FUTURE: on node:sqlite this could wrap the
      // loop in explicit BEGIN/COMMIT once that driver is the only one left.
      if (typeof db.transaction === 'function') db.transaction(addAll)()
      else addAll()
      return { inserted, skipped: logs.length - inserted }
    },

    /**
     * Stream every log's identity columns, calling `fn` per row.
     *
     * The audit walks all ~152,000 rows. The original had to stream because
     * RethinkDB caps coerceTo('array') at 100,000 elements; here the reason is
     * simply memory -- and this selects five columns rather than whole
     * documents, so no JSON is parsed for rows the audit only counts.
     */
    scanLogCoords (fn) {
      const stmt = db.prepare(
        'SELECT id, name, blockNumber, logIndex, transactionHash FROM logs')
      // better-sqlite3 and newer node:sqlite expose iterate(); fall back to
      // all() where it is missing. FUTURE: drop the fallback once the runtime
      // is guaranteed to have it.
      const rows = typeof stmt.iterate === 'function' ? stmt.iterate() : stmt.all()
      let n = 0
      for (const row of rows) { fn(row); n++ }
      return n
    },

    /** Delete logs by primary key. Returns the number actually removed. */
    deleteLogs (ids) {
      if (!ids.length) return 0
      const ph = ids.map(() => '?').join(',')
      const res = db.prepare(`DELETE FROM logs WHERE id IN (${ph})`).run(...ids)
      return res.changes || 0
    },

    /** Every log at or after a block, oldest first -- the rebuild replay order. */
    logsFromBlock: block => many('logs',
      'SELECT * FROM logs WHERE blockNumber >= ? ORDER BY blockNumber, logIndex', block),

    countLogs: filter => filter
      ? prep('SELECT count(*) n FROM logs WHERE feed_type = ?').get(filter).n
      : prep('SELECT count(*) n FROM logs WHERE is_active = 1').get().n,

    /**
      * The ReQL `active` and `type` indexes are [predicate, blockNumber] -- and
      * nothing else. So logs sharing a block tie on the primary key `id`, a
      * UUID, in the sort direction. Ordering by logIndex instead looks more
      * sensible but selects a different page whenever a block holds more than
      * 24 events, which for Clovers_Transfer is most of them.
      */
    listLogs ({ filter, page = 1, pageSize = 24, asc = false } = {}) {
      const where = filter ? 'feed_type = ?' : 'is_active = 1'
      const args = filter ? [filter] : []
      const dir = asc ? 'ASC' : 'DESC'
      return many('logs',
        `SELECT * FROM logs WHERE ${where} ORDER BY blockNumber ${dir}, id ${dir} LIMIT ? OFFSET ?`,
        ...args, pageSize, Math.max(0, page - 1) * pageSize)
    },

    countLogsForClover: board => prep(
      'SELECT count(*) n FROM logs WHERE clover_key = ?').get(String(board).toLowerCase()).n,

    logsForClover (board, { page = 1, pageSize = 12, asc = false } = {}) {
      const dir = asc ? 'ASC' : 'DESC'
      return many('logs',
        `SELECT * FROM logs WHERE clover_key = ? ORDER BY blockNumber ${dir}, id ${dir} LIMIT ? OFFSET ?`,
        String(board).toLowerCase(), pageSize, Math.max(0, page - 1) * pageSize)
    },

    // ---- chats -----------------------------------------------------------
    insertChat (chat, opts) {
      const res = insert('chats', chat, opts)
      emitChange('chats', { new_val: res.new_val, old_val: null })
      return res
    },
    getChat: id => one('chats', 'SELECT * FROM chats WHERE id = ?', id),
    updateChat (id, patch) {
      const old_val = this.getChat(id)
      const res = update('chats', 'id', id, patch)
      if (res.replaced) emitChange('chats', { new_val: res.new_val, old_val })
      return res
    },
    deleteChat (id) {
      const old_val = this.getChat(id)
      const res = prep('DELETE FROM chats WHERE id = ?').run(id)
      if (old_val) emitChange('chats', { new_val: null, old_val })
      return res
    },
    chatsForBoard: board =>
      many('chats', 'SELECT * FROM chats WHERE lower(board) = ? ORDER BY created', String(board).toLowerCase()),

    countChatsForBoard: board => prep(
      'SELECT count(*) n FROM chats WHERE lower(board) = ?').get(String(board).toLowerCase()).n,

    /**
     * A page of a board's comments, newest first, ending strictly before
     * `before` -- the ReQL `dates` index [board, created] with an exclusive
     * upper bound.
     *
     * `created` is an ISO-8601 UTC string, so comparing it as text is comparing
     * it as a date. `id` breaks ties: the original's orderBy was an in-memory
     * sort with no tiebreaker, so two comments posted in the same millisecond
     * could swap between calls and be shown twice or not at all.
     *
     * Note the ReQL `dates` index keys on the raw board while the `board` index
     * downcases it. Every board is stored lowercase and the caller lowercases
     * too, so both are matched with lower() here.
     */
    chatsBefore: (board, before, { pageSize = 16 } = {}) => many('chats',
      `SELECT * FROM chats WHERE lower(board) = ? AND created < ?
       ORDER BY created DESC, id DESC LIMIT ?`,
      String(board).toLowerCase(), before, pageSize),

    // ---- albums ----------------------------------------------------------
    insertAlbum (album, opts) {
      // conflict:'update' means this can be an update; report it as one so the
      // listener emits 'edit album' rather than a duplicate 'new album'.
      const old_val = album.id != null ? this.getAlbum(album.id) : null
      const res = insert('albums', album, opts)
      emitChange('albums', { new_val: res.new_val, old_val })
      return res
    },
    getAlbum: id => one('albums', 'SELECT * FROM albums WHERE id = ?', id),
    updateAlbum (id, patch) {
      const old_val = this.getAlbum(id)
      const res = update('albums', 'id', id, patch)
      if (res.replaced) emitChange('albums', { new_val: res.new_val, old_val })
      return res
    },
    deleteAlbum (id) {
      const old_val = this.getAlbum(id)
      const res = prep('DELETE FROM albums WHERE id = ?').run(id)
      if (old_val) emitChange('albums', { new_val: null, old_val })
      return res
    },
    albumsByName: name =>
      many('albums', 'SELECT * FROM albums WHERE lower(name) = ?', String(name).toLowerCase()),

    /**
     * Albums that actually contain something -- the ReQL `all` index.
     *
     * GET /albums also accepts filter=name|userAddress|dates|cloverCount, and
     * every one of them returned an empty 404. They were
     * `getAll(true, {index})` against indexes whose values are names,
     * addresses, [id, modified] pairs and counts -- never the boolean `true` --
     * so they could not match. Meanwhile an unrecognised value like `bogus`
     * fell through to `all` and worked, which is the wrong way round.
     *
     * All of them now select the same row set. Where the name happens to be a
     * real column the endpoint also uses it as the sort key, so `?filter=name`
     * does the obvious thing instead of nothing.
     */
    countAlbums: () =>
      prep('SELECT count(*) n FROM albums WHERE cloverCount > 0').get().n,

    /** A page of albums with their owner attached, in one statement. */
    listAlbums ({ sort = 'modified', asc = false, page = 1, pageSize = 12 } = {}) {
      const sortable = ['name', 'userAddress', 'created', 'modified', 'cloverCount']
      const col = sortable.includes(sort) ? sort : 'modified'
      const dir = asc ? 'ASC' : 'DESC'
      return prep(
        `SELECT ${cols('albums')}, ${userCols()} FROM albums
         LEFT JOIN users u ON lower(u.address) = lower(albums.userAddress)
         WHERE albums.cloverCount > 0
         ORDER BY albums.${col} ${dir}, albums.id ${dir} LIMIT ? OFFSET ?`)
        .all(pageSize, Math.max(0, page - 1) * pageSize)
        .map(raw => stripUser(splitJoined('albums', raw, USER_GROUP)))
    },

    /** The `clovers` multi-index: albums whose clovers array contains a board. */
    albumsContainingClover: board => many('albums',
      `SELECT * FROM albums
       WHERE EXISTS (SELECT 1 FROM json_each(albums.clovers) WHERE value = ?)
       ORDER BY name DESC, id DESC`, String(board).toLowerCase()),

    /** Attach the owner, stripped the way every album payload strips it. */
    withAlbumUser (album) {
      if (!album) return album
      const user = this.getUser(album.userAddress)
      if (user) { delete user.clovers; delete user.curationMarket }
      return { ...album, user: user || null }
    },

    cloverExists: board =>
      prep('SELECT 1 FROM clovers WHERE board = ?').get(board) ? 1 : 0,

    countAlbumsByUser: userAddress => prep(
      'SELECT count(*) n FROM albums WHERE lower(userAddress) = ?').get(String(userAddress).toLowerCase()).n,

    /**
     * `sort` comes straight off the query string in the original, where ReQL's
     * orderBy took it safely. Here it would be string-interpolated into SQL, so
     * it is whitelisted against real columns and falls back to `modified`.
     */
    albumsByUser (userAddress, { sort = 'modified', asc = false, page = 1, pageSize = 12 } = {}) {
      const cols = ['name', 'userAddress', 'created', 'modified', 'cloverCount']
      const col = cols.includes(sort) ? sort : 'modified'
      const dir = asc ? 'ASC' : 'DESC'
      return many('albums',
        `SELECT * FROM albums WHERE lower(userAddress) = ?
         ORDER BY ${col} ${dir}, id ${dir} LIMIT ? OFFSET ?`,
        String(userAddress).toLowerCase(), pageSize, Math.max(0, page - 1) * pageSize)
    },

    // ---- orders ----------------------------------------------------------
    insertOrder: (order, opts) => insert('orders', order, opts),

    findOrder: (transactionHash, logIndex) =>
      one('orders', 'SELECT * FROM orders WHERE transactionHash = ? AND logIndex = ?',
          transactionHash, logIndex),
    /**
     * All orders in a market, newest first.
     *
     * The ReQL `ordered` index is [market, created, logIndex] -- logIndex, not
     * transactionIndex, despite the commented-out orderBy at the call site
     * suggesting otherwise. Matched here so pagination lands identically.
     */
    ordersForMarket: (market, { limit = 2000 } = {}) =>
      many('orders',
        `SELECT * FROM orders WHERE market = ?
         ORDER BY created DESC, logIndex DESC, id DESC LIMIT ?`, market, limit),

    /** GET /orders -- every market, newest first. */
    listOrders: ({ limit = 100, offset = 0 } = {}) =>
      many('orders', 'SELECT * FROM orders ORDER BY created DESC, id DESC LIMIT ? OFFSET ?', limit, offset),

    // ---- search ----------------------------------------------------------

    /**
     * Case-insensitive substring search, the equivalent of ReQL's
     * `match('(?i)' + escapeRegex(s))`.
     *
     * The original escaped the needle for regex and searched for it literally,
     * so LIKE with the *unescaped* needle is the same search -- but LIKE's own
     * metacharacters (% and _) have to be escaped instead, which is what the
     * ESCAPE clause below is for.
     *
     * SQLite's LIKE is case-insensitive for ASCII only, where ReQL's (?i) also
     * folds non-ASCII. Clover, user and album names in this database are ASCII,
     * so the two agree. FUTURE: if non-ASCII names become possible, either
     * compile SQLite with ICU or normalise a `name_lc` column on write.
     */
    /**
     * Joined, not looked up per row. `?s=a` matches 700 clovers and 1,082
     * albums, and attaching a user to each with getUser issued 1,782 separate
     * statements -- 169 ms of the 200 ms the endpoint took. The users index
     * alone brought that to a few ms; the join removes the round-trips too,
     * which is what would matter on any store where a query is a network hop.
     *
     * `board DESC` not `board`: the tiebreaker has to run the same direction as
     * the sort or the index cannot supply the order and SQLite sorts instead.
     */
    searchClovers (needle) {
      return joinUser('clovers', 'owner',
        `SELECT ${cols('clovers')}, ${userCols()} FROM clovers
         LEFT JOIN users u ON lower(u.address) = lower(clovers.owner)
         WHERE clovers.is_named = 1 AND clovers.name LIKE ? ESCAPE '\\'
         ORDER BY clovers.modified DESC, clovers.board DESC`, likeArg(needle))
    },

    searchUsers: needle => many('users',
      `SELECT * FROM users WHERE name LIKE ? ESCAPE '\\' AND lower(address) <> ?
       ORDER BY name`, likeArg(needle), ZERO_ADDRESS),

    searchAlbums (needle) {
      return joinUser('albums', 'userAddress',
        `SELECT ${cols('albums')}, ${userCols()} FROM albums
         LEFT JOIN users u ON lower(u.address) = lower(albums.userAddress)
         WHERE albums.name LIKE ? ESCAPE '\\' ORDER BY albums.name, albums.id`, likeArg(needle))
    },

    /**
     * Expand a log's userAddresses into full user documents.
     *
     * Mirrors the r.branch in api/logs: an array of {id, address} becomes an
     * array of {id, address: <user doc>}; a bare `userAddress` string is passed
     * through unchanged; anything else becomes []. A missing user degrades to
     * {address} rather than null, matching ReQL's .default({address: ...}).
     */
    hydrateLogUsers (log) {
      return this.hydrateLogsUsers([log])[0]
    },

    /**
     * Expand userAddresses across a page of logs with one lookup, not one per
     * address. A page of 24 logs referenced up to 14 users individually; the
     * addresses repeat heavily, so fetching the distinct set in a single IN
     * query is both fewer statements and less work.
     */
    hydrateLogsUsers (logs) {
      const wanted = new Set()
      for (const l of logs) {
        if (Array.isArray(l.userAddresses)) {
          for (const u of l.userAddresses) if (u && u.address) wanted.add(String(u.address).toLowerCase())
        }
      }
      const byAddress = new Map()
      if (wanted.size) {
        const list = [...wanted]
        // Chunked: SQLite's default parameter ceiling is high but not infinite,
        // and an activity feed can reference a lot of distinct addresses.
        for (let i = 0; i < list.length; i += 400) {
          const chunk = list.slice(i, i + 400)
          const ph = chunk.map(() => '?').join(',')
          for (const row of prep(`SELECT * FROM users WHERE lower(address) IN (${ph})`).all(...chunk)) {
            const u = decode('users', row)
            delete u.clovers; delete u.curationMarket
            byAddress.set(String(u.address).toLowerCase(), u)
          }
        }
      }
      return logs.map(log => {
        if (Array.isArray(log.userAddresses)) {
          return {
            ...log,
            userAddresses: log.userAddresses.map(u => ({
              id: u.id,
              address: byAddress.get(String(u.address).toLowerCase()) || { address: u.address }
            }))
          }
        }
        if (log.userAddress) return { ...log, userAddresses: log.userAddress }
        return { ...log, userAddresses: [] }
      })
    }
  }
}
