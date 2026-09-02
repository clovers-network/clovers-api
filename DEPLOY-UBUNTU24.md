# Deploy Runbook — Stage 2: new box, Ubuntu 24.04 + Node 22

**Status:** provisioning validated in a container; no droplet created yet.
**Prepared:** 2026-09-01

This replaces the in-place upgrade idea. Every command below was run end to end
against a clean `ubuntu:24.04` image with the real database, and the HTTP suite
passes 40/40 on it.

---

## The hosts, which are not named the way you would guess

Worth getting straight before anything else, because the names are inverted.

| SSH host | IP | Served, until the migration | Serves now | In this DO account? |
|---|---|---|---|---|
| `clover-main` | 206.81.16.230 | **api.clovers.network** | nothing — standby | **no** |
| `clover` | 104.131.181.241 | **api2.clovers.network** | nothing — retired | yes, as the droplet *named* `api.clovers.network` |

The names are inverted: the droplet DigitalOcean calls `api.clovers.network` is
api2, and the machine that was actually serving the API is not in this account
at all — `doctl` lists four droplets and none of them is 206.81.16.230.

**Both are now out of the serving path.** api.clovers.network is on Fly;
api2.clovers.network and img.clovers.network are both on the `clovers-images`
Worker. `clover-main` is kept powered on as the rollback target for the API and
should be the last thing retired; `clover` is unreferenced.

### Do not push to the `server` remote

`server` is `clover-main:/home/billy/clovers-api.git` and has a post-receive
hook that deploys whatever it receives. `master` is now the SQLite build, and
that host has a RethinkDB database and no SQLite one — so a push deploys code
that cannot start, onto the machine being kept as the API's rollback target.
It breaks the fallback rather than the live service, which is a worse failure
than it sounds: nothing appears wrong until the day you need it.

Push is disabled locally with

    git remote set-url --push server DISABLED--master-is-sqlite--...

so `git push server` fails with that string in the error. That is local config,
not repository config: it protects one checkout, and anyone else with this
remote still has a live trigger. Re-enable deliberately, and only for a commit
that predates the SQLite migration:

    git remote set-url --push server clover-main:/home/billy/clovers-api.git

### Importing on the target machine

Two things the Fly deploy taught, both of which apply to a droplet too:

**The importer must stream.** It used to gunzip each table, stringify it, split
it and map JSON.parse over the whole thing — three copies resident. That is
merely wasteful with a 4 GB heap and fatal in 1 GB: `logs` killed it with a V8
OOM inside JsonParse. It streams now; peak RSS went from over a gigabyte to
**97 MB**, and it is no slower.

**Stop the app, or import to a staging path.** Importing over a database the
running app has open fails with `disk I/O error` — the app holds the file and
its WAL. Import to `/data/import.db`, then stop, swap, and restart.

### api2 — do not migrate it, retire it

api2 is a second copy of this same application with its own RethinkDB on :28015.
Its database side is dead: `/clovers` returns 500/502 on every request. The only
endpoint that still works is `/clovers/svg/:id`, which succeeds 8 times out of 8
— because the SVG is computed from the board and needs no database at all.

The sole dependency on it was two hardcoded strings in `src/api/clovers.js`
writing NFT metadata `image` URLs. Those are now `IMAGE_BASE_URL`, defaulting to
`https://api2.clovers.network` so today's output is byte-identical. Retiring
api2 is:

```bash
IMAGE_BASE_URL=https://api.clovers.network   # same code serves the same SVG
```

then destroy the droplet — which is the `s-1vcpu-2gb` at $12/mo. Do it
deliberately: OpenSea caches these URLs and will re-fetch on its own schedule.

## Why a new box and not `do-release-upgrade`

Checked on **api-production** (206.81.16.230) rather than assumed:

| | Value | Consequence |
|---|---|---|
| OS | Ubuntu **16.04.7** LTS, kernel 4.4.0-210 | glibc 2.23 |
| Uptime | **5 years, 16 weeks, 3 days** | has never been proven to boot with its current config |
| `do-release-upgrade -c` | offers **18.04.6** | 16.04 → 18.04 → 20.04 → 22.04 → 24.04 |
| System node | **v9.4.0**; pm2 runs 16.20.2 via `interpreter` | see NODE-UPGRADE.md |
| gcc | **5.4.0** | too old for anything wanting C++17 |
| Memory | 3,951 MB | this is a 4 GB machine, not the 2 GB droplet |
| Disk | 25 GB, 51% used | not the constraint |
| pm2 | API online, **564 restarts** | worth understanding before cutover |

So in-place is four sequential release upgrades and four reboots, on a box whose
first reboot in three years is itself the risk, with no rollback if it stops
part-way — and it still leaves you on a 2 GB droplet at $12/mo, because a
droplet cannot be shrunk.

A new droplet is the *faster* cutover, not the cautious one: build alongside,
test, switch, and keep the old box powered on as rollback until you are happy.

## What the dry run found

Three things that would each have stopped a naive deploy.

**`sha3` cannot compile on Node 22.** It is a native module whose bundled `nan`
predates V8 API changes — `'AccessorSignature' is not a member of 'v8'` and a
dozen more. It is also **not installed on the current production box at all**,
and nothing in `src/` imports it. It is lockfile dead weight, reachable only
through an install script.

**`svg-to-png` drags in `phantomjs-prebuilt`,** whose install script needs
`bzip2` to unpack a 23 MB binary. Also unnecessary.

Both are skipped with `--ignore-scripts`, which is why the provisioning below
needs no compiler, no Python and no bzip2.

**`babel-runtime` is a devDependency that `dist/` requires at runtime**
(`.babelrc` uses `transform-runtime`). So `npm ci --omit=dev` produces an app
that cannot start — `Cannot find module 'babel-runtime/helpers/toConsumableArray'`.
The install has to include dev dependencies, which is what the current box does.
Moving `babel-runtime` into `dependencies` would allow a much smaller production
install; deliberately not done here, because it changes dependency placement and
this deploy should change one thing at a time.

## Provision

Verified minimal set — nothing else is needed.

```bash
apt-get update
apt-get install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs        # v22.x, with node:sqlite built in
```

No `build-essential`, no `python3`, no `bzip2`. The whole native-module problem
disappears on Node 22: `node:sqlite` is built in, so there is no `better-sqlite3`
to install and nothing to compile. This is why `package.json` declares
`engines: { node: ">=22.4" }` and does *not* depend on `better-sqlite3`.

## Install and run

```bash
git clone <repo> /home/billy/clovers-api && cd /home/billy/clovers-api
npm ci --ignore-scripts          # dev deps included -- see babel-runtime above
npm run build
```

Seed the database — **copy the `-wal` too, or checkpoint first**, or the `.db`
looks complete and is missing most of its rows (see migration/sqlite/README.md):

```bash
node migration/sqlite/import.mjs ~/clovers-backups/backup-<stamp> ~/clovers_chain_1.db
```

Then start under pm2. Note `ecosystem.config.js` currently pins
`interpreter: '/home/billy/node/bin/node'` for the Node 16 workaround on the old
box — **that line must be removed** so the system Node 22 is used.

## CHAIN_LISTENER — read this before deploying anywhere

`socketing()` used to start the chain listener only when
`process.env.HOME === '/home/billy'`. Anywhere else — any container, any new
droplet, Fly (`HOME=/root`) — it silently did nothing, and the API went on
answering reads perfectly while never ingesting another event. Found on the Fly
deploy, where it was off and nothing in the logs said so.

It is now `CHAIN_LISTENER`, defaulting to **on**, and it logs its decision with
`console.log` so a disabled DEBUG namespace cannot hide it:

```
chain listener enabled
chain listener DISABLED (CHAIN_LISTENER=off)
```

Set `CHAIN_LISTENER=off` for tests and local work. Leave it unset in production.
**Exactly one process may have it on** — it is the only writer.

## Verify before cutting over

Run against the new box, with the old one still serving traffic:

```bash
node migration/sqlite/http-parity.mjs      # 40 checks vs the live API
node migration/sqlite/query-audit.mjs      # scan/sort/N+1 thresholds
node migration/sqlite/load-test.mjs --target=http://<new-ip>:4444 --label=new
```

Measured in the container dry run on this exact stack: **40/40 passing, 252
req/s under amd64 emulation** (the droplet will be faster — emulation costs
roughly a third).

## Cut over

1. Stop the chain listener on the old box so only one process writes.
2. Re-run the import so the new database is current.
3. Start the new box, confirm it is catching up from the right block.
4. Move the floating IP, or update DNS.
5. **Leave the old droplet powered on for a week.** It is the rollback, and
   DigitalOcean bills a powered-off droplet anyway.

## Portability: the same image runs on Fly

`Dockerfile` and `fly.toml` are the same artifact the local verification runs
against, so "works locally" and "works deployed" are one claim rather than two.
This is also what keeps the Fly and Cloudflare options open — anything that only
works because of some leftover on the old droplet shows up here as a failure.

Verified by running the built image locally on emulated amd64:

| | |
|---|---|
| image | 595 MB, `node:22-slim`, no compiler in it |
| http-parity | **40/40** |
| throughput | 245.7 req/s at concurrency 32, 0 errors |
| memory | 181 MB |

`fly.toml` pins one always-on machine. Both parts matter: the chain listener
holds `eth_subscribe` websockets so a suspending machine misses blocks, and
SQLite here is single-writer with an in-process changefeed replacement, so a
second machine would get its own volume and its own divergent database.

Nothing has been created on Fly. `fly auth whoami` is `b@trifle.life`, org
`personal`, so `fly launch` is one command whenever you want it.

## Frontend: what the dapp needs

Checked `clovers-dapp` against the preview. **No code changes required** for the
backend swap — the API host is already a single variable:

```bash
VUE_APP_API_URL=https://clovers-api-preview.fly.dev npm run serve
```

There is a `.env.preview.local` in the dapp with that set. Every endpoint the
dapp calls was exercised against the preview and returns 200: `/clovers`,
`/clovers/:id`, `/clovers/:id/activity`, `/albums`, `/albums/:id`,
`/albums/list/all`, `/search`, `/users`, `/users/:id`, `/users/:id/albums`,
`/chats/:board`, `/orders/:market`. CORS is `*` and the preflight allows
`authorization`, so a browser on localhost can talk to it. The production build
succeeds with the preview URL baked in.

**The price padding does not affect the dapp.** The one place that could have
broken is `CloverItem--Card.vue`'s `showPrice`, which compares `!== '0'` — but
it compares `prettyBigNumber(clover.price, 0)`, and that runs `fromWei` first,
so `'0'` and 64 zeros both come out `'0'`. `ActivityItem.vue` compares
`item.data.price === '0'`, which reads a *log*, and the importer only pads
`clovers.price` — the 244 log rows holding a bare `'0'` are untouched.

### Realtime was dead in production. FIXED.

`socket.io-client` **4.0.1** in the dapp could not talk to `socket.io` **2.1.1**
in the API — the client refuses with "trying to reach a Socket.IO server in v2.x
with a v3.x client". It failed identically against production, so live
`updateClover`, `newLog` and comment events had not been reaching the dapp at
all.

Fixed on the **server** side, so the dapp needs no change: socket.io 2.1.1 → 4.8.1.
Three instantiation sites (`index.js`, `api/albums.js`, `api/chats.js`) become
`new Server(...)`, and v3+ requires CORS stated explicitly — set to `*`, matching
the `cors()` already on the express app. The 27 `io.emit`/`io.on` call sites are
unchanged. Verified: the dapp's v4 client connects over websocket to both the
local server and Fly, and the `/comments` and `/albums` listeners still respond
on their custom paths.

This also regenerated `package-lock.json`, which turned out to be necessary
anyway — see below.

### The lockfile was regenerated, deliberately

Adding socket.io rewrote `package-lock.json` from lockfileVersion 1 (npm 5,
2018) to 3. That is the churn I had been avoiding all along, so it was validated
rather than trusted:

| | |
|---|---|
| `npm ci` on Node 22 | **OK**, 641 packages (was 902) |
| `npm ci` on Node 24 | **OK** — this *fixed* the malformed `ethereumjs-abi` entry that npm 11 rejected |
| express-basic-auth | still returns 401 on missing and bad credentials, not 500 |
| full suite | 264/264 |
| app on Node 24 | builds, boots, 40/40 |

So the regeneration removed the Node 24 blocker as a side effect. `yarn.lock` was
restored — the repo carries both a `package-lock.json` and a `yarn.lock`, which
is its own hazard and should be resolved separately by deleting one.

## Then

- Retire api2 via `IMAGE_BASE_URL` and destroy its droplet ($12/mo saved).
- Size the replacement for api-production at `s-1vcpu-1gb`; it currently runs on
  a 4 GB machine, and the load tests show it needs ~100 MB.
- Drop `rethinkdb` from `package.json` and delete `src/lib/db-tables.js`
  (kept until now as the record of what each ReQL index meant).
- Consider moving `babel-runtime` to `dependencies` so production installs can
  use `--omit=dev`.
