const debug = require('debug')('app:util')
import Reversi from 'clovers-reversi'
import svg_to_png from 'svg-to-png'
import fs from 'fs-extra'
import path from 'path'
import xss from 'xss'
import BigNumber from 'bignumber.js'
import { bigNumberify } from 'ethers/utils';
var utils = require('ethers').utils

export const oneEthInWei = utils.parseEther('1').toString(10)
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
export function userTemplate(address = null) {
  return {
    name: '',
    address: address.toLowerCase(),
    created: 0,
    modified: 0,
    balance: '0',
    curationMarket: {},
    albumCount: 0
  }
}

export function albumTemplate(user, name, clovers) {
  if (!user) throw new Error('Must provide user object')
  if (!name) throw new Error('Must provide album name')
  return {
    userAddress: user.address.toLowerCase(),
    name: xss(name),
    created: new Date(),
    modified: new Date(),
    clovers
  }
}


export function commentTemplate(user, board, comment = '') {
  if (!user) throw new Error('Must provide user object')
  if (!board) throw new Error('Board ID required')
  return {
    board,
    comment,

    userAddress: user.address.toLowerCase(),
    userName: user.name || user.address.toLowerCase(),
    created: new Date(),
    edited: null,
    deleted: false,
    flagged: false
  }
}

export function dodb(db, command) {
  return new Promise((resolve, reject) => {
    command.run(db, (err, result) => {
      if (err) return reject(err)
      resolve(result)
    })
  })
}

export async function getLowestPrice(
  contract,
  targetAmount,
  _tokenId = null,
  currentPrice = new BigNumber('0'),
  useLittle = false
) {
  if (typeof targetAmount !== 'object') {
    targetAmount = new BigNumber(targetAmount)
  }
  let littleIncrement = utils.parseEther('0.001')
  let bigIncrement = utils.parseEther('0.1')
  currentPrice = currentPrice.plus(useLittle ? littleIncrement : bigIncrement)
  if (_tokenId) {
    let resultOfSpend = await contract.getBuy(_tokenId, currentPrice)
  } else {
    let resultOfSpend = await contract.getBuy(currentPrice)
  }
  if (resultOfSpend.gt(targetAmount)) {
    return useLittle
      ? currentPrice
      : getLowestPrice(
          contract,
          targetAmount,
          _tokenId,
          currentPrice.minus(bigIncrement),
          true
        )
  }
  return getLowestPrice(
    contract,
    targetAmount,
    _tokenId,
    currentPrice,
    useLittle
  )
}

export function parseLogForStorage(_l) {
  let l = JSON.parse(JSON.stringify(_l))
  Object.keys(l).map((key, index) => {
    if (typeof l[key] === 'object' && l[key]._hex) {
      if (key === '_tokenId') {
        l[key] = l[key]._hex
      } else {
        let fuckBigNumberInEthersJS = new BigNumber(l[key]._hex)
        l[key] = (fuckBigNumberInEthersJS.toString(10)).padStart(64, '0')
      }
    }
  })
  return l
}

export function padBigNum (amount, format = 10) {
  if (amount.constructor === Array) {
    amount = amount[0]
  }
  amount = typeof amount === 'object' ? amount : new BigNumber(amount)
  if (amount.lt(0)) {
    console.log('negative number ' + amount.toString())
  }
  return amount.toString(format).padStart(64, '0')
}

export function toRes(res, status = 200) {
  return (err, thing) => {
    if (err) return res.status(500).send(err)

    if (thing && typeof thing.toObject === 'function') {
      thing = thing.toObject()
    }
    thing
      .toArray()
      .then(results => {
        res.status(status).json(results)
      })
      .error(console.log)
  }
}

export function toSVG(id, size = 400) {
  size = parseInt(size)
  return new Promise((resolve, reject) => {
    let green = '#01B463'
    let black = '#000000'
    let white = '#FFFFFF'
    let grey = '#808080'

    let r = new Reversi()
    // let svgPath = path.resolve(
    //   __dirname + '/../../public/svg/' + size + '/' + id + '.svg'
    // )

    r.byteBoardPopulateBoard(id)
    r.calcWinners()
    r.isSymmetrical()

    let fill, stroke, sequence
    let strokeWidth = 1
    let radius = size / 2

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
      fill = black
      stroke = black
    } else if (r.whiteScore > r.blackScore) {
      fill = white
      stroke = black
    } else {
      fill = grey
      stroke = grey
    }
    // if (r.symmetrical) {
    //   strokeWidth = 2
    //   stroke = green
    // }

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
      let row = Math.floor(i / 8)
      let col = i % 8
      switch (r.board[row][col]) {
        case r.BLACK:
          if (r.whiteScore < r.blackScore) continue
          fill = black
          stroke = 'none'
          break
        case r.WHITE:
          if (r.whiteScore > r.blackScore) continue
          fill = white
          stroke = 'none'
          break
        case r.EMPTY:
          fill = green
          stroke = 'none'
          break
        default:
          continue
      }
      let x = (row + 1) * (size / 12) + size / 8
      let y = (col + 1) * (size / 12) + size / 8
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
    svg += '</svg>'
    resolve(svg)

    // fs.outputFile(svgPath, svg, (err) => {
    //   if (err) {
    //     reject(err)
    //   } else {
    //     resolve()
    //   }
    // })
  })
}

// export function toPNG (id) {
//   return new Promise(async (resolve, reject) => {
//     try {
//       let svg = path.resolve(__dirname + '/../../public/svg/' + id + '.svg')
//       let png = path.resolve(__dirname + '/../../public/png/' + id + '.png')

//       if (!fs.existsSync(svg)) {
//         await toSVG(id)
//       }
//       await svg_to_png.convert(svg, png) // async, returns promise
//       resolve()
//     } catch (error) {
//       reject (error)
//     }
//   })
// }

export function sym(syms) {
  let RotSym = (syms >> 4) & (1 == 1)
  let Y0Sym = (syms >> 3) & (1 == 1)
  let X0Sym = (syms >> 2) & (1 == 1)
  let XYSym = (syms >> 1) & (1 == 1)
  let XnYSym = syms & (1 == 1)
  return {
    RotSym,
    Y0Sym,
    X0Sym,
    XYSym,
    XnYSym
  }
}
