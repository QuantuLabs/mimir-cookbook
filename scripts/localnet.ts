// A local validator cloned from mainnet: Mimir, the feed and its pools, the cookbook program,
// and a funded wallet.
//
// Usage: npm run localnet [-- <your wallet address>]
// Without an address it creates (or reuses) a throwaway keypair in .localnet/test-wallet.json,
// which the apps offer as "Use the local test wallet".
// Needs the Solana CLI, and `cargo build-sbf` run in programs/mimir-cookbook first.
// RPC sets the mainnet endpoint to clone from; LOCALNET_ARGS adds solana-test-validator flags
// (for example LOCALNET_ARGS="--rpc-port 8999").
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { decodeV1ClassicFeed } from "@quantulabs/mimir-sdk/v1";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "./env.ts";

const DEFAULT_FEED = "F5fXuWuVFwBF3eBVtFkxXS5PMY651uVQ1bL4W4mse5Qj";
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const NATIVE_LOADER = "NativeLoader1111111111111111111111111111111";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL = 1_000_000_000;
const WALLET_SOL = 10;
/** The wallet gets about this much USDC worth of the feed's token. */
const WALLET_TOKEN_USDC = 100;
/** Each vault holds this much USDC, in atoms (100 USDC). */
const VAULT_USDC_ATOMS = 100_000_000n;
const TOKEN_ACCOUNT_SIZE = 165;
const TOKEN_ACCOUNT_RENT = 2_039_280;
const SLOTS_PER_EPOCH = 432_000;
const DEFAULT_RPC_PORT = "8899";

const localnetDir = new URL("../.localnet/", import.meta.url);
const testWalletFile = new URL("test-wallet.json", localnetDir);
const programKeypairFile = new URL(
  "../programs/mimir-cookbook/target/deploy/mimir_cookbook-keypair.json",
  import.meta.url,
);
const programFile = new URL(
  "../programs/mimir-cookbook/target/deploy/mimir_cookbook.so",
  import.meta.url,
);

/** Reads a Solana CLI keypair file (a JSON array of 64 bytes). */
function readKeypair(file: URL): Keypair {
  const secretKey = Uint8Array.from(JSON.parse(readFileSync(file, "utf8")));
  return Keypair.fromSecretKey(secretKey);
}

/** The wallet to fund: the address given on the command line, or the local test wallet,
 * created on first use. */
function walletAddress(): string {
  const fromCommandLine = process.argv[2];
  if (fromCommandLine) return fromCommandLine;
  if (!existsSync(testWalletFile)) {
    const secretKey = Array.from(Keypair.generate().secretKey);
    writeFileSync(testWalletFile, JSON.stringify(secretKey), { mode: 0o600 });
  }
  return readKeypair(testWalletFile).publicKey.toBase58();
}

/** The address of the cookbook program, from the keypair `cargo build-sbf` wrote. */
function programAddress(): string {
  if (!existsSync(programKeypairFile)) {
    throw new Error("Build the program first: cd programs/mimir-cookbook && cargo build-sbf");
  }
  return readKeypair(programKeypairFile).publicKey.toBase58();
}

mkdirSync(localnetDir, { recursive: true });
const wallet = walletAddress();
const feed = readEnvFile().VITE_FEED || DEFAULT_FEED;
const rpc = process.env.RPC || "https://api.mainnet-beta.solana.com";
const connection = new Connection(rpc, "confirmed");
const program = programAddress();
const consumer = await import("../packages/mimir-easy/src/consumer.ts");
Object.assign(consumer.demo, { rpc, feed, program });

/** solana-test-validator arguments, filled in by the steps below. */
const validatorArgs: string[] = [];

/** Clones every account the feed's refresh reads, the programs that own its pools, the USDC and
 * base mints, and the feed's creator (it pays refresh previews). */
async function cloneFeedAccounts(creator: string, base: PublicKey) {
  const refresh = await consumer.refreshed(connection, creator, feed);
  const addresses = new Set<string>();
  for (const instruction of refresh) {
    addresses.add(instruction.programId.toBase58());
    for (const key of instruction.keys) addresses.add(key.pubkey.toBase58());
  }
  addresses.add(consumer.USDC.toBase58());
  addresses.add(base.toBase58());
  addresses.add(creator);

  const keys = [...addresses];
  const accounts = await connection.getMultipleAccountsInfo(keys.map((key) => new PublicKey(key)));
  keys.forEach((key, index) => {
    const account = accounts[index];
    if (!account || key === WRAPPED_SOL) return;
    const owner = account.owner.toBase58();
    if (owner === NATIVE_LOADER) return;
    if (owner === UPGRADEABLE_LOADER) {
      // The program account clones its program-data account with it; skip the latter.
      if (account.executable) validatorArgs.push("--clone-upgradeable-program", key);
      return;
    }
    validatorArgs.push("--clone", key);
  });
}

/** Writes one account to .localnet/<name>.json and loads it into the validator. */
function addAccount(
  name: string,
  address: string,
  lamports: number,
  owner: string,
  data = Buffer.alloc(0),
) {
  const path = fileURLToPath(new URL(`${name}.json`, localnetDir));
  const account = {
    lamports,
    data: [data.toString("base64"), "base64"],
    owner,
    executable: false,
    rentEpoch: 0,
    space: data.length,
  };
  writeFileSync(path, JSON.stringify({ pubkey: address, account }));
  validatorArgs.push("--account", address, path);
}

/** Adds an SPL token account (the owner's associated token account) holding `amount` atoms. */
function addTokenAccount(name: string, owner: PublicKey, mint: PublicKey, amount: bigint) {
  const isNative = mint.toBase58() === WRAPPED_SOL;
  const data = Buffer.alloc(TOKEN_ACCOUNT_SIZE);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  const initialized = 1;
  data[108] = initialized;
  if (isNative) {
    data.writeUInt32LE(1, 109);
    data.writeBigUInt64LE(BigInt(TOKEN_ACCOUNT_RENT), 113);
  }
  const address = getAssociatedTokenAddressSync(mint, owner, true).toBase58();
  const lamports = TOKEN_ACCOUNT_RENT + (isNative ? Number(amount) : 0);
  addAccount(name, address, lamports, TOKEN_PROGRAM, data);
}

/** Funds the wallet (SOL, the feed's token, an empty USDC account) and both vaults (USDC). */
async function fundAccounts(base: PublicKey, decimals: number) {
  const { token: price } = await consumer.preview(connection, undefined, feed);
  const user = new PublicKey(wallet);
  addAccount("wallet", wallet, WALLET_SOL * LAMPORTS_PER_SOL, SYSTEM_PROGRAM);
  const tokenAmount = consumer.atoms(WALLET_TOKEN_USDC / price.lower, decimals);
  addTokenAccount("wallet-token", user, base, tokenAmount);
  addTokenAccount("wallet-usdc", user, consumer.USDC, 0n);
  for (const tag of [0, 1] as const) {
    const vault = consumer.vaultAddress(tag, feed);
    addTokenAccount(`vault${tag}-token`, vault, base, 0n);
    addTokenAccount(`vault${tag}-usdc`, vault, consumer.USDC, VAULT_USDC_ATOMS);
  }
}

/** The RPC port passed in LOCALNET_ARGS, or the validator's default. */
function rpcPort(extraArgs: string[]): string {
  const index = extraArgs.indexOf("--rpc-port");
  return index >= 0 ? extraArgs[index + 1]! : DEFAULT_RPC_PORT;
}

const feedAccount = await connection.getAccountInfo(new PublicKey(feed));
if (!feedAccount) throw new Error(`No Mimir feed at ${feed} on ${new URL(rpc).host}`);
const feedData = decodeV1ClassicFeed(feedAccount.data);
const base = new PublicKey(feedData.definition.feedImage.slice(48, 80));
const decimals = feedData.definition.feedImage[118]!;
await cloneFeedAccounts(feedData.owner.creator!, base);
await fundAccounts(base, decimals);

// Start just after an epoch boundary: the local clock then stays close to real time. Nothing
// trades on the copy, so prices stop being Fresh after a minute or two; run this again to clone
// current pools.
const currentSlot = await connection.getSlot();
const warpSlot = Math.floor(currentSlot / SLOTS_PER_EPOCH) * SLOTS_PER_EPOCH + 100;
const extraArgs = (process.env.LOCALNET_ARGS ?? "").split(" ").filter(Boolean);
const port = rpcPort(extraArgs);
const walletLabel = process.argv[2]
  ? "Funded wallet"
  : "Local test wallet (.localnet/test-wallet.json)";
console.log(`${walletLabel}: ${wallet}`);
console.log(`Add to .env.local, then run an app:`);
console.log(`VITE_RPC_URL=http://127.0.0.1:${port}`);
console.log(`VITE_CONSUMER=${program}\n`);

spawn(
  "solana-test-validator",
  [
    "--reset",
    "--ledger",
    fileURLToPath(new URL("ledger", localnetDir)),
    "--slots-per-epoch",
    String(SLOTS_PER_EPOCH),
    "--warp-slot",
    String(warpSlot),
    "--url",
    rpc,
    "--bpf-program",
    program,
    fileURLToPath(programFile),
    ...validatorArgs,
    ...extraArgs,
  ],
  { stdio: "inherit" },
);
