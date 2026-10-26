import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Address } from "@solana/kit";
import * as V1 from "@quantulabs/mimir-sdk/v1";
import type * as B from "@quantulabs/mimir-sdk/beta";
import { Buffer } from "buffer";
import { getWallets } from "@wallet-standard/app";
import { LOCAL_WALLET_PATH } from "./local-wallet-path.ts";

// web3.js 1.x and the SDK refresh path expect a global Buffer in the browser.
globalThis.Buffer ??= Buffer;

/** Any wallet that signs raw transaction bytes: Wallet Standard `solana:signTransaction`,
 * or a local keypair. */
export type MimirWallet = {
  address: string;
  signTransaction(tx: Uint8Array): Promise<Uint8Array>;
  /** False for wallets that cannot sign Transaction v1 yet (Phantom, Backpack). */
  supportsV1?: boolean;
};

/** An unsigned transaction: legacy-compatible v0 when it fits,
 * Transaction v1 only when it has to. */
export type PreparedTransaction = {
  version: 0 | 1;
  bytes: Uint8Array;
  blockhash: string;
  lastValidBlockHeight: number;
};

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const COMPOSITE_MAGIC = "MIMIRCSP";

/** Decodes bytes as ASCII text. */
function asText(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

const genesisByConnection = new WeakMap<Connection, Promise<string>>();

/** Mainnet or localnet, from the genesis hash (asked once per connection). */
async function cluster(connection: Connection) {
  if (!genesisByConnection.has(connection)) {
    genesisByConnection.set(connection, connection.getGenesisHash());
  }
  const genesis = await genesisByConnection.get(connection);
  return genesis === MAINNET_GENESIS ? ("mainnet" as const) : ("localnet" as const);
}

/** Converts an SDK instruction into a web3.js TransactionInstruction. */
export function toWeb3(instruction: B.MimirBetaInstruction): TransactionInstruction {
  const keys = instruction.accounts.map((account) => ({
    pubkey: new PublicKey(account.address),
    isSigner: account.isSigner,
    isWritable: account.isWritable,
  }));
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programAddress),
    keys,
    data: Buffer.from(instruction.data),
  });
}

/** Compute budget + Mimir's refresh for this feed (a token feed or an index).
 * Anyone can refresh. */
export async function refreshInstructions(
  connection: Connection,
  feed: string,
  payer: string,
): Promise<TransactionInstruction[]> {
  const account = await connection.getAccountInfo(new PublicKey(feed), "confirmed");
  if (!account) throw new Error(`No Mimir price feed at ${feed}`);
  const options = {
    programId: account.owner.toBase58() as Address,
    cluster: await cluster(connection),
  };
  const isComposite = asText(account.data.subarray(0, 8)) === COMPOSITE_MAGIC;
  const refresh = isComposite
    ? await V1.prepareMimirV1CompositeRefresh(
        connection,
        feed as Address,
        payer as Address,
        options,
      )
    : await V1.prepareMimirV1ClassicRefresh(connection, feed as Address, options);
  const computeLimit = ComputeBudgetProgram.setComputeUnitLimit({
    units: refresh.computeUnitLimit,
  });
  return [computeLimit, toWeb3(refresh.instruction)];
}

/** Signs with the wallet, sends, and waits for confirmation. Returns the signature. */
export async function signAndSend(
  connection: Connection,
  wallet: MimirWallet,
  tx: PreparedTransaction,
): Promise<string> {
  if (tx.version === 1 && wallet.supportsV1 === false) {
    throw new Error(
      "This step needs a Transaction v1 wallet. " +
        "Solflare signs it today; Phantom and Backpack do not yet.",
    );
  }
  const signed = await wallet.signTransaction(tx.bytes);
  const signature = await connection.sendRawTransaction(signed, {
    skipPreflight: false,
    maxRetries: 3,
  });
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash: tx.blockhash, lastValidBlockHeight: tx.lastValidBlockHeight },
    "confirmed",
  );
  if (confirmation.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  return signature;
}

/** Connects the first Wallet Standard wallet that can sign Solana transactions
 * (Solflare, Phantom, Backpack…). */
export async function connectWallet(
  chain = "solana:mainnet",
): Promise<MimirWallet & { name: string }> {
  const wallet = getWallets()
    .get()
    .find((candidate) => {
      const features = candidate.features;
      return "solana:signTransaction" in features && "standard:connect" in features;
    });
  if (!wallet) throw new Error("No Solana wallet found. Install Solflare, Phantom or Backpack.");
  const features = wallet.features as Record<string, any>;
  const { accounts } = await features["standard:connect"].connect();
  const account = accounts[0];
  return {
    name: wallet.name,
    address: account.address,
    // Wallets do not advertise Transaction v1 support yet; Solflare signs it today.
    supportsV1: !/phantom|backpack/i.test(wallet.name),
    async signTransaction(transaction) {
      const request = { account, transaction, chain };
      const [output] = await features["solana:signTransaction"].signTransaction(request);
      return output.signedTransaction;
    },
  };
}

/** True when the RPC URL points at this machine (a local validator). */
export function isLocalRpc(rpcUrl: string): boolean {
  try {
    const hostname = new URL(rpcUrl).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/** A wallet that signs with a keypair held in memory. For a local validator only. */
export function keypairWallet(keypair: Keypair): MimirWallet & { name: string } {
  return {
    name: "Local test wallet",
    address: keypair.publicKey.toBase58(),
    supportsV1: false,
    async signTransaction(bytes) {
      const transaction = VersionedTransaction.deserialize(bytes);
      transaction.sign([keypair]);
      return transaction.serialize();
    },
  };
}

/** Loads the throwaway keypair that `npm run localnet` wrote to .localnet/. The vite dev server
 * serves it, and only when VITE_RPC_URL is a localhost URL. */
export async function connectLocalWallet(rpcUrl: string): Promise<MimirWallet & { name: string }> {
  if (!isLocalRpc(rpcUrl)) {
    throw new Error("The local test wallet only signs against a local validator.");
  }
  const response = await fetch(LOCAL_WALLET_PATH);
  if (!response.ok) {
    throw new Error(`Local test wallet unavailable: ${await response.text()}`);
  }
  const secretKey = Uint8Array.from((await response.json()) as number[]);
  return keypairWallet(Keypair.fromSecretKey(secretKey));
}
