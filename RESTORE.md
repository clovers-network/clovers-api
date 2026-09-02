# Backup and restore

The database is one SQLite file. Everything below was run against the live
389 MB database on `clovers-api-preview` on 2026-09-02, and the restore was
verified by serving it — not by opening it and looking.

## What replaced what

The droplet ran `~/backup-clovers.js`, which streamed each RethinkDB table to
gzipped JSON-lines. That script existed because `rethinkdb-dump` was not
installed on the host and neither was the Python driver. It is now
`scripts/backup-sqlite.mjs`, and the off-box copy is
`.github/workflows/backup.yml`.

Worth recording why the naive version is wrong: the database runs in WAL mode,
so recent commits live in `clovers_chain_1.db-wal` and not yet in the `.db`. A
`cp` of the `.db` alone silently loses them, and a `cp` of both files taken
mid-write can capture a torn pair. This app writes about one row a day, so the
window is tiny — but the failure is silent and only surfaces at restore time,
which is the worst moment to find it.

`VACUUM INTO` takes a read transaction, so it sees one consistent snapshot
including the WAL, and writes a standalone file with no sidecar. Readers are
never blocked in WAL mode, so the app keeps serving throughout.

## Taking one

```sh
fly ssh console -a clovers-api-preview -C \
  "node /app/scripts/backup-sqlite.mjs --db /data/clovers_chain_1.db --dir /data/backups"
```

Measured: **62 s**, 371 MB → **71.7 MB** gzipped. The script re-opens the
snapshot, runs `integrity_check`, and compares row counts against the source
before keeping it; on any mismatch it deletes the file and exits non-zero. It
keeps the newest 3 and prunes the rest.

`VACUUM INTO` rebuilds the b-trees, so the output is smaller than the source —
371 MB of file holds 340 MB of data.

## The nightly job

`.github/workflows/backup.yml` runs at 03:20 UTC: snapshot on the machine, pull
it here, verify the copy that arrived, upload as a 90-day artifact.

One setup step, without which the job fails loudly on its first run:

```sh
fly tokens create ssh -a clovers-api-preview -x 8760h   # prints the token
gh secret set FLY_API_TOKEN --repo clovers-network/clovers-api
```

An **ssh** token, not a deploy token and not `fly auth token`. All three can run
the job -- verified -- but they differ in what else they can do, and this one
lives in CI for a year:

| | ssh console | sftp get | deploy | other apps |
|---|---|---|---|---|
| `fly auth token` | yes | yes | yes | yes, whole account |
| `tokens create deploy` | yes | yes | **yes** | no |
| `tokens create ssh` | yes | yes | **no** (401) | no |

A backup job has no business being able to replace the running code, and
`fly auth token` is worse still: it covers the entire account and rotates
whenever you re-authenticate, which breaks CI silently months later with no
obvious cause.

Driving it from outside is not a workaround. Fly volumes attach to one machine
at a time, so the usual pattern — a scheduled machine that mounts the volume —
cannot work, and the external job is also the thing that gets the file off the
machine. A backup on the volume it protects is not a backup; the droplet went
from February 2021 to August 2026 between copies partly because taking one was
a separate manual step.

## Restoring

```sh
fly ssh sftp get /data/backups/clovers-<stamp>.db.gz ./snap.db.gz -a clovers-api-preview
gunzip -k snap.db.gz
```

75 MB pulled in **5 s**.

Check it before trusting it:

```sh
node -e '
  const { DatabaseSync } = require("node:sqlite")
  const d = new DatabaseSync("snap.db")
  console.log(Object.values(d.prepare("PRAGMA integrity_check").get())[0])
  console.log(d.prepare("PRAGMA foreign_key_check").all().length, "fk violations")
  for (const t of ["clovers","users","chats","albums","logs","orders"])
    console.log(t, d.prepare("select count(*) n from " + t).get().n)
'
```

Verified on the 2026-09-02 snapshot: `ok`, 0 violations, all 69 indexes present,
clovers 44,589 · users 3,093 · chats 1,127 · albums 2,457 · logs 151,654 ·
orders 8,865.

Then serve it and run the parity suite, which is the check that actually means
something:

```sh
npm run -s build
SQLITE_PATH=$PWD/snap.db CHAIN_LISTENER=off PORT=4599 NODE_ENV=production node dist/index.js &
node migration/sqlite/http-parity.mjs   # 40 passed, 0 failed
```

`CHAIN_LISTENER=off` matters — otherwise the restored copy starts indexing from
its own last block and diverges from the machine you are trying to replace.

### Putting it back on the volume

The app holds the database open, so the file cannot be swapped underneath it —
this is the `disk I/O error` seen during the original import. Land it beside the
live file, stop, swap, start:

```sh
fly ssh sftp shell -a clovers-api-preview   # put snap.db /data/restored.db
fly machine stop <id> -a clovers-api-preview
fly ssh console -a clovers-api-preview -C "sh -c '
  mv /data/clovers_chain_1.db /data/clovers_chain_1.db.displaced &&
  rm -f /data/clovers_chain_1.db-wal /data/clovers_chain_1.db-shm &&
  mv /data/restored.db /data/clovers_chain_1.db'"
fly machine start <id> -a clovers-api-preview
```

Delete the `-wal` and `-shm`: they belong to the displaced file, and leaving a
stale WAL next to a different database is how you get corruption that
`integrity_check` will happily confirm.

Keep `.displaced` until the restore is verified. Note the snapshot comes back in
`journal_mode=delete`, not WAL — `VACUUM INTO` does not carry the mode across.
`initStore` sets WAL on open, so this corrects itself on first start and is only
worth knowing if you inspect the file beforehand and wonder.

## The gap that remains

Nothing here protects against a bad write that is faithfully backed up — an
indexing bug that corrupts rows gets snapshotted like anything else. The 90-day
artifact window is the real answer to that, since it is long enough to notice.
