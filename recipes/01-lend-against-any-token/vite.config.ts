import { defineConfig } from "vite";
import { localTestWallet } from "../../packages/mimir-easy/vite-plugin.ts";

/** Reads .env.local from the repository root and serves the local test wallet in dev. */
export default defineConfig({
  envDir: "../..",
  plugins: [localTestWallet()],
  server: { port: 5171 },
  preview: { port: 5171 },
});
