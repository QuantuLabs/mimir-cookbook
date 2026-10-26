# Lend against any token

> [!WARNING]
> **Demonstration only, not audited.** This code shows how a program reads a Mimir price. Don't deploy or use it as-is with real funds.
>
> The tokens shown here (DOOD and others) are examples only. Mimir doesn't support, endorse or recommend any token mentioned.

## What it shows

A small vault lends USDC against a token valued at Mimir's lower bound, not at the pool spot.
Mimir is refreshed inside the borrow transaction; if the price is not Fresh, the loan is declined
and no token moves. Repay and release then return the collateral without reading a price.

<table><tr><td width="33%"><a href="../../assets/01-step1.webp"><img src="../../assets/01-step1.webp" alt="Refresh price. Mimir is Fresh, with a lower bound of 0.002201 USDC per DOOD."></a></td><td width="33%"><a href="../../assets/01-step2.webp"><img src="../../assets/01-step2.webp" alt="Borrow. 1 USDC against 1,000 DOOD, checked at the lower bound in the same transaction."></a></td><td width="33%"><a href="../../assets/01-step3.webp"><img src="../../assets/01-step3.webp" alt="Repay and release. The debt goes back to 0 and the DOOD returns to the wallet."></a></td></tr><tr><td>1. Refresh price. Mimir is Fresh, with a lower bound of 0.002201 USDC per DOOD.</td><td>2. Borrow. 1 USDC against 1,000 DOOD, checked at the lower bound in the same transaction.</td><td>3. Repay and release. The debt goes back to 0 and the DOOD returns to the wallet.</td></tr></table>

Recorded on a local validator cloned from mainnet, with DOOD as collateral.

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
   npm run dev -w 01-lend-against-any-token
   ```

   Open the URL it prints. Click **Use the local test wallet**, then **Refresh price** (you should see *Price is Fresh* and the lower bound), **Borrow 1 USDC** (*Loan approved*, a transaction signature, and your position: collateral and 1 USDC debt) and **Repay and release** (*Collateral released*, position back to 0).

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

The client builds one transaction (refresh, then borrow); the program checks freshness and the
bound and decides.

1. **Refresh.** [`refreshed()`](../../packages/mimir-easy/src/consumer.ts) asks the Mimir SDK for the refresh instruction of
   the feed. Anyone can refresh; the user pays.
2. **Size the loan.** [`onBorrow()`](src/main.ts) simulates a refresh with
   [`preview()`](../../packages/mimir-easy/src/consumer.ts) to read the lower bound, then sizes the collateral at twice the loan:

   ```ts
   const { token: price } = await preview(connection, wallet.address);
   const collateral = (COLLATERAL_TO_LOAN * LOAN_USDC) / price.lower;
   ```

3. **Refresh + borrow in one transaction.** [`checkBorrow()`](../../packages/mimir-easy/src/consumer.ts) puts the refresh
   right before the consumer instruction ([`consumerInstruction()`](../../packages/mimir-easy/src/consumer.ts)), simulates it,
   and [`borrow()`](../../packages/mimir-easy/src/consumer.ts) signs and sends it only if the simulation passed.
4. **The program checks freshness.** [`check_fresh()`](../../programs/mimir-cookbook/src/lib.rs) requires Mimir's refresh of this
   feed among the two previous instructions, then [`fresh_at()`](../../programs/mimir-cookbook/src/lib.rs) checks the status, the
   validity window and a non-zero lower bound. Otherwise: error 1, *price is not Fresh*.
5. **The program decides at the lower bound.** In [`borrow()`](../../programs/mimir-cookbook/src/lib.rs):

   ```rust
   let price_q32 = mimir_lower_bound(feed_account, sysvar)?;
   let limit = loan_limit(deposit, price_q32, decimals, LTV_BPS)?; // 90% of the value
   if loan as u128 > limit {
       return Err(LIMIT);
   }
   ```

   It then moves the collateral into the vault, sends the USDC and records the position
   ([`record_position()`](../../programs/mimir-cookbook/src/lib.rs)).
6. **Repay and release.** [`onRepay()`](src/main.ts) calls [`settle()`](../../packages/mimir-easy/src/consumer.ts) with
   `Tag.Repay`, then `Tag.Release`; the program's [`settle()`](../../programs/mimir-cookbook/src/lib.rs) returns the collateral
   once the debt is zero. Neither step reads a price. Liquidation is out of scope: this is a
   teaching vault, not a lending protocol.

Measured in the recorded run:

- **Refresh + borrow:** 75,471 CU, 22 accounts (11 for the consumer), 1 signature, 5,000 lamports.
  The first borrow also opens a 16-byte position account.
- **Repay or release:** about 9,550 CU, 12 accounts, 5,000 lamports.
- **Price not Fresh:** the consumer returns error 1 and the transaction changes nothing.
