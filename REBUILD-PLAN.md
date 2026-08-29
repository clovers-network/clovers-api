# Clovers Infrastructure Rebuild — Staged Plan

**Status:** proposal, not started
**Last updated:** 2026-08-29

---

## Summary

Four DigitalOcean droplets currently exist to ingest roughly **one contract event per day**.
One of them — the Ethereum full node — has been dead for about two weeks, which is why
production data is frozen. It is also the large majority of the bill.

The plan below removes the node, keeps the pieces that work, and moves one self-contained
service to Cloudflare as a low-risk way to evaluate the platform. It is deliberately staged
so each step ships independently and nothing depends on a decision that hasn't been made yet.

**Guiding principle:** the savings come from deleting the node, not from where the API lives.
Do the valuable, low-risk work first. Defer the rewrite.

---

## Current state

| Machine | IP | Job | Status |
|---|---|---|---|
| ETH node | `138.68.85.68` | Full node the API watches for events | **Dead — connection times out** |
| API | `206.81.16.230` | Express API + RethinkDB | Alive, but frozen since the node died |
| img | `165.22.72.114` | Clover image generation | Alive |
| forum | `68.183.74.37` | Discourse | Alive |

The dapp front end is on AWS, not DigitalOcean.

### Measured facts

These were verified against live systems, not assumed.

| Measure | Value |
|---|---|
| Clovers `Transfer` events, all time | 52,325 |
| Clovers `Transfer` events, last ~18 months | ~700 (**~1/day**) |
| Last on-chain Clovers event | block 25,764,344 |
| Newest clover in production DB | block 25,761,840 |
| Clovers / logs / users / albums | 44,012 / 60,714 / 3,085 / 314 |
| Total rows, all tables | ~110,000 |
| Estimated database size | ~150 MB |

The workload does not justify a full node. It barely justifies a database.

---

## Stage 0 — Establish the actual bill

**Effort:** minutes · **Risk:** none · **Blocks:** cost claims below

`doctl` is installed locally but not authenticated. Run:

```sh
doctl auth init
doctl compute droplet list --format Name,Region,Memory,VCPUs,Disk,PriceMonthly
doctl compute volume list
```

Everything labelled "estimated" in this document is list-price arithmetic. This replaces it
with the real number and confirms which droplets and volumes actually exist — including any
large block-storage volume attached to the node, which is likely the single biggest line item.

---

## Stage 1 — Delete the node, switch to RPC subscriptions

**Effort:** days · **Risk:** medium · **Value:** fixes the outage *and* ~90% of the bill

This is the whole ballgame. Everything else is tidying.

### What changes

Replace the "watch our own node" listener with subscriptions to **multiple third-party RPC
providers**. Nothing else about the API needs to change to do this.

### Provider redundancy

Free public endpoints were historically unreliable, so do not depend on one. Verified working
with `eth_subscribe` on mainnet logs, **with no API key at all**:

- `wss://ethereum-rpc.publicnode.com` — accepted
- `wss://eth.drpc.org` — accepted
- `wss://mainnet.gateway.tenderly.co` — accepted
- `wss://eth.merkle.io/ws` — rejected (non-101 response)

Recommended shape:

- **Two live subscriptions** on different providers, deduplicated by `(transactionHash, logIndex)` —
  the `unique_log` index already enforces this.
- **One slow poller** on a third provider (`eth_getLogs` every ~60s from the last stored block)
  as a backstop that catches anything both subscriptions missed.
- Add an Alchemy or Infura free key as a named fallback if the public endpoints degrade.
  Alchemy free is 30M compute units/month at 15 req/s and includes `eth_subscribe`.

Cost of a subscription is negligible: providers bill on delivered bandwidth, and this emits
about one event a day.

### Important distinction

Live subscription and historical backfill are **not** the same difficulty:

- **Live `eth_subscribe`** — freely available, no key needed, verified above.
- **Historical `eth_getLogs`** — heavily restricted on free tiers. Measured caps:
  Cloudflare 800 blocks, dRPC 10,000 blocks; Ankr, PublicNode and LlamaRPC now require keys
  or reject archive requests outright.

You only backfill once, so this is fine — but do not assume a provider that streams happily
will also serve deep history.

### Catch-up and backfill

The obvious worry is: if we fall behind for a long time, historical blocks are hard to get from
free providers. **Measured, this turns out not to be a problem for this contract** — but the
reason matters, because it tells you when it *would* become one.

#### What actually limits free `eth_getLogs`

Two different caps, and only one of them is about blocks:

- **Block-range cap** — how wide a range you may ask for. Measured: Cloudflare 800,
  dRPC 10,000 (5,000 reliably), others require keys.
- **Result cap** — how many logs may come back in one response, typically ~10,000.

**The result cap is the one that hurts**, and it is a function of how busy the contract is, not
how long you were down. A high-traffic contract blows the result cap in a handful of blocks, so
backfilling it means thousands of tiny ranges. Clovers emits **~1 event/day**, so a maximum-width
range comes back nearly empty and the result cap is never approached.

Being dormant is what makes our catch-up cheap. That property holds no matter how far behind
we fall.

#### Measured, against `https://eth.drpc.org`, no API key

Catching up the real production gap:

```
gap:      97,443 blocks (~13.5 days)
result:   20 requests, 1 chunk shrink, 26 logs, 7.9s wall time
```

Extrapolating from that measured rate (~0.4s/request at 5,000 blocks per chunk):

| Time behind | Blocks | Requests | Approx. wall time |
|---|---|---|---|
| 1 day | 7,200 | 2 | ~1s |
| 1 week | 50,400 | 11 | ~4s |
| 1 month | 216,000 | 44 | ~18s |
| 1 year | 2,628,000 | 526 | ~3.5 min |
| **Full rebuild from genesis** | 17,496,283 | ~3,500 | **~25 min** |

Even total database loss is a ~25-minute job, subject to rate-limit backoff. There is no
scenario where we are stranded.

#### The algorithm

1. **Persist a cursor.** Store the last *fully processed* block. Never infer it from the data.
2. **Catch up on every startup**, not just after an outage. Paginate from cursor to head before
   going live. This makes a two-week outage behave identically to a routine restart — the
   recovery path is exercised constantly instead of being cold code that only runs in a crisis.
3. **Adaptive chunk size.** Start at 10,000; halve on error; recover upward on sustained success.
   Observed working above: one shrink from 10,000 to 5,000, then clean to completion.
4. **Never advance the cursor past a range that failed.** This was a real defect in the
   IndexSupply commit — `populateLogs` advanced its position whether or not the fetch succeeded,
   so any failed range was skipped permanently and silently.
5. **Rotate providers on repeated failure** and retry the *same* range. Different providers have
   different caps, so a range one rejects another may serve.
6. **Re-scan the last ~12 blocks each pass** and hold the cursor slightly behind head, so a
   chain reorg cannot strand incorrect data.

#### Why over-fetching is always safe

The `logs` table has a `unique_log` index on `(transactionHash, logIndex)`, and inserts are
deduplicated against it. **Re-fetching a range you already have is harmless.**

That is the property that makes this robust: correctness never depends on fetching precisely the
right range. It only depends on never *missing* one. So always overlap, always re-scan on doubt,
and prefer fetching too much over reasoning carefully about boundaries.

#### Escape hatch

If the gap is ever genuinely large (total database loss) and free providers rate-limit too
aggressively, an Alchemy free key (30M compute units/month) covers a full genesis rebuild
comfortably — a 3,500-request backfill is ~210,000 compute units, well under 1% of the monthly
free allowance. A month of a paid tier for a one-time job is also a rounding error. This is a
convenience problem, never a blocker.

#### Do not rebuild what you already have

For the *routine* case, still prefer copying: the existing 60,714 decoded logs are canonical.
Re-deriving history is the disaster-recovery path, not the migration path.

### Prior art in this repo

Branch `feature/indexsupply-migration` contains a fixed IndexSupply integration
(commit `aacd24e`). IndexSupply is being retired as a vendor, so it is **reference only** —
but read it before writing the replacement. It documents five defects that were found the
hard way, four of which fail silently. In particular:

> The Clovers `Transfer` event declares `_tokenId` as **indexed**. Getting that wrong does not
> raise an error — `topic0` is identical either way, so logs still match, but `tokenId` decodes
> out of the empty data section and comes back `0` for every clover. `_tokenId` is the `clovers`
> primary key.

Whatever indexes these contracts next needs to get the `indexed` markers right.

### Then

Destroy the node droplet and its block-storage volume.

---

## Stage 2 — Move image generation to Cloudflare

**Effort:** days · **Risk:** low · **Value:** deletes a droplet, kills a dead dependency

A clover image is a **pure function of its token ID** — no database, no state, no I/O. That
makes it the ideal first thing to move: entirely self-contained, trivially verifiable
(same input, same output), and easy to roll back by pointing DNS back.

### Why this is worth doing beyond the droplet cost

- Current image path depends on `svg-to-png`, which needs **PhantomJS** — long dead and a
  maintenance liability.
- 44,000 clover images are immutable. On Cloudflare they cache at the edge worldwide,
  permanently, for free. This is the one thing a droplet genuinely cannot match.
- It is a real but low-stakes way to learn the platform before betting the API on it.

### Approach

A Worker that takes a token ID, generates the SVG, and returns it with a long cache header.
Point `img.clovers.network` at it. Keep the droplet powered on until you've compared output,
then destroy it.

---

## Stage 3 — Decide about the API (deferred on purpose)

**Do not decide this now.** Decide it after Stage 2, when you have actually used Workers and
have your own opinion.

Two viable end states:

### Option A — API stays on DigitalOcean

One **2 GB droplet ($12/mo)** running the API, the database, and the event listener.

- Not the $6/1 GB tier — you're running Node, a database, and holding socket connections.
- Keeps a mental model you already have.
- Still requires replacing RethinkDB (abandoned) — likely with Postgres or SQLite.

### Option B — API moves to Cloudflare

Worker + D1 + one Durable Object holding the provider subscriptions. ~$5/mo.

- Cheaper, no machine to patch or lose.
- Bigger rewrite.

**Either way the current code needs significant work** — it is Node-8-era Babel with
RethinkDB (abandoned) and PhantomJS (dead). There is no "lift and shift" option. That
reality is what makes deferring this decision cheap: you aren't preserving anything by waiting.

---

## The forum: leave it alone

`forum.clovers.network` runs Discourse and should stay on its own droplet **permanently**.

- Discourse needs Ruby, Postgres, Redis and a persistent disk. It **cannot** run on Cloudflare
  Workers. This is not an engineering problem to solve around.
- Official requirements: 1 GB RAM minimum with swap, 2 GB recommended, 4 GB for an active
  community. It will not share a $6 droplet with the API.
- **Do not merge it with the API.** Discourse is the heaviest, least related workload, it is a
  public web app that attracts attack traffic, and it self-updates. Coupling it to the game API
  means a forum problem becomes a game outage.

Treat it as a separate decision entirely: keep it, move it to managed hosting, or retire it.

---

## Cost

Current droplet pricing (verified): $4 / 512 MB · $6 / 1 GB · $12 / 2 GB · $24 / 4 GB · $48 / 8 GB.

| | Now (estimated) | After Stage 1 | After Stage 3 |
|---|---|---|---|
| ETH node | ~$150–250 | **deleted** | — |
| API + DB | ~$24 | ~$24 | $12 (A) or $5 (B) |
| img | ~$12 | ~$12 | **deleted** |
| forum | ~$24 | ~$24 | ~$24 |
| RPC access | — | $0 (free tiers) | $0 |
| **Total** | **~$210–310** | **~$60** | **~$36–41** |

**Stage 1 alone captures most of the savings.** Stages 2 and 3 are worth doing, but they are
optimisation — not the emergency.

---

## Migration notes (whenever the database moves)

1. **Export the social data first.** Clover names, comments, albums and user profiles exist
   **nowhere but that database**. Everything else is re-derivable from chain; this is not.
2. Chain data should be **copied, not rebuilt**, for the reasons in Stage 1.
3. Run old and new side by side and diff responses endpoint by endpoint before cutting DNS.
4. Keep the old droplets powered on for a rollback window.
5. Destroy machines only after the rollback window closes.

---

## Note on the v5 contracts

Not yet deployed, so these are still free to change:

- **Add `indexed` to event parameters.** The v5 events currently declare **no indexed
  parameters at all**. Marking `tokenId` and the address parameters `indexed` lets any indexer
  filter by topic instead of decoding every log. It costs nothing at deploy time and cannot be
  changed afterwards. This is the exact class of mistake documented in Stage 1.
- **Typo in a public signature:** `recepient` should be `recipient`. Baked into the ABI forever
  once deployed.
- **Good news — board encoding is unchanged.** The v5 bitboard rewrite is internal only.
  `toBoard()` re-packs into the identical `bytes16` layout; verified by decoding v5's
  `emptyBoard()` constant with the existing v4 `clovers-reversi` decoder, which renders the
  correct Othello opening position. Token IDs keep their format, so the `clovers` primary key
  stays stable and v4/v5 clovers can share one table. **No migration step forks on contract
  version.**
- v5's `cloverClaimed` carries `moves`, `symmetries`, `reward` and `keep` inline. The current
  indexer makes 4–5 `eth_call`s per new clover to recover exactly this. Under v5 the log is
  sufficient, which removes almost all of the indexer's RPC dependency.

---

## Open items

- [ ] `doctl auth init` — replace estimated costs with the real bill
- [ ] Database access on `206.81.16.230` for the social-data export
- [ ] Decide the forum's long-term home (independent of everything above)
- [ ] Choose the RethinkDB replacement (Postgres / SQLite / D1) — follows from Stage 3
