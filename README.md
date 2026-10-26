# Mimir Cookbook

> [!WARNING]
> **Demonstration only, not audited.** This code shows how a program reads a Mimir price. Don't deploy or use it as-is with real funds.
>
> The tokens shown here (DOOD and others) are examples only. Mimir doesn't support, endorse or recommend any token mentioned.

Three small apps where an onchain program reads a Mimir price and decides: lend, fill or decline.

| Recipe | What the program does |
|---|---|
| [Lend against any token](recipes/01-lend-against-any-token) | Lends USDC against a token valued at Mimir's lower bound; repay and release return the collateral |
| [Fair-price order](recipes/02-fair-price-order) | Pays a maker fill only inside Mimir's bound |
| [Price shock: spot vs Mimir](recipes/03-price-shock-spot-vs-mimir) | After a 25% pool buy the spot lender holds bad debt; the Mimir lender declines |

<table><tr><td width="33%"><a href="recipes/01-lend-against-any-token"><img src="assets/01-step2.webp" alt="Loan approved: 1 USDC against 1,000 DOOD"></a></td><td width="33%"><a href="recipes/02-fair-price-order"><img src="assets/02-step3.webp" alt="The same quote passes, then is refused after a +25% pool buy"></a></td><td width="33%"><a href="recipes/03-price-shock-spot-vs-mimir"><img src="assets/03-step3.webp" alt="The spot lender holds bad debt; the Mimir lender declined"></a></td></tr></table>

## Quick start

Needs Node.js 22.6+, Rust, and the Agave (Solana) CLI (`solana-test-validator`, `cargo build-sbf`).

```bash
git clone https://github.com/QuantuLabs/mimir-cookbook.git && cd mimir-cookbook
npm ci
npm run preflight                                   # read-only check of the feed on mainnet
(cd programs/mimir-cookbook && cargo build-sbf)     # build the teaching program
RPC=<your mainnet RPC URL> npm run localnet         # local copy of mainnet + a funded test wallet; leave it running
```

In a second terminal, put the two lines `npm run localnet` printed in `.env.local`, then run an app:

```bash
printf 'VITE_RPC_URL=http://127.0.0.1:8899\nVITE_CONSUMER=<program address it printed>\n' > .env.local
npm run dev -w 01-lend-against-any-token            # or 02-fair-price-order, 03-price-shock-spot-vs-mimir
```

Click **Use the local test wallet** (shown only on a localhost RPC), then follow the buttons. Each
recipe README has the full steps, what you should see, and troubleshooting.

- The program is a teaching vault: never fund it on mainnet. Nothing trades on the local copy, so
  after a minute or two its price is no longer Fresh and the apps decline, as they should; rerun
  `npm run localnet` to clone current pools.
- Without `.env.local` the apps read mainnet (SOL/USDC feed, see `.env.example`). The public
  endpoint refuses browser requests: set `VITE_RPC_URL` to your own.
- `npm run check` type-checks, `npm test` runs the program's unit tests, `npm run format` formats
  TypeScript (Prettier) and Rust (`cargo fmt`).

The pictures were recorded on a local validator cloned from mainnet, with DOOD, a token that trades in one Raydium USDC pool.

The apps share one small Pinocchio program and the browser client in [`packages/mimir-easy`](packages/mimir-easy/src/consumer.ts). The Mimir SDK is not on npm yet; `vendor/` holds the build the apps use.

**Boundary and trust:** each feed here reads one pool, so a move that pool accepts moves the price. You trust the feed and its limits, its source pool, and the upgrade authorities of Mimir and of your program (`npm run preflight` prints them).

## Links

- Mimir app, to create a feed for your token: https://app.mimirfeeds.io
- Documentation: https://mimirfeeds.io/docs/ (cookbook pages: https://mimirfeeds.io/docs/cookbook/)
