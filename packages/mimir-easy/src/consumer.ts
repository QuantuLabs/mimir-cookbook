import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { decodeV1ClassicFeed } from "@quantulabs/mimir-sdk/v1";
import { decodeFeedSnapshotHeader } from "@quantulabs/mimir-sdk";
import {
  connectWallet,
  refreshInstructions,
  signAndSend,
  type MimirWallet,
  type PreparedTransaction,
} from "./index.ts";

export { Connection, connectWallet, signAndSend };
export type { MimirWallet };

/**
 * The settings every app reads. Defaults: mainnet and the SOL/USDC Mimir feed.
 * The consumer program, its CPMM pool and the lookup table are yours to deploy and set.
 */
export const demo = {
  rpc: import.meta.env?.VITE_RPC_URL || "https://api.mainnet-beta.solana.com",
  feed: import.meta.env?.VITE_FEED || "F5fXuWuVFwBF3eBVtFkxXS5PMY651uVQ1bL4W4mse5Qj",
  program: import.meta.env?.VITE_CONSUMER || "",
  pool: import.meta.env?.VITE_POOL || "",
  lookup: import.meta.env?.VITE_LOOKUP || "",
};

export const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const MIMIR_PROGRAM = "hBYrGHXVCQsnduDERkVnViCXNYawpHCvN5y3GsMiMiR";
export const USDC_DECIMALS = 6;
const RECEIPT_SIZE = 40;
const MAX_COMPUTE_UNITS = 1_400_000;

/** Instruction tags understood by programs/mimir-cookbook (first byte of the instruction data). */
export const Tag = {
  MimirBorrow: 0,
  ProtectedFill: 1,
  SpotLender: 2,
  Repay: 3,
  Release: 4,
} as const;
export type ConsumerTag = (typeof Tag)[keyof typeof Tag];
type BorrowTag = typeof Tag.MimirBorrow | typeof Tag.SpotLender;
type SettleTag = typeof Tag.Repay | typeof Tag.Release;

/** Byte offsets in the Mimir feed snapshot, read by the freshness check. */
const Snapshot = {
  revision: 96,
  status: 104,
  routeability: 105,
  validFromSlot: 116,
  validUntilSlot: 124,
  lowerBoundLow: 216,
  lowerBoundHigh: 224,
  quoteStatus: 257,
} as const;
const STATUS_OK = 0;
const ROUTEABILITY_LIMIT = 4;

/** Byte layout of a Raydium CPMM pool account, used by the spot lender. */
const CpmmPool = {
  size: 637,
  discriminator: [247, 237, 227, 245, 215, 195, 222, 70],
  vault0: 72,
  vault1: 104,
  mint0: 168,
  mint1: 200,
} as const;

/** Error codes returned by programs/mimir-cookbook, with a readable reason. */
const CONSUMER_REASONS: Record<number, string> = {
  1: "price is not Fresh",
  2: "above the collateral limit",
  3: "outside the price bound",
  4: "feed or account binding refused",
};

/** A Mimir price read from a feed snapshot, in USDC per token. */
export type Price = {
  fresh: boolean;
  price: number;
  lower: number;
  upper: number;
  confidence: number;
  slot: number;
  base: string;
  decimals: number;
  ticker: string;
};

/** The result of a simulation, as returned by the `simulateTransaction` RPC method. */
type Simulation = {
  context: { slot: number };
  value: {
    err: any;
    logs: string[];
    unitsConsumed: number;
    accounts: any[];
    returnData?: { programId: string; data: [string, string] };
  };
};

/** A transaction ready to sign, with its simulation. */
type CheckedTransaction = { tx: PreparedTransaction; simulation: Simulation };

/** Turns a base58 string into a PublicKey. */
function toKey(address: string): PublicKey {
  return new PublicKey(address);
}

/** Converts a Q64.64 fixed-point value to a JavaScript number. */
export function q64(value: bigint): number {
  return Number(value >> 32n) / 2 ** 32;
}

/** Reads the feed's ticker: one length byte, then the characters. */
function readTicker(tickerBytes: Uint8Array): string {
  const length = Math.min(tickerBytes[0] ?? 0, tickerBytes.length - 1);
  return String.fromCharCode(...tickerBytes.subarray(1, 1 + length));
}

/** Reads the base token mint and its decimals from the feed definition. */
function readFeedToken(feedData: Uint8Array) {
  const definition = decodeV1ClassicFeed(feedData).definition;
  const feedImage = definition.feedImage;
  return {
    mint: new PublicKey(feedImage.slice(48, 80)),
    decimals: feedImage[118]!,
    ticker: readTicker(definition.ticker),
  };
}

/** Same predicate as the program's fresh_at(): revision, status, routeability, quote status,
 * slot window, and a non-zero lower bound. */
function isFresh(feedData: Uint8Array, slot: number): boolean {
  const data = Buffer.from(feedData);
  const currentSlot = BigInt(slot);
  const lowerBound =
    data.readBigUInt64LE(Snapshot.lowerBoundLow) | data.readBigUInt64LE(Snapshot.lowerBoundHigh);
  const hasRevision = data.readBigUInt64LE(Snapshot.revision) > 0n;
  const statusOk = data[Snapshot.status] === STATUS_OK;
  const routeable = data[Snapshot.routeability]! < ROUTEABILITY_LIMIT;
  const quoteOk = data[Snapshot.quoteStatus] === STATUS_OK;
  const notExpired = data.readBigUInt64LE(Snapshot.validUntilSlot) >= currentSlot;
  const alreadyValid = data.readBigUInt64LE(Snapshot.validFromSlot) <= currentSlot;
  return (
    hasRevision && statusOk && routeable && quoteOk && notExpired && alreadyValid && lowerBound > 0n
  );
}

/** Decodes a feed account into a price, its bounds and whether it is Fresh at `slot`. */
export function snapshot(feedData: Uint8Array, slot: number): Price {
  const header = decodeFeedSnapshotHeader(decodeV1ClassicFeed(feedData).prefix);
  const token = readFeedToken(feedData);
  return {
    fresh: isFresh(feedData, slot),
    price: q64(header.priceX64),
    lower: q64(header.priceLowerX64),
    upper: q64(header.priceUpperX64),
    confidence: header.confidenceBps,
    slot,
    base: token.mint.toBase58(),
    decimals: token.decimals,
    ticker: token.ticker,
  };
}

/** The associated token account of `owner` for `mint` (owner may be a PDA). */
export function ata(owner: string, mint: PublicKey): PublicKey {
  const allowOwnerOffCurve = true;
  return getAssociatedTokenAddressSync(mint, toKey(owner), allowOwnerOffCurve);
}

/** The vault PDA of the consumer program for one feed and one instruction tag. */
export function vaultAddress(tag: 0 | 1 | 2, feed = demo.feed): PublicKey {
  const seeds = [Buffer.from("vault"), toKey(feed).toBuffer(), Buffer.from([tag])];
  const [address] = PublicKey.findProgramAddressSync(seeds, toKey(demo.program));
  return address;
}

/** The position PDA that records one user's collateral and debt for one feed. */
export function positionAddress(user: string, feed = demo.feed): PublicKey {
  const seeds = [Buffer.from("position"), toKey(feed).toBuffer(), toKey(user).toBuffer()];
  const [address] = PublicKey.findProgramAddressSync(seeds, toKey(demo.program));
  return address;
}

/** Converts a token amount to atoms, using the mint decimals. */
export function atoms(amount: number, decimals: number): bigint {
  return BigInt(Math.round(amount * 10 ** decimals));
}

/** Turns any error into a readable message.
 * The public mainnet endpoint refuses browser requests: say so. */
export function explain(error: unknown): string {
  if (/\b403\b|Access forbidden/.test(String(error))) {
    return (
      "This RPC endpoint refuses browser requests. " +
      "Set VITE_RPC_URL in .env.local to your own endpoint."
    );
  }
  return error instanceof Error ? error.message : String(error);
}

/** Throws unless VITE_CONSUMER points at a deployed programs/mimir-cookbook.
 * Borrow, fill and settle need it; the price refresh does not. */
export async function assertConsumer(connection: Connection): Promise<void> {
  const account = demo.program
    ? await connection.getAccountInfo(toKey(demo.program), "confirmed")
    : null;
  if (!account?.executable) {
    throw Error(
      "This step needs your own deployment of programs/mimir-cookbook: set VITE_CONSUMER. " +
        "Refresh price works without it.",
    );
  }
}

/** True for compute-budget instructions, which `transaction()` replaces with its own. */
function isComputeBudget(instruction: TransactionInstruction): boolean {
  return instruction.programId.equals(ComputeBudgetProgram.programId);
}

/** Builds an unsigned v0 transaction with a compute limit and, if set, the lookup table. */
export async function transaction(
  connection: Connection,
  payer: string,
  instructions: TransactionInstruction[],
  lookup?: AddressLookupTableAccount,
): Promise<PreparedTransaction> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  if (!lookup && demo.lookup) {
    const response = await connection.getAddressLookupTable(toKey(demo.lookup));
    lookup = response.value ?? undefined;
  }
  const computeLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS });
  const message = new TransactionMessage({
    payerKey: toKey(payer),
    recentBlockhash: blockhash,
    instructions: [computeLimit, ...instructions.filter((ix) => !isComputeBudget(ix))],
  }).compileToV0Message(lookup ? [lookup] : []);
  const bytes = new VersionedTransaction(message).serialize();
  return { version: 0, bytes, blockhash, lastValidBlockHeight };
}

/** The Mimir refresh instruction for a feed, without its compute-budget instruction. */
export async function refreshed(
  connection: Connection,
  payer: string,
  feed = demo.feed,
): Promise<TransactionInstruction[]> {
  const instructions = await refreshInstructions(connection, feed, payer);
  return instructions.filter((ix) => !isComputeBudget(ix));
}

/** Simulates a transaction without a signature and returns the listed accounts after it. */
export async function simulate(
  connection: Connection,
  tx: PreparedTransaction,
  addresses: string[],
): Promise<Simulation> {
  // web3.js 1.x has no public method that returns post-simulation accounts for a v0 transaction.
  const rpc = connection as unknown as {
    _rpcRequest(method: string, params: unknown[]): Promise<any>;
  };
  const options = {
    encoding: "base64",
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
    accounts: { encoding: "base64", addresses },
  };
  const encoded = Buffer.from(tx.bytes).toString("base64");
  const response = await rpc._rpcRequest("simulateTransaction", [encoded, options]);
  if (response.error || !response.result) {
    throw Error(response.error?.message ?? "No simulation response");
  }
  return response.result as Simulation;
}

/** The feed's creator: any funded address can pay a simulation, and this one always exists. */
async function feedCreator(connection: Connection, feed: string): Promise<string> {
  const account = await connection.getAccountInfo(toKey(feed), "confirmed");
  if (!account) throw Error("Feed missing");
  return decodeV1ClassicFeed(account.data).owner.creator!;
}

/** Simulates Mimir's refresh: no signature, no fee. Without a wallet, the feed's creator
 * pays the simulation. Returns the refreshed price. */
export async function preview(connection: Connection, payer?: string, feed = demo.feed) {
  const simulationPayer = payer ?? (await feedCreator(connection, feed));
  const refresh = await refreshed(connection, simulationPayer, feed);
  const tx = await transaction(connection, simulationPayer, refresh);
  const simulation = await simulate(connection, tx, [feed]);
  if (simulation.value.err) {
    throw decisionError(simulation.value.err, tx, simulation.value.logs);
  }
  const feedAfter = Buffer.from(simulation.value.accounts[0].data[0], "base64");
  return {
    token: snapshot(feedAfter, simulation.context.slot),
    slot: simulation.context.slot,
    cu: simulation.value.unitsConsumed,
  };
}

/** The feed's base token: mint, decimals and ticker. */
export async function tokenMint(connection: Connection, feed = demo.feed) {
  const account = await connection.getAccountInfo(toKey(feed), "confirmed");
  if (!account) throw Error("Feed missing");
  return readFeedToken(account.data);
}

/** Reads the CPMM pool set in VITE_POOL and returns its base and USDC vaults. */
export async function poolVaults(connection: Connection, base: PublicKey) {
  if (!demo.pool) throw Error("Set VITE_POOL to the feed's Raydium CPMM pool.");
  const account = await connection.getAccountInfo(toKey(demo.pool), "confirmed");
  const data = account?.data;
  const discriminator = Buffer.from(CpmmPool.discriminator);
  if (!data || data.length !== CpmmPool.size || !data.subarray(0, 8).equals(discriminator)) {
    throw Error("Pool binding changed.");
  }
  const keyAt = (offset: number) => new PublicKey(data.subarray(offset, offset + 32));
  const mint0 = keyAt(CpmmPool.mint0);
  const mint1 = keyAt(CpmmPool.mint1);
  const vault0 = keyAt(CpmmPool.vault0);
  const vault1 = keyAt(CpmmPool.vault1);
  if (mint0.equals(base) && mint1.equals(USDC)) {
    return { baseVault: vault0, quoteVault: vault1 };
  }
  if (mint1.equals(base) && mint0.equals(USDC)) {
    return { baseVault: vault1, quoteVault: vault0 };
  }
  throw Error("Pool pair changed.");
}

/** An account the instruction reads, or writes when `isWritable` is true. Never a signer. */
function accountMeta(pubkey: PublicKey, isWritable = false) {
  return { pubkey, isWritable, isSigner: false };
}

/** Encodes the 17-byte instruction data: tag, collateral (u64), loan or payout (u64). */
function encodeData(tag: ConsumerTag, collateral: bigint, loan: bigint): Buffer {
  const data = Buffer.alloc(17);
  data[0] = tag;
  data.writeBigUInt64LE(collateral, 1);
  data.writeBigUInt64LE(loan, 9);
  return data;
}

/** The accounts that follow the 9 shared ones, which depend on the instruction tag. */
function extraAccounts(
  tag: ConsumerTag,
  user: string,
  feed: string,
  vaults?: { baseVault: PublicKey; quoteVault: PublicKey },
) {
  if (tag === Tag.SpotLender) {
    return [toKey(demo.pool), vaults!.baseVault, vaults!.quoteVault].map((key) => accountMeta(key));
  }
  if (tag === Tag.MimirBorrow) {
    const systemProgram = PublicKey.default;
    return [accountMeta(positionAddress(user, feed), true), accountMeta(systemProgram)];
  }
  if (tag === Tag.Repay || tag === Tag.Release) {
    return [accountMeta(positionAddress(user, feed), true)];
  }
  return [];
}

/** Builds one instruction for programs/mimir-cookbook. Account order matches the program:
 * feed, user, user token, vault token, vault USDC, user USDC, vault, token program,
 * instructions sysvar, then the tag's extra accounts. */
export function consumerInstruction(
  user: string,
  base: PublicKey,
  collateral: bigint,
  loan: bigint,
  tag: ConsumerTag,
  feed = demo.feed,
  vaults?: { baseVault: PublicKey; quoteVault: PublicKey },
): TransactionInstruction {
  // Repay and release use the Mimir borrow vault.
  const vaultTag = tag === Tag.Repay || tag === Tag.Release ? Tag.MimirBorrow : tag;
  const vault = vaultAddress(vaultTag, feed);
  const vaultOwner = vault.toBase58();
  const userSigns = { pubkey: toKey(user), isSigner: true, isWritable: tag === Tag.MimirBorrow };
  const tokenAccounts = [
    ata(user, base),
    ata(vaultOwner, base),
    ata(vaultOwner, USDC),
    ata(user, USDC),
  ].map((key) => accountMeta(key, true));
  const keys = [
    accountMeta(toKey(feed)),
    userSigns,
    ...tokenAccounts,
    accountMeta(vault),
    accountMeta(TOKEN_PROGRAM_ID),
    accountMeta(SYSVAR_INSTRUCTIONS_PUBKEY),
    ...extraAccounts(tag, user, feed, vaults),
  ];
  return new TransactionInstruction({
    programId: toKey(demo.program),
    data: encodeData(tag, collateral, loan),
    keys,
  });
}

/** Signs and sends a checked transaction, unless its simulation already failed. */
async function run(connection: Connection, wallet: MimirWallet, check: CheckedTransaction) {
  if (check.simulation.value.err) {
    const { err, logs } = check.simulation.value;
    throw decisionError(err, check.tx, logs);
  }
  const signature = await signAndSend(connection, wallet, check.tx);
  return { signature, simulation: check.simulation };
}

/** Refreshes Mimir and borrows `loan` USDC atoms against `collateral` token atoms. */
export async function borrow(
  connection: Connection,
  wallet: MimirWallet,
  collateral: bigint,
  loan: bigint,
  feed = demo.feed,
) {
  const check = await checkBorrow(
    connection,
    wallet.address,
    collateral,
    loan,
    Tag.MimirBorrow,
    feed,
  );
  return run(connection, wallet, check);
}

/** Builds and simulates a borrow. The Mimir borrow reads only the Mimir feed, refreshed in the
 * same transaction; the spot lender reads the CPMM pool instead. */
export async function checkBorrow(
  connection: Connection,
  payer: string,
  collateral: bigint,
  loan: bigint,
  tag: BorrowTag,
  feed = demo.feed,
): Promise<CheckedTransaction> {
  await assertConsumer(connection);
  const { mint } = await tokenMint(connection, feed);
  const usesPool = tag === Tag.SpotLender;
  const vaults = usesPool ? await poolVaults(connection, mint) : undefined;
  const refresh = usesPool ? [] : await refreshed(connection, payer, feed);
  const borrowIx = consumerInstruction(payer, mint, collateral, loan, tag, feed, vaults);
  const tx = await transaction(connection, payer, [...refresh, borrowIx]);
  return { tx, simulation: await simulate(connection, tx, []) };
}

/** Repays USDC debt (Tag.Repay) or releases all collateral once the debt is zero
 * (Tag.Release). No price is read. */
export async function settle(
  connection: Connection,
  wallet: MimirWallet,
  tag: SettleTag,
  amount = 0n,
  feed = demo.feed,
) {
  await assertConsumer(connection);
  const { mint } = await tokenMint(connection, feed);
  const noCollateral = 0n;
  const settleIx = consumerInstruction(wallet.address, mint, noCollateral, amount, tag, feed);
  const tx = await transaction(connection, wallet.address, [settleIx]);
  return run(connection, wallet, { tx, simulation: await simulate(connection, tx, []) });
}

/** The user's position: collateral (token atoms) and debt (USDC atoms). Zero if none. */
export async function position(connection: Connection, user: string, feed = demo.feed) {
  if (!demo.program) return { collateral: 0n, debt: 0n };
  const account = await connection.getAccountInfo(positionAddress(user, feed), "confirmed");
  if (!account) return { collateral: 0n, debt: 0n };
  return {
    collateral: account.data.readBigUInt64LE(0),
    debt: account.data.readBigUInt64LE(8),
  };
}

/** The program id of the instruction at `index` in a serialized transaction. */
function programAt(tx: PreparedTransaction, index: number): string {
  const message = VersionedTransaction.deserialize(tx.bytes).message;
  const instruction = message.compiledInstructions[index]!;
  return message.staticAccountKeys[instruction.programIdIndex]!.toBase58();
}

/** Turns a failed simulation into a readable error. It names the failing instruction by its
 * program, and the innermost failing program from the logs: a Mimir refresh or token-transfer
 * error is not a consumer decision. */
export function decisionError(err: any, tx?: PreparedTransaction, logs?: string[] | null) {
  const [index, inner] = err?.InstructionError ?? [];
  const program = tx && index !== undefined ? programAt(tx, index) : undefined;
  const failedLog = logs?.find((line) => /^Program \w+ failed/.test(line));
  const failed = failedLog?.split(" ")[1] ?? program;
  if (failed === TOKEN_PROGRAM_ID.toBase58()) {
    const reason = inner?.Custom === 1 ? "insufficient token balance" : JSON.stringify(inner);
    return Error(`Token transfer refused: ${reason}.`);
  }
  if (program === demo.program && failed === program && inner?.Custom in CONSUMER_REASONS) {
    return Error(`Declined by the consumer: ${CONSUMER_REASONS[inner.Custom]}.`);
  }
  let source = "Transaction";
  if (program === MIMIR_PROGRAM) source = "Mimir refresh";
  else if (program) source = `Instruction ${index} (${program})`;
  return Error(`${source} refused: ${JSON.stringify(inner ?? err)}`);
}

/** Reads a little-endian u64 at `offset`. */
function u64At(bytes: Buffer, offset: number): bigint {
  return bytes.readBigUInt64LE(offset);
}

/** Decodes the consumer's 40-byte return data: Q32 price (USDC per token, u128),
 * loan limit in USDC atoms (u128) and slot (u64). Null if it is not ours. */
export function receipt(sim: {
  value: { returnData?: { programId: string; data: [string, string] } };
}) {
  const returnData = sim.value.returnData;
  if (!returnData || returnData.programId !== demo.program || returnData.data[1] !== "base64") {
    return null;
  }
  const bytes = Buffer.from(returnData.data[0], "base64");
  if (bytes.length !== RECEIPT_SIZE) return null;
  const limitHigh = u64At(bytes, 24);
  if (limitHigh !== 0n) return null;
  const priceQ32 = u64At(bytes, 0) + (u64At(bytes, 8) << 64n);
  return {
    price: Number(priceQ32) / 2 ** 32,
    limit: u64At(bytes, 16),
    slot: Number(u64At(bytes, 32)),
  };
}

/** Refreshes Mimir and sells `collateral` token atoms for `payout` USDC atoms, only inside
 * the Mimir bound. */
export async function fill(
  connection: Connection,
  wallet: MimirWallet,
  collateral: bigint,
  payout: bigint,
  feed = demo.feed,
) {
  const check = await checkFill(connection, wallet.address, collateral, payout, feed);
  return run(connection, wallet, check);
}

/** Builds and simulates a protected fill, with the Mimir refresh in the same transaction. */
export async function checkFill(
  connection: Connection,
  payer: string,
  collateral: bigint,
  payout: bigint,
  feed = demo.feed,
): Promise<CheckedTransaction> {
  await assertConsumer(connection);
  const { mint } = await tokenMint(connection, feed);
  const refresh = await refreshed(connection, payer, feed);
  const fillIx = consumerInstruction(payer, mint, collateral, payout, Tag.ProtectedFill, feed);
  const tx = await transaction(connection, payer, [...refresh, fillIx]);
  return { tx, simulation: await simulate(connection, tx, []) };
}
