import config from '../config.json'
import {
  Clovers,
  ClubToken,
  CloversController,
  SimpleCloversMarket,
  // CurationMarket,
  ClubTokenController
} from 'clovers-contracts'

var ethers = Object.assign(require('ethers'), require('ethers-contracts'))

// const ZeroClientProvider = require('web3-provider-engine/zero.js')
// import Web3 from 'web3'
export let iface = ethers.Interface
export let web3mode = false
ethers.apiToken = config.etherscanAPI
ethers.apiAccessToken = config.infuraAPI
var network = config.network
var providers = require('ethers').providers

var infuraProvider = new ethers.providers.InfuraProvider(network)
var etherscanProvider = new ethers.providers.EtherscanProvider(network)

export var jsonRpcProvider = new ethers.providers.JsonRpcProvider(
  'https://mainnet.infura.io/v3/e5b8088fe4df4a69a4b5f35c2561bbe0',
  network
)

var fallbackProvider = new ethers.providers.FallbackProvider([
  jsonRpcProvider,
  infuraProvider,
  etherscanProvider
])
export let provider = jsonRpcProvider // providers.getDefaultProvider(network)
// export let provider = fallbackProvider;
// export let provider = jsonRpcProvider;

// var web3Provider = ZeroClientProvider({
//   getAccounts: function() {},
//   rpcUrl: 'https://rinkeby.infura.io/v3/' + config.infuraKey
// })
// export var web3 = new Web3(web3Provider)

let simpleCloversMarketABI = SimpleCloversMarket.abi
let simpleCloversMarketAddress =
  SimpleCloversMarket.networks[network.chainId].address
let simpleCloversMarketInstance = new ethers.Contract(
  simpleCloversMarketAddress,
  simpleCloversMarketABI,
  provider
)


// let curationMarketABI = CurationMarket.abi
// let curationMarketAddress = CurationMarket.networks[network.chainId].address
// let curationMarketInstance = new ethers.Contract(
//   curationMarketAddress,
//   curationMarketABI,
//   provider
// )

let clubTokenControllerABI = ClubTokenController.abi
let clubTokenControllerAddress =
  ClubTokenController.networks[network.chainId].address
let clubTokenControllerInstance = new ethers.Contract(
  clubTokenControllerAddress,
  clubTokenControllerABI,
  provider
)

let cloversABI = Clovers.abi
let cloversAddress = Clovers.networks[network.chainId].address
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

const walletProvider = new ethers.Wallet(config.oraclePrivateKey, provider)

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
  // CurationMarket: {
  //   abi: curationMarketABI,
  //   address: curationMarketAddress,
  //   instance: curationMarketInstance,
  //   eventTypes: [
  //     'Transfer',
  //     // 'Mint',
  //     // 'Burn',
  //     'Buy',
  //     'Sell'
  //     // 'OwnershipTransferred'
  //   ]
  // },
  Clovers: {
    abi: cloversABI,
    address: cloversAddress,
    instance: cloversInstance,
    // web3instance: cloversWeb3Instance,
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
    // web3instance: clubTokenWeb3Instance,
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
