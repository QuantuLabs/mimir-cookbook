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

## Run

```bash
npm ci
npm run preflight                         # read-only: checks the feed and refreshes it in a simulation on mainnet
npm run dev -w 01-lend-against-any-token
```

- The defaults are mainnet and the SOL/USDC Mimir feed (see `.env.example`). To change them, copy it to `.env.local`. The public mainnet endpoint serves `npm run preflight` but refuses browser requests: set `VITE_RPC_URL` to your own endpoint for the apps.
- **Refresh price** reads mainnet through your endpoint. Borrow, fill and repay need the program in [`programs/mimir-cookbook`](programs/mimir-cookbook). It is a teaching vault: never fund it on mainnet. Run it on a local copy of mainnet instead:

  ```bash
  (cd programs/mimir-cookbook && cargo build-sbf)
  npm run localnet -- <your wallet address>   # clones Mimir, the feed and its pools; funds your wallet and the vaults
  ```

  Put the two lines it prints in `.env.local`, then run an app. Nothing trades on the local copy, so after a minute or two its price is no longer Fresh and the apps decline, as they should; run `npm run localnet` again to clone current pools.
- `npm run check` type-checks the apps; `npm test` runs the program's unit tests (Rust).

The pictures were recorded on a local validator cloned from mainnet, with DOOD, a token that trades in one Raydium USDC pool.

The apps share one small Pinocchio program and the browser client in [`packages/mimir-easy`](packages/mimir-easy/src/consumer.ts). The Mimir SDK is not on npm yet; `vendor/` holds the build the apps use.

**Boundary and trust:** each feed here reads one pool, so a move that pool accepts moves the price. You trust the feed and its limits, its source pool, and the upgrade authorities of Mimir and of your program (`npm run preflight` prints them).

## Links

- Mimir app, to create a feed for your token: https://app.mimirfeeds.io
- Documentation: https://mimirfeeds.io/docs/ (cookbook pages: https://mimirfeeds.io/docs/cookbook/)
