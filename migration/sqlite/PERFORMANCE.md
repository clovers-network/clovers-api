# Load testing: before and after

**2026-09-01.** Run with `migration/sqlite/load-test.mjs`.

## How this was measured, and what it is worth

Three measurements, because no single one is trustworthy on its own.

**1. Controlled, both stacks emulated.** The honest comparison. `rethinkdb:2.4`
has no arm64 image, so on this machine it runs under QEMU — which would make
any straight before/after a lie in SQLite's favour. So *both* stacks were put
in `--platform linux/amd64` containers on the same host, against the same data,
replaying the same seeded request sequence. Same penalty on both sides.

**2. Native.** The ported stack with no emulation, to find where it actually
saturates and how much memory it holds.

**3. Live production, sequential only.** Real hardware, real RethinkDB, to
sanity-check that the emulated numbers are not describing an imaginary problem.
Sequential only — a concurrency sweep against production would be a
self-inflicted outage, and was not run.

The request mix is weighted like dapp traffic: 30% clover grid, 15% detail,
10% activity, 10% feed, then comments, user pages, albums, and 2% search.

## Controlled comparison — identical emulation, same host, same data

| | BEFORE (RethinkDB) | AFTER (SQLite) |
|---|---|---|
| throughput, concurrency 1 | 3.7 req/s | **86.2 req/s** |
| throughput, concurrency 64 | 16.5 req/s | **95.8 req/s** |
| p50, concurrency 1 | 10.5 ms | 3.4 ms |
| p95, concurrency 64 | 10,095 ms | **2,562 ms** |
| requests over 1 s | **114 of 236 (48%)** | 39 of 2,167 (1.8%) |
| database resident memory | **1,225 MB** | 0 — in-process |

Emulation inflates both sides, so read the ratios, not the absolutes. The one
thing emulation does not explain is the stall rate: under the *same* penalty,
half of all RethinkDB requests took over a second and 1.8% of SQLite ones did.

## Where the RethinkDB stalls come from

Two separate effects, and it took instrumenting the harness to separate them.

**Cold indexes.** The first run showed a p95 of 7.8 s at concurrency *one*,
while the same endpoint answered in 12 ms when measured sequentially. RethinkDB
pages each of its 74 secondary indexes in on first touch, and a randomly
sampled warmup leaves most of them cold. The harness now enumerates the mix's
whole parameter space — 598 distinct paths — and fetches each once before the
clock starts. That alone took p95 at concurrency 1 from 7,814 ms to 30 ms.

**Queueing on one connection.** What remains is concurrency-dependent and does
not go away with warming: 48% of requests over a second, clustered at ~7.8 s,
~9.8 s, ~10.1 s, ~12.1 s. The application holds a single RethinkDB connection
and multiplexes every query over it, so one slow query stalls everything behind
it. The slow-request log is dominated by `/logs` and `/clovers?filter=…` — the
two endpoints that run a `.count()` over a large index on every request.

SQLite has no equivalent because there is no connection: the query runs in the
process, on the calling thread.

## Native, after the bug fixes and index tuning

| concurrency | req/s | p50 | p95 | p99 | errors | RSS |
|---|---|---|---|---|---|---|
| 1 | 164.0 | 2.1 ms | 22.1 ms | 43.1 ms | 0 | 198 MB |
| 8 | 169.5 | 37.4 ms | 105.1 ms | 240 ms | 0 | 248 MB |
| 32 | 171.2 | 165.4 ms | 391.7 ms | 540 ms | 0 | 272 MB |
| 64 | 174.8 | 319.9 ms | 704.2 ms | 2,289 ms | 0 | 299 MB |
| 256 | 166.5 | 1,091 ms | 6,987 ms | 7,398 ms | 0 | 326 MB |

Throughput is flat from concurrency 1 to 256. That is the signature of a
single-threaded server that is already saturated at concurrency 1: Node runs
one thread, and both SQLite drivers are synchronous, so every query blocks the
event loop. **More vCPUs will not help a single process.** Latency degrades
linearly with concurrency while throughput holds, which is the well-behaved
failure mode — requests queue, nothing errors, nothing times out.

Per endpoint, sequential, after tuning:

| endpoint | before (prod, −20 ms RTT) | after (native) |
|---|---|---|
| clover detail | ~5 ms | 0.4 ms |
| user detail | ~1 ms | 0.3 ms |
| comments | ~10 ms | 0.4 ms |
| clover activity | ~8 ms | 0.6 ms |
| activity feed | ~220 ms | 1.9 ms |
| albums | ~64 ms | 1.6 ms |
| user clovers | ~33 ms | 2.2 ms |
| leaderboard | ~22 ms | 0.6 ms |
| clovers grid | ~113 ms | 5.7 ms |
| grid by price | ~259 ms | 11.2 ms |
| search | ~131 ms | 18.3 ms |

Production runs a 1-vCPU droplet and this is a laptop, so this table conflates
the engine with the hardware. It is here as a sanity check on the controlled
numbers above, not as a claim on its own.

## What the bug fixes cost, and the index work that paid for it

Excluding burned clovers changed the filter predicates, and the partial indexes
no longer matched them exactly — throughput fell from 128.8 to 107.7 req/s.
Realigning the indexes with the new predicates, appending the `board`
tiebreaker so `ORDER BY … , board` no longer needs a temp b-tree, splitting the
symmetry indexes per sort key, and running `ANALYZE` at import took it to
**164 req/s** — 27% faster than before the fixes were made. The query audit
below then took it to 355.

Every clover-grid query is now fully index-ordered; `EXPLAIN QUERY PLAN` shows
no sort step for any filter × sort combination. The cost is disk: the database
grew from 292 MB to 353 MB.

`search` is the one remaining hot endpoint at 18 ms / 205 ms p95. It is
`LIKE '%needle%'` across clovers, users and albums, and `?s=a` matches 2,454
rows and joins a user onto each. FTS5 would fix it if it ever matters.

## Query audit

`query-audit.mjs` wraps the database handle, drives each endpoint's real store
path, and records every statement it issues — how many times, how long, and
what `EXPLAIN QUERY PLAN` says. Written to find N+1s and scans by observation
rather than by reading the code and guessing. It found five things.

**The user lookup was a full table scan.** `SELECT * FROM users WHERE
lower(address) = ?` — `address` is the PRIMARY KEY, but wrapping a column in a
function defeats its index, so every one of these scanned all 3,093 rows. It is
the most-issued statement in the codebase: 24 times per grid page, 1,782 times
for `/search?s=a`. An expression index on `lower(address)` took it from
**113.6 µs to 2.4 µs**.

**The unfiltered count scanned the whole table.** `/clovers` with no filter
counts `WHERE owner_lc <> ZERO`, and `<>` cannot seek, so SQLite read all 44,589
rows — **8.3 ms on every default grid load**, the single most expensive
statement here. Counting the table and subtracting the burned ones is the same
number from two seeks: **11 µs, a 750× improvement.**

**Eleven statements were building temp b-trees.** Every feed, listing and
comment thread sorted its whole filtered set to return one page, because the
indexes carried the sort key but not the primary-key tiebreaker the queries end
with. Appending it to the `logs`, `orders`, `users`, `albums` and `chats`
indexes removed all but one.

**A join that looked right and wasn't.** Replacing the search N+1 with a
`LEFT JOIN users u ON lower(u.address) = clovers.owner_lc` made it *slower* —
279 ms — because SQLite will only use an expression index when the other side
is wrapped too. `lower(u.address) = lower(clovers.owner)` uses the index and
runs in **2.1 ms**. The redundant-looking `lower()` on an
already-lowercase column is load-bearing.

**Statements were recompiled on every call.** `db.prepare()` on the way into
each helper, ~50 per grid request. Caching by SQL text: 17.3 µs → 4.8 µs each.

Plus the page cache, which was SQLite's 2 MB default against a 371 MB database.
`synchronous` was deliberately left at FULL — NORMAL is the usual WAL
recommendation and a genuine write speedup, but this application writes about
one row a day, so there is nothing to win and something to lose.

### Result

| endpoint | before audit | after |
|---|---|---|
| `GET /clovers` (store time) | 180.4 ms | **1.6 ms** |
| `GET /logs` | 30.1 ms | **2.7 ms** |
| `GET /search?s=a` | 200.1 ms | **19.4 ms** |
| clover grid, p50 | 5.7 ms | **1.2 ms** |
| grid by price, p50 | 11.2 ms | **1.1 ms** |
| search, p50 | 18.3 ms | **3.5 ms** |

| | before audit | after |
|---|---|---|
| throughput, concurrency 1 | 164 req/s | **286.5 req/s** |
| throughput, concurrency 64 | 174.8 req/s | **354.7 req/s** |
| p95, concurrency 64 | 704 ms | **312 ms** |
| full table scans | 4 | **1** |
| statements needing a sort | 11 | **1** |
| N+1 patterns | 6 | **0** |

The one remaining scan-and-sort is `users` under substring search, which is
inherent: `LIKE '%needle%'` has no index that can help. FTS5 would fix it if it
ever matters.

`query-audit.mjs` asserts these as thresholds and exits non-zero if a new scan,
sort or N+1 appears, so this does not quietly regress.

## Memory, and what to deploy on

RSS on macOS climbs to ~330 MB under sustained load and keeps creeping. That is
not a leak: capping the V8 heap at 96 MB changed neither the growth nor the
throughput, so it is native, reclaimable memory — page cache the OS had no
reason to evict.

Under a hard limit it simply does not use it:

| limit | steady-state usage | throughput | OOM |
|---|---|---|---|
| 512 MB | 302 MB | 227 req/s | no |
| 256 MB | 101 MB | 226 req/s | no |

Re-measured after the audit raised `cache_size` and `mmap_size`. Note the
throughput is *identical* at both caps: the tuning is elastic, taking memory
when it is there and adapting when it is not, and at this data size the kernel
already had the hot set cached either way. It fits in 256 MB.

Against RethinkDB's 1,225 MB resident — which is what forced a 2 GB droplet.

**Recommendation: a new `s-1vcpu-1gb` droplet on Ubuntu 24.04 running Node 22,
$6/mo**, down from the current `s-1vcpu-2gb` at $12/mo.

A *new* droplet, not a resize, and this is not only about cost. The current box
is Ubuntu 16.04 with glibc 2.23, capped at Node 16, which has no built-in
`node:sqlite` — and `better-sqlite3` has no usable binary there either (no Node
16 prebuild at all in v9; v8's prebuild needs glibc 2.29). Node 22 has SQLite
built in, so the whole native-module problem does not exist. See
NODE-UPGRADE.md. It fits in 256 MB, so this is headroom rather than requirement: room
for the page cache to hold the hot set, for the nightly backup and gzip, and
for the database to grow. The $4 512 MB size would also work but only comes
with 10 GB of disk.

vCPU count does not need to change: one process saturates one core and the
current droplet already has one.

**If throughput ever needs to go past ~355 req/s**, the move is pm2 cluster
mode — SQLite in WAL supports concurrent readers across processes. But the
changefeed replacement in `src/lib/store/changes.js` is an in-process
EventEmitter, so comment and album realtime updates would only reach clients
connected to the process that handled the write. That has to be replaced with a
real fan-out first. For context, 355 req/s is 30 million requests a day.

## Reproducing

```bash
# scratch RethinkDB with the real data and all 74 indexes
docker run -d --name rdb-load --platform linux/amd64 -p 28017:28015 rethinkdb:2.4
node migration/sqlite/load-rethink.mjs ~/clovers-backups/backup-<stamp>

# pre-port code from before the migration commit
git worktree add /tmp/clovers-before <pre-port-sha>

# then run both under the same emulation and compare
node migration/sqlite/load-test.mjs --target=... --label=... --pid=... --docker=rdb-load
```

`--sequential-only` skips the concurrency sweep; use it for anything that must
not be put under load.
