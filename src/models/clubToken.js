import r from "rethinkdb";

export let clubTokenBurn = async function({ log, io, db }) {
  console.log(log.name + " called");
  let user = log.data.burner;
  let amount = log.data.value;
  await changeUserBalance(user, amount, "sub", log);
};
export let clubTokenMint = async function({ log, io, db }) {
  console.log(log.name + " called");
  let user = log.data.burner;
  let amount = log.data.value;
  await changeUserBalance(user, amount, "add", log);
};
export let clubTokenApproval = async function({ log, io, db }) {
  console.log(log.name + " does not affect the database");
};
// event Transfer(address indexed from, address indexed to, uint256 value);
export let clubTokenTransfer = async function({ log, io, db }) {
  console.log(log.name + " called");
  let from = log.data.from;
  let to = log.data.to;
  let amount = log.data.value;
  await changeUserBalance(to, amount, "add", log);
  await changeUserBalance(from, amount, "sub", log);
};
export let clubTokenOwnershipTransferred = async function({ log, io, db }) {
  console.log(log.name + " does not affect the database");
};

function changeUserBalance(user_id, amount, add, log) {
  return new Promise((resolve, reject) => {
    amount = typeof amount == "object" ? amount : new BigNumber(amount);
    add = add == "add";
    r.db("clovers_v2")
      .table("users")
      .get(user_id)
      .run(db, (err, user) => {
        if (err) return reject(err);
        user.balance = padBigNum(
          add
            ? new BigNumber(user.balance).add(amount).toString(16)
            : new BigNumber(user.balance).sub(amount).toString(16)
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

