import eth from 'ethjs'
import sigUtil from 'eth-sig-util'
// import utils from 'ethereumjs-util'
var msgParams = [{
  type: 'string',
  name: 'Message',
  value: 'Please sign this message to authenticate with Clovers - '
}]

// function checkAddress (ctx, address) {
//   console.log('checkAddress')
//   if (!eth.isAddress(address)) {
//     ctx.throw(400, 'Invalid ETH address')
//   }
// }

export function auth (wallet, signature) {
  console.log('auth')
  try {
    var now = new Date()
    msgParams[0].value += now.getMonth() + '/' + now.getFullYear()
    const recovered = sigUtil.recoverTypedSignature({
      data: msgParams,
      sig: signature
    })
    return wallet.toLowerCase() === recovered.toLowerCase() || new Error('try again')
  } catch (err) {
    console.log('first sig recovery failed')
    try {
      var personal = { data: msgParams[0].value }
      personal.sig = signature
      const recovered = sigUtil.recoverPersonalSignature(personal)

      // for web3.eth.sign //
      // const hash = msg = utils.keccak256(msgParams[0].value)
      // const sigParams = utils.fromRpcSig(signature)
      // const hashBuffer = utils.toBuffer(hash)
      // const result = utils.ecrecover(
      //   hashBuffer,
      //   sigParams.v,
      //   sigParams.r,
      //   sigParams.s
      // )
      // const recovered = utils.bufferToHex(utils.publicToAddress(result))
      return wallet.toLowerCase() === recovered.toLowerCase()
    } catch (err) {
      console.log('second sig recovery failed')
      console.log(err)
      return false
    }
  }
}
