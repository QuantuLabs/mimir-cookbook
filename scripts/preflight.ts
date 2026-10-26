import { Connection, PublicKey } from "@solana/web3.js";
import { decodeV1ClassicFeed } from "@quantulabs/mimir-sdk/v1";
import { existsSync, readFileSync } from "node:fs";
import baseline from "../fixtures/dood-shock/baseline.json" with { type: "json" };
import moved from "../fixtures/dood-shock/after-buy.json" with { type: "json" };
import restored from "../fixtures/dood-shock/restored.json" with { type: "json" };
// Read-only: checks the feed and programs the apps use, and the recorded fixtures. Never signs or sends.
// Reads .env.local (else .env.example); RPC overrides VITE_RPC_URL. Optional argument: a wallet address to inspect.
const file = new URL(existsSync(new URL("../.env.local", import.meta.url)) ? "../.env.local" : "../.env.example", import.meta.url);
const env = Object.fromEntries(readFileSync(file, "utf8").split("\n").filter((l) => /^VITE_\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const C = await import("../packages/mimir-easy/src/consumer.ts");
Object.assign(C.demo, Object.fromEntries(Object.entries({ rpc: process.env.RPC || env.VITE_RPC_URL, feed: env.VITE_FEED, program: env.VITE_CONSUMER, pool: env.VITE_POOL, lookup: env.VITE_LOOKUP }).filter(([, v]) => v)));
const MIMIR = "hBYrGHXVCQsnduDERkVnViCXNYawpHCvN5y3GsMiMiR", MAINNET = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const c = new Connection(C.demo.rpc, "confirmed"), pk = (s: string) => new PublicKey(s), wallet = process.argv[2], failures: string[] = [];
const check = (name: string, ok: boolean) => { if (!ok) failures.push(name); return ok; };
const upgrade = async (program: string) => { const a = await c.getAccountInfo(pk(program)); if (!a?.executable) return "missing";
  const d = (await c.getAccountInfo(new PublicKey(a.data.subarray(4, 36))))!.data; return d[12] ? new PublicKey(d.subarray(13, 45)).toBase58() : "immutable"; };
const amount = async (a: PublicKey) => { const x = await c.getAccountInfo(a); return x ? x.data.readBigUInt64LE(64).toString() : "missing"; };

// The same account checks the consumer program makes before it reads a price (programs/mimir-cookbook, classic()).
const feed = await c.getAccountInfo(pk(C.demo.feed), "confirmed");
if (!feed) throw new Error(`No account at ${C.demo.feed}`);
const d = feed.data, f = decodeV1ClassicFeed(d);
const [pda] = PublicKey.findProgramAddressSync([Buffer.from("feed_snapshot"), d.subarray(16, 48)], pk(MIMIR));
const binding = feed.owner.toBase58() === MIMIR && d.length >= 2506 && d.subarray(0, 8).toString() === "MIMIRSNP" && d.readUInt16LE(8) === 0
  && d.readUInt16LE(10) === 512 && d.subarray(593, 601).toString() === "MIMIRCLX" && d.readUInt16LE(601) === 2 && d[652] === 1 && pda.equals(pk(C.demo.feed))
  && new PublicKey(d.subarray(993, 1025)).equals(C.USDC);
check("consumer binding", binding);
const mintOwner = (await c.getAccountInfo(new PublicKey(d.subarray(961, 993))))?.owner.toBase58();
const splToken = check("collateral is an SPL Token mint (not Token-2022)", mintOwner === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
// Any funded address can pay a simulation; the feed's creator is one.
const p = await C.preview(c, wallet ?? f.owner.creator!, C.demo.feed);
check("refresh simulation", p.token.price > 0);

const lent = Number(moved.spotLender.receipt!.limit) / 1e6, debt = lent - 1000 * restored.pool.spot;
check("recorded quote passes before the move", baseline.makerQuote.err === null);
check("recorded quote refused after the move", moved.makerQuote.err !== null);
check("recorded Mimir lender declines after the move", moved.mimirLender.err !== null && moved.spotLender.err === null && debt > 0);

const out: Record<string, unknown> = {
  cluster: (await c.getGenesisHash()) === MAINNET ? "mainnet" : "other",
  feed: { address: C.demo.feed, ticker: p.token.ticker, consumerBinding: binding ? "ok" : "refused", collateralTokenProgram: splToken ? "SPL Token" : `${mintOwner} (not supported by programs/mimir-cookbook)` },
  refresh: { slot: p.slot, fresh: p.token.fresh, price: p.token.price, lower: p.token.lower, upper: p.token.upper, cu: p.cu },
  mimirProgram: { id: MIMIR, upgradeAuthority: await upgrade(MIMIR) },
  consumer: C.demo.program ? { id: C.demo.program, upgradeAuthority: await upgrade(C.demo.program) } : "not set: borrow, fill and settle need your own deployment",
  recorded: { spotLenderLent: lent, spotLenderBadDebt: Number(debt.toFixed(6)), mimirLender: "declined" },
};
if (C.demo.lookup) out.lookupTable = (await c.getAddressLookupTable(pk(C.demo.lookup))).value ? "ok" : "missing";
if (C.demo.pool) out.pool = { id: C.demo.pool, owner: (await c.getAccountInfo(pk(C.demo.pool)))?.owner.toBase58() ?? "missing" };
if (C.demo.program) out.vaultLiquidityUsdc = Object.fromEntries(await Promise.all(([0, 1, 2] as const).map(async (t) => [t, await amount(C.ata(C.vaultAddress(t, C.demo.feed).toBase58(), C.USDC))])));
if (wallet && C.demo.program) out.wallet = { token: await amount(C.ata(wallet, new PublicKey(f.definition.feedImage.slice(48, 80)))), usdc: await amount(C.ata(wallet, C.USDC)), position: await C.position(c, wallet, C.demo.feed) };
console.log(JSON.stringify({ ...out, failures }, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
process.exit(failures.length ? 1 : 0);
