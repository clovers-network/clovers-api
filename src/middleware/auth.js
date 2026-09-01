// `ethjs` was imported here but never used -- its only reference is a
// commented-out isAddress check below. It was also absent from
// package.json and the lockfile, surviving only as a stale entry in
// node_modules, so `npm install` correctly pruned it and the API then
// crash-looped on 'Cannot find module ethjs'. Removed rather than declared.
import sigUtil from 'eth-sig-util'
import createDebug from 'debug'
// import utils from 'ethereumjs-util'

const debug = createDebug('app:auth')

/**
 * The message the client is expected to have signed.
 *
 * Built fresh on every call. It used to be a module-level array that this
 * function mutated with `+=`, so the expected value accumulated:
 *
 *   call 1   "...with Clovers - 9/2026"
 *   call 2   "...with Clovers - 9/20269/2026"
 *   call 3   "...with Clovers - 9/20269/20269/2026"
 *
 * Every authenticated request after the first was therefore checked against a
 * message no client would ever sign.
 */
function expectedMessage () {
  const now = new Date()
  return [{
    type: 'string',
    name: 'Message',
    value: 'Please sign this message to authenticate with Clovers - ' +
      (now.getMonth() + 1) + '/' + now.getFullYear()
  }]
}

/**
 * Verify that `signature` was produced by `wallet`.
 *
 * SECURITY: this returned `matches || new Error('try again')` on the typed-data
 * path. express-basic-auth authorises on any truthy return, and an Error object
 * is truthy -- so a mismatch authorised the request. Any valid signature from
 * any key authenticated as any address: rename anyone's clover, comment as
 * anyone, delete anyone's album. Confirmed exploitable over HTTP before the fix.
 *
 * It must return a boolean, and only true when the recovered address is the
 * claimed one.
 */
export function auth (wallet, signature) {
  if (typeof wallet !== 'string' || typeof signature !== 'string') return false
  const data = expectedMessage()

  try {
    const recovered = sigUtil.recoverTypedSignature({ data, sig: signature })
    debug('typed signature recovered %s for %s', recovered, wallet)
    return wallet.toLowerCase() === recovered.toLowerCase()
  } catch (err) {
    debug('typed recovery failed: %s', err.message)
  }

  // Some wallets sign the same string as a personal message instead.
  try {
    const recovered = sigUtil.recoverPersonalSignature({
      data: data[0].value,
      sig: signature
    })
    debug('personal signature recovered %s for %s', recovered, wallet)
    return wallet.toLowerCase() === recovered.toLowerCase()
  } catch (err) {
    debug('personal recovery failed: %s', err.message)
    return false
  }
}
