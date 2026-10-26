import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { decodeV1ClassicFeed } from "@quantulabs/mimir-sdk/v1";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
// A local validator cloned from mainnet: Mimir, the feed and its pools, the cookbook program, and your wallet funded.
// Usage: npm run localnet -- <your wallet address>. Needs the Solana CLI, and `cargo build-sbf` run in programs/mimir-cookbook.
// RPC sets the mainnet endpoint to clone from; LOCALNET_ARGS adds solana-test-validator flags (for example --rpc-port).
const wallet = process.argv[2];
if (!wallet) throw new Error("Usage: npm run localnet -- <your wallet address>");
const file = new URL(existsSync(new URL("../.env.local", import.meta.url)) ? "../.env.local" : "../.env.example", import.meta.url);
const feed = readFileSync(file, "utf8").match(/^VITE_FEED=(\S+)/m)?.[1] ?? "F5fXuWuVFwBF3eBVtFkxXS5PMY651uVQ1bL4W4mse5Qj";
const rpc = process.env.RPC || "https://api.mainnet-beta.solana.com", c = new Connection(rpc, "confirmed");
const keypair = new URL("../programs/mimir-cookbook/target/deploy/mimir_cookbook-keypair.json", import.meta.url);
if (!existsSync(keypair)) throw new Error("Build the program first: cd programs/mimir-cookbook && cargo build-sbf");
const program = new PublicKey(Uint8Array.from(JSON.parse(readFileSync(keypair, "utf8"))).subarray(32)).toBase58();
const C = await import("../packages/mimir-easy/src/consumer.ts");
Object.assign(C.demo, { rpc, feed, program });

// Clone every account the feed's refresh reads, the programs that own its pools, and the feed's creator (it pays refresh previews).
const UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111", WSOL = "So11111111111111111111111111111111111111112", TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const f = decodeV1ClassicFeed((await c.getAccountInfo(new PublicKey(feed)))!.data), base = new PublicKey(f.definition.feedImage.slice(48, 80));
const ixs = await C.refreshed(c, f.owner.creator!, feed);
const keys = [...new Set([...ixs.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.map((k) => k.pubkey.toBase58())]), C.USDC.toBase58(), base.toBase58(), f.owner.creator!])];
const infos = await c.getMultipleAccountsInfo(keys.map((k) => new PublicKey(k)));
const args: string[] = [];
keys.forEach((k, i) => {
  const a = infos[i];
  if (!a || k === WSOL || a.owner.toBase58() === "NativeLoader1111111111111111111111111111111") return;
  if (a.owner.toBase58() === UPGRADEABLE) { if (a.executable) args.push("--clone-upgradeable-program", k); return; }
  args.push("--clone", k);
});

// Your wallet: 10 SOL, about 100 USDC worth of the feed's token, an empty USDC account. Each vault holds 100 USDC.
const p = await C.preview(c, undefined, feed), decimals = f.definition.feedImage[118]!;
const dir = new URL("../.localnet/", import.meta.url); mkdirSync(dir, { recursive: true });
const put = (name: string, pubkey: string, lamports: number, owner: string, data = Buffer.alloc(0)) => {
  const path = fileURLToPath(new URL(`${name}.json`, dir));
  writeFileSync(path, JSON.stringify({ pubkey, account: { lamports, data: [data.toString("base64"), "base64"], owner, executable: false, rentEpoch: 0, space: data.length } }));
  args.push("--account", pubkey, path);
};
const token = (name: string, owner: PublicKey, mint: PublicKey, amount: bigint) => {
  const d = Buffer.alloc(165), native = mint.toBase58() === WSOL, rent = 2_039_280;
  mint.toBuffer().copy(d, 0); owner.toBuffer().copy(d, 32); d.writeBigUInt64LE(amount, 64); d[108] = 1;
  if (native) { d.writeUInt32LE(1, 109); d.writeBigUInt64LE(BigInt(rent), 113); }
  put(name, getAssociatedTokenAddressSync(mint, owner, true).toBase58(), rent + (native ? Number(amount) : 0), TOKEN, d);
};
const user = new PublicKey(wallet);
put("wallet", wallet, 10_000_000_000, "11111111111111111111111111111111");
token("wallet-token", user, base, C.atoms(100 / p.token.lower, decimals));
token("wallet-usdc", user, C.USDC, 0n);
for (const tag of [0, 1] as const) {
  token(`vault${tag}-token`, C.vaultAddress(tag, feed), base, 0n);
  token(`vault${tag}-usdc`, C.vaultAddress(tag, feed), C.USDC, 100_000_000n);
}

// Start just after an epoch boundary: the local clock then stays close to real time. Nothing trades on the copy, so prices
// stop being Fresh after a minute or two; run this again to clone current pools.
const warp = Math.floor((await c.getSlot()) / 432_000) * 432_000 + 100;
const extra = (process.env.LOCALNET_ARGS ?? "").split(" ").filter(Boolean), at = extra.indexOf("--rpc-port"), port = at >= 0 ? extra[at + 1] : "8899";
console.log(`Add to .env.local, then run an app:\nVITE_RPC_URL=http://127.0.0.1:${port}\nVITE_CONSUMER=${program}\n`);
spawn("solana-test-validator", ["--reset", "--ledger", fileURLToPath(new URL("ledger", dir)), "--slots-per-epoch", "432000", "--warp-slot", String(warp), "--url", rpc,
  "--bpf-program", program, fileURLToPath(new URL("../programs/mimir-cookbook/target/deploy/mimir_cookbook.so", import.meta.url)), ...args, ...extra], { stdio: "inherit" });
