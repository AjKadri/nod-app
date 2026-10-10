"use strict";
/**
 * Test stand-in only: does what the Associated Token Account program does, without running it.
 *
 * Why: in LiteSVM (the Solana runtime the stand-in uses), executing the real Associated Token
 * Account program corrupts the JavaScript heap and the process dies a moment later with
 * `std::bad_alloc` (reproduced with litesvm 0.5, 0.8, 1.0, 1.4 and 1.6, on both simulate and send).
 * The SPL Token and Token-2022 programs run fine. So, for a transaction that has "create the
 * associated token account" instructions, this removes them from what LiteSVM executes and writes
 * the account they would have created, with the same owner, size and rent, and takes the same rent
 * from the payer. The phone's own code (what it builds and how it reads the result) is untouched,
 * and the real program is what runs on a real network.
 */
const bs58pkg = require("bs58");
const { Message, MessageV0, PublicKey, VersionedTransaction } = require("@solana/web3.js");

const bs58 = bs58pkg.default || bs58pkg;

const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

function writeU64(buffer, offset, value) {
  let rest = BigInt(value);
  for (let i = 0; i < 8; i += 1) {
    buffer[offset + i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
}

/** The bytes of a freshly created associated token account, as the token program lays them out. */
function newTokenAccountData({ mint, owner, tokenProgram }) {
  // Token-2022 associated accounts carry the ImmutableOwner extension: 165 + account type + a 4 byte header.
  const data = Buffer.alloc(tokenProgram === TOKEN_2022_PROGRAM_ID ? 170 : 165);
  new PublicKey(mint).toBuffer().copy(data, 0);
  new PublicKey(owner).toBuffer().copy(data, 32);
  writeU64(data, 64, 0n);
  data[108] = 1; // initialized
  if (tokenProgram === TOKEN_2022_PROGRAM_ID) {
    data[165] = 2; // account type: token account
    data.writeUInt16LE(7, 166); // extension: ImmutableOwner
    data.writeUInt16LE(0, 168);
  }
  return data;
}

function rebuild(message, keep) {
  if (message.version === "legacy" || message instanceof Message) {
    return new Message({
      header: message.header,
      accountKeys: message.accountKeys,
      recentBlockhash: message.recentBlockhash,
      instructions: message.instructions.filter((_ix, index) => keep(index)),
    });
  }
  return new MessageV0({
    header: message.header,
    staticAccountKeys: message.staticAccountKeys,
    recentBlockhash: message.recentBlockhash,
    compiledInstructions: message.compiledInstructions.filter((_ix, index) => keep(index)),
    addressTableLookups: message.addressTableLookups,
  });
}

/**
 * @param svm a LiteSVM
 * @param {VersionedTransaction} transaction
 * @returns {{ transaction: VersionedTransaction, shimmed: boolean, undo: () => void }}
 *   `transaction` is what LiteSVM should run. Its signatures no longer match, so the caller must
 *   run it with signature checks off. `undo()` puts back everything the shim wrote (simulation, or a
 *   transaction that then failed).
 */
function withoutAtaInstructions(svm, transaction) {
  const message = transaction.message;
  const keys = message.staticAccountKeys || message.accountKeys;
  const instructions = message.compiledInstructions;
  const ataIndexes = [];
  instructions.forEach((ix, index) => {
    const program = keys[ix.programIdIndex];
    if (program && program.toBase58() === ATA_PROGRAM_ID) ataIndexes.push(index);
  });
  if (ataIndexes.length === 0) return { transaction, shimmed: false, undo() {} };

  const restores = [];
  const remember = (address) => {
    const account = svm.getAccount(address);
    restores.push({
      address,
      account: account ? { lamports: BigInt(account.lamports), data: new Uint8Array(account.data), owner: new PublicKey(account.owner), executable: !!account.executable } : null,
    });
  };

  const skipped = new Set();
  for (const index of ataIndexes) {
    const ix = instructions[index];
    const at = (n) => keys[ix.accountKeyIndexes[n]];
    // Only the six-account form that wallets and Nod build (payer, account, owner, mint, system, token program).
    if (ix.accountKeyIndexes.length < 6 || at(4).toBase58() !== SYSTEM_PROGRAM_ID) continue;
    const tokenProgram = at(5).toBase58();
    if (tokenProgram !== TOKEN_PROGRAM_ID && tokenProgram !== TOKEN_2022_PROGRAM_ID) continue;
    const ata = at(1);
    const payer = at(0);
    const existing = svm.getAccount(ata);
    if (existing && Number(existing.lamports) > 0) {
      skipped.add(index); // already there: the idempotent form does nothing
      continue;
    }
    const data = newTokenAccountData({ mint: at(3), owner: at(2), tokenProgram });
    const rent = svm.minimumBalanceForRentExemption(BigInt(data.length));
    const payerAccount = svm.getAccount(payer);
    if (!payerAccount || BigInt(payerAccount.lamports) < rent) continue; // cannot pay: leave it out, the rest of the transaction will fail
    remember(payer);
    remember(ata);
    svm.setAccount(payer, {
      lamports: BigInt(payerAccount.lamports) - rent,
      data: new Uint8Array(payerAccount.data),
      owner: new PublicKey(payerAccount.owner),
      executable: !!payerAccount.executable,
    });
    svm.setAccount(ata, { lamports: rent, data: new Uint8Array(data), owner: new PublicKey(tokenProgram), executable: false });
    skipped.add(index);
  }
  if (skipped.size === 0) return { transaction, shimmed: false, undo() {} };

  const rewritten = new VersionedTransaction(rebuild(message, (index) => !skipped.has(index)), transaction.signatures);
  return {
    transaction: rewritten,
    shimmed: true,
    undo() {
      for (const { address, account } of restores.reverse()) {
        svm.setAccount(
          address,
          account || { lamports: 0n, data: new Uint8Array(), owner: new PublicKey(SYSTEM_PROGRAM_ID), executable: false },
        );
      }
    },
  };
}

module.exports = { withoutAtaInstructions, newTokenAccountData, bs58 };
