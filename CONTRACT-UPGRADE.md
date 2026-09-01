# Preparing for the CloversController redeploy

The non-ZK branch, `clovers-contracts@fix/reversi-illegal-move-absorption`:
a bitboard rewrite of the Reversi engine, symmetry as bit permutations, a
pause-bypass and commit-namespace griefing fix, and the illegal-move absorption
bug. Checked against what this API actually depends on.

## The ABI does not break

Diffed the public surface of both changed contracts, master against the branch.

`Reversi.sol` was rewritten internally — every changed function is `private` or
`internal`, and `getGame(bytes28[2]) returns (bool, bool, bool, bytes16, uint8,
uint8)` is untouched.

`CloversController.sol` has one signature difference:
`claimCloverWithVerification` gains a `notPaused` modifier, which does not
appear in an ABI. The two new mappings, `pendingCommits` and `commitBlock`, add
getters — additive, so nothing existing breaks.

**Event signatures are unchanged**, so topic0 values are unchanged and indexing
is unaffected. In any case `CloversController` is registered with
`eventTypes: []` — the API makes only view calls to it and watches no events
from it, so a redeploy cannot orphan any history.

## The one real risk was the engine, and it is clear

`POST /clovers/verify` runs the JS `clovers-reversi` engine over submitted moves
and, if satisfied, **signs a message with the API's wallet** authorising an
on-chain claim. That signature is worth exactly as much as the agreement between
the JS engine and the Solidity one.

The Solidity engine was silently absorbing illegal moves — discarding the
submitted move, substituting a legal one of its own, and continuing. A JS engine
with the same bug would, after the fix, start signing games the contract
rejects: users pay gas for a revert.

`clovers-reversi@1.0.21` does not have the bug. Run against the same vectors as
`foundry/test/Reversi.t.sol`:

| | Solidity (fixed) | JS |
|---|---|---|
| C4 + A1 (flips nothing) | error, board unchanged | same |
| C4 + D4 (occupied) | error, board unchanged | same |
| both illegal games | stop at the legal prefix | same |
| real game 1 | `55555aa5569955695569555955555555` | identical |
| real game 2 | `55555555596556955695596555555555` | identical |
| non-C4 opening | rejected | rejected |

`migration/sqlite/engine-parity.mjs` asserts this permanently — 10 checks — so
the two engines cannot drift apart unnoticed.

Two places they do differ, neither reachable:

- **Empty moves.** Solidity rejects; the JS engine reports `error: false`. But
  it also reports `complete: false`, and `/clovers/verify` refuses on
  `error || !complete`, so it cannot reach the signing path. Asserted.
- **Scores.** After C4 the fixed Solidity engine reports black 4 / white 1; the
  JS engine reports 0/0. The API reads scores only to pick an NFT background
  colour, and every branch of that expression returns `#ffffff`.

## On the day

**1. Point the API at the new controller.** Addresses now come from the
environment first, package second:

```bash
CLOVERS_CONTROLLER_ADDRESS=0x…   # restart; it logs the override at startup
```

That makes repointing a restart and rolling back the same. Without it the loop
is: publish `clovers-contracts`, bump the dependency, reinstall, rebuild — slow,
and no quick way back. Bump the package properly afterwards; the override is for
the day itself.

The same override exists for `CLOVERS_ADDRESS`, `CLUB_TOKEN_ADDRESS`,
`SIMPLE_CLOVERS_MARKET_ADDRESS` and `CLUB_TOKEN_CONTROLLER_ADDRESS`. A malformed
value throws at startup rather than being treated as a live address.

**2. Nothing else in the API needs changing.** No migration, no reindex, no
event replay. Confirmed by the ABI diff above.

**3. Re-run the engine parity check** against whatever `clovers-reversi` version
is installed at the time:

```bash
node migration/sqlite/engine-parity.mjs
```

Worth doing even though it passes today: if the bitboard rewrite altered the
board or symmetry output for any real game, this is what catches it, and it is
cheaper than discovering it from a signature that reverts.

## Also fixed while looking

`doSyncOracle` gated its backfill on `commits.collected`. There has never been a
`collected` field — `commits` is `mapping(bytes32 => address)`, so the call
returns an address and `.collected` was always `undefined`, meaning the branch
always ran and the `already collected` path was dead.

Nor can it be repaired: a successful claim *deletes* the entry, so `address(0)`
means "never committed" and "already collected" indistinguishably. The check was
asking a question this mapping cannot answer. Removed, along with the
`getSymmetries` call feeding the commented-out `oracleVerify` — two RPC calls per
clover, in a sweep over tens of thousands, for values nothing consumed.
Behaviour is unchanged, because the branch always ran.
