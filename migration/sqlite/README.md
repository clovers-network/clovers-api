# RethinkDB → SQLite: schema validated

**Status:** design proven against real data. **No API code has been changed.**
2026-08-31.

This is the cheap step that decides whether the migration is worth attempting:
translate the schema, load the real database into it, and check that the hard
queries return what the live API returns. If the design were wrong, it would
show up here rather than three days into porting 135 call sites.

## Result

**38/38 parity checks pass** against the live API.

```
node import.mjs ~/clovers-backups/backup-<stamp> /tmp/clovers.db
node parity.mjs /tmp/clovers.db
```

| Table | Source rows | Imported |
|---|---|---|
| clovers | 44,589 | 44,589 |
| users | 3,093 | 3,093 |
| logs | 151,654 | 151,654 |
| orders | 8,866 | 8,865 *(1 duplicate rejected — see below)* |
| albums | 2,457 | 2,457 |
| chats | 1,127 | 1,127 |

**288 MB in SQLite against 1.2 GB in RethinkDB**, and RethinkDB currently holds
1,128 MB resident to serve it. That difference is the whole reason a 4 GB
droplet was needed.

Every API filter was checked for both total count and first-page contents:
`all`, `contract`, `public`, `market`, `pending`, `Sym`, `NonSym`, `RotSym`,
`X0Sym`, `XYSym`, `XnYSym`, `Y0Sym`, `commented`, plus the five log feeds and
the users and albums counts.

## The 74 indexes are not 74 indexes

RethinkDB defines 74 secondary indexes here, 49 on `clovers` alone. That is an
artifact of ReQL: the only way to filter-then-sort-then-paginate is `between()`
across a compound `[predicate, sortkey]` index, so every (filter × sort) pair
needs its own — `Sym-modified`, `Sym-price`, `market-modified`, and so on.

SQL says that as `WHERE … ORDER BY …`, so the pairs collapse into **partial
indexes**, which are the exact equivalent: the index contains only matching
rows, already in sort order. The schema is 30 indexes and much easier to read.

## What the exercise actually found

**A deliberate asymmetry I nearly erased.** `NonSym` is
`sum(symmetries) = 0 AND owner <> ZERO`, but `Sym` is just `sum > 0` — no owner
check. So burned clovers count as symmetrical while being excluded from
non-symmetrical. I "tidied" that into consistency and the count came out 161
short of the API. Reverted; parity means reproducing behaviour, not improving
it. Anyone touching these predicates should know the inconsistency is real.

**`foundBy` is polymorphic.** 44,396 null, 88 address strings, and **105 rows
holding an entire embedded user document** — `{address, name, balance,
cloverCount, …}` — where an address belongs. The API writes
`hasFoundBy[0].address`, so those 105 are drift a schemaless store allowed. The
importer collapses them to `.address`. A typed column makes this impossible
going forward, which is precisely the point.

**One duplicate order.** `orders` contains two rows identical but for their
`id`, sharing `(transactionHash, logIndex)` — the same class of duplication
already cleaned out of `logs`. The UNIQUE index rejects it on import. Also
4,171 older orders carry no `transactionHash` at all; SQLite treats those NULLs
as distinct, so they import fine.

**Pagination ties are arbitrary, in both stores.** 100 of the 109 `pending`
clovers share `modified = 0`, so the page-1 boundary falls inside a 100-row tie
and which 24 appear is undefined. Checked the live API: its order *is* stable
across calls and pages 1 and 2 do not overlap, so this is two
consistent-but-different orderings rather than a live bug. Worth adding
`ORDER BY modified DESC, board` when porting, to make it guaranteed stable
instead of incidentally stable.

## Not yet answered

Parity here covers reads. Still to prove before any port:

- **Writes** — insert/update paths, and whether `commentCount`/`cloverCount`
  bookkeeping stays consistent.
- **Changefeeds** — `chats` and `albums` use `.changes()` for realtime. SQLite
  has no equivalent; both become an emit-after-write in the same process. Only
  two sites, so this is small.
- **Concurrency** — one writer plus the live event listener. WAL mode handles
  it, but it should be demonstrated rather than assumed.
- **The remaining ~120 call sites** across 20 files.

## Files

| | |
|---|---|
| `schema.sql` | The translated schema: 6 tables, generated columns, 30 indexes |
| `import.mjs` | Loads a `backup-clovers.js` dump; verifies counts; normalises `foundBy` |
| `parity.mjs` | 38 checks of counts and page contents against the live API |
