# Node upgrade: what's possible on this server

**Investigated and applied 2026-08-31.** The API now runs on **Node 16.20.2**.
It previously ran **Node 9.4.0** — released January 2018, EOL that June, so
roughly eight years of unpatched runtime CVEs.

> **Done.** `ecosystem.config.js` sets
> `interpreter: '/home/billy/node/bin/node'`, so the app runs on Node 16 while
> the pm2 daemon stays on the system Node 9. Confirmed by resolving
> `/proc/<pid>/exe`, which points at that binary and reports `v16.20.2`.
>
> Post-switch verification: every endpoint 200 (`/`, `/clovers`, `/logs`,
> `/users`, `/clovers/metadata/:id`, `/clovers/svg/:id`), socket.io answering,
> both WebSocket subscriptions connected, catch-up clean, and the clover count
> still matching chain at 44,326.
>
> **Rollback:** delete the `interpreter` line and reload. Node 16 lives at
> `~/node` on the server; the system Node is untouched at 9.4.0.

## The blocker is the OS, not Node

The server is **Ubuntu 16.04.7 with glibc 2.23**. Modern Node binaries need a
newer glibc. Tested directly on the host rather than inferred:

| Node | Result |
|---|---|
| 22.23.2 | fails — `GLIBC_2.27' not found` |
| 20.20.2 | fails — `GLIBC_2.28' not found` |
| 18.20.8 | fails — `GLIBC_2.25' not found` |
| **16.20.2** | **runs** |

So **Node 16 is the hard ceiling**, and Node 16 went EOL in September 2023.
There is no *supported* Node that can run on this machine at all.

That reframes the problem. This was never "upgrade Node" — it is "the OS is three
years past EOL and caps the runtime". Ubuntu 16.04 lost standard support in April
2021 and even extended maintenance ended April 2024, so the box also receives no
kernel or library security updates.

## But 9 → 16 works today, with no code changes

Tested on the host against the real database and live chain, using the
**existing** `node_modules` (no reinstall):

- **All 28 built modules load** under Node 16. Zero failures.
- **RethinkDB driver works** — connected and counted 44,589 clovers.
- **chain.js works** — head and `totalSupply` (44,326) both correct. Node 16 has
  no global `fetch`, so the `http`/`https` fallback added for Node 9 carries it.
- **eth-sig-util loads** (the auth path).
- **The full API boots and serves**: started on port 4555, catch-up ran, both
  WebSocket subscriptions connected, and `/`, `/clovers`, `/logs` all returned
  200 with real data. No errors logged.

Native modules (`secp256k1`, `sha3`) are compiled for Node 9's ABI and would not
normally survive a major-version jump — but nothing on the critical path loads
them, which is consistent with the earlier finding that `eth-sig-util` works
without `sha3`.

**Value of the jump:** unpatched-CVE exposure shrinks from 2018→now to
2023→now. Still not good, but roughly seven years of runtime fixes for near-zero
risk and no code change.

## How to actually do 9 → 16

Do **not** replace the system Node or reinstall pm2. The pm2 daemon is currently
running under Node 9 with the API as a managed process; the low-risk move is to
change only the interpreter the app runs under, leaving the daemon alone:

```js
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'API',
    script: 'dist/index.js',
    interpreter: '/home/billy/node/bin/node',   // Node 16
    // ...existing env blocks unchanged
  }]
}
```

Then:

```sh
# install Node 16 to a fixed path
ssh clover-main '
  cd ~ && curl -sSO https://nodejs.org/dist/v16.20.2/node-v16.20.2-linux-x64.tar.xz
  tar xf node-v16.20.2-linux-x64.tar.xz && mv node-v16.20.2-linux-x64 node
  ~/node/bin/node -v
'
# then deploy the ecosystem change and reload
```

Rollback is removing the `interpreter` line and reloading — the app returns to
Node 9 immediately.

**Verify after switching:** `pm2 describe API` shows the interpreter in use, and
the startup log should show catch-up plus two subscriptions, exactly as on Node 9.

## The real fix — now required, not just advisable

A current OS. That means a new droplet (or Fly, or the Cloudflare direction) —
not an in-place upgrade, because Ubuntu 16.04 → 24.04 in place on a box with
1,900+ days uptime and undeclared `node_modules` drift is far riskier than
building alongside and cutting over.

**The SQLite migration turns this from a preference into a requirement.** The
store needs a SQLite driver. `node:sqlite` is built into Node 22.4+, but Node 16
does not have it, so on this box it would fall back to `better-sqlite3` — a
native module. Tested in a Node 16 container rather than assumed:

| | result |
|---|---|
| `better-sqlite3@9.6.0` | no prebuilt binary exists for Node 16 at all — falls through to `node-gyp`, which needs Python and a C++17 toolchain |
| `better-sqlite3@8.7.0` | a prebuild downloads, then fails to load: requires `GLIBC_2.29`, and this box has **2.23** |

So on Ubuntu 16.04 the only route is compiling from source with gcc 5.4 against
a library that wants C++17. That is not a deploy step anyone should sign up for.

On Ubuntu 24.04 with Node 22 the problem disappears completely: `node:sqlite` is
built in and **there is no native module to build**. That is also the path all
264 tests already exercise. `better-sqlite3` is therefore declared as an
*optional* dependency — if it fails to build, npm continues and the built-in
driver is used.

`SQLITE_DRIVER=better-sqlite3` forces the fallback so the non-default path can
still be tested on a modern Node; the HTTP suite passes 40/40 on it.

Whenever that happens, the constraint disappears: everything here already runs on
Node 22 locally, and the `fetch`/`WebSocket` fallbacks make the code
version-agnostic from Node 9 through 22.

## Known cosmetic warning

Startup logs one deprecation notice:

```
[DEP0066] DeprecationWarning: OutgoingMessage.prototype._headers is deprecated
```

Cosmetic on Node 16 — verified the property still returns headers correctly. It
comes from transitive dependencies (`send`, `http-signature`, `timed-out`,
`event-loop-inspector`), not from this codebase, so there is nothing to fix
here. Worth remembering for the eventual move to a supported Node, where the
property may be gone: the fix then is updating those dependencies, most of which
arrive via express 4.16 and pm2 3.0.

## Cleanup

Done — the Node test tarballs (733 MB) were removed from the server. `~/node`
holds the Node 16 build now in use.
