import { Buffer } from "buffer";
import "./style.css";
import baseline from "../../../fixtures/dood-shock/baseline.json";
import moved from "../../../fixtures/dood-shock/after-buy.json";

// web3.js and the Mimir SDK expect these Node globals in the browser.
globalThis.Buffer ??= Buffer;
(globalThis as any).process ??= { env: {} };

// Imported after the globals above are set.
const { atoms, Connection, demo, explain, fill, preview, tokenMint } =
  await import("mimir-easy/consumer");
const { setupWallet } = await import("mimir-easy/wallet-choice");

/** The order sells tokens worth about this much USDC. */
const ORDER_USDC = 1;
const USDC_DECIMALS = 6;
/** localStorage key of the last fill, so a reload still shows it. */
const SAVED_FILL_KEY = "mimir-fair-fill";

/** One recorded maker quote: the USDC payout, and why the program refused it, if it did. */
type Quote = { payout: string; slot: number; err: unknown; reason: string | null };
type SavedFill = { wallet: string; genesis: string; signature: string };

const connection = new Connection(demo.rpc, "confirmed");
const token = tokenMint(connection);

/** The element with this id (it always exists in index.html). */
function element(id: string): HTMLElement {
  return document.getElementById(id)!;
}

const getWallet = setupWallet(demo.rpc, element("actions"));

/** Shortens a signature to its first and last 8 characters. */
function shorten(signature: string): string {
  return `${signature.slice(0, 8)}…${signature.slice(-8)}`;
}

/** Shows the order's state: kind is "pass", "fail" or "neutral". */
function showOrder(kind: string, title: string, detail: string) {
  const card = element("normal");
  card.className = `decision ${kind}`;
  card.innerHTML = `<small>PROTECTED ORDER</small><b>${title}</b><span>${detail}</span>`;
}

/** Shows the saved fill only if it belongs to this cluster and its signature is still
 * confirmed for that wallet; otherwise forgets it. */
async function restoreSavedFill() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_FILL_KEY) ?? "null") as SavedFill | null;
    if (!saved || saved.genesis !== (await connection.getGenesisHash())) return;
    const sent = await connection.getTransaction(saved.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const feePayer = sent?.transaction.message.staticAccountKeys[0]!.toBase58();
    if (sent && !sent.meta?.err && feePayer === saved.wallet) {
      showOrder("pass", "Order filled", shorten(saved.signature));
    } else {
      localStorage.removeItem(SAVED_FILL_KEY);
    }
  } catch {
    // A saved fill is a convenience: ignore any error reading it.
  }
}

/** Lists the recorded replay: one fixed maker quote before and after a +25% buy on the DOOD
 * pool (unsigned simulations saved in fixtures/dood-shock). */
function showRecordedQuotes() {
  const quotes = [baseline.makerQuote, moved.makerQuote] as Quote[];
  const items = quotes.map((quote, index) => {
    const when = index === 0 ? "Before the move" : "After a +25% pool buy";
    const verdict = quote.err ? "refused" : "passes";
    const payout = (Number(quote.payout) / 10 ** USDC_DECIMALS).toFixed(6);
    const reason = quote.reason ?? "inside the Mimir bound ± 1%";
    return (
      `<li class="${quote.err ? "fail" : "pass"}"><b>${when}: ${verdict}</b>` +
      `<span>${payout} USDC for 100 DOOD · ${reason} · slot ${quote.slot}</span></li>`
    );
  });
  element("replay").innerHTML = items.join("");
}

/** Simulates Mimir's refresh and shows the bound the program will check. */
async function onRefresh() {
  try {
    const refreshed = await preview(connection);
    const price = refreshed.token;
    const bound = `${price.lower.toPrecision(6)} to ${price.upper.toPrecision(6)}`;
    const notFresh = price.fresh ? "" : " (not Fresh)";
    element("evidence").textContent =
      `Mimir bound refreshed at slot ${refreshed.slot}: ` +
      `${bound} USDC per ${price.ticker}${notFresh}.`;
  } catch (error) {
    element("evidence").textContent = explain(error);
  }
}

/** Sells about ORDER_USDC of tokens at the Mimir price. The refresh and the program's bound
 * check run in the same transaction. */
async function onFill() {
  try {
    const wallet = await getWallet();
    const { decimals } = await token;
    const { token: price } = await preview(connection, wallet.address);
    const collateral = atoms(ORDER_USDC / price.price, decimals);
    const payoutUsdc = (price.price * Number(collateral)) / 10 ** decimals;
    const payout = BigInt(Math.floor(payoutUsdc * 10 ** USDC_DECIMALS));
    showOrder("neutral", "Checking onchain…", "Refresh + protected exchange");
    const result = await fill(connection, wallet, collateral, payout);
    const genesis = await connection.getGenesisHash();
    const saved: SavedFill = { wallet: wallet.address, genesis, signature: result.signature };
    localStorage.setItem(SAVED_FILL_KEY, JSON.stringify(saved));
    showOrder("pass", "Order filled", shorten(result.signature));
    element("evidence").textContent = result.signature;
  } catch (error) {
    showOrder("fail", "Order declined", explain(error));
  }
}

restoreSavedFill();
showRecordedQuotes();
element("refresh").onclick = onRefresh;
element("fill").onclick = onFill;
