import "./style.css";
import baseline from "../../../fixtures/dood-shock/baseline.json";
import moved from "../../../fixtures/dood-shock/after-buy.json";
import restored from "../../../fixtures/dood-shock/restored.json";

// A replay of three snapshots recorded on a local validator cloned from mainnet, around one
// ordinary DOOD buy and its exact inverse sell. Fixed request: 1,000 DOOD of collateral; each
// lender asks for the spot lender's limit after the buy.

/** One simulated loan request: the slot, the refusal if any, and the program's receipt. */
type Simulation = {
  slot: number;
  err: unknown;
  reason: string | null;
  receipt: { limit: string } | null;
};

/** One recorded snapshot of the pool and the Mimir feed, with three simulated requests. */
type RecordedSnapshot = {
  label: string;
  pool: { spot: number };
  mimir: { fresh: boolean; lower: number; refreshSlot: number };
  spotLender: Simulation;
  mimirLender: Simulation;
  mimirLimit: Simulation;
};

const COLLATERAL_TOKENS = 1000;
const USDC_DECIMALS = 6;

const before = baseline as RecordedSnapshot;
const afterBuy = moved as RecordedSnapshot;
const afterSell = restored as RecordedSnapshot;

/** The element with this id (it always exists in index.html). */
function element(id: string): HTMLElement {
  return document.getElementById(id)!;
}

/** Formats USDC atoms as USDC with 3 decimals. */
function formatUsdc(usdcAtoms: string | number): string {
  return (Number(usdcAtoms) / 10 ** USDC_DECIMALS).toFixed(3);
}

/** The change from `previous` to `current`, as a signed percentage. */
function percentChange(current: number, previous: number): string {
  const sign = current > previous ? "+" : "";
  return `${sign}${((current / previous - 1) * 100).toFixed(1)}%`;
}

/** The collateral's value in USDC at the pool spot price of a snapshot. */
function collateralValue(snapshot: RecordedSnapshot): number {
  return COLLATERAL_TOKENS * snapshot.pool.spot;
}

/** What the Mimir lender would lend at this snapshot. */
function describeMimirLimit(snapshot: RecordedSnapshot): string {
  const receipt = snapshot.mimirLimit.receipt;
  if (!receipt) return "Mimir price not Fresh: loan declined";
  return `Mimir limit ${formatUsdc(receipt.limit)} USDC`;
}

/** Lists the three snapshots with the pool spot and the Mimir limit. */
function showSteps() {
  const spotMove = percentChange(afterBuy.pool.spot, before.pool.spot);
  const steps: [RecordedSnapshot, string][] = [
    [before, "Baseline"],
    [afterBuy, `After one buy (spot ${spotMove})`],
    [afterSell, "After the exact inverse sell"],
  ];
  const items = steps.map(([snapshot, title]) => {
    const spot = snapshot.pool.spot.toFixed(7);
    const slots =
      `spot simulation slot ${snapshot.spotLender.slot} · ` +
      `Mimir simulation slot ${snapshot.mimirLimit.slot}`;
    return (
      `<li><b>${title}</b>` +
      `<span>Pool spot ${spot} USDC · ${describeMimirLimit(snapshot)}</span>` +
      `<small>${slots}</small></li>`
    );
  });
  element("steps").innerHTML = items.join("");
}

/** Fills one lender's card: kind is "pass" or "fail". */
function showLender(id: "spot" | "mimir", kind: string, title: string, detail: string) {
  const label = id === "spot" ? "POOL SPOT LENDER" : "MIMIR LENDER";
  const card = element(id);
  card.className = `decision ${kind}`;
  card.innerHTML = `<small>${label}</small><b>${title}</b><span>${detail}</span>`;
}

/** Compares both lenders after the buy: the spot lender lends and keeps bad debt once the price
 * returns; the Mimir lender declines. */
function showComparison() {
  const spotReceipt = afterBuy.spotLender.receipt;
  const lent = spotReceipt ? Number(spotReceipt.limit) / 10 ** USDC_DECIMALS : 0;
  const valueAfterSell = collateralValue(afterSell);
  const badDebt = Math.max(0, lent - valueAfterSell);
  showLender(
    "spot",
    "fail",
    `${lent.toFixed(3)} USDC lent`,
    `Bad debt ${badDebt.toFixed(3)} USDC once the price returns ` +
      `(collateral worth ${valueAfterSell.toFixed(3)} USDC)`,
  );

  const mimirDeclined = Boolean(afterBuy.mimirLender.err);
  const mimirTitle = mimirDeclined
    ? "Loan declined"
    : `${formatUsdc(afterBuy.mimirLender.receipt!.limit)} USDC lent`;
  const mimirReason = mimirDeclined ? "Price not Fresh after the jump" : "Inside the Mimir limit";
  showLender("mimir", "pass", mimirTitle, `${mimirReason} · bad debt 0.000 USDC`);

  element("evidence").textContent =
    `Same ${lent.toFixed(3)} USDC request for both lenders, simulated at slot ` +
    `${afterBuy.spotLender.slot} (spot) and ${afterBuy.mimirLender.slot} (Mimir).`;
}

showSteps();
showComparison();
