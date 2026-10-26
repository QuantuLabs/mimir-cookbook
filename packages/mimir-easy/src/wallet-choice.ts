import { connectLocalWallet, connectWallet, isLocalRpc, type MimirWallet } from "./index.ts";

type NamedWallet = MimirWallet & { name: string };

/**
 * Lets the user pick a wallet. On a localhost RPC it adds a "Use the local test wallet" button
 * after `actions`; elsewhere only the browser wallet (Wallet Standard extension) is offered.
 * Returns a function that gives the chosen wallet, connecting the browser wallet on first use.
 */
export function setupWallet(rpcUrl: string, actions: HTMLElement): () => Promise<NamedWallet> {
  let wallet: NamedWallet | undefined;
  const status = document.createElement("p");
  status.id = "wallet";
  status.className = "muted";
  actions.after(status);

  /** Shows which wallet signs. */
  function showWallet(chosen: NamedWallet) {
    status.textContent = `Signing with ${chosen.name}: ${chosen.address}`;
  }

  if (isLocalRpc(rpcUrl)) {
    const button = document.createElement("button");
    button.id = "use-local-wallet";
    button.className = "ghost";
    button.textContent = "Use the local test wallet";
    button.onclick = async () => {
      try {
        wallet = await connectLocalWallet(rpcUrl);
        showWallet(wallet);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    };
    actions.append(button);
  }

  return async () => {
    if (!wallet) {
      wallet = await connectWallet();
      showWallet(wallet);
    }
    return wallet;
  };
}
