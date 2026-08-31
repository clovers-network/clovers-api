/**
 * Clover board images at the edge.
 *
 * Replaces two droplets that exist only to run this one pure function:
 *
 *   img.clovers.network/svg/<board>/<size>     - what the dapp requests
 *   api2.clovers.network/clovers/svg/<board>   - what NFT metadata requests
 *
 * A board is a uint256 token id and its rendering is a pure function of it, so
 * every response is immutable and can be cached at the edge forever. That is
 * the whole reason this workload suits Workers: 44,000 boards, each generated
 * at most once per edge location.
 *
 * `renderSVG` is a direct port of `toSVG` in src/lib/util.js. It must stay
 * byte-identical to it — the output is referenced by NFT metadata already in
 * the wild, and test/parity.test.js asserts equality against the live host.
 */

import reversiModule from 'clovers-reversi'

// clovers-reversi is Babel-compiled CommonJS: it sets `exports.__esModule` and
// puts the class on `exports.default`. Babel's own interop unwraps that, which
// is why `import Reversi from ...` works in the API, but a real ESM default
// import (Node, and esbuild in the Workers build) hands back the namespace
// object instead — so the constructor has to be unwrapped explicitly.
const Reversi = reversiModule.default || reversiModule

// Matches src/lib/util.js exactly.
const GREEN = '#01B463'
const BLACK = '#000000'
const WHITE = '#FFFFFF'
const GREY = '#808080'

// The origin never bounded this. At the edge it is worth bounding: size drives
// only the numbers in the markup, but an absurd value still costs CPU and
// bytes on a public endpoint. Covers every size the dapp and metadata use.
const MIN_SIZE = 8
const MAX_SIZE = 4000
const DEFAULT_SIZE = 400

const IMMUTABLE = 'public, max-age=31536000, immutable'

/**
 * Port of toSVG(). Kept as one function with the original concatenation order
 * so the output stays byte-for-byte identical; do not "tidy" it.
 */
function renderSVG (id, size) {
  const r = new Reversi()
  r.byteBoardPopulateBoard(id)
  r.calcWinners()
  r.isSymmetrical()

  let fill, stroke
  const strokeWidth = 1
  const radius = size / 2

  let svg =
    '<?xml version="1.0" encoding="UTF-8"?><svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" width="' +
    size +
    'px" height="' +
    size +
    'px" viewBox="-1 -1 ' +
    (size + 2) +
    ' ' +
    (size + 2) +
    '" enable-background="new 0 0 ' +
    size +
    ' ' +
    size +
    '" xml:space="preserve">'

  if (r.whiteScore < r.blackScore) {
    fill = BLACK
    stroke = BLACK
  } else if (r.whiteScore > r.blackScore) {
    fill = WHITE
    stroke = BLACK
  } else {
    fill = GREY
    stroke = GREY
  }

  svg +=
    '<circle shape-rendering="optimizeQuality" fill="' +
    fill +
    '" stroke="' +
    stroke +
    '" stroke-width="' +
    strokeWidth +
    '" stroke-miterlimit="10" cx="' +
    size / 2 +
    '" cy="' +
    size / 2 +
    '" r="' +
    radius +
    '"/>'

  for (let i = 0; i < 64; i++) {
    const row = Math.floor(i / 8)
    const col = i % 8
    switch (r.board[row][col]) {
      case r.BLACK:
        if (r.whiteScore < r.blackScore) continue
        fill = BLACK
        stroke = 'none'
        break
      case r.WHITE:
        if (r.whiteScore > r.blackScore) continue
        fill = WHITE
        stroke = 'none'
        break
      case r.EMPTY:
        fill = GREEN
        stroke = 'none'
        break
      default:
        continue
    }
    const x = (row + 1) * (size / 12) + size / 8
    const y = (col + 1) * (size / 12) + size / 8
    svg +=
      '<circle shape-rendering="optimizeQuality" fill="' +
      fill +
      '" stroke="' +
      stroke +
      '" stroke-miterlimit="1" cx="' +
      x +
      '" cy="' +
      y +
      '" r="' +
      size / 24 +
      '"/>'
  }

  return svg + '</svg>'
}

/**
 * Pull the board and size out of either path shape:
 *   /svg/<board>[/<size>]
 *   /clovers/svg/<board>[/<size>]
 * Returns null when the path is not an image request.
 */
function parsePath (pathname) {
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] === 'clovers') parts.shift()
  if (parts[0] !== 'svg' || !parts[1]) return null
  return { board: parts[1], rawSize: parts[2] }
}

function clampSize (raw) {
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n)) return DEFAULT_SIZE
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, n))
}

function svgResponse (body, extra = {}) {
  return new Response(body, {
    headers: {
      // charset matches what the origin sent, so responses stay identical.
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': IMMUTABLE,
      'Access-Control-Allow-Origin': '*',
      ...extra
    }
  })
}

function errorResponse (status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Do not let a bad request get cached as though it were an image.
      'Cache-Control': 'no-store'
    }
  })
}

export default {
  async fetch (request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return errorResponse(405, 'method not allowed')
    }

    const url = new URL(request.url)

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ service: 'clovers-images', ok: true }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
      })
    }

    const parsed = parsePath(url.pathname)
    if (!parsed) return errorResponse(404, 'not found')

    // Matches the origin: strip whitespace, no other normalisation. Board ids
    // are compared case-sensitively downstream, so casing is left alone.
    const board = parsed.board.replace(/\s+/g, '')
    const size = clampSize(parsed.rawSize)

    let svg
    try {
      svg = renderSVG(board, size)
    } catch (err) {
      // The origin answered 400 for an unparseable board; keep that contract.
      console.log(JSON.stringify({
        level: 'warn', msg: 'render failed', board, size, error: String(err && err.message || err)
      }))
      return errorResponse(400, 'invalid board')
    }

    return svgResponse(request.method === 'HEAD' ? null : svg, {
      'X-Clover-Board': board,
      'X-Clover-Size': String(size)
    })
  }
}

export { renderSVG, parsePath, clampSize }
