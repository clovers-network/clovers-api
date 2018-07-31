import { iface, provider, events } from "./lib/ethers-utils";

import * as clovers from "./models/clovers";
import * as clubToken from "./models/clubToken";
import * as cloversController from "./models/cloversController";

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
};

function beginListen (contract, key = 0) {
  let eventTypes = events[contract].eventTypes
  if (key > eventTypes.length - 1) return
  beginListen(contract, key + 1)
  let eventType = events[contract].instance.interface.events[eventTypes[key]]
  if (!eventType) return
  provider.on(eventType.topic, (log) => {
    console.log('got an event')
    try {
      let event = events[contract].abi.find(a => a.name === eventType().name);
      let names = event.inputs.map(o => o.name);
      let types = event.inputs.map(o => o.type);
      let decoded = iface.decodeParams(names, types, log.data);
      log.data = decoded;
      log.name = contract + "_" + eventType.name;
      console.log(log);
      r.db("clovers_v2")
        .table("logs")
        .insert(log)
        .run(db, (err, results) => {
          if (err) throw new Error(err);
          handleEvent({ io, db, log });
        });
    } catch (err) {
      console.log("didnt work");
      console.error(err);
    }
  });
}

export var handleEvent = function({ io, db, log }) {
  io && io.emit("addEvent", log);
  console.log(log.name);
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
