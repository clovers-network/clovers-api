# Migration: IndexSupply Integration

## What Changed

The clovers-api server previously connected directly to a custom Ethereum full
node at `http://138.68.85.68:8545` via ethers.js to:

1. Listen for real-time contract events (via WebSocket/polling)
2. Fetch historical event logs for chain sync
3. Make `eth_call` view function calls (balanceOf, ownerOf, etc.)

This migration replaces **items 1 and 2** with [IndexSupply](https://indexsupply.net),
a hosted API that provides SQL access to decoded Ethereum event logs. Item 3
(view function calls) now uses Infura's free tier as a lightweight RPC provider.

### Files Changed

- **`src/lib/indexsupply.js`** (NEW) - Replaces `src/lib/ethers-utils.js` as the
  primary data source module. Provides:
  - `queryIndexSupply()` - One-shot SQL queries against event logs
  - `queryLiveIndexSupply()` - SSE streaming for real-time events
  - `fetchHistoricalEvents()` - Batch historical event fetching by block range
  - `startLiveStreams()` - Start all live event listeners
  - Contract instances via Infura for `eth_call` (view functions)
  - Same `events` export shape for backward compatibility with model handlers

- **`src/socketing.js`** - Replaced ethers.js `contract.on(event)` listeners
  with IndexSupply SSE live queries via `startLiveStreams()`. Socket.io output
  to dApp clients remains unchanged.

- **`src/lib/build.js`** - Replaced `provider.getLogs()` calls with
  `fetchHistoricalEvents()` which queries IndexSupply in block-range batches.
  The `transformLog()` function now handles both pre-transformed IndexSupply
  logs and legacy raw ethers logs.

- **`src/models/*.js`** - Updated imports from `ethers-utils` to `indexsupply`.
  No logic changes; model handlers receive the same log format as before.

- **`src/api/*.js`** - Updated imports from `ethers-utils` to `indexsupply`.

- **`package.json`** - Removed `web3` and `web3-provider-engine` (no longer
  needed). Added `web3-utils` as explicit dependency. Added `eventsource` for
  SSE support. Kept `ethers` for Infura RPC calls.

### What Stays the Same

- RethinkDB database and all table schemas
- All REST API endpoints and response formats
- Social features (clover names, comments, albums)
- Authentication via eth-sig-util
- Socket.io event output to connected dApp clients
- The `src/lib/ethers-utils.js` file is preserved but no longer imported

## Required Environment Variables

| Variable | Required | Description |
|---|---|---|
| `INDEXSUPPLY_API_KEY` | Recommended | API key for IndexSupply. Free tier allows 5 queries/min. Indie tier ($50/mo) allows 5 req/sec and 3M queries/month. |
| `INFURA_API_KEY` | Recommended | Infura API key for `eth_call` view functions (balanceOf, ownerOf, getCloverMoves, etc.). Free tier is sufficient. |

If neither key is set, the server falls back to the legacy full node at
`http://138.68.85.68:8545` for RPC calls and will fail for IndexSupply queries.

These can also be set in `src/config.json` as `infuraKey` / `infuraAPI`.

## Why

Running a custom Ethereum full node costs approximately $100-200/month in
server resources and requires ongoing maintenance (disk space, updates, syncing).
IndexSupply eliminates this dependency for event log queries, and Infura's free
tier handles the small number of `eth_call` requests needed for view functions.

**Estimated cost savings**: ~$100-200/month (full node) replaced by $0-50/month
(IndexSupply free or Indie tier + Infura free tier).

## IndexSupply API Overview

- **Endpoint**: `GET https://api.indexsupply.net/v2/query`
- **Live streaming**: `GET https://api.indexsupply.net/v2/query-live` (SSE)
- **How it works**: You provide human-readable event signatures and SQL. Event
  signatures create virtual tables that can be JOINed with base tables
  (`blocks`, `txs`, `logs`).
- **Filtering**: Use `log_addr` column to filter by contract address.
- **Documentation**: https://docs.indexsupply.net

## Future Roadmap: Full Server Deprecation

The long-term goal is to make this server unnecessary entirely:

1. **Social layer on-chain**: Move clover names, comments, and albums to an
   onchain data layer (e.g., EAS attestations, Lens, or a dedicated contract).

2. **Metadata from IPFS/onchain**: Serve clover SVGs and metadata from IPFS
   or generate them client-side from onchain data.

3. **Client-side IndexSupply**: The dApp can query IndexSupply directly from
   the browser, eliminating the need for a backend API server.

4. **Replace RethinkDB**: Once the social layer is onchain, the database
   becomes unnecessary. All data can be derived from onchain events.

At that point, the entire clovers-api server can be retired, saving all hosting
costs and eliminating a centralized dependency.
