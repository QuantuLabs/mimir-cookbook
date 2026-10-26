# Fair-price order

> [!WARNING]
> **Demonstration only, not audited.** This code shows how a program reads a Mimir price. Don't deploy or use it as-is with real funds.
>
> The tokens shown here (DOOD and others) are examples only. Mimir doesn't support, endorse or recommend any token mentioned.

## What it shows

A maker buys the user's tokens for USDC. The program pays only if the payout sits inside Mimir's
bound (± 1%), checked in the same transaction as the refresh. The page also replays one recorded
quote that passes before a +25% pool buy and is refused after it.

<table><tr><td width="33%"><a href="../../assets/02-step1.webp"><img src="../../assets/02-step1.webp" alt="The order. A maker offers USDC for 100 DOOD; the program checks Mimir's bound in the same transaction."></a></td><td width="33%"><a href="../../assets/02-step2.webp"><img src="../../assets/02-step2.webp" alt="Before the move. The 0.221717 USDC quote sits inside the bound and passes."></a></td><td width="33%"><a href="../../assets/02-step3.webp"><img src="../../assets/02-step3.webp" alt="After a +25% pool buy. The same quote is refused: the price is not Fresh."></a></td></tr><tr><td>1. The order. A maker offers USDC for 100 DOOD; the program checks Mimir's bound in the same transaction.</td><td>2. Before the move. The 0.221717 USDC quote sits inside the bound and passes.</td><td>3. After a +25% pool buy. The same quote is refused: the price is not Fresh.</td></tr></table>

Recorded on a local validator cloned from mainnet, with DOOD.

A maker buys 100 DOOD, and the program refreshes Mimir and pays only between 99% of the lower bound and 101% of the upper bound. The same quote passed before a 25% pool buy and was refused after it, in recorded simulations. A Mimir refresh cannot share a transaction with a write to its source pool, so this is a maker exchange, not a swap through that pool.

## Run it on your machine

**Prerequisites** (tested versions in brackets):

- Node.js 22.6 or later, with npm 10 or later [Node 24.20, npm 11.19]
- Rust with `rustup` [rustc 1.98]
- The Agave (Solana) CLI, which brings `solana-test-validator` and `cargo build-sbf`
  [solana-cli 4.2, cargo-build-sbf 4.1]: https://docs.anza.xyz/cli/install
- A mainnet RPC endpoint of your own (any provider) is recommended: the public one is rate limited.

**Steps**, from an empty folder:

1. Get the code.

   ```bash
   git clone https://github.com/QuantuLabs/mimir-cookbook.git
   cd mimir-cookbook
   ```

2. Install the dependencies.

   ```bash
   npm ci
   ```

   You should see `added … packages` and no error.

3. Check the feed on mainnet (read-only: it simulates a refresh, signs nothing).

   ```bash
   npm run preflight
   ```

   You should see a JSON report with `"refresh": { … "fresh": true … }` and `"failures": []`.

4. Build the program.

   ```bash
   (cd programs/mimir-cookbook && cargo build-sbf)
   ```

   You should see `Finished release`. It writes `programs/mimir-cookbook/target/deploy/mimir_cookbook.so`
   and the program keypair next to it.

5. Start a local validator cloned from mainnet. Leave it running in its own terminal.

   ```bash
   RPC=<your mainnet RPC URL> npm run localnet
   ```

   Without `RPC` it clones from the public endpoint. It clones Mimir, the feed and its pools, loads
   your program, creates a throwaway test wallet in `.localnet/test-wallet.json` (gitignored) and
   funds it with SOL, the feed's token and the vaults with USDC. You should see:

   ```text
   Local test wallet (.localnet/test-wallet.json): <address>
   Add to .env.local, then run an app:
   VITE_RPC_URL=http://127.0.0.1:8899
   VITE_CONSUMER=<your program address>
   ```

   then the validator's status line. To fund your own wallet instead, pass its address:
   `npm run localnet -- <your wallet address>`.

6. In a second terminal, create `.env.local` at the repository root with the two lines it printed.

   ```bash
   printf 'VITE_RPC_URL=http://127.0.0.1:8899\nVITE_CONSUMER=<your program address>\n' > .env.local
   ```

7. Run the app.

   ```bash
   npm run dev -w 02-fair-price-order
   ```

   Open the URL it prints. Click **Use the local test wallet**, then **Refresh price** (the bound, in USDC per token) and **Place protected order**: you should see *Order filled* and a shortened signature. Below, the recorded replay shows the same quote *passes* before the move and is *refused* after it.

**Troubleshooting**

- *"This RPC endpoint refuses browser requests"*: the public mainnet endpoint serves scripts but
  not browsers. Set `VITE_RPC_URL` in `.env.local` to your own endpoint, or to the localnet URL.
- *The price is no longer Fresh after a minute or two on localnet*: expected. Nothing trades on the
  local copy, so the Mimir price ages out and the program declines, as it should. Stop the validator
  (Ctrl-C) and run `npm run localnet` again to clone current pools.
- *A port is busy* (`Address already in use`): another validator is running. Pick free ports, then
  use the new RPC port in `.env.local`:

  ```bash
  LOCALNET_ARGS="--rpc-port 8999 --faucet-port 9999 --gossip-port 8100 --dynamic-port-range 8110-8140" npm run localnet
  ```

- *No wallet extension signs on localhost*: use **Use the local test wallet**. It appears only when
  `VITE_RPC_URL` is a localhost URL. The vite dev server serves the key from `.localnet/`; a build
  never contains it, and the server refuses it for any other RPC. Browser wallets (Solflare,
  Phantom, Backpack) stay available for mainnet reads and your own deployments.

## How it works

1. **Read the price.** [`onFill()`](src/main.ts) simulates a refresh with
   [`preview()`](../../packages/mimir-easy/src/consumer.ts) and prices the order at the Mimir price:

   ```ts
   const collateral = atoms(ORDER_USDC / price.price, decimals);
   const payoutUsdc = (price.price * Number(collateral)) / 10 ** decimals;
   ```

2. **Refresh + fill in one transaction.** [`checkFill()`](../../packages/mimir-easy/src/consumer.ts) puts Mimir's refresh
   before the consumer instruction with `Tag.ProtectedFill`, simulates it, and
   [`fill()`](../../packages/mimir-easy/src/consumer.ts) signs and sends it. The fill does not write the pool Mimir reads,
   so the refresh and the check can share one transaction.
3. **The program checks freshness**: [`check_fresh()`](../../programs/mimir-cookbook/src/lib.rs) and [`fresh_at()`](../../programs/mimir-cookbook/src/lib.rs),
   as in recipe 01.
4. **The program checks the bound.** [`check_fill_inside_bound()`](../../programs/mimir-cookbook/src/lib.rs) accepts a payout
   between 99% of the value at the lower bound and 101% of the value at the upper bound:

   ```rust
   let minimum = mul(value_at_lower, FILL_MIN_BPS)? / BPS;
   let maximum = mul(value_at_upper, FILL_MAX_BPS)? / BPS;
   if payout < minimum || payout > maximum {
       return Err(ORDER);
   }
   ```

   Outside it: error 3, *outside the price bound*. Inside, [`borrow()`](../../programs/mimir-cookbook/src/lib.rs) moves the tokens
   to the vault and the USDC to the user.
5. **The recorded replay.** [`showRecordedQuotes()`](src/main.ts) lists the same maker quote from
   [`fixtures/dood-shock`](../../fixtures/dood-shock), simulated before and after a +25% pool buy.

Measured in the recorded run:

- **Refresh + fill:** 73,623 CU in simulation, 9 program accounts, 1 signature, 5,000 lamports.
- **Price not Fresh:** the program returns error 1 and no token moves.
