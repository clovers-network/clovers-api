import eth from 'ethjs'
import sigUtil from 'eth-sig-util'

const msgParams = [{
  type: 'string',
  name: 'Message',
  value: 'To avoid bad things, sign below to authenticate with Clovers'
}]

function checkAddress (ctx, address) {
  if (!eth.isAddress(address)) {
    ctx.throw(400, 'Invalid ETH address')
  }
}

export function auth (wallet, signature) {
  try {
    const recovered = sigUtil.recoverTypedSignature({
      data: msgParams,
      sig: signature
    })
    return wallet.toLowerCase() === recovered.toLowerCase()
  } catch (err) {
    console.log(err)
    return false
  }
}
