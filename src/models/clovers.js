import r from "rethinkdb";
import { events } from "../lib/ethers-utils";
import { sym, padBigNum } from "../lib/util";

export const cloversTransfer = ({ log, io, db }) => {
  return Promise.all([
    // update the clover
    new Promise(async (resolve, reject) => {
      if (log.data._from === "0x0000000000000000000000000000000000000000") {
        try {
          let cloverMoves = await events.Clovers.instance.getCloverMoves(
            log.data._tokenId
          );
          let cloverReward = await events.Clovers.instance.getReward(
            log.data._tokenId
          );
          let cloverSymmetries = await events.Clovers.instance.getSymmetries(
            log.data._tokenId
          );
          let cloverBlock = await events.Clovers.instance.getBlockMinted(
            log.data._tokenId
          );
          let price = await events.SimpleCloversMarket.instance.sellPrice(
            log.data._tokenId
          );
          // var cloverURI = await events.Clovers.instance.tokenURI(log.data._tokenId)

          let clover = {
            name: log.data._tokenId,
            board: log.data._tokenId,
            owner: log.data._to,
            moves: cloverMoves,
            reward: padBigNum(cloverReward),
            symmetries: sym(cloverSymmetries),
            created: Number(cloverBlock),
            modified: Number(cloverBlock),
            // store price as hex, padded for sorting/filtering in DB
            price: padBigNum(price)
          };

          r.db("clovers_v2")
            .table("clovers")
            .insert(clover)
            .run(db, (err, result) => {
              if (err) return reject(err);
              io && io.emit("addClover", clover);
              resolve();
            });
        } catch (error) {
          reject(error);
        }
      } else {
        r.db("clovers_v2")
          .table("clovers")
          .get(log.data._tokenId)
          .run(db, (err, clover) => {
            if (err) return reject(err);
            if (!clover)
              return reject("clover " + log.data._tokenId + " not found");
            clover.owner = log.data._to;
            clover.modified = log.blockNumber;

            r.db("clovers_v2")
              .table("clovers")
              .get(log.data._tokenId)
              .update(clover)
              .run(db, (err, result) => {
                if (err) return reject(err);
                io && io.emit("updateClover", clover);
                r.db("clovers_v2")
                  .table("users")
                  .get(log.data._from)
                  .run(db, (err, user) => {
                    if (user) {
                      user.clovers.splice(
                        user.clovers.indexOf(log.data._tokenId),
                        1
                      );
                      user.modified = log.blockNumber;
                      r.db("clovers_v2")
                        .table("users")
                        .get(log.data._to)
                        .update(user)
                        .run(db, (err, result) => {
                          if (err) return reject(err);
                          io && io.emit("updateUser", user);
                          resolve();
                        });
                    } else {
                      // this should not happen
                      reject(
                        new Error(
                          "looking for user " +
                            log.data._from +
                            " but not found"
                        )
                      );
                    }
                  });
              });
          });
      }
    }),
    // update the user
    new Promise((resolve, reject) => {
      r.db("clovers_v2")
        .table("users")
        .get(log.data._to)
        .run(db, (err, user) => {
          if (user) {
            user.modified = log.blockNumber;
            user.clovers.push(log.data._tokenId);
            r.db("clovers_v2")
              .table("users")
              .get(log.data._to)
              .update(user)
              .run(db, (err, result) => {
                if (err) return reject(err);
                io && io.emit("updateUser", user);
                resolve();
              });
          } else {
            user = {
              name: log.data._to,
              address: log.data._to,
              clovers: [log.data._tokenId],
              created: log.blockNumber,
              modified: log.blockNumber
            };
            r.db("clovers_v2")
              .table("users")
              .insert(user)
              .run(db, (err, result) => {
                if (err) return reject(err);
                io && io.emit("addUser", user);
                resolve();
              });
          }
        });
    })
  ]);
};
export const cloversApproval = async function({ log, io, db }) {
  console.log(log.name + " does not affect the database");
};
export const cloversApprovalForAll = async function({ log, io, db }) {
  console.log(log.name + " does not affect the database");
};
export const cloversOwnershipTransferred = async function({ log, io, db }) {
  console.log(log.name + " does not affect the database");
};
