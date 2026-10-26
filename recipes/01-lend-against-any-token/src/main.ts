import { Buffer } from "buffer";
import "./style.css";

// web3.js and the Mimir SDK expect these Node globals in the browser.
globalThis.Buffer ??= Buffer;
(globalThis as any).process ??= { env: {} };

// Imported after the globals above are set.
const { atoms, borrow, Connection, demo, explain, position, preview, settle, tokenMint, Tag } =
  await import("mimir-easy/consumer");
const { setupWallet } = await import("mimir-easy/wallet-choice");

/** The loan in USDC. The collateral is sized at twice its value at Mimir's lower bound. */
const LOAN_USDC = 1;
const COLLATERAL_TO_LOAN = 2;
const USDC_DECIMALS = 6;

const connection = new Connection(demo.rpc, "confirmed");
const token = tokenMint(connection);

/** The element with this id (it always exists in index.html). */
function element(id: string): HTMLElement {
  return document.getElementById(id)!;
}

const getWallet = setupWallet(demo.rpc, element("actions"));

/** Shows the program's decision: kind is "pass", "fail" or "neutral". */
function showDecision(kind: string, title: string, detail: string) {
  const card = element("decision");
  card.className = `decision ${kind}`;
  card.innerHTML = `<b>${title}</b><span>${detail}</span>`;
}

/** Shows a transaction signature under the card. */
function showEvidence(text: string) {
  element("evidence").textContent = text;
}

/** Reads and shows the user's position (collateral and debt), and returns it. */
async function showPosition(walletAddress: string) {
  const current = await position(connection, walletAddress);
  const { decimals, ticker } = await token;
  const collateral = Number(current.collateral) / 10 ** decimals;
  const debt = Number(current.debt) / 10 ** USDC_DECIMALS;
  element("position").textContent =
    `Your position: ${collateral} ${ticker} collateral · ${debt} USDC debt`;
  return current;
}

/** Step 1: simulates Mimir's refresh and shows whether the price is Fresh. */
async function onRefresh() {
  try {
    const { token: price } = await preview(connection);
    const title = price.fresh ? "Price is Fresh" : "Loan declined";
    const lower = `Lower bound: ${price.lower.toPrecision(6)} USDC per ${price.ticker}`;
    showDecision(price.fresh ? "pass" : "fail", title, lower);
  } catch (error) {
    showDecision("fail", "Refresh refused", explain(error));
  }
}

/** Step 2: refreshes Mimir and borrows in one transaction; the program checks the lower bound. */
async function onBorrow() {
  try {
    const wallet = await getWallet();
    const { decimals, ticker } = await token;
    showDecision("neutral", "Checking onchain…", "Mimir refresh + lower-bound LTV");
    const { token: price } = await preview(connection, wallet.address);
    const collateral = (COLLATERAL_TO_LOAN * LOAN_USDC) / price.lower;
    const result = await borrow(
      connection,
      wallet,
      atoms(collateral, decimals),
      atoms(LOAN_USDC, USDC_DECIMALS),
    );
    const locked = `${collateral.toPrecision(4)} ${ticker} locked`;
    showDecision("pass", "Loan approved", `${LOAN_USDC} USDC sent · ${locked}`);
    showEvidence(`Transaction ${result.signature}`);
    await showPosition(wallet.address);
  } catch (error) {
    showDecision("fail", "Loan declined", explain(error));
  }
}

/** Step 3: repays all debt, then releases all collateral. Neither step reads a price. */
async function onRepay() {
  try {
    const wallet = await getWallet();
    const current = await showPosition(wallet.address);
    if (current.debt > 0n) {
      const repaid = await settle(connection, wallet, Tag.Repay, current.debt);
      showEvidence(`Repaid: transaction ${repaid.signature}`);
    }
    const released = await settle(connection, wallet, Tag.Release);
    showDecision("pass", "Collateral released", "Debt repaid · collateral back in your wallet");
    showEvidence(`Released: transaction ${released.signature}`);
    await showPosition(wallet.address);
  } catch (error) {
    showDecision("fail", "Release refused", explain(error));
  }
}

element("refresh").onclick = onRefresh;
element("borrow").onclick = onBorrow;
element("repay").onclick = onRepay;
