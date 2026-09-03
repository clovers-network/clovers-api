/**
 * The Worker's renderer must equal the API's renderer, byte for byte.
 *
 * This replaces what parity.test.mjs was doing, and it has to, because that
 * test has quietly stopped asking a question. It fetches
 * https://img.clovers.network as "the origin" -- but that hostname now resolves
 * to this Worker, so it compares the Worker with itself and passes
 * unconditionally. A green run means nothing.
 *
 * Nor can it be repaired by pointing it at the droplets. Measured 2026-09-03:
 * api2's box has ports 80 and 443 shut, and img's accepts TCP but completes no
 * HTTP exchange. There is no live origin left to compare against.
 *
 * `toSVG` in src/lib/util.js is the real source of truth: it is what those
 * droplets ran, and it is still what the API serves from its own /svg alias.
 * Comparing the two functions asks the question directly and keeps working
 * after the droplets are destroyed.
 *
 * Why byte-identity rather than "renders the same board": the output is
 * referenced by NFT metadata already in circulation. A different byte is a
 * different image.
 *
 * Run: node --test workers/images/test/equivalence.test.mjs
 * Needs `npm run build` first, for dist/lib/util.js.
 */
import test from 'node:test'
import assert from 'node:assert'
import { renderSVG } from '../src/index.js'
// Named export. util.js also has a default export object, and reaching for
// `default.toSVG` finds nothing -- toSVG is not on it.
import { toSVG } from '../../../dist/lib/util.js'

// Real minted boards, including the edge cases the original parity suite used:
// an all-one-colour board, 180-degree rotational symmetry, horizontal symmetry.
const BOARDS = [
  '0xaaaa555a5aaa556a55a65aa655aa556a',
  '0x55555955669569a55a69569955655555',
  '0x55556aa566956a656995665555555555',
  '0xaaaaaaaaaaaaa55aa69a969655556aa9',
  '0xaaaaaaaaaaa5aaa9aaa9aaa5aaaaaaaa',
  '0x5555555555555555555555555555aaaa'
]

// 400 is the Worker's default; the others are what the dapp and metadata ask for.
const SIZES = [50, 100, 200, 400, 1000]

test('toSVG loaded from the built API', () => {
  assert.strictEqual(typeof toSVG, 'function',
    'dist/lib/util.js has no toSVG -- run npm run build')
})

// toSVG is async in the API and renderSVG is synchronous in the Worker -- the
// port dropped the promise, correctly, since nothing in it awaits anything.
// Comparing them without awaiting compares a string to a Promise and fails with
// two blobs that are in fact identical, which is a confusing way to find out.
for (const board of BOARDS) {
  test(`renderSVG matches toSVG for ${board}`, async () => {
    for (const size of SIZES) {
      assert.strictEqual(renderSVG(board, size), await toSVG(board, size),
        `differs at size ${size}`)
    }
  })
}

test('a board id that is not 32 hex digits behaves the same in both', async () => {
  // The origin never validated this; both must degrade identically rather than
  // one throwing and the other rendering.
  for (const odd of ['0xabc', '0x', 'not-a-board']) {
    let a, b
    try { a = await toSVG(odd, 100) } catch (e) { a = 'THREW:' + e.constructor.name }
    try { b = renderSVG(odd, 100) } catch (e) { b = 'THREW:' + e.constructor.name }
    assert.strictEqual(b, a, `diverges on ${JSON.stringify(odd)}`)
  }
})
