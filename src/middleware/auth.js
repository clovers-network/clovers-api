import eth from 'ethjs'
import sigUtil from 'eth-sig-util'

const msgParams = [{
  type: 'string',
  name: 'Message',
  value: 'To avoid bad things, sign below to authenticate with Clovers'
}]

function checkAddress (ctx, address) {
  console.log('checkAddress')
  if (!eth.isAddress(address)) {
    ctx.throw(400, 'Invalid ETH address')
  }
}

export function auth (wallet, signature) {
  console.log('auth')
  try {
    const recovered = sigUtil.recoverTypedSignature({
      data: msgParams,
      sig: signature
    })
    return wallet.toLowerCase() === recovered.toLowerCase()
  } catch (err) {
    console.log('first sig recovery failed')
    try {
      const recovered = sigUtil.recoverTypedSignature({
        data: msgParams[0].value,
        sig: signature
      })
      return wallet.toLowerCase() === recovered.toLowerCase()
    } catch (err) {
      console.log('second sig recovery failed')
      console.log(err)
      return false
    }
  }
}
