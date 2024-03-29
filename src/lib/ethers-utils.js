import config from '../config.json'
import {
  Clovers,
  ClubToken,
  CloversController,
  SimpleCloversMarket,
  ClubTokenController
} from 'clovers-contracts'

export var ethers = require('ethers')

export let iface = ethers.Interface
export let web3mode = false

ethers.apiToken = config.etherscanAPI
ethers.apiAccessToken = config.infuraAPI
var network = config.network

// export let provider = ethers.getDefaultProvider(network.name);
// export let provider = new ethers.providers.JsonRpcProvider('http://localhost:8545');
// export let provider = new ethers.providers.JsonRpcProvider('https://cloudflare-eth.com');
export let provider = new ethers.providers.JsonRpcProvider('http://138.68.85.68:8545'); // eth-node

let simpleCloversMarketABI = SimpleCloversMarket.abi
let simpleCloversMarketAddress =
  SimpleCloversMarket.networks[network.chainId].address
let simpleCloversMarketInstance = new ethers.Contract(
  simpleCloversMarketAddress,
  simpleCloversMarketABI,
  provider
)


let clubTokenControllerABI = ClubTokenController.abi
let clubTokenControllerAddress =
  ClubTokenController.networks[network.chainId].address
let clubTokenControllerInstance = new ethers.Contract(
  clubTokenControllerAddress,
  clubTokenControllerABI,
  provider
)

let cloversABI = Clovers.abi
export let cloversAddress = Clovers.networks[network.chainId].address
let cloversInstance = new ethers.Contract(cloversAddress, cloversABI, provider)
// let _clovers = web3.eth.contract(cloversABI)
// let cloversWeb3Instance = _clovers.at(cloversAddress)

let clubTokenABI = ClubToken.abi
let clubTokenAddress = ClubToken.networks[network.chainId].address
let clubTokenInstance = new ethers.Contract(
  clubTokenAddress,
  clubTokenABI,
  provider
)
// let _clubToken = web3.eth.contract(clubTokenABI)
// let clubTokenWeb3Instance = _clubToken.at(clubTokenAddress)

let cloversControllerABI = CloversController.abi
let cloversControllerAddress =
  CloversController.networks[network.chainId].address
let cloversControllerInstance = new ethers.Contract(
  cloversControllerAddress,
  cloversControllerABI,
  provider
)
// let _cloversController = web3.eth.contract(cloversControllerABI)
// let cloversControllerWeb3Instance = _cloversController.at(
//   cloversControllerAddress
// )

export const walletProvider = new ethers.Wallet(config.oraclePrivateKey, provider)

export let wallet = {
  CloversController: new ethers.Contract(
    cloversControllerAddress,
    cloversControllerABI,
    walletProvider
  )
}

export let events = {
  SimpleCloversMarket: {
    abi: simpleCloversMarketABI,
    address: simpleCloversMarketAddress,
    instance: simpleCloversMarketInstance,
    eventTypes: [
      'updatePrice'
      // 'OwnershipTransferred'
    ]
  },
  Clovers: {
    abi: cloversABI,
    address: cloversAddress,
    instance: cloversInstance,
    eventTypes: [
      'Transfer'
      // 'Approval',
      // 'ApprovalForAll',
      // 'OwnershipTransferred'
    ]
  },
  ClubToken: {
    abi: clubTokenABI,
    address: clubTokenAddress,
    instance: clubTokenInstance,
    eventTypes: [
      // 'Burn',
      // 'Mint',
      // 'Approval',
      'Transfer'
      //'OwnershipTransferred'
    ]
  },
  ClubTokenController: {
    abi: clubTokenControllerABI,
    address: clubTokenControllerAddress,
    instance: clubTokenControllerInstance,
    eventTypes: [
      'Buy',
      'Sell'
      // 'OwnershipTransferred'
      // 'Transfer'
    ]
  },
  CloversController: {
    abi: cloversControllerABI,
    address: cloversControllerAddress,
    instance: cloversControllerInstance,
    // web3instance: cloversControllerWeb3Instance,
    eventTypes: [
      // 'cloverCommitted',
      // 'cloverClaimed'
      // "stakeAndRewardRetrieved",
      // "cloverChallenged",
      // "stakeRetrieved",
      // 'OwnershipTransferred'
    ]
  }
}
