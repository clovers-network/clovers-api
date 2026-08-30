# Deploy Runbook — Stage 1

Replacing the dead Ethereum node with redundant third-party RPC providers.

**Status:** prepared, not executed.
**Prepared:** 2026-08-29

---

## Pre-flight findings

These were checked directly against the production host (read-only) and change
how the deploy must be done. Do not skip this section.

| | Value | Consequence |
|---|---|---|
| Host | `clover-main` → `206.81.16.230` (`api-production`) | SSH works from this machine |
| Uptime | **1932 days** | Never rebooted. Do not reboot casually. |
| Node | **v9.4.0** (2018, EOL) | No `fetch`, no `WebSocket`, no `URLSearchParams`, no `AbortController` |
| npm | **5.6.0** | Reads **lockfileVersion 1 only** |
| Disk | 12G used of 25G (47%) | Room for a backup |
| Memory | 3951 MB total, ~1860 MB available | Fine |
| pm2 | app `API`, online, 176 restarts | `pm2 reload ecosystem.config.js` |
| RethinkDB | active, `/var/lib/rethinkdb/instance1/data` | Backup target |
| Deploy | bare repo `~/clovers-api.git` → checkout to `~/apps/api2` | `post-receive` hook, **master branch only** |

### Two things this forced

**1. Node 9 has no `fetch` or `WebSocket`.** `src/lib/chain.js` needs both.
Both now fall back automatically — HTTP via the `http`/`https` modules,
WebSocket via `ws` — with no new dependency. Verified locally by deleting both
globals and confirming `getBlockNumber`, `catchUp` and live subscriptions all
still work. Without this the deploy would have failed on the first RPC call.

**2. npm 5.6 cannot read a lockfileVersion 3 lockfile.** `package-lock.json`
has been regenerated at **version 1**. If it ever gets rewritten by a modern
npm, convert it back before deploying:

```sh
npm install --package-lock-only --lockfile-version 1 --ignore-scripts
```

### Known trap: `npm install` fails on modern Node

The native module `sha3` cannot compile on current Node/toolchains. It arrives
transitively and **nothing loads it** — `eth-sig-util` works without it. Use
`npm install --ignore-scripts` when installing locally. On the server's Node 9
it built successfully years ago and is already present.

---

## Recommended path: manual, staged

The `post-receive` hook runs `npm run reload`, which runs `npm i` — and an
`npm i` under npm 5.6 against a changed `package.json` is the single riskiest
step in this deploy. The only new runtime dependency is `ws`, which is
**already installed** (socket.io depends on it). So skip the install.

Deploy manually instead of pushing to the hook.

### 0. Snapshot first  ← this is what needs `doctl`

```sh
doctl auth init
doctl compute droplet list --format ID,Name,PublicIPv4,Memory,Disk,PriceMonthly
doctl compute droplet-action snapshot <api-droplet-id> --snapshot-name "pre-rpc-migration-$(date +%Y%m%d)"
```

Wait for it to complete before continuing:

```sh
doctl compute action list --format ID,Type,Status | head
```

Also back up the database independently of the droplet snapshot.

**`rethinkdb-dump` is not installed on the host and neither is the python
driver**, so the documented backup route does not work. `~/backup-clovers.js`
streams every table to gzipped JSON-lines using the `rethinkdb` npm driver the
API already depends on. Module resolution is relative to the script, so
`NODE_PATH` must be set:

```sh
ssh clover-main 'NODE_PATH=/home/billy/apps/api2/node_modules node ~/backup-clovers.js'
```

Takes about 50 seconds and writes ~36 MB to `~/backups/backup-<timestamp>/`.
Verify the row counts, then pull a copy **off the droplet** — a backup living
on the machine it protects is not a backup:

```sh
D=$(ssh clover-main 'ls -d ~/backups/backup-* | tail -1')
for f in clovers users chats albums logs orders; do
  echo -n "  $f: "; ssh clover-main "gunzip -c $D/$f.jsonl.gz | wc -l"
done
scp -r "clover-main:$D" ~/clovers-backups/
```

Expected counts as of 2026-08-29: clovers 44,432 · logs 154,913 · orders 8,866
· users 3,086 · albums 2,457 · chats 1,127.

**The social data — clover names, comments, albums, user profiles — exists
nowhere else.** Do not proceed without a verified dump.

> The previous backup on that host was from **February 2021**. Whatever else
> comes of this work, a recurring dump is worth setting up.

### 1. Get the code onto the server

The hook only fires on `master`, and this work is on
`feature/indexsupply-migration`. Either merge to master first, or push the
branch to the bare repo under a name the hook ignores and check out manually.
The manual route avoids triggering `npm i`:

```sh
git remote add server ssh://billy@206.81.16.230/home/billy/clovers-api.git   # once
git push server feature/indexsupply-migration          # hook ignores non-master
ssh clover-main '
  git --work-tree=/home/billy/apps/api2 --git-dir=/home/billy/clovers-api.git \
      checkout -f feature/indexsupply-migration
'
```

### 2. Build (no install)

```sh
ssh clover-main 'cd ~/apps/api2 && npm run -s build 2>&1 | tail -5'
```

If the build fails on Node 9, stop — do not reload. Babel 6 is Node 9
compatible, so this is expected to pass.

### 3. Sanity-check the new module before restarting anything

This touches nothing and proves the RPC path works from that host:

```sh
ssh clover-main 'cd ~/apps/api2 && node -e "
const c = require(\"./dist/lib/chain.js\");
c.getBlockNumber()
 .then(b => { console.log(\"head:\", b); return c.events.Clovers.instance.totalSupply() })
 .then(s => console.log(\"totalSupply:\", s.toString()))
 .catch(e => { console.log(\"FAILED:\", e.message); process.exit(1) })
"'
```

Expect a current block number and `44326`. If this fails, the server cannot
reach the RPC providers — check egress before going further.

### 4. Reload

```sh
ssh clover-main 'cd ~/apps/api2 && pm2 reload ecosystem.config.js --env production'
ssh clover-main 'pm2 list'
```

### 5. Watch it catch up

```sh
ssh clover-main 'pm2 logs API --lines 100'
```

Expect, in order:

- `Catching up blocks 25761841-<head>` — roughly 97,000+ blocks
- `Catch-up complete: N events in M requests` — around 10 requests, a few seconds
- `2 live subscriptions started`
- `[wss://...] subscribed (0x...)` twice

If you see repeated `socket error` / `reconnecting`, the provider list may need
adjusting via `RPC_WS` in `ecosystem.config.js`.

### 6. Verify data actually moved

```sh
curl -s 'https://api.clovers.network/clovers?page=1' | head -c 300
```

`modified` on the newest clover should now be near chain head rather than
25761840.

---

## Rollback

Nothing in Stage 1 is destructive to data — it only changes where events are
read from. To revert:

```sh
ssh clover-main '
  git --work-tree=/home/billy/apps/api2 --git-dir=/home/billy/clovers-api.git checkout -f master
  cd /home/billy/apps/api2 && npm run -s build && pm2 reload ecosystem.config.js --env production
'
```

The old code points at the dead node, so rolling back returns you to a frozen
database — not a broken one.

---

## After the deploy has been stable

### Repair the damaged clover rows — DONE 2026-08-29

Completed ahead of the migration, from an isolated work tree, without touching
the running API. Result: **157 rows inserted, 254 owners corrected, 0 failed.**
An independent re-run afterwards reports 0 missing and 0 wrong.

| | Before | After | Chain |
|---|---|---|---|
| Rows | 44,432 | 44,589 | — |
| Non-zero owner | 44,012 | **44,326** | 44,326 |
| API `allResults` | 44,012 | **44,326** | 44,326 |

A follow-up pass corrected `created` on the 157 inserted rows: the logs table
no longer held their mint logs, so they had defaulted to the current block.
reconcile now takes the mint block from the chain walk, so that fallback no
longer occurs.

The steps below are retained for future use.

Original measurement: 157 rows missing entirely, 254 rows with the wrong
owner, 0 rows for tokens never minted.

**This can be done before the migration, and without touching the running
API.** Check the branch out into a separate work tree so a pm2 restart cannot
pick up the new code by accident:

```sh
git push server feature/indexsupply-migration        # hook ignores non-master
ssh clover-main '
  mkdir -p ~/apps/api2-reconcile
  git --work-tree=/home/billy/apps/api2-reconcile --git-dir=/home/billy/clovers-api.git       checkout -f feature/indexsupply-migration
  cd ~/apps/api2-reconcile
  ln -sfn /home/billy/apps/api2/node_modules node_modules
  cp /home/billy/apps/api2/src/config.json src/config.json
  npm run -s build
'
```

Dry run, then apply:

```sh
ssh clover-main 'cd ~/apps/api2-reconcile && DEBUG=app:reconcile node dist/index.js reconcile'
ssh clover-main 'cd ~/apps/api2-reconcile && DEBUG=app:reconcile node dist/index.js reconcile --write'
```

The walk covers ~17.5M blocks and takes a few minutes. It re-checks the
database afterwards and reports anything still missing or still wrong.

### Only then, decommission the node

Once the API has been running on RPC providers for a few days:

```sh
doctl compute droplet list --format ID,Name,PublicIPv4,PriceMonthly
# confirm 138.68.85.68 is the node droplet, then:
doctl compute volume list                       # its block storage is the big cost
doctl compute droplet delete <node-droplet-id>
doctl compute volume delete <node-volume-id>
```

**This is where the money comes back.** Take a snapshot first if you want the
option of resurrecting it.

---

## Logs table repair — partially DONE 2026-08-30

Audited the `logs` table against a full `eth_getLogs` walk of all tracked
events. Three symptoms of one historical bug: some rows were written with the
wrong `blockNumber`/`logIndex`.

| | Before | After |
|---|---|---|
| Chain events (tracked types) | 144,087 | 144,087 |
| DB rows (tracked types) | 147,349 | 148,052 |
| **Missing from DB** | **703** | **0** ✅ |
| Duplicate rows | 2,065 | 2,065 ⚠️ |
| Wrong blockNumber/logIndex | 1,917 | 1,917 ⚠️ |

703 missing rows inserted, 0 failed, verified by an independent re-audit. The
newest `Clovers_Transfer` now reads block 25,764,344, matching chain exactly
(it read 25,761,840 before).

### Cleanup — DONE 2026-08-30

3,962 rows deleted (2,048 duplicates, 1,914 misplaced), 0 failed.

| | Rows | Chain positions uncovered |
|---|---|---|
| Before any of this work | 154,913 | 762 |
| After backfill | 155,616 | 59 |
| After cleanup | 144,090 | 59 |

Verified against the pre-deletion backup and the deletion manifest: of the
3,962 rows removed, 2,048 were themselves correctly placed — but every one of
those positions retained a surviving correct row, so **0 positions lost their
only correct row.** They were true duplicates.

The audit initially validated coordinate → transaction hash but not the event
name, which under-reported misplacement: a transaction emitting both a
Clovers_Transfer and a ClubToken_Transfer holds several positions under one
hash, so a row filed under the wrong name at a sibling position passed. Fixed
to compare both; that is what surfaced the 59 below.

### Still outstanding: 59 mislabeled rows

Correct transaction and logIndex, **wrong event name** — and therefore a
payload decoded against the wrong event, so the `data` is also wrong.
Relabelling is not sufficient; these need replacing with a correctly decoded
row. Example, block 8389028 logIndex 115: chain holds a `ClubToken_Transfer`
(tx `0xdb553124852a5e…`), the table holds `SimpleCloversMarket_updatePrice`
for the same transaction and position.

They predate this work — 762 such positions existed before it, 59 remain.

**Also outstanding, deliberately not automated** — both require deleting
or rewriting rows:

- **2,065 duplicates**: identical rows sharing (transactionHash, logIndex).
  `unique_log` is a plain secondary index, not a uniqueness constraint, so the
  manual pre-insert check could race. Deleting all but one of each is
  low-risk deduplication.
- **1,917 misplaced**: correct transaction and decoded data, wrong
  coordinates. Preferable to *correct* these in place rather than delete them —
  and check first whether a correctly-positioned row now exists, because rows
  whose `logIndex` was right but `blockNumber` wrong were not treated as
  missing and so have no replacement.

Evidence it is a coordinate bug: the row at block 8766804 / logIndex 78 carries
tx `0x83c37cb9…d42d3ce`, which on chain sits in block 8766824 with its Clovers
logs at logIndexes 46 and 47.

```sh
ssh clover-main 'cd ~/apps/api2 && node dist/index.js audit-logs'
```

---

## Deferred, deliberately

- **Node 9 is eight years EOL.** It should be upgraded, but not during this
  deploy — one change at a time. The code now works on Node 9 through 22, so
  the upgrade can happen independently and be rolled back independently.
- **`npm i` on the server** is untested against the modified `package.json`.
  The manual path above avoids it. If you ever do run it, snapshot first.
- **`mine()` in `src/lib/build.js`** cannot run — Web Worker globals in Node.
  Deleting it is a product decision, not a deploy step.
