// Read-only: checks the feed and programs the apps use, and the recorded fixtures. Never signs
// or sends. Reads .env.local (else .env.example); RPC overrides VITE_RPC_URL.
// Usage: npm run preflight [-- <wallet address to inspect>]
import { Connection, PublicKey } from "@solana/web3.js";
import { decodeV1ClassicFeed } from "@quantulabs/mimir-sdk/v1";
import baseline from "../fixtures/dood-shock/baseline.json" with { type: "json" };
import moved from "../fixtures/dood-shock/after-buy.json" with { type: "json" };
import restored from "../fixtures/dood-shock/restored.json" with { type: "json" };
import { readEnvFile } from "./env.ts";

const MIMIR_PROGRAM = "hBYrGHXVCQsnduDERkVnViCXNYawpHCvN5y3GsMiMiR";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const COLLATERAL_TOKENS = 1000;
const USDC_DECIMALS = 6;

const consumer = await import("../packages/mimir-easy/src/consumer.ts");
const env = readEnvFile();
const settings = {
  rpc: process.env.RPC || env.VITE_RPC_URL,
  feed: env.VITE_FEED,
  program: env.VITE_CONSUMER,
  pool: env.VITE_POOL,
  lookup: env.VITE_LOOKUP,
};
for (const [name, value] of Object.entries(settings)) {
  if (value) Object.assign(consumer.demo, { [name]: value });
}
const demo = consumer.demo;
const connection = new Connection(demo.rpc, "confirmed");
const wallet = process.argv[2];
const failures: string[] = [];

/** Records a failed check by name, and returns whether it passed. */
function check(name: string, passed: boolean): boolean {
  if (!passed) failures.push(name);
  return passed;
}

/** The upgrade authority of a program: an address, "immutable" or "missing". */
async function upgradeAuthority(program: string): Promise<string> {
  const account = await connection.getAccountInfo(new PublicKey(program));
  if (!account?.executable) return "missing";
  const programData = new PublicKey(account.data.subarray(4, 36));
  const data = (await connection.getAccountInfo(programData))!.data;
  const hasAuthority = data[12] !== 0;
  return hasAuthority ? new PublicKey(data.subarray(13, 45)).toBase58() : "immutable";
}

/** The balance of a token account in atoms, or "missing". */
async function tokenBalance(tokenAccount: PublicKey): Promise<string> {
  const account = await connection.getAccountInfo(tokenAccount);
  return account ? account.data.readBigUInt64LE(64).toString() : "missing";
}

/** The same account checks programs/mimir-cookbook makes in classic() before it reads a price,
 * plus the USDC quote check made by borrow(). */
function consumerAcceptsFeed(owner: PublicKey, data: Buffer): boolean {
  const feedId = data.subarray(16, 48);
  const seeds = [Buffer.from("feed_snapshot"), feedId];
  const [snapshotPda] = PublicKey.findProgramAddressSync(seeds, new PublicKey(MIMIR_PROGRAM));
  return (
    owner.toBase58() === MIMIR_PROGRAM &&
    data.length >= 2506 &&
    data.subarray(0, 8).toString() === "MIMIRSNP" &&
    data.readUInt16LE(8) === 0 &&
    data.readUInt16LE(10) === 512 &&
    data.subarray(593, 601).toString() === "MIMIRCLX" &&
    data.readUInt16LE(601) === 2 &&
    data[652] === 1 &&
    snapshotPda.equals(new PublicKey(demo.feed)) &&
    new PublicKey(data.subarray(993, 1025)).equals(consumer.USDC)
  );
}

/** Liquidity of the three vaults (one per borrow tag), in USDC atoms. */
async function vaultLiquidity() {
  const entries = [];
  for (const tag of [0, 1, 2] as const) {
    const vault = consumer.vaultAddress(tag, demo.feed).toBase58();
    entries.push([tag, await tokenBalance(consumer.ata(vault, consumer.USDC))]);
  }
  return Object.fromEntries(entries);
}

const feedAccount = await connection.getAccountInfo(new PublicKey(demo.feed), "confirmed");
if (!feedAccount) throw new Error(`No account at ${demo.feed}`);
const feedData = feedAccount.data;
const feed = decodeV1ClassicFeed(feedData);
const baseMint = new PublicKey(feed.definition.feedImage.slice(48, 80));

const binding = check("consumer binding", consumerAcceptsFeed(feedAccount.owner, feedData));
const mintOwner = (await connection.getAccountInfo(baseMint))?.owner.toBase58();
const isSplToken = check(
  "collateral is an SPL Token mint (not Token-2022)",
  mintOwner === TOKEN_PROGRAM,
);
// Any funded address can pay a simulation; the feed's creator is one.
const refresh = await consumer.preview(connection, wallet ?? feed.owner.creator!, demo.feed);
check("refresh simulation", refresh.token.price > 0);

const spotLent = Number(moved.spotLender.receipt!.limit) / 10 ** USDC_DECIMALS;
const badDebt = spotLent - COLLATERAL_TOKENS * restored.pool.spot;
check("recorded quote passes before the move", baseline.makerQuote.err === null);
check("recorded quote refused after the move", moved.makerQuote.err !== null);
check(
  "recorded Mimir lender declines after the move",
  moved.mimirLender.err !== null && moved.spotLender.err === null && badDebt > 0,
);

const isMainnet = (await connection.getGenesisHash()) === MAINNET_GENESIS;
const collateralTokenProgram = isSplToken
  ? "SPL Token"
  : `${mintOwner} (not supported by programs/mimir-cookbook)`;
const report: Record<string, unknown> = {
  cluster: isMainnet ? "mainnet" : "other",
  feed: {
    address: demo.feed,
    ticker: refresh.token.ticker,
    consumerBinding: binding ? "ok" : "refused",
    collateralTokenProgram,
  },
  refresh: {
    slot: refresh.slot,
    fresh: refresh.token.fresh,
    price: refresh.token.price,
    lower: refresh.token.lower,
    upper: refresh.token.upper,
    cu: refresh.cu,
  },
  mimirProgram: { id: MIMIR_PROGRAM, upgradeAuthority: await upgradeAuthority(MIMIR_PROGRAM) },
  consumer: demo.program
    ? { id: demo.program, upgradeAuthority: await upgradeAuthority(demo.program) }
    : "not set: borrow, fill and settle need your own deployment",
  recorded: {
    spotLenderLent: spotLent,
    spotLenderBadDebt: Number(badDebt.toFixed(6)),
    mimirLender: "declined",
  },
};
if (demo.lookup) {
  const table = await connection.getAddressLookupTable(new PublicKey(demo.lookup));
  report.lookupTable = table.value ? "ok" : "missing";
}
if (demo.pool) {
  const pool = await connection.getAccountInfo(new PublicKey(demo.pool));
  report.pool = { id: demo.pool, owner: pool?.owner.toBase58() ?? "missing" };
}
if (demo.program) {
  report.vaultLiquidityUsdc = await vaultLiquidity();
}
if (wallet && demo.program) {
  report.wallet = {
    token: await tokenBalance(consumer.ata(wallet, baseMint)),
    usdc: await tokenBalance(consumer.ata(wallet, consumer.USDC)),
    position: await consumer.position(connection, wallet, demo.feed),
  };
}

/** JSON.stringify cannot print bigint: print it as a string. */
function bigintAsString(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}
console.log(JSON.stringify({ ...report, failures }, bigintAsString, 2));
process.exit(failures.length ? 1 : 0);
