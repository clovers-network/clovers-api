import config from "../config";
import {
  Clovers,
  ClubToken,
  CloversController,
  SimpleCloversMarket,
  CurationMarket
} from "clovers-contracts";
var ethers = Object.assign(require("ethers"), require("ethers-contracts"));

const ZeroClientProvider = require("web3-provider-engine/zero.js");
import Web3 from "web3";
export let iface = ethers.Interface;
export let web3mode = false;
ethers.apiToken = config.etherscanAPI;
ethers.apiAccessToken = config.infuraAPI;
var network = ethers.providers.networks.rinkeby;
var providers = require("ethers").providers;

var infuraProvider = new ethers.providers.InfuraProvider(network);
var etherscanProvider = new ethers.providers.EtherscanProvider(network);

export var jsonRpcProvider = new ethers.providers.JsonRpcProvider(
  "http://localhost:7545",
  ethers.providers.networks.unspecified
);

var fallbackProvider = new ethers.providers.FallbackProvider([
  infuraProvider,
  etherscanProvider
  // jsonRpcProvider
]);
export let provider = providers.getDefaultProvider(network);
// export let provider = fallbackProvider;
// export let provider = jsonRpcProvider;

var web3Provider = ZeroClientProvider({
  getAccounts: function() {},
  rpcUrl: "https://rinkeby.infura.io/v3/" + config.infuraKey
});
export var web3 = new Web3(web3Provider);

let simpleCloversMarketABI = SimpleCloversMarket.abi;
let simpleCloversMarketAddress =
  SimpleCloversMarket.networks[config.networkId].address;
let simpleCloversMarketInstance = new ethers.Contract(
  simpleCloversMarketAddress,
  simpleCloversMarketABI,
  provider
);

let curationMarketABI = CurationMarket.abi;
let curationMarketAddress = CurationMarket.networks[config.networkId].address;
let curationMarketInstance = new ethers.Contract(
  curationMarketAddress,
  curationMarketABI,
  provider
);

let cloversABI = Clovers.abi;
let cloversAddress = Clovers.networks[config.networkId].address;
let cloversInstance = new ethers.Contract(cloversAddress, cloversABI, provider);
let _clovers = web3.eth.contract(cloversABI);
let cloversWeb3Instance = _clovers.at(cloversAddress);

let clubTokenABI = ClubToken.abi;
let clubTokenAddress = ClubToken.networks[config.networkId].address;
let clubTokenInstance = new ethers.Contract(
  clubTokenAddress,
  clubTokenABI,
  provider
);
let _clubToken = web3.eth.contract(clubTokenABI);
let clubTokenWeb3Instance = _clubToken.at(clubTokenAddress);

let cloversControllerABI = CloversController.abi;
let cloversControllerAddress =
  CloversController.networks[config.networkId].address;
let cloversControllerInstance = new ethers.Contract(
  cloversControllerAddress,
  cloversControllerABI,
  provider
);
let _cloversController = web3.eth.contract(cloversControllerABI);
let cloversControllerWeb3Instance = _cloversController.at(
  cloversControllerAddress
);

export let events = {
  SimpleCloversMarket: {
    abi: simpleCloversMarketABI,
    address: simpleCloversMarketAddress,
    instance: simpleCloversMarketInstance,
    eventTypes: ["updatePrice", "OwnershipTransferred"]
  },
  CurationMarket: {
    abi: curationMarketABI,
    address: curationMarketAddress,
    instance: curationMarketInstance,
    eventTypes: ["Transfer", "Mint", "Burn", "OwnershipTransferred"]
  },
  Clovers: {
    abi: cloversABI,
    address: cloversAddress,
    instance: cloversInstance,
    // web3instance: cloversWeb3Instance,
    eventTypes: [
      "Transfer",
      "Approval",
      "ApprovalForAll",
      "OwnershipTransferred"
    ]
  },
  ClubToken: {
    abi: clubTokenABI,
    address: clubTokenAddress,
    instance: clubTokenInstance,
    // web3instance: clubTokenWeb3Instance,
    eventTypes: ["Burn", "Mint", "Approval", "Transfer", "OwnershipTransferred"]
  },
  CloversController: {
    abi: cloversControllerABI,
    address: cloversControllerAddress,
    instance: cloversControllerInstance,
    // web3instance: cloversControllerWeb3Instance,
    eventTypes: [
      "cloverCommitted",
      "cloverClaimed",
      // "stakeAndRewardRetrieved",
      // "cloverChallenged",
      // "stakeRetrieved",
      "OwnershipTransferred"
    ]
  }
};
