# RethinkDB → SQLite

**Status:** port complete, bugs fixed, load tested; not yet deployed. No
RethinkDB call sites remain in `src/`. 2026-09-01.

```
node import.mjs ~/clovers-backups/backup-<stamp> /tmp/clovers.db
node parity.mjs /tmp/clovers.db            # 38 schema/index checks
node write-parity.mjs                      # 31 mutation + concurrency checks
node endpoint-parity.mjs /tmp/clovers.db   # 155 store-method checks
# then, with the server running against a copy:
node http-parity.mjs                       # 32 end-to-end HTTP checks
```

**264 checks, all passing** against the live API and a real RethinkDB 2.4.

Load testing, the query audit and droplet sizing are in
[PERFORMANCE.md](PERFORMANCE.md). The short version: **355 req/s against 3.7**,
and **101 MB of memory against 1,225 MB**, which takes the droplet from $12/mo
to $6/mo.

| Table | Source rows | Imported |
|---|---|---|
| clovers | 44,589 | 44,589 |
| users | 3,093 | 3,093 |
| logs | 151,654 | 151,654 |
| orders | 8,866 | 8,865 *(1 duplicate rejected)* |
| albums | 2,457 | 2,457 |
| chats | 1,127 | 1,127 |

**371 MB in SQLite against 1.2 GB in RethinkDB**, and RethinkDB holds 1,128 MB
resident to serve it. That difference is the whole reason a 4 GB droplet was
needed.

## The 74 indexes are not 74 indexes

RethinkDB defines 74 secondary indexes here, 49 on `clovers` alone. That is an
artifact of ReQL: the only way to filter-then-sort-then-paginate is `between()`
across a compound `[predicate, sortkey]` index, so every (filter × sort) pair
needs its own — `Sym-modified`, `Sym-price`, `market-modified`, and so on.

SQL says that as `WHERE … ORDER BY …`, so the pairs collapse into **partial
indexes**, which are the exact equivalent: the index contains only matching
rows, already in sort order. The schema is 30 indexes and much easier to read.

`src/lib/db-tables.js` is kept, unexecuted, as the record of what each ReQL
index actually meant. Several of those meanings are quoted in comments on the
SQLite side.

## What the exercise found

Ordered roughly by how much trouble each would have caused.

**RethinkDB breaks index ties by primary key, in the sort direction.** A DESC
sort ties DESC. Getting this wrong produces the right count and the wrong page,
which is invisible in aggregate checks — it only showed up once
`endpoint-parity.mjs` started comparing ordered id lists against the live API.
The log feeds tie on a UUID, not on `logIndex`, which looks wrong and is not:
`active` and `type` are `[predicate, blockNumber]` and carry nothing else.

**`data.board` is the literal `false` on 2,388 album logs.** ReQL's `clovers`
index calls `.downcase()` on it, which errors, and RethinkDB silently drops a
document whose index function errors — so those rows are absent from the live
index. The first SQLite translation used `json_extract`, which turns `false`
into `0`, and `/clovers/0/activity` began returning 2,388 album logs under a
board that does not exist. The generated column now guards on
`json_type(...) = 'text'`.

**`price` was sorted two different ways in production.** `all-price` sorts the
raw string; `owner-price` sorts `price.coerceTo('number')`. They agree only if
every price is the same width — and 3,795 legacy clovers stored a bare `'0'`
where the schema, and `padBigNum`, say 64 zero-padded digits. The importer pads
them, which makes both endpoints agree and makes string order exactly numeric
order. It also changes which zero-priced clovers appear on page 1 of
`?sort=price&asc=true`; they are all numerically tied, so that ordering was
arbitrary either way.

**Burned clovers leaked into the symmetry filters. FIXED.** `NonSym` is
`sum(symmetries) = 0 AND owner <> ZERO`, but `Sym` was a bare `sum > 0` with no
owner check — so a clover the contract has destroyed counted as symmetrical
while being excluded from non-symmetrical. During the port I "tidied" this,
saw the count go 161 short of the API, and reverted it as a parity failure.
It was not: 161 burned clovers really are listed under `Sym`, and between 8 and
68 under each of RotSym, X0Sym, XYSym, XnYSym and Y0Sym — each one linking to a
detail page that correctly 404s. Every filter now excludes them, `market` and
`commented` included, where no burned row happens to exist today but nothing
prevented one. The exact expected delta per filter is asserted in `parity.mjs`
and `endpoint-parity.mjs`, so a future change that shifts these counts by a
different amount still fails.

**`foundBy` is polymorphic.** 44,396 null, 88 address strings, and **105 rows
holding an entire embedded user document** — `{address, name, balance, …}` —
where an address belongs. The API writes `hasFoundBy[0].address`, so those 105
are drift a schemaless store allowed. The importer collapses them to
`.address`. A typed column makes this impossible going forward.

**The importer left a 225 MB write-ahead log.** The `.db` file on its own then
looked complete and reported 2,457 albums as 0. Found by copying it and booting
the API against the copy — the store-level suite could not see it, because it
opened the original. The import now checkpoints and warns if a WAL survives.
**Anything that moves this database must move the `-wal` too, or checkpoint
first.**

**One duplicate order.** Two rows identical but for their `id`, sharing
`(transactionHash, logIndex)`. The UNIQUE index rejects it on import, so the
live list is one row longer and everything after it shifts. Which of the pair
survives is arbitrary, so the harnesses key orders on the log coordinate rather
than the uuid. 4,171 older orders carry no `transactionHash`; SQLite treats
those NULLs as distinct, so they import fine.

**`lastOrder` was hardcoded in four places. FIXED.** Endpoints look orders up
with `getAll(doc('board'), {index: 'market'})`, and all 8,865 orders have
`market = 'ClubToken'` — never a board — so the sub-select never matched. The
query is not wrong: `curationMarket` is the only writer that keys orders to a
board, and CurationMarket events are commented out of `socketing.js`. So the
data is absent, not the logic. Hardcoding it meant turning curation markets
back on would have silently left the field empty. All four sites now run the
real lookup — an index seek on `orders(market, created, logIndex)` — and it
returns null today exactly as before. The empty value is also unified: three
sites returned `null` and one returned `false`, so the dapp received two
different shapes for the same field depending on which contract emitted.

**`/albums?filter=name|userAddress|dates|cloverCount` returned an empty 404.
FIXED.** They were `getAll(true, {index})` against indexes whose values are
names, addresses, pairs and counts — never the boolean `true`. Meanwhile an
unrecognised value like `bogus` fell through to `all` and worked, which is the
wrong way round. All filters now select the same rows, and where the name is a
real column it doubles as the sort key.

**`/clovers` page order does not match its own declared `orderBy`.** The live
pipeline slices the page and *then* `eqJoin`s the owner, and the join does not
preserve order: pages holding one owner come back sorted, pages spanning many
come back shuffled. It is stable and non-overlapping, just not sorted. Not
reproducible in SQL and not worth reproducing, so the port returns the declared
order and `endpoint-parity.mjs` compares that endpoint as a set. Every other
endpoint is compared as an ordered list.

**Dead and broken code found while porting.** `createDB`/`createTables`/
`createIndexes`/`copySyncData` and the four copy-back steps in `build.js` have
no callers — `build` replays logs into whatever database is already there.
`nameClovers` also built its query and never called `.run()`. Both ported and
annotated rather than deleted; wiring the rebuild back up is a product
decision, and doing it would make `build` destructive.

`api/albums`' `load` passed its result into `run()`'s *error* argument, so it
ran a join on every request and threw the result away — **deleted**.

## Bugs fixed rather than reproduced

Beyond the three above:

- **Renaming a nonexistent clover hung the request.** `PUT /clovers/:id` read
  `clover.owner` *before* testing the error argument, so a 404 threw a
  TypeError out of an async callback — an unhandled rejection, no response.
  Now a 404.
- **`doSyncOracle` dereferenced a missing clover.** `clover.owner` where
  `clover` is `false` threw, and `syncOracle` caught it into `debug()` — so the
  oracle sweep appeared to run and had actually stopped at the first token
  without a row.
- **`/clovers/sync/pending/:id` passed `[false]` into `syncPending`**, which
  read `.board` off it one frame later. Now a 404.
- **Album logs recorded `board: false`.** `clovers.length > 0 && clovers[0]`
  yields the boolean `false` for an empty album. 2,388 rows carry it, ReQL's
  index called `.downcase()` on it and dropped them, and album activity is
  therefore missing from every clover's feed. Writes `null` now; the schema
  guard stays for the existing rows.
- **The clover grid used an inner join applied after paging**, so a clover
  whose owner had no user row would vanish from its page while still being
  counted in `allResults` — a page silently returning 23 of 24. Left join now.
  No such clover exists today, which is why it was never seen.
- **An event from an unknown contract was *returned*, not thrown.**
  `handleEvent`'s default branch resolved with an `Error` object, which every
  caller treats as success.
- **`albumCount` was not recomputed on album create**, only on edit and delete,
  so a new album left the owner's count stale — and that count is what
  `/users?filter=albums` sorts on.

Each of these has a dedicated assertion in `http-parity.mjs`.

## Changefeeds

`chats` and `albums` used `.changes()` for realtime. SQLite has no equivalent,
so `src/lib/store/changes.js` emits the same `{new_val, old_val}` shape from the
store after every write and the listeners are otherwise unchanged. The one
behavioural difference: a changefeed also fires for writes by *another* process;
this fires only for writes through this store in this process. Fine while pm2
runs one instance and nothing else writes — that is the assumption to check
first if a second writer is ever added.

## Concurrency

Answered, not assumed: `write-parity.mjs` runs a writer and a reader on separate
connections for two seconds — ~2,300 writes against ~47,000 reads, zero errors,
and the reader always sees the latest write.

## Files

| | |
|---|---|
| `schema.sql` | 6 tables, generated columns, 30 indexes |
| `import.mjs` | Loads a `backup-clovers.js` dump; verifies counts; normalises `foundBy` and `price` |
| `parity.mjs` | 38 checks of the schema and index translation |
| `write-parity.mjs` | 31 mutation checks against real RethinkDB 2.4, plus the concurrency test |
| `endpoint-parity.mjs` | 155 checks driving the store methods `src/api/*` calls |
| `http-parity.mjs` | 40 checks against the running server, including one per bug fixed |
| `load-test.mjs` | Concurrency sweep and per-endpoint latency — see PERFORMANCE.md |
| `load-rethink.mjs` | Loads a backup into a scratch RethinkDB, for before/after comparison |
| `query-audit.mjs` | Statements issued per endpoint, plans, N+1s — fails on regression |
| `PERFORMANCE.md` | Load-test results and the droplet sizing they imply |
