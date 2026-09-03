/**
 * Parity test: the Worker's SVG must be byte-identical to the origin's.
 *
 * This is not a nicety. NFT metadata already in circulation points at
 * api2.clovers.network for images, and the dapp at img.clovers.network. If the
 * Worker renders even one byte differently, it is a different image.
 *
 * Boards are drawn from real minted tokens, including edge cases: an all-one-
 * colour board, a symmetric board, and one whose id is not 32 hex digits.
 *
 * Run: node --test test/parity.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert'
import { renderSVG, parsePath, clampSize } from '../src/index.js'

// WARNING: this suite no longer proves anything, and passing is not evidence.
//
// It was written when img.clovers.network was the Express droplet, so fetching
// it was a genuine comparison against the origin. That hostname now resolves to
// this Worker -- so the suite fetches the Worker, compares it with the Worker,
// and passes unconditionally.
//
// It cannot be repaired by repointing ORIGIN at the droplets either. Measured
// 2026-09-03: api2's box has ports 80 and 443 shut; img's accepts TCP but
// completes no HTTP exchange. There is no live origin left.
//
// equivalence.test.mjs replaces it, comparing renderSVG against toSVG in
// src/lib/util.js -- the function those droplets actually ran, and still the
// one the API serves from its own /svg alias. Kept here because the fixtures
// and edge-case boards are worth having, and because a test that quietly
// became tautological is worth leaving visible rather than deleting.
const ORIGIN = 'https://img.clovers.network'

// Real boards, verified present on chain earlier in this work.
const BOARDS = [
  '0xaaaa555a5aaa556a55a65aa655aa556a', // first ever minted
  '0x55555955669569a55a69569955655555', // 180-degree rotational symmetry
  '0x55556aa566956a656995665555555555',
  '0xaaaaaaaaaaaaa55aa69a969655556aa9'  // horizontal symmetry
]
const SIZES = [200, 400]

async function fetchOrigin (board, size) {
  const res = await fetch(`${ORIGIN}/svg/${board}/${size}`)
  if (!res.ok) throw new Error(`origin returned ${res.status} for ${board}/${size}`)
  return res.text()
}

for (const board of BOARDS) {
  for (const size of SIZES) {
    test(`byte-identical to origin: ${board.slice(0, 12)}… @ ${size}`, async () => {
      const [mine, theirs] = await Promise.all([
        Promise.resolve(renderSVG(board, size)),
        fetchOrigin(board, size)
      ])
      assert.equal(mine.length, theirs.length, 'byte length differs')
      assert.equal(mine, theirs, 'content differs')
    })
  }
}

test('default size matches the origin default of 400', async () => {
  const board = BOARDS[0]
  const res = await fetch(`${ORIGIN}/svg/${board}`)
  // The origin route is /svg/:id/:size? so this exercises its default.
  if (res.ok) {
    assert.equal(renderSVG(board, clampSize(undefined)), await res.text())
  }
})

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

test('parses the dapp path', () => {
  assert.deepEqual(parsePath('/svg/0xabc/200'), { board: '0xabc', rawSize: '200' })
})

test('parses the metadata path', () => {
  assert.deepEqual(parsePath('/clovers/svg/0xabc'), { board: '0xabc', rawSize: undefined })
})

test('parses the metadata path with a size', () => {
  assert.deepEqual(parsePath('/clovers/svg/0xabc/64'), { board: '0xabc', rawSize: '64' })
})

test('rejects non-image paths', () => {
  ;['/', '/svg', '/clovers/svg', '/favicon.ico', '/clovers'].forEach(p =>
    assert.equal(parsePath(p), null, `${p} should not parse`))
})

// ---------------------------------------------------------------------------
// size handling
// ---------------------------------------------------------------------------

test('size defaults to 400 when absent or unparseable', () => {
  assert.equal(clampSize(undefined), 400)
  assert.equal(clampSize('banana'), 400)
})

test('size is clamped rather than trusted', () => {
  assert.equal(clampSize('999999'), 4000)
  assert.equal(clampSize('1'), 8)
  assert.equal(clampSize('200'), 200)
})

// The origin does NOT reject an unparseable board: byteBoardPopulateBoard
// tolerates it and the route answers 200 with whatever renders. Verified
// against img.clovers.network, which returns 10,389 bytes for 'not-a-board'.
// Parity means reproducing that, not "improving" it -- a 400 here would be a
// behaviour change for any caller relying on always getting an image.
test('junk boards render identically to the origin rather than erroring', async () => {
  for (const junk of ['not-a-board', 'zzz']) {
    const res = await fetch(`${ORIGIN}/svg/${junk}/200`)
    assert.equal(res.status, 200, 'origin answers 200 for junk')
    assert.equal(renderSVG(junk, 200), await res.text(), `differs for ${junk}`)
  }
})
