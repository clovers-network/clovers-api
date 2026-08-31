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

-- Predicates, one per ReQL index family. ZERO_ADDRESS and the Clovers contract
-- address are inlined because SQLite partial indexes require constant
-- expressions; both are fixed for mainnet.
--   ZERO      = 0x0000000000000000000000000000000000000000
--   CLOVERS   = 0xb55c5cac5014c662fdbf21a2c59cd45403c482fd

-- all: owner <> ZERO
CREATE INDEX clovers_all_modified ON clovers(modified)
  WHERE owner_lc <> '0x0000000000000000000000000000000000000000';
CREATE INDEX clovers_all_price ON clovers(price)
  WHERE owner_lc <> '0x0000000000000000000000000000000000000000';

-- contract: owner = CLOVERS
CREATE INDEX clovers_contract_modified ON clovers(modified)
  WHERE owner_lc = '0xb55c5cac5014c662fdbf21a2c59cd45403c482fd';
CREATE INDEX clovers_contract_price ON clovers(price)
  WHERE owner_lc = '0xb55c5cac5014c662fdbf21a2c59cd45403c482fd';

-- public: owner NOT IN (CLOVERS, ZERO)
CREATE INDEX clovers_public_modified ON clovers(modified)
  WHERE owner_lc NOT IN ('0xb55c5cac5014c662fdbf21a2c59cd45403c482fd',
                         '0x0000000000000000000000000000000000000000');
CREATE INDEX clovers_public_price ON clovers(price)
  WHERE owner_lc NOT IN ('0xb55c5cac5014c662fdbf21a2c59cd45403c482fd',
                         '0x0000000000000000000000000000000000000000');

-- pending: owned by the contract and unpriced
CREATE INDEX clovers_pending_modified ON clovers(modified)
  WHERE owner_lc = '0xb55c5cac5014c662fdbf21a2c59cd45403c482fd'
    AND price_is_zero = 1;
CREATE INDEX clovers_pending_price ON clovers(price)
  WHERE owner_lc = '0xb55c5cac5014c662fdbf21a2c59cd45403c482fd'
    AND price_is_zero = 1;

-- market: priced
CREATE INDEX clovers_market_modified ON clovers(modified) WHERE price_is_zero = 0;
CREATE INDEX clovers_market_price    ON clovers(price)    WHERE price_is_zero = 0;

-- symmetry families. NOTE the deliberate asymmetry, which is in the original
-- and is reproduced rather than tidied away: NonSym is
-- `sum = 0 AND owner <> ZERO`, but Sym is just `sum > 0` with no owner check.
-- So burned clovers are counted as symmetrical and excluded from non-symmetrical.
-- Adding the owner check to Sym "for consistency" changes the count by 161 and
-- breaks parity with the live API.
CREATE INDEX clovers_sym_modified ON clovers(modified) WHERE sym_total > 0;
CREATE INDEX clovers_sym_price    ON clovers(price)    WHERE sym_total > 0;
CREATE INDEX clovers_nonsym_modified ON clovers(modified)
  WHERE sym_total = 0 AND owner_lc <> '0x0000000000000000000000000000000000000000';
CREATE INDEX clovers_nonsym_price ON clovers(price)
  WHERE sym_total = 0 AND owner_lc <> '0x0000000000000000000000000000000000000000';

-- individual symmetries: expression indexes, since the value is in JSON
CREATE INDEX clovers_rotsym  ON clovers(json_extract(symmetries,'$.RotSym'),  modified);
CREATE INDEX clovers_x0sym   ON clovers(json_extract(symmetries,'$.X0Sym'),   modified);
CREATE INDEX clovers_xysym   ON clovers(json_extract(symmetries,'$.XYSym'),   modified);
CREATE INDEX clovers_xnysym  ON clovers(json_extract(symmetries,'$.XnYSym'),  modified);
CREATE INDEX clovers_y0sym   ON clovers(json_extract(symmetries,'$.Y0Sym'),   modified);

-- multi: symmetry count, excluding burned. The API filters on x = 1, 3 or 5.
CREATE INDEX clovers_multi_modified ON clovers(sym_total, modified)
  WHERE owner_lc <> '0x0000000000000000000000000000000000000000';
CREATE INDEX clovers_multi_price ON clovers(sym_total, price)
  WHERE owner_lc <> '0x0000000000000000000000000000000000000000';

CREATE INDEX clovers_commented_modified ON clovers(modified) WHERE commentCount > 0;
CREATE INDEX clovers_commented_price    ON clovers(price)    WHERE commentCount > 0;
CREATE INDEX clovers_named              ON clovers(modified) WHERE is_named = 1;

-- owner-scoped listings, and the two owner+facet composites
CREATE INDEX clovers_owner_modified   ON clovers(owner_lc, modified);
CREATE INDEX clovers_owner_price      ON clovers(owner_lc, price);
CREATE INDEX clovers_ownersym_modified  ON clovers(owner_lc, sym_total > 0, modified);
CREATE INDEX clovers_ownersym_price     ON clovers(owner_lc, sym_total > 0, price);
CREATE INDEX clovers_ownersale_modified ON clovers(owner_lc, price_is_zero = 0, modified);
CREATE INDEX clovers_ownersale_price    ON clovers(owner_lc, price_is_zero = 0, price);

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
CREATE INDEX users_modified ON users(modified);
CREATE INDEX users_balance  ON users(balance);
CREATE INDEX users_clovers  ON users(cloverCount);
CREATE INDEX users_albums   ON users(albumCount);

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
  clover_key TEXT GENERATED ALWAYS AS (
    CASE
      WHEN json_extract(data,'$.board') IS NOT NULL THEN lower(json_extract(data,'$.board'))
      WHEN json_extract(data,'$._tokenId') IS NOT NULL AND name <> 'CurationMarket_Transfer'
        THEN lower(json_extract(data,'$._tokenId'))
      ELSE NULL
    END
  ) VIRTUAL
);

CREATE UNIQUE INDEX logs_unique_log ON logs(transactionHash, logIndex);
CREATE INDEX logs_active      ON logs(blockNumber) WHERE is_active = 1;
CREATE INDEX logs_type        ON logs(feed_type, blockNumber);
CREATE INDEX logs_clovers     ON logs(clover_key, blockNumber);
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
CREATE INDEX orders_created      ON orders(created);
CREATE INDEX orders_ordered      ON orders(market, created, transactionIndex);
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
CREATE INDEX albums_userAddress ON albums(lower(userAddress));
CREATE INDEX albums_dates       ON albums(created);
CREATE INDEX albums_cloverCount ON albums(cloverCount);

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
CREATE INDEX chats_board ON chats(lower(board), created);
CREATE INDEX chats_dates ON chats(created);
