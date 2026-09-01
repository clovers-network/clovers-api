/**
 * The JS Reversi engine against the Solidity one's test vectors.
 *
 * POST /clovers/verify runs `clovers-reversi` over submitted moves and, if it
 * is satisfied, signs a message with the API's wallet authorising an on-chain
 * claim. The signature is only as good as the agreement between that JS engine
 * and the engine inside CloversController -- if the JS one accepts a game the
 * contract rejects, the API signs something that reverts; if it accepts a game
 * the contract *shouldn't* have, the API underwrites a bad clover.
 *
 * Nothing guarded that agreement. It became urgent because the Solidity engine
 * was found to silently absorb illegal moves -- discarding the submitted move,
 * substituting a legal one, and carrying on -- and the fix in
 * clovers-contracts@fix/reversi-illegal-move-absorption makes it reject them.
 * A JS engine with the same bug would now be signing games that revert.
 *
 * It does not have the bug. These are the same vectors as
 * clovers-contracts/foundry/test/Reversi.t.sol, asserted against the JS engine,
 * so the two cannot drift apart unnoticed.
 *
 *   node migration/sqlite/engine-parity.mjs
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const Reversi = require('clovers-reversi').default

// Same packing as foundry/src/ReversiHarness.sol: 32 slots of 7 bits, packed
// left to right, move = 64 + col + row*8.
const enc = (c, r) => 64 + c + r * 8
const pack = (mv) => {
  let acc = 0n
  for (let i = 0; i < 32; i++) acc = (acc << 7n) | BigInt(i < mv.length ? mv[i] : 0)
  return '0x' + acc.toString(16).padStart(56, '0')
}
const EMPTY = '0x' + '0'.repeat(56)

// The board after the single legal opening move C4: black 4, white 1.
const AFTER_C4 = 'fffffffffdfffd7ffdbfffffffffffff'

const play = (a, b) => {
  const r = new Reversi()
  try { r.playGameByteMoves(a, b) } catch (err) { return { threw: err.message } }
  return {
    error: !!r.error,
    complete: !!r.complete,
    board: String(r.byteBoard || '').replace(/^0x/, '')
  }
}

let pass = 0, fail = 0
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} ${detail}`)
  ok ? pass++ : fail++
}

console.log('\n  JS engine vs the Solidity vectors\n')

// ---- the security-critical cases -----------------------------------------
// An illegal move must invalidate the game AND must not advance the board.
// Checking `error` alone does not isolate the bug: the original engine set
// error on some paths while still having mutated the position.
{
  const a1 = play(pack([enc(2, 3), enc(0, 0)]), EMPTY)   // A1 flips nothing
  check(a1.error === true, 'illegal move (A1) is rejected', `error=${a1.error}`)
  check(a1.board === AFTER_C4, 'illegal move (A1) does not advance the board', a1.board)

  const d4 = play(pack([enc(2, 3), enc(3, 3)]), EMPTY)   // D4 is occupied
  check(d4.error === true, 'illegal move (occupied D4) is rejected', `error=${d4.error}`)
  check(d4.board === AFTER_C4, 'illegal move (D4) does not advance the board', d4.board)

  // Originally both collapsed onto the same phantom board, different from the
  // legal prefix. Each must now stop at the true position.
  check(a1.board === d4.board && a1.board === AFTER_C4,
    'distinct illegal moves both stop at the legal prefix')
}

// ---- the known-good games must keep producing their tokenIds --------------
for (const [label, a, b, id] of [
  ['real game 1', '0xb58b552a986549b132451cbcbd69d106af0e3ae6cead82cc297427c3',
    '0xbb9af45dbeefd78f120678dd7ef4dfe69f3d9bbe7eeddfc7f0000000',
    '55555aa5569955695569555955555555'],
  ['real game 2', '0xb58b561d7532f1e59aef3970a6d1cfb7d55b34a25febe7c53e9bf4e8',
    '0xb1b257cc10f841fb2287b8116b49dd1af768ffbbd7ff3274f0000000',
    '55555555596556955695596555555555']
]) {
  const g = play(a, b)
  check(!g.error && g.complete && g.board === id, `${label} still validates to its tokenId`, g.board)
}

// ---- the opening constraint ----------------------------------------------
{
  const d3 = play(pack([enc(3, 2)]), EMPTY)
  check(d3.error === true, 'a non-C4 opening is rejected', `error=${d3.error}`)
}

// ---- what /clovers/verify actually gates on -------------------------------
//
// The endpoint refuses on `error || !complete`, so a disagreement only matters
// if it lets something through. Empty moves are one place the engines differ --
// Solidity rejects outright, the JS engine reports error=false -- but it also
// reports complete=false, so the endpoint still refuses. Asserted here because
// that is the property the signature depends on, not the engines matching
// field for field.
{
  const empty = play(EMPTY, EMPTY)
  check(empty.error || !empty.complete, 'empty moves cannot reach the signing path',
    `error=${empty.error} complete=${empty.complete}`)
  const a1 = play(pack([enc(2, 3), enc(0, 0)]), EMPTY)
  check(a1.error || !a1.complete, 'an illegal game cannot reach the signing path')
}

console.log(`\n  ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
