import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { LOCAL_WALLET_PATH } from "./src/local-wallet-path.ts";

/** The throwaway keypair written by `npm run localnet` (gitignored). */
const KEYPAIR_FILE = fileURLToPath(new URL("../../.localnet/test-wallet.json", import.meta.url));
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
const LOOPBACK_ADDRESSES = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

/** True when the RPC URL points at this machine. */
function isLocalRpc(rpcUrl: string | undefined): boolean {
  try {
    return LOOPBACK_HOSTS.includes(new URL(rpcUrl ?? "").hostname);
  } catch {
    return false;
  }
}

/**
 * Serves the local test wallet's secret key to the app, so it can sign on a local validator
 * without a wallet extension. Dev server only (`apply: "serve"`): a build never contains it.
 * It refuses unless VITE_RPC_URL is a localhost URL and the request comes from this machine.
 */
export function localTestWallet(): Plugin {
  return {
    name: "mimir-local-test-wallet",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(LOCAL_WALLET_PATH, (request, response) => {
        const rpcUrl = server.config.env.VITE_RPC_URL;
        const fromThisMachine = LOOPBACK_ADDRESSES.includes(request.socket.remoteAddress ?? "");
        if (!isLocalRpc(rpcUrl) || !fromThisMachine) {
          response.statusCode = 403;
          response.end("Refused: VITE_RPC_URL is not a localhost RPC.");
          return;
        }
        if (!existsSync(KEYPAIR_FILE)) {
          response.statusCode = 404;
          response.end("No .localnet/test-wallet.json: run `npm run localnet` first.");
          return;
        }
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        response.end(readFileSync(KEYPAIR_FILE));
      });
    },
  };
}
