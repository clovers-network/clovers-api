import r from "rethinkdb";
import utils from "web3-utils";
import BigNumber from "bignumber.js";
import { padBigNum } from "../lib/util";

// event updatePrice(uint256 _tokenId, uint256 price);
export let simpleCloversMarketUpdatePrice = async function({ log, io, db }) {
  console.log(log.name + " called");
  let _tokenId = log.data._tokenId;
  await changeCloverPrice(_tokenId, log);
};

export let simpleCloversMarketOwnershipTransferred = async function({
  log,
  io,
  db
}) {
  console.log(log.name + " does not affect the database");
};

function changeCloverPrice(_tokenId, log) {
  return new Promise((resolve, reject) => {
    let price = log.data.price;
    price = typeof price == "object" ? price : new BigNumber(price);

    r.db("clovers_v2")
      .table("clovers")
      .get(_tokenId)
      .run(db, (err, clover) => {
        if (err) return reject(err);

        clover.price = padBigNum(price.toString(16));
        clover.modified = log.blockNumber;

        r.db("clovers_v2")
          .table("clover")
          .get(_tokenId)
          .update(clover)
          .run(db, (err, result) => {
            if (err) return reject(err);
            io && io.emit("updateClover", clover);
            resolve();
          });
      });
  });
}
