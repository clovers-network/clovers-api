/**
 * Where the oracle signing key comes from.
 *
 * Was `config.oraclePrivateKey`, read straight out of src/config.json. That
 * file is gitignored precisely because it holds this key, which meant the key
 * could only ever live on a machine as a file -- and on the container platform
 * would have had to be baked into an image or written onto a volume. Neither is
 * where a production signing key belongs.
 *
 * ORACLE_PRIVATE_KEY now takes precedence, so on Fly it is an encrypted secret
 * that exists only in the machine's environment. config.json remains the
 * fallback so local development and the old droplet are unaffected.
 *
 * This key is load-bearing, not decorative: CloversController.oracle() on
 * mainnet returns the address it derives, verified against the deployed
 * contract at 0x3c037014486aaA5D509c5171d413C8B3022f1072. Sign with the wrong
 * key and /clovers/verify still returns a signature, the dapp still submits it,
 * and the transaction reverts -- so a mistake here surfaces as users losing gas
 * rather than as anything failing here.
 */
import config from '../config.json'

const TEST_KEY_1 = '0x' + '0'.repeat(63) + '1'

export function oraclePrivateKey () {
  const fromEnv = process.env.ORACLE_PRIVATE_KEY
  if (fromEnv) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(fromEnv)) {
      throw new Error('ORACLE_PRIVATE_KEY is not a 32-byte hex key')
    }
    return fromEnv
  }
  return config.oraclePrivateKey
}

/**
 * Whether the key in use is the canonical `private key = 1` test value.
 *
 * src/config.json in this repo holds exactly that, so a deployment that forgets
 * the secret does not fail -- it signs with a key no contract trusts. Callers
 * log this at boot rather than throwing, because a preview box legitimately
 * runs without a real key and should still serve reads.
 */
export function usingTestKey () {
  return oraclePrivateKey() === TEST_KEY_1
}
