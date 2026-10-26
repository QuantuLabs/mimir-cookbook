# Price shock: spot vs Mimir

> [!WARNING]
> **Demonstration only, not audited.** This code shows how a program reads a Mimir price. Don't deploy or use it as-is with real funds.
>
> The tokens shown here (DOOD and others) are examples only. Mimir doesn't support, endorse or recommend any token mentioned.

One pool buy makes a spot lender over-lend; the Mimir lender declines.

<table><tr><td width="33%"><a href="../../assets/03-step1.webp"><img src="../../assets/03-step1.webp" alt="Baseline. Both lenders allow 1.981 USDC on 1,000 DOOD."></a></td><td width="33%"><a href="../../assets/03-step2.webp"><img src="../../assets/03-step2.webp" alt="After one +25% buy. The spot lender lends 2.476 USDC; the Mimir lender declines."></a></td><td width="33%"><a href="../../assets/03-step3.webp"><img src="../../assets/03-step3.webp" alt="After the price returns. The spot lender holds 0.275 USDC of bad debt; the Mimir lender holds none."></a></td></tr><tr><td>1. Baseline. Both lenders allow 1.981 USDC on 1,000 DOOD.</td><td>2. After one +25% buy. The spot lender lends 2.476 USDC; the Mimir lender declines.</td><td>3. After the price returns. The spot lender holds 0.275 USDC of bad debt; the Mimir lender holds none.</td></tr></table>

Recorded on a local validator cloned from mainnet, with DOOD.

On the local validator, one 34,839 USDC buy lifted the DOOD pool spot by 25%, and an exact inverse sell brought it back; a buy that inflates the collateral is the adverse case for a lender. Both lenders got the same 1,000 DOOD request at 90% LTV: the spot lender lent 2.476 USDC, 0.275 USDC more than the collateral was worth once the price returned. Mimir marked the price not Fresh after the jump, so the Mimir lender declined and holds no bad debt. The app replays the three recorded snapshots, baseline, after the buy and after the restore, and shows every simulation slot. Both checks run onchain.

```rust
let price = if let [pool, base_vault, quote_vault] = extra { spot_price(feed, pool, base_vault, quote_vault)? }
    else { fresh(feed, sys)?; u128_at(&feed.try_borrow()?, 216)? >> 32 };
if loan as u128 > loan_limit(deposit, price, decimals, LTV_BPS)? { return Err(LIMIT); }
```

```ts
const spot = await checkBorrow(connection, payer, collateral, loan, 2);  // reads the pool spot
const mimir = await checkBorrow(connection, payer, collateral, loan, 0); // refreshes Mimir first
```

Measured in the recorded run:

- **Spot lender:** 20,905 CU. **Refresh + Mimir lender:** 73,999 CU, both simulated at slot 460064019.
- **Price not Fresh:** the Mimir lender returns error 1 and no token moves.

Run `npm run dev -w 03-price-shock-spot-vs-mimir`. It replays the recorded snapshots and needs no RPC; the data is in [`fixtures/dood-shock`](../../fixtures/dood-shock).
