import r from "rethinkdb";
import utils from "web3-utils";
import BigNumber from "bignumber.js";
import { padBigNum } from "../lib/util";

// event Burn(uint256 _tokenId, address indexed burner, uint256 value);
export let curationMarketBurn = async function({ log, io, db }) {
  console.log(log.name + " called");
  let _tokenId = log.data._tokenId;
  let user = log.data.burner;
  let amount = log.data.value;
  await changeUserBalance(user, amount, _tokenId, "sub", log);
};

// event Mint(uint256 _tokenId, address indexed to, uint256 amount);
export let curationMarketMint = async function({ log, io, db }) {
  console.log(log.name + " called");
  let _tokenId = log.data._tokenId;
  let user = log.data.to;
  let amount = log.data.amount;
  await changeUserBalance(user, amount, _tokenId, "add", log);
};

// event Transfer(uint256 _tokenId, address indexed from, address indexed to, uint256 value);
export let curationMarketTransfer = async function({ log, io, db }) {
  console.log(log.name + " called");
  let _tokenId = log.data._tokenId;
  let from = log.data.from;
  let to = log.data.to;
  let amount = new BigNumber(log.data.vaulue);
  // get the user who is sending the token and remove to their balance
  await changeUserBalance(from, amount, _tokenId, "sub", log);
  // get the user who is receiving the token and add to their balance
  await changeUserBalance(to, amount, _tokenId, "add", log);
};
export let curationMarketOwnershipTransferred = async function({
  log,
  io,
  db
}) {
  console.log(log.name + " does not affect the database");
};

function changeUserBalance(user_id, amount, _tokenId, add, log) {
  return new Promise((resolve, reject) => {
    amount = typeof amount == "object" ? amount : new BigNumber(amount);
    add = add == "add";
    r.db("clovers_v2")
      .table("users")
      .get(user_id)
      .run(db, (err, user) => {
        if (err) return reject(err);
        if (!user.curationMarket[_tokenId]) {
          user.curationMarket[_tokenId] = "0x0";
        }
        user.curationMarket[_tokenId] = padBigNum(
          add
            ? new BigNumber(user.curationMarket[_tokenId])
                .add(amount)
                .toString(16)
            : new BigNumber(user.curationMarket[_tokenId])
                .sub(amount)
                .toString(16)
        );
        user.modified = log.blockNumber;

        r.db("clovers_v2")
          .table("users")
          .get(user_id)
          .update(user)
          .run(db, (err, result) => {
            if (err) return reject(err);
            io && io.emit("updateUser", user);
            resolve();
          });
      });
  });
}
