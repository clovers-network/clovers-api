-- SQLite schema translated from RethinkDB (src/lib/db-tables.js).
--
-- RethinkDB has 74 secondary indexes here, 49 of them on `clovers` alone. That
-- count is an artifact of ReQL rather than real complexity: the only way to do
-- "filter, then sort, then paginate" is `between()` over a compound
-- [predicate, sortkey] index, so the original needs one index per
-- (filter x sort) pair -- `Sym-modified`, `Sym-price`, `market-modified`,
-- `market-price`, and so on.
--
-- SQL expresses that as WHERE + ORDER BY, so the pairs collapse. Each ReQL
-- predicate becomes a PARTIAL INDEX, which is the direct equivalent: the index
-- only contains rows matching the predicate, already ordered by the sort key.
--
-- Value formats are preserved exactly rather than "improved":
--   * price/balance/reward are 64-char zero-padded decimal strings, kept TEXT
--     so lexicographic order still equals numeric order -- that padding is
--     load-bearing and the dapp reads these values verbatim.
--   * clovers/users timestamps are block numbers (INTEGER); albums/chats use
--     ISO-8601 strings (TEXT). Left as they are.
--   * symmetries/moves/curationMarket stay JSON, read via json_extract.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- clovers
-- ---------------------------------------------------------------------------
CREATE TABLE clovers (
  board          TEXT PRIMARY KEY,
  name           TEXT,
  owner          TEXT,
  price          TEXT,            -- 64-char zero-padded decimal
  originalPrice  TEXT,
  reward         TEXT,
  created        INTEGER,         -- block number
  modified       INTEGER,         -- block number
  commentCount   INTEGER DEFAULT 0,
  kept           INTEGER DEFAULT 0,
  foundBy        TEXT,
  moves          TEXT,            -- JSON array
  symmetries     TEXT,            -- JSON object

  -- Derived once on write, so the partial indexes below stay simple and the
  -- API's filter names map to a column each.
  owner_lc       TEXT GENERATED ALWAYS AS (lower(owner)) VIRTUAL,
  sym_total      INTEGER GENERATED ALWAYS AS (
                   COALESCE(json_extract(symmetries,'$.RotSym'),0) +
                   COALESCE(json_extract(symmetries,'$.X0Sym'),0) +
                   COALESCE(json_extract(symmetries,'$.XYSym'),0) +
                   COALESCE(json_extract(symmetries,'$.XnYSym'),0) +
                   COALESCE(json_extract(symmetries,'$.Y0Sym'),0)
                 ) VIRTUAL,
  -- NOT CAST(price AS INTEGER): price is wei, so 1 ETH is 1e18, past JS's
  -- 2^53 safe-integer range. SQLite stores it fine but node:sqlite refuses to
  -- return it rather than lose precision, so any SELECT * on a priced clover
  -- throws. Since price is zero-padded decimal, stripping zeros tests the same
  -- thing exactly and never leaves SQLite's integer domain.
  price_is_zero  INTEGER GENERATED ALWAYS AS (ltrim(COALESCE(price,''),'0') = '') VIRTUAL,
  is_named       INTEGER GENERATED ALWAYS AS (lower(name) <> lower(board)) VIRTUAL
);

-- Every sort index ends in `board`, the primary key. RethinkDB broke index
-- ties by primary key in the sort direction, so the queries all end
-- `ORDER BY <key> <dir>, board <dir>`; without board in the index SQLite
-- satisfies that with a temp b-tree, which turns a 24-row page into a sort of
-- the whole filtered set. `board` is a TEXT primary key, so it is not the
-- rowid and does not come along for free.

-- Predicates, one per ReQL index family. ZERO_ADDRESS and the Clovers contract
-- address are inlined because SQLite partial indexes require constant
-- expressions; both are fixed for mainnet.
--   ZERO      = 0x0000000000000000000000000000000000000000
--   CLOVERS   = 0xb55c5cac5014c662fdbf21a2c59cd45403c482fd

-- all: owner <> ZERO
CREATE INDEX clovers_all_modified ON clovers(modified, board)
  WHERE owner_lc <> '0x0000000000000000000000000000000000000000';
CREATE INDEX clovers_all_price ON clovers(price, board)
  WHERE owner_lc <> '0x0000000000000000000000000000000000000000';

-- contract: owner = CLOVERS
CREATE INDEX clovers_contract_modified ON clovers(modified, board)
  WHERE owner_lc = '0xb55c5cac5014c662fdbf21a2c59cd45403c482fd';
CREATE INDEX clovers_contract_price ON clovers(price, board)
  WHERE owner_lc = '0xb55c5cac5014c662fdbf21a2c59cd45403c482fd';

-- public: owner NOT IN (CLOVERS, ZERO)
CREATE INDEX clovers_public_modified ON clovers(modified, board)
  WHERE owner_lc NOT IN ('0xb55c5cac5014c662fdbf21a2c59cd45403c482fd',
                         '0x0000000000000000000000000000000000000000');
CREATE INDEX clovers_public_price ON clovers(price, board)
  WHERE owner_lc NOT IN ('0xb55c5cac5014c662fdbf21a2c59cd45403c482fd',
                         '0x0000000000000000000000000000000000000000');

-- pending: owned by the contract and unpriced
CREATE INDEX clovers_pending_modified ON clovers(modified, board)
  WHERE owner_lc = '0xb55c5cac5014c662fdbf21a2c59cd45403c482fd'
    AND price_is_zero = 1;
CREATE INDEX clovers_pending_price ON clovers(price, board)
  WHERE owner_lc = '0xb55c5cac5014c662fdbf21a2c59cd45403c482fd'
    AND price_is_zero = 1;

-- market: priced, and not burned
CREATE INDEX clovers_market_modified ON clovers(modified, board)
  WHERE price_is_zero = 0 AND owner_lc <> '0x0000000000000000000000000000000000000000';
CREATE INDEX clovers_market_price    ON clovers(price, board)
  WHERE price_is_zero = 0 AND owner_lc <> '0x0000000000000000000000000000000000000000';

-- Symmetry families.
--
-- Every one of these carries the owner check. The ReQL originals did not --
-- NonSym was `sum = 0 AND owner <> ZERO` but Sym was a bare `sum > 0` -- so
-- burned clovers counted as symmetrical while being excluded from
-- non-symmetrical, and 161 of them were listed under Sym. That asymmetry was
-- reproduced during the port and is now fixed; see the note in
-- cloverFilterSql. The predicate here must stay identical to the one there, or
-- SQLite silently falls back to a scan.
CREATE INDEX clovers_sym_modified ON clovers(modified, board)
  WHERE sym_total > 0 AND owner_lc <> '0x0000000000000000000000000000000000000000';
CREATE INDEX clovers_sym_price    ON clovers(price, board)
  WHERE sym_total > 0 AND owner_lc <> '0x0000000000000000000000000000000000000000';
CREATE INDEX clovers_nonsym_modified ON clovers(modified, board)
  WHERE sym_total = 0 AND owner_lc <> '0x0000000000000000000000000000000000000000';
CREATE INDEX clovers_nonsym_price ON clovers(price, board)
  WHERE sym_total = 0 AND owner_lc <> '0x0000000000000000000000000000000000000000';

-- Individual symmetries: expression indexes, since the value is in JSON.
-- Partial on the owner check for the same reason as above. One index per sort
-- key rather than one carrying both: a single (expr, modified, price, board)
-- index serves ORDER BY modified but leaves ORDER BY price to a temp b-tree,
-- because price sits after modified in the key.
CREATE INDEX clovers_rotsym_modified ON clovers(json_extract(symmetries,'$.RotSym'), modified, board)
  WHERE owner_lc <> '0x0000000000000000000000000000000000000000';
CREATE INDEX clovers_rotsym_price    ON clovers(json_extract(symmetries,'$.RotSym'), price, board)
  WHERE owner_lc <> '0x0000000000000000000000000000000000000000';
CREATE INDEX clovers_x0sym_modified ON clovers(json_extract(symmetries,'$.X0Sym'), modified, board)
  WHERE owner_lc <> '0x0000000000000000000000000000000000000000';
CREATE INDEX clovers_x0sym_price    ON clovers(json_extract(symmetries,'$.X0Sym'), price, board)
  WHERE owner_lc <> '0x0000000000000000000000000000000000000000';
CREATE INDEX clovers_xysym_modified ON clovers(json_extract(symmetries,'$.XYSym'), modified, board)
  WHERE owner_lc <> '0x0000000000000000000000000000000000000000';
CREATE INDEX clovers_xysym_price    ON clovers(json_extract(symmetries,'$.XYSym'), price, board)
  WHERE owner_lc <> '0x0000000000000000000000000000000000000000';
CREATE INDEX clovers_xnysym_modified ON clovers(json_extract(symmetries,'$.XnYSym'), modified, board)
  WHERE owner_lc <> '0x0000000000000000000000000000000000000000';
CREATE INDEX clovers_xnysym_price    ON clovers(json_extract(symmetries,'$.XnYSym'), price, board)
  WHERE owner_lc <> '0x0000000000000000000000000000000000000000';
CREATE INDEX clovers_y0sym_modified ON clovers(json_extract(symmetries,'$.Y0Sym'), modified, board)
  WHERE owner_lc <> '0x0000000000000000000000000000000000000000';
CREATE INDEX clovers_y0sym_price    ON clovers(json_extract(symmetries,'$.Y0Sym'), price, board)
  WHERE owner_lc <> '0x0000000000000000000000000000000000000000';

-- multi: symmetry count, excluding burned. The API filters on x = 1, 3 or 5.
CREATE INDEX clovers_multi_modified ON clovers(sym_total, modified, board)
  WHERE owner_lc <> '0x0000000000000000000000000000000000000000';
CREATE INDEX clovers_multi_price ON clovers(sym_total, price, board)
  WHERE owner_lc <> '0x0000000000000000000000000000000000000000';

CREATE INDEX clovers_commented_modified ON clovers(modified, board)
  WHERE commentCount > 0 AND owner_lc <> '0x0000000000000000000000000000000000000000';
CREATE INDEX clovers_commented_price    ON clovers(price, board)
  WHERE commentCount > 0 AND owner_lc <> '0x0000000000000000000000000000000000000000';
CREATE INDEX clovers_named              ON clovers(modified, board) WHERE is_named = 1;

-- owner-scoped listings, and the two owner+facet composites
CREATE INDEX clovers_owner_modified   ON clovers(owner_lc, modified, board);
CREATE INDEX clovers_owner_price      ON clovers(owner_lc, price, board);
CREATE INDEX clovers_ownersym_modified  ON clovers(owner_lc, sym_total > 0, modified, board);
CREATE INDEX clovers_ownersym_price     ON clovers(owner_lc, sym_total > 0, price, board);
CREATE INDEX clovers_ownersale_modified ON clovers(owner_lc, price_is_zero = 0, modified, board);
CREATE INDEX clovers_ownersale_price    ON clovers(owner_lc, price_is_zero = 0, price, board);

CREATE INDEX clovers_modified ON clovers(modified);
CREATE INDEX clovers_created  ON clovers(created);

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  address        TEXT PRIMARY KEY,
  name           TEXT,
  balance        TEXT,
  created        INTEGER,
  modified       INTEGER,
  cloverCount    INTEGER DEFAULT 0,
  albumCount     INTEGER DEFAULT 0,
  image          TEXT,
  curationMarket TEXT             -- JSON
);
-- Every user lookup in the application goes through lower(address). The
-- PRIMARY KEY cannot serve that -- wrapping a column in a function defeats its
-- index -- so before this existed, `SELECT * FROM users WHERE lower(address)=?`
-- was a full scan of 3,093 rows, and it is the single most-issued statement in
-- the codebase: 24 times per clover grid page, 1,782 times for /search?s=a.
-- Measured: 113.6 us to 2.4 us, a 47x improvement on the hottest query here.
--
-- An expression index rather than lowercasing the column, because it is exact:
-- if a mixed-case address is ever written the semantics do not silently change.
CREATE INDEX users_address_lc ON users(lower(address));

-- Sort indexes carry `address` so the primary-key tiebreaker is satisfied by
-- the index instead of a temp b-tree. Same reasoning as the clovers indexes.
CREATE INDEX users_modified ON users(modified, address);
CREATE INDEX users_balance  ON users(balance, address);
CREATE INDEX users_clovers  ON users(cloverCount, address);
CREATE INDEX users_albums   ON users(albumCount, address);

-- ---------------------------------------------------------------------------
-- logs
-- ---------------------------------------------------------------------------
CREATE TABLE logs (
  id               TEXT PRIMARY KEY,
  name             TEXT,
  address          TEXT,
  blockNumber      INTEGER,
  transactionHash  TEXT,
  transactionIndex INTEGER,
  logIndex         INTEGER,
  blockHash        TEXT,
  removed          INTEGER DEFAULT 0,
  topics           TEXT,          -- JSON array
  data             TEXT,          -- JSON object (decoded event args)
  args             TEXT,          -- JSON, legacy rows only
  event            TEXT,
  eventSignature   TEXT,
  userAddresses    TEXT,          -- JSON array
  userAddress      TEXT,

  data_to      TEXT GENERATED ALWAYS AS (lower(json_extract(data,'$._to')))     VIRTUAL,
  data_tokenId TEXT GENERATED ALWAYS AS (lower(json_extract(data,'$._tokenId'))) VIRTUAL,
  data_board   TEXT GENERATED ALWAYS AS (lower(json_extract(data,'$.board')))    VIRTUAL,

  -- The `type` index folds Buy/Sell into one feed category.
  feed_type TEXT GENERATED ALWAYS AS (
    CASE WHEN name IN ('ClubTokenController_Buy','ClubTokenController_Sell')
         THEN 'Coin_Activity' ELSE name END
  ) VIRTUAL,

  -- The `active` index encodes which events belong in the activity feed:
  -- exclude ClubToken/CurationMarket transfers and Album_Created outright, and
  -- exclude Clovers_Transfer only when it is a transfer *to* the Clovers
  -- contract (i.e. a clover returning to market rather than a user action).
  is_active INTEGER GENERATED ALWAYS AS (
    CASE
      WHEN name IN ('ClubToken_Transfer','CurationMarket_Transfer','Album_Created') THEN 0
      WHEN name <> 'Clovers_Transfer' THEN 1
      WHEN lower(json_extract(data,'$._to')) <> '0xb55c5cac5014c662fdbf21a2c59cd45403c482fd' THEN 1
      ELSE 0
    END
  ) VIRTUAL,

  -- The `clovers` index keys a log to a board: prefer data.board, else
  -- data._tokenId, but never for CurationMarket_Transfer.
  --
  -- The json_type guards are load-bearing, not defensive. The ReQL index calls
  -- .downcase() on the value, which *errors* on a non-string, and RethinkDB
  -- silently drops a document whose index function errors. 2,388 Album_Created
  -- and Album_Updated logs carry `board: false` -- so they are absent from the
  -- live index, and /clovers/0/activity returns nothing. Without the guard
  -- json_extract turns that false into 0, lower() into '0', and the endpoint
  -- starts returning 2,388 album logs under a board that does not exist.
  clover_key TEXT GENERATED ALWAYS AS (
    CASE
      WHEN json_type(data,'$.board') = 'text' THEN lower(json_extract(data,'$.board'))
      WHEN json_type(data,'$._tokenId') = 'text' AND name <> 'CurationMarket_Transfer'
        THEN lower(json_extract(data,'$._tokenId'))
      ELSE NULL
    END
  ) VIRTUAL
);

CREATE UNIQUE INDEX logs_unique_log ON logs(transactionHash, logIndex);
-- `id` completes the ORDER BY. RethinkDB tied on the primary key, so the feeds
-- sort by (blockNumber, id) -- without id in the index every page of every feed
-- built a temp b-tree over the whole filtered set to return 24 rows.
CREATE INDEX logs_active      ON logs(blockNumber, id) WHERE is_active = 1;
CREATE INDEX logs_type        ON logs(feed_type, blockNumber, id);
CREATE INDEX logs_clovers     ON logs(clover_key, blockNumber, id);
CREATE INDEX logs_blockNumber ON logs(blockNumber);
CREATE INDEX logs_name        ON logs(name);

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id               TEXT PRIMARY KEY,
  market           TEXT,
  type             TEXT,
  user             TEXT,
  created          INTEGER,
  transactionHash  TEXT,
  transactionIndex INTEGER,
  logIndex         INTEGER,
  tokens           TEXT,
  value            TEXT,
  poolBalance      TEXT,
  tokenSupply      TEXT
);
CREATE INDEX orders_market       ON orders(market);
CREATE INDEX orders_created      ON orders(created, id);
CREATE INDEX orders_ordered      ON orders(market, created, logIndex, id);
-- lastOrder orders by transactionIndex, not logIndex -- the ReQL it replaces
-- spelled the sort out explicitly rather than riding the `ordered` index.
CREATE INDEX orders_last        ON orders(market, created, transactionIndex, id);
CREATE UNIQUE INDEX orders_unique_log ON orders(transactionHash, logIndex);

-- ---------------------------------------------------------------------------
-- albums / chats  (ISO-8601 timestamps, unlike the block numbers above)
-- ---------------------------------------------------------------------------
CREATE TABLE albums (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  userAddress TEXT,
  created     TEXT,
  modified    TEXT,
  clovers     TEXT,               -- JSON array of boards
  cloverCount INTEGER GENERATED ALWAYS AS (json_array_length(COALESCE(clovers,'[]'))) VIRTUAL
);
CREATE INDEX albums_name        ON albums(lower(name));
-- Carrying the sort key and the primary key, because /users/:id/albums orders
-- by modified and /albums orders by whichever column the filter names.
CREATE INDEX albums_userAddress ON albums(lower(userAddress), modified, id);
CREATE INDEX albums_user_name   ON albums(lower(userAddress), name, id);
CREATE INDEX albums_user_created ON albums(lower(userAddress), created, id);
CREATE INDEX albums_dates       ON albums(created, id);
CREATE INDEX albums_modified    ON albums(modified, id);
CREATE INDEX albums_name_sort   ON albums(name, id);
CREATE INDEX albums_cloverCount ON albums(cloverCount, id);

CREATE TABLE chats (
  id          TEXT PRIMARY KEY,
  board       TEXT,
  comment     TEXT,
  userAddress TEXT,
  userName    TEXT,
  created     TEXT,
  edited      TEXT,
  deleted     INTEGER DEFAULT 0,
  flagged     INTEGER DEFAULT 0
);
CREATE INDEX chats_board ON chats(lower(board), created, id);
CREATE INDEX chats_dates ON chats(created, id);
