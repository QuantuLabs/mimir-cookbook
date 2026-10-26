import "./style.css";
import baseline from "../../../fixtures/dood-shock/baseline.json";
import moved from "../../../fixtures/dood-shock/after-buy.json";
import restored from "../../../fixtures/dood-shock/restored.json";

// Replay of three snapshots recorded on a local validator cloned from mainnet, around one ordinary DOOD buy and its exact inverse sell.
// Fixed request: 1,000 DOOD collateral; each lender asks for the spot lender's limit after the buy.
type Sim = { slot: number; err: unknown; reason: string | null; receipt: { limit: string } | null };
type Snap = { label: string; pool: { spot: number }; mimir: { fresh: boolean; lower: number; refreshSlot: number }; spotLender: Sim; mimirLender: Sim; mimirLimit: Sim };
const [a, b, c] = [baseline, moved, restored] as Snap[];
const $ = (id: string) => document.getElementById(id)!, usdc = (atoms: string | number) => (Number(atoms) / 1e6).toFixed(3);
const pct = (x: number, y: number) => `${x > y ? "+" : ""}${((x / y - 1) * 100).toFixed(1)}%`;
const value = (s: Snap) => 1000 * s.pool.spot;
const mimir = (s: Snap) => s.mimirLimit.receipt ? `Mimir limit ${usdc(s.mimirLimit.receipt.limit)} USDC` : "Mimir price not Fresh: loan declined";
$("steps").innerHTML = [[a, "Baseline"], [b, `After one buy (spot ${pct(b.pool.spot, a.pool.spot)})`], [c, "After the exact inverse sell"]].map(([s, title]) =>
  `<li><b>${title}</b><span>Pool spot ${(s as Snap).pool.spot.toFixed(7)} USDC · ${mimir(s as Snap)}</span><small>spot simulation slot ${(s as Snap).spotLender.slot} · Mimir simulation slot ${(s as Snap).mimirLimit.slot}</small></li>`).join("");
const lent = b.spotLender.receipt ? Number(b.spotLender.receipt.limit) / 1e6 : 0, debt = Math.max(0, lent - value(c));
const card = (id: string, kind: string, title: string, detail: string) => { $(id).className = `decision ${kind}`; $(id).innerHTML = `<small>${id === "spot" ? "POOL SPOT LENDER" : "MIMIR LENDER"}</small><b>${title}</b><span>${detail}</span>`; };
card("spot", "fail", `${lent.toFixed(3)} USDC lent`, `Bad debt ${debt.toFixed(3)} USDC once the price returns (collateral worth ${value(c).toFixed(3)} USDC)`);
card("mimir", "pass", b.mimirLender.err ? "Loan declined" : `${usdc(b.mimirLender.receipt!.limit)} USDC lent`, `${b.mimirLender.err ? "Price not Fresh after the jump" : "Inside the Mimir limit"} · bad debt 0.000 USDC`);
$("evidence").textContent = `Same ${lent.toFixed(3)} USDC request for both lenders, simulated at slot ${b.spotLender.slot} (spot) and ${b.mimirLender.slot} (Mimir).`;
