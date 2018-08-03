import { provider, events } from "./lib/ethers-utils";
import ethers from "ethers";
import * as clovers from "./models/clovers";
import * as clubToken from "./models/clubToken";
import * as cloversController from "./models/cloversController";
import { parseLogForStorage } from "./lib/util";
import r from "rethinkdb";

let io, db;

export var socketing = function({ _io, _db }) {
  io = _io;
  db = _db;
  var connections = 0;
  io.on("connection", function(socket) {
    connections += 1;
    console.log("opened, now " + connections + " connections");

    socket.on("data", function(data) {
      console.log(data);
    });
    socket.on("disconnect", function() {
      connections -= 1;
      console.log("closed, now " + connections + " connections");
    });
    socket.on("error", function(err) {
      console.log("error");
    });
  });
  beginListen("Clovers");
  beginListen("ClubToken");
  beginListen("CloversController");
  beginListen("SimpleCloversMarket");
  beginListen("CurationMarket");
};

async function beginListen(contract, key = 0) {
  let eventTypes = events[contract].eventTypes;
  if (key > eventTypes.length - 1) return;
  beginListen(contract, key + 1);
  let eventType = events[contract].instance.interface.events[eventTypes[key]];
  if (!eventType) return;
  // let listen = "on" + eventType().name.toLowerCase();
  // events[contract].instance[listen] = (...log) => {
  //   console.log("!!!!!");
  //   console.log(log);
  // };
  // var address =
  //   "0x000000000000000000000000" + events[contract].address.substring(2);
  let topics = eventType().topics;
  // topics.push(address);
  console.log("make a listener on ", eventType().name);
  provider.on(topics, log => {
    let address = events[contract].address;
    if (log.address.toLowerCase() !== address.toLowerCase()) {
      return;
    }
    let abi = events[contract].abi;
    let iface = new ethers.Interface(abi);

    log.name = contract + "_" + eventType().name;

    let transferCoder = iface.events[eventTypes[key]];
    log.data = transferCoder.parse(log.topics, log.data);
    if (false) {
      let event = events[contract].abi.find(a => a.name === eventType().name);
      let names = event.inputs.map(o => o.name);
      let types = event.inputs.map(o => o.type);
      log.data = iface.decodeParams(names, types, log.data);
    } else {
      try {
        let transferCoder = iface.events[eventTypes[key]];
        log.data = transferCoder.parse(log.topics, log.data);
      } catch (err) {
        if (err.message.indexOf("invalid arrayify value") == -1) {
          console.log("didnt work");
          console.log(log);
          console.error(err);
        } else {
          // console.log("why invalid arrify?");
        }
      }

      log.data = parseLogForStorage(log.data);
      r.db("clovers_v2")
        .table("logs")
        .insert(log)
        .run(db, (err, results) => {
          console.log((err ? "ERROR " : "SUCCESS ") + "saving " + log.name);
          if (err) throw new Error(err);
          handleEvent({ io, db, log });
        });
    }
  });
}

export var handleEvent = function({ io, db, log }) {
  io && io.emit("addEvent", log);
  console.log("handleEvent " + log.name);
  let foo = log.name.split("_");
  let contract = foo[0];
  let name = foo[1];
  try {
    switch (contract) {
      case "Clovers":
        switch (name) {
          case "Transfer":
            return clovers.cloversTransfer({ log, io, db });
            break;
          case "Approval":
            return clovers.cloversApproval({ log, io, db });
            break;
          case "ApprovalForAll":
            return clovers.cloversApprovalForAll({ log, io, db });
            break;
          case "OwnershipTransferred":
            return clovers.cloversOwnershipTransferred({ log, io, db });
            break;
          default:
            return new Error("Event " + name + " not found");
        }
        break;
      case "ClubToken":
        switch (name) {
          case "Burn":
            return clubToken.clubTokenBurn({ log, io, db });
            break;
          case "Mint":
            return clubToken.clubTokenMint({ log, io, db });
            break;
          case "Approval":
            return clubToken.clubTokenApproval({ log, io, db });
            break;
          case "Transfer":
            return clubToken.clubTokenTransfer({ log, io, db });
            break;
          case "OwnershipTransferred":
            return clubToken.clubTokenOwnershipTransferred({ log, io, db });
            break;
          default:
            return new Error("Event " + name + " not found");
        }
        break;
      case "SimpleCloversMarket":
        switch (name) {
          case "UpdatePrice":
            return simpleCloversMarket.simpleCloversMarketUpdatePrice({
              log,
              io,
              db
            });
            break;
          case "OwnershipTransferred":
            return simpleCloversMarket.simpleCloversMarketOwnershipTransferred({
              log,
              io,
              db
            });
            break;
          default:
            return new Error("Event " + name + " not found");
        }
        break;
      case "CurationMarket":
        switch (name) {
          case "Burn":
            return curationMarket.curationMarketBurn({ log, io, db });
            break;
          case "Mint":
            return curationMarket.curationMarketMint({ log, io, db });
            break;
          case "Transfer":
            return curationMarket.curationMarketTransfer({ log, io, db });
            break;
          case "OwnershipTransferred":
            return curationMarket.curationMarketOwnershipTransferred({
              log,
              io,
              db
            });
            break;
          default:
            return new Error("Event " + name + " not found");
        }
        break;
      case "CloversController":
        switch (name) {
          case "cloverCommitted":
            return cloversController.cloversControllerCloverCommitted({
              log,
              io,
              db
            });
            break;
          case "cloverClaimed":
            return cloversController.cloversControllerCloverClaimed({
              log,
              io,
              db
            });
            break;
          case "stakeAndRewardRetrieved":
            return cloversController.cloversControllerStakeAndRewardRetrieved({
              log,
              io,
              db
            });
            break;
          case "cloverChallenged":
            return cloversController.cloversControllerCloverChallenged({
              log,
              io,
              db
            });
            break;
          case "OwnershipTransferred":
            return cloversController.cloversControllerOwnershipTransferred({
              log,
              io,
              db
            });
            break;
          default:
            return new Error("Event " + name + " not found");
        }
        break;
      default:
        return new Error("Contract " + contract + " not found");
    }
  } catch (error) {
    console.log("error!!!");
    console.log(error);
  }
};
