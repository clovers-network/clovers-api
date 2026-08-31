# Node upgrade: what's possible on this server

**Investigated 2026-08-31.** Production runs **Node 9.4.0**, released January 2018,
EOL June 2018. Roughly eight years of unpatched runtime CVEs.

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

## The real fix

A current OS. That means a new droplet (or Fly, or the Cloudflare direction) —
not an in-place upgrade, because Ubuntu 16.04 → 24.04 in place on a box with
1,900+ days uptime and undeclared `node_modules` drift is far riskier than
building alongside and cutting over.

Whenever that happens, the constraint disappears: everything here already runs on
Node 22 locally, and the `fetch`/`WebSocket` fallbacks make the code
version-agnostic from Node 9 through 22.

## Cleanup

The test tarballs and extracted builds live in `~/node-test` on the server
(~350 MB). Remove them once a decision is made:

```sh
ssh clover-main 'rm -rf ~/node-test'
```
