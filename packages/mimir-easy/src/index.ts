import { ComputeBudgetProgram, Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { Address } from "@solana/kit";
import * as V1 from "@quantulabs/mimir-sdk/v1";
import type * as B from "@quantulabs/mimir-sdk/beta";
import { Buffer } from "buffer";
import { getWallets } from "@wallet-standard/app";

// web3.js 1.x and the SDK refresh path expect a global Buffer in the browser.
globalThis.Buffer ??= Buffer;

/** Any wallet that signs raw transaction bytes: Wallet Standard `solana:signTransaction`, or a local keypair in scripts. */
export type MimirWallet = {
  address: string;
  signTransaction(tx: Uint8Array): Promise<Uint8Array>;
  /** False for wallets that cannot sign Transaction v1 yet (Phantom, Backpack). */
  supportsV1?: boolean;
};

/** An unsigned transaction: legacy-compatible v0 when it fits, Transaction v1 only when it has to. */
export type PreparedTransaction = { version: 0 | 1; bytes: Uint8Array; blockhash: string; lastValidBlockHeight: number };

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const text = (b: Uint8Array) => String.fromCharCode(...b);

const genesis = new WeakMap<Connection, Promise<string>>();
async function cluster(connection: Connection) {
  if (!genesis.has(connection)) genesis.set(connection, connection.getGenesisHash());
  return (await genesis.get(connection)) === MAINNET_GENESIS ? "mainnet" as const : "localnet" as const;
}

export const toWeb3 = (ix: B.MimirBetaInstruction) => new TransactionInstruction({
  programId: new PublicKey(ix.programAddress),
  keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.address), isSigner: a.isSigner, isWritable: a.isWritable })),
  data: Buffer.from(ix.data),
});

/** Compute budget + Mimir's refresh for this feed (a token feed or an index). Anyone can refresh. */
export async function refreshInstructions(connection: Connection, feed: string, payer: string): Promise<TransactionInstruction[]> {
  const account = await connection.getAccountInfo(new PublicKey(feed), "confirmed");
  if (!account) throw new Error(`No Mimir price feed at ${feed}`);
  const opts = { programId: account.owner.toBase58() as Address, cluster: await cluster(connection) };
  const r = text(account.data.subarray(0, 8)) === "MIMIRCSP"
    ? await V1.prepareMimirV1CompositeRefresh(connection, feed as Address, payer as Address, opts)
    : await V1.prepareMimirV1ClassicRefresh(connection, feed as Address, opts);
  return [ComputeBudgetProgram.setComputeUnitLimit({ units: r.computeUnitLimit }), toWeb3(r.instruction)];
}

/** Signs with the wallet, sends, and waits for confirmation. Returns the signature. */
export async function signAndSend(connection: Connection, wallet: MimirWallet, tx: PreparedTransaction): Promise<string> {
  if (tx.version === 1 && wallet.supportsV1 === false) throw new Error("This step needs a Transaction v1 wallet. Solflare signs it today; Phantom and Backpack do not yet.");
  const signed = await wallet.signTransaction(tx.bytes);
  const signature = await connection.sendRawTransaction(signed, { skipPreflight: false, maxRetries: 3 });
  const { value } = await connection.confirmTransaction({ signature, blockhash: tx.blockhash, lastValidBlockHeight: tx.lastValidBlockHeight }, "confirmed");
  if (value.err) throw new Error(`Transaction failed: ${JSON.stringify(value.err)}`);
  return signature;
}

/** Connects the first Wallet Standard wallet that can sign Solana transactions (Solflare, Phantom, Backpack…). */
export async function connectWallet(chain = "solana:mainnet"): Promise<MimirWallet & { name: string }> {
  const w = getWallets().get().find((x) => "solana:signTransaction" in x.features && "standard:connect" in x.features);
  if (!w) throw new Error("No Solana wallet found. Install Solflare, Phantom or Backpack.");
  const f = w.features as Record<string, any>;
  const { accounts } = await f["standard:connect"].connect();
  const account = accounts[0];
  return {
    name: w.name, address: account.address,
    // Wallets do not advertise Transaction v1 support yet; Solflare signs it today.
    supportsV1: !/phantom|backpack/i.test(w.name),
    async signTransaction(transaction) {
      const [out] = await f["solana:signTransaction"].signTransaction({ account, transaction, chain });
      return out.signedTransaction;
    },
  };
}
