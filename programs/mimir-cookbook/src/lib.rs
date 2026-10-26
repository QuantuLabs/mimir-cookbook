#![cfg_attr(not(test), no_std)]
//! Teaching vault that reads a Mimir price: borrow, protected fill, repay and release; no
//! liquidation. Never fund this on mainnet.
//!
//! Instructions (first byte of the data, then two u64 little-endian amounts):
//! - 0 `MIMIR_BORROW`: borrows USDC against a token valued at Mimir's lower bound.
//! - 1 `PROTECTED_FILL`: a maker pays USDC for tokens, only inside Mimir's bound.
//! - 2 `SPOT_LENDER`: the same loan valued at the pool spot price (the unsafe comparison).
//! - 3 `REPAY`: repays USDC debt. 4 `RELEASE`: returns the collateral once the debt is zero.
use pinocchio::{
    cpi::{invoke_signed_with_bounds, invoke_with_bounds, set_return_data, Seed, Signer},
    error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    sysvars::{clock::Clock, instructions::Instructions, rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};

/// hBYrGHXVCQsnduDERkVnViCXNYawpHCvN5y3GsMiMiR, the Mimir V1 program on mainnet.
const MIMIR: Address = Address::new_from_array([
    10, 75, 41, 9, 91, 115, 107, 245, 77, 34, 137, 133, 150, 137, 74, 160, 54, 103, 163, 3, 197,
    155, 195, 107, 129, 51, 46, 96, 136, 98, 253, 218,
]);
/// TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA, the SPL Token program.
const TOKEN: Address = Address::new_from_array([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237,
    95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
]);
/// EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v, USDC on mainnet.
const USDC: Address = Address::new_from_array([
    198, 250, 122, 243, 190, 219, 173, 58, 61, 101, 243, 106, 171, 201, 116, 49, 177, 187, 228,
    194, 210, 246, 224, 228, 124, 166, 2, 3, 69, 47, 93, 97,
]);

/// Instruction tags.
const MIMIR_BORROW: u8 = 0;
const PROTECTED_FILL: u8 = 1;
const SPOT_LENDER: u8 = 2;
const REPAY: u8 = 3;
const RELEASE: u8 = 4;
/// Tag, collateral (u64), loan or payout (u64).
const INSTRUCTION_DATA_LEN: usize = 17;

/// One in Q32 fixed point.
const Q32: u128 = 1 << 32;
const BPS: u128 = 10_000;
/// Loans up to 90% of the collateral value.
const LTV_BPS: u128 = 9_000;
/// A protected fill must pay between 99% of the lower-bound value and 101% of the
/// upper-bound value.
const FILL_MIN_BPS: u128 = 9_900;
const FILL_MAX_BPS: u128 = 10_100;
const USDC_ATOMS: u128 = 1_000_000;
const MAX_TOKEN_DECIMALS: u8 = 12;

/// Errors, as `Custom(n)`: the browser client turns them into readable reasons.
const NOT_FRESH: ProgramError = ProgramError::Custom(1);
const LIMIT: ProgramError = ProgramError::Custom(2);
const ORDER: ProgramError = ProgramError::Custom(3);
const BINDING: ProgramError = ProgramError::Custom(4);

/// Byte offsets in a Mimir V1 Classic feed account. V1 Classic keeps the 512-byte V0 public
/// snapshot prefix; the generated SDK layouts own these offsets (v1/layout/classic + common).
mod feed {
    pub const MIN_LEN: usize = 2506;
    pub const MAGIC: core::ops::Range<usize> = 0..8;
    pub const VERSION: usize = 8;
    pub const PREFIX_LEN: usize = 10;
    pub const FEED_ID: usize = 16;
    pub const REVISION: usize = 96;
    pub const STATUS: usize = 104;
    pub const ROUTEABILITY: usize = 105;
    pub const VALID_FROM_SLOT: usize = 116;
    pub const VALID_UNTIL_SLOT: usize = 124;
    /// Q64.64 USDC per token.
    pub const PRICE_LOWER: usize = 216;
    pub const PRICE_UPPER: usize = 232;
    pub const QUOTE_STATUS: usize = 257;
    pub const CLASSIC_MAGIC: core::ops::Range<usize> = 593..601;
    pub const CLASSIC_VERSION: usize = 601;
    pub const SOURCE_COUNT: usize = 649;
    pub const KIND: usize = 652;
    pub const BASE_MINT: usize = 961;
    pub const QUOTE_MINT: usize = 993;
    pub const BASE_DECIMALS: usize = 1031;
    /// The first price source: its kind, its program, and its pool.
    pub const SOURCE: usize = 1574;
    pub const SOURCE_KIND: usize = SOURCE + 49;
    pub const SOURCE_PROGRAM: usize = SOURCE + 104;
    pub const SOURCE_POOL: usize = SOURCE + 136;
    pub const SOURCE_KIND_CPMM: u8 = 2;
}

/// Byte offsets in a Raydium CPMM pool account.
mod cpmm {
    pub const LEN: usize = 637;
    pub const DISCRIMINATOR: [u8; 8] = [247, 237, 227, 245, 215, 195, 222, 70];
    pub const VAULT_0: usize = 72;
    pub const VAULT_1: usize = 104;
    pub const MINT_0: usize = 168;
    pub const MINT_1: usize = 200;
    /// Protocol, fund and creator fees per side (u64 each, side 0 then side 1).
    pub const PROTOCOL_FEES: usize = 341;
    pub const FUND_FEES: usize = 357;
    pub const CREATOR_FEES: usize = 397;
    pub const AUTHORITY_SEED: &[u8] = b"vault_and_lp_mint_auth_seed";
}

/// Byte offsets in an SPL token account.
mod token_account {
    pub const LEN: usize = 165;
    pub const MINT: usize = 0;
    pub const OWNER: usize = 32;
    pub const AMOUNT: usize = 64;
    pub const STATE: usize = 108;
    pub const INITIALIZED: u8 = 1;
}

/// The position PDA ["position", feed, user]: collateral (u64) then debt (u64).
const POSITION_LEN: u64 = 16;
const POSITION_COLLATERAL: usize = 0;
const POSITION_DEBT: usize = 8;

/// Mimir's refresh instruction discriminator.
const MIMIR_REFRESH: u8 = 89;
/// At most this many feeds are refreshed, immediately before this consumer.
const MAX_REFRESHES: usize = 2;
const SPL_TRANSFER: u8 = 3;

#[cfg(not(feature = "no-entrypoint"))]
pinocchio::program_entrypoint!(process_instruction);
#[cfg(not(feature = "no-entrypoint"))]
pinocchio::default_allocator!();
#[cfg(not(feature = "no-entrypoint"))]
pinocchio::nostd_panic_handler!();

/// Reads `N` bytes at `offset`.
fn bytes<const N: usize>(data: &[u8], offset: usize) -> Result<[u8; N], ProgramError> {
    let slice = data
        .get(offset..offset + N)
        .ok_or(ProgramError::InvalidAccountData)?;
    slice
        .try_into()
        .map_err(|_| ProgramError::InvalidAccountData)
}

/// Reads a little-endian u16 at `offset`.
fn u16_at(data: &[u8], offset: usize) -> Result<u16, ProgramError> {
    Ok(u16::from_le_bytes(bytes(data, offset)?))
}

/// Reads a little-endian u64 at `offset`.
fn u64_at(data: &[u8], offset: usize) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(bytes(data, offset)?))
}

/// Reads a little-endian u128 at `offset`.
fn u128_at(data: &[u8], offset: usize) -> Result<u128, ProgramError> {
    Ok(u128::from_le_bytes(bytes(data, offset)?))
}

/// Reads an address at `offset`.
fn address_at(data: &[u8], offset: usize) -> Result<Address, ProgramError> {
    Ok(Address::new_from_array(bytes(data, offset)?))
}

/// Writes a little-endian u64 at `offset`.
fn write_u64(data: &mut [u8], offset: usize, value: u64) {
    data[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

/// Multiplies, failing on overflow.
fn mul(left: u128, right: u128) -> Result<u128, ProgramError> {
    left.checked_mul(right)
        .ok_or(ProgramError::ArithmeticOverflow)
}

/// Converts a Q64.64 price to Q32.
fn q64_to_q32(price_q64: u128) -> u128 {
    price_q64 >> 32
}

/// Checks that `account` is a Mimir V1 Classic feed: owner, layout and the feed_snapshot PDA.
fn check_classic_feed(account: &AccountView) -> ProgramResult {
    if !account.owned_by(&MIMIR) || account.is_signer() {
        return Err(BINDING);
    }
    let data = account.try_borrow()?;
    let layout_ok = data.len() >= feed::MIN_LEN
        && data.get(feed::MAGIC) == Some(b"MIMIRSNP")
        && u16_at(&data, feed::VERSION)? == 0
        && u16_at(&data, feed::PREFIX_LEN)? == 512
        && data.get(feed::CLASSIC_MAGIC) == Some(b"MIMIRCLX")
        && u16_at(&data, feed::CLASSIC_VERSION)? == 2
        && data[feed::KIND] == 1;
    if !layout_ok {
        return Err(BINDING);
    }
    let feed_id = bytes::<32>(&data, feed::FEED_ID)?;
    let (snapshot_pda, _) = Address::find_program_address(&[b"feed_snapshot", &feed_id], &MIMIR);
    if account.address() != &snapshot_pda {
        return Err(BINDING);
    }
    Ok(())
}

/// Checks that one of the instructions just before this one is Mimir's refresh of `feed`.
fn check_refreshed_in_this_transaction(
    feed: &AccountView,
    instructions_sysvar: &AccountView,
) -> ProgramResult {
    let instructions = Instructions::try_from(instructions_sysvar)?;
    let current = instructions.load_current_index() as usize;
    for index in current.saturating_sub(MAX_REFRESHES)..current {
        let previous = instructions.load_instruction_at(index)?;
        let is_mimir_refresh = previous.get_program_id() == &MIMIR
            && previous.get_instruction_data().first() == Some(&MIMIR_REFRESH);
        if is_mimir_refresh && previous.get_instruction_account_at(0)?.key == *feed.address() {
            return Ok(());
        }
    }
    Err(BINDING)
}

/// Checks that the feed is a Mimir feed, refreshed in this transaction, and Fresh now.
fn check_fresh(feed: &AccountView, instructions_sysvar: &AccountView) -> ProgramResult {
    check_classic_feed(feed)?;
    check_refreshed_in_this_transaction(feed, instructions_sysvar)?;
    let slot = Clock::get()?.slot;
    fresh_at(&feed.try_borrow()?, slot)
}

/// The freshness rule: a published revision, a healthy status, routeable, a healthy quote,
/// `slot` inside the validity window, and a non-zero lower bound.
fn fresh_at(data: &[u8], slot: u64) -> ProgramResult {
    let published = u64_at(data, feed::REVISION)? != 0;
    let healthy = data[feed::STATUS] == 0 && data[feed::QUOTE_STATUS] == 0;
    let routeable = data[feed::ROUTEABILITY] < 4;
    let in_window = u64_at(data, feed::VALID_FROM_SLOT)? <= slot
        && u64_at(data, feed::VALID_UNTIL_SLOT)? >= slot;
    let has_price = u128_at(data, feed::PRICE_LOWER)? != 0;
    if published && healthy && routeable && in_window && has_price {
        Ok(())
    } else {
        Err(NOT_FRESH)
    }
}

/// Checks that `account` is an initialized SPL token account for `mint` owned by `owner`.
fn check_token_account(account: &AccountView, mint: &Address, owner: &Address) -> ProgramResult {
    if !account.owned_by(&TOKEN) {
        return Err(BINDING);
    }
    let data = account.try_borrow()?;
    let valid = data.len() == token_account::LEN
        && address_at(&data, token_account::MINT)? == *mint
        && address_at(&data, token_account::OWNER)? == *owner
        && data[token_account::STATE] == token_account::INITIALIZED;
    if !valid {
        return Err(BINDING);
    }
    Ok(())
}

/// Transfers `amount` tokens with the SPL Token program. A PDA authority passes its `signer`.
fn transfer(
    from: &AccountView,
    to: &AccountView,
    authority: &AccountView,
    amount: u64,
    signer: Option<Signer>,
) -> ProgramResult {
    let mut data = [0u8; 9];
    data[0] = SPL_TRANSFER;
    data[1..].copy_from_slice(&amount.to_le_bytes());
    let metas = [
        InstructionAccount::writable(from.address()),
        InstructionAccount::writable(to.address()),
        InstructionAccount::readonly_signer(authority.address()),
    ];
    let instruction = InstructionView {
        program_id: &TOKEN,
        accounts: &metas,
        data: &data,
    };
    let accounts = [from, to, authority];
    match signer {
        Some(signer) => invoke_signed_with_bounds::<3>(&instruction, &accounts, &[signer]),
        None => invoke_with_bounds::<3>(&instruction, &accounts),
    }
}

/// Returns the decision inputs as return data (40 bytes): Q32 price in USDC per token (u128),
/// loan limit in USDC atoms (u128), slot (u64).
fn set_receipt(price_q32: u128, limit: u128) -> ProgramResult {
    let mut out = [0u8; 40];
    out[..16].copy_from_slice(&price_q32.to_le_bytes());
    out[16..32].copy_from_slice(&limit.to_le_bytes());
    out[32..40].copy_from_slice(&Clock::get()?.slot.to_le_bytes());
    set_return_data(&out);
    Ok(())
}

/// The 9 accounts every instruction starts with, in this order.
struct SharedAccounts<'a> {
    /// The Mimir feed (read-only).
    feed_account: &'a AccountView,
    /// The user, who signs.
    user: &'a AccountView,
    /// The user's token account (collateral).
    collateral: &'a AccountView,
    /// The vault's token account (holds the collateral).
    escrow: &'a AccountView,
    /// The vault's USDC account (lends the USDC).
    liquidity: &'a AccountView,
    /// The user's USDC account.
    destination: &'a AccountView,
    /// The vault PDA ["vault", feed, tag], authority of `escrow` and `liquidity`.
    vault: &'a AccountView,
    token_program: &'a AccountView,
    /// The instructions sysvar, to find Mimir's refresh in this transaction.
    sysvar: &'a AccountView,
}
const SHARED_ACCOUNT_COUNT: usize = 9;

/// Splits the accounts into the 9 shared ones and the instruction's extra accounts.
fn split_accounts(
    accounts: &[AccountView],
) -> Result<(SharedAccounts<'_>, &[AccountView]), ProgramError> {
    let (shared, extra) = accounts
        .split_at_checked(SHARED_ACCOUNT_COUNT)
        .ok_or(BINDING)?;
    let named = SharedAccounts {
        feed_account: &shared[0],
        user: &shared[1],
        collateral: &shared[2],
        escrow: &shared[3],
        liquidity: &shared[4],
        destination: &shared[5],
        vault: &shared[6],
        token_program: &shared[7],
        sysvar: &shared[8],
    };
    Ok((named, extra))
}

/// Program entrypoint: dispatches on the first byte of the instruction data.
pub fn process_instruction(
    program: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    match data.first() {
        Some(&(MIMIR_BORROW | PROTECTED_FILL | SPOT_LENDER)) => borrow(program, accounts, data),
        Some(&(REPAY | RELEASE)) => settle(program, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// The number of accounts each borrow tag expects: 9 shared, then the Mimir borrow adds the
/// position and the system program, the spot lender adds the CPMM pool and its two vaults.
fn borrow_account_count(tag: u8) -> usize {
    match tag {
        MIMIR_BORROW => 11,
        PROTECTED_FILL => 9,
        _ => 12,
    }
}

/// The base mint and its decimals from a Mimir feed that is quoted in USDC.
fn read_feed_token(feed_account: &AccountView) -> Result<(Address, u8), ProgramError> {
    let data = feed_account.try_borrow()?;
    if address_at(&data, feed::QUOTE_MINT)? != USDC {
        return Err(BINDING);
    }
    let base = address_at(&data, feed::BASE_MINT)?;
    let decimals = *data.get(feed::BASE_DECIMALS).ok_or(BINDING)?;
    if decimals > MAX_TOKEN_DECIMALS {
        return Err(BINDING);
    }
    Ok((base, decimals))
}

/// Mimir's lower bound in Q32 USDC per token, once the feed is checked Fresh.
fn mimir_lower_bound(
    feed_account: &AccountView,
    sysvar: &AccountView,
) -> Result<u128, ProgramError> {
    check_fresh(feed_account, sysvar)?;
    let lower_q64 = u128_at(&feed_account.try_borrow()?, feed::PRICE_LOWER)?;
    Ok(q64_to_q32(lower_q64))
}

/// Checks a protected fill: the payout must sit between 99% of the collateral's value at the
/// lower bound (`value_at_lower`) and 101% of its value at the upper bound.
fn check_fill_inside_bound(
    feed_account: &AccountView,
    deposit: u64,
    payout: u64,
    value_at_lower: u128,
    decimals: u8,
) -> ProgramResult {
    let upper_q64 = u128_at(&feed_account.try_borrow()?, feed::PRICE_UPPER)?;
    let value_at_upper = loan_limit(deposit, q64_to_q32(upper_q64), decimals, BPS)?;
    let minimum = mul(value_at_lower, FILL_MIN_BPS)? / BPS;
    let maximum = mul(value_at_upper, FILL_MAX_BPS)? / BPS;
    let payout = payout as u128;
    if payout < minimum || payout > maximum {
        return Err(ORDER);
    }
    Ok(())
}

/// Tags 0 to 2: reads a price (Mimir's lower bound, or the pool spot for the spot lender),
/// checks the loan against it, then moves the collateral in and the USDC out.
fn borrow(program: &Address, accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    let tag = data[0];
    if data.len() != INSTRUCTION_DATA_LEN || accounts.len() != borrow_account_count(tag) {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (shared, extra) = split_accounts(accounts)?;
    let SharedAccounts {
        feed_account,
        user,
        collateral,
        escrow,
        liquidity,
        destination,
        vault,
        token_program,
        sysvar,
    } = shared;
    let distinct_accounts =
        collateral.address() != escrow.address() && liquidity.address() != destination.address();
    if !user.is_signer() || token_program.address() != &TOKEN || !distinct_accounts {
        return Err(BINDING);
    }
    check_classic_feed(feed_account)?;
    let (base, decimals) = read_feed_token(feed_account)?;

    let price_q32 = if let [pool, base_vault, quote_vault] = extra {
        spot_price(feed_account, pool, base_vault, quote_vault)?
    } else {
        mimir_lower_bound(feed_account, sysvar)?
    };

    let deposit = u64_at(data, 1)?;
    let loan = u64_at(data, 9)?;
    let ltv_bps = if tag == PROTECTED_FILL { BPS } else { LTV_BPS };
    let limit = loan_limit(deposit, price_q32, decimals, ltv_bps)?;
    if deposit == 0 || loan == 0 {
        return Err(LIMIT);
    }
    if tag == PROTECTED_FILL {
        // A maker pays USDC for the user's tokens: refuse execution outside the bound +/- 1%.
        check_fill_inside_bound(feed_account, deposit, loan, limit, decimals)?;
    } else if loan as u128 > limit {
        return Err(LIMIT);
    }

    let tag_seed = [tag];
    let vault_seeds: [&[u8]; 3] = [b"vault", feed_account.address().as_ref(), &tag_seed];
    let (authority, bump) = Address::find_program_address(&vault_seeds, program);
    if vault.address() != &authority {
        return Err(BINDING);
    }
    check_token_account(collateral, &base, user.address())?;
    check_token_account(escrow, &base, &authority)?;
    check_token_account(liquidity, &USDC, &authority)?;
    check_token_account(destination, &USDC, user.address())?;

    transfer(collateral, escrow, user, deposit, None)?;
    let bump_seed = [bump];
    let signer_seeds = [
        Seed::from(b"vault".as_slice()),
        Seed::from(feed_account.address().as_ref()),
        Seed::from(tag_seed.as_slice()),
        Seed::from(bump_seed.as_slice()),
    ];
    transfer(
        liquidity,
        destination,
        vault,
        loan,
        Some(Signer::from(&signer_seeds[..])),
    )?;
    if let [position, system_program] = extra {
        record_position(
            program,
            feed_account,
            user,
            position,
            system_program,
            deposit,
            loan,
        )?;
    }
    set_receipt(price_q32, limit)
}

/// Creates the position PDA with the system program, paid by the user.
fn create_position(
    program: &Address,
    feed_account: &AccountView,
    user: &AccountView,
    position: &AccountView,
    system_program: &AccountView,
    bump: u8,
) -> ProgramResult {
    // System program CreateAccount: u32 index 0, lamports, space, owner.
    let mut data = [0u8; 52];
    let lamports = Rent::get()?.try_minimum_balance(POSITION_LEN as usize)?;
    data[4..12].copy_from_slice(&lamports.to_le_bytes());
    data[12..20].copy_from_slice(&POSITION_LEN.to_le_bytes());
    data[20..].copy_from_slice(program.as_ref());
    let metas = [
        InstructionAccount::writable_signer(user.address()),
        InstructionAccount::writable_signer(position.address()),
    ];
    let bump_seed = [bump];
    let seeds = [
        Seed::from(b"position".as_slice()),
        Seed::from(feed_account.address().as_ref()),
        Seed::from(user.address().as_ref()),
        Seed::from(bump_seed.as_slice()),
    ];
    let instruction = InstructionView {
        program_id: system_program.address(),
        accounts: &metas,
        data: &data,
    };
    invoke_signed_with_bounds::<2>(&instruction, &[user, position], &[Signer::from(&seeds[..])])
}

/// Adds the deposit and the loan to the user's position, creating it on first use.
fn record_position(
    program: &Address,
    feed_account: &AccountView,
    user: &AccountView,
    position: &AccountView,
    system_program: &AccountView,
    deposit: u64,
    loan: u64,
) -> ProgramResult {
    let seeds: [&[u8]; 3] = [
        b"position",
        feed_account.address().as_ref(),
        user.address().as_ref(),
    ];
    let (position_pda, bump) = Address::find_program_address(&seeds, program);
    if position.address() != &position_pda || system_program.address() != &Address::default() {
        return Err(BINDING);
    }
    if position.lamports() == 0 {
        create_position(program, feed_account, user, position, system_program, bump)?;
    }
    if !position.owned_by(program) {
        return Err(BINDING);
    }
    let mut data = position.try_borrow_mut()?;
    let collateral = u64_at(&data, POSITION_COLLATERAL)?
        .checked_add(deposit)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let debt = u64_at(&data, POSITION_DEBT)?
        .checked_add(loan)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    write_u64(&mut data, POSITION_COLLATERAL, collateral);
    write_u64(&mut data, POSITION_DEBT, debt);
    Ok(())
}

/// Tags 3 and 4: repays USDC debt, or releases all collateral once the debt is zero. No price
/// is needed. Accounts: the 9 shared borrow accounts (the sysvar is unused), then the position.
fn settle(program: &Address, accounts: &[AccountView], data: &[u8]) -> ProgramResult {
    if data.len() != INSTRUCTION_DATA_LEN || accounts.len() != 10 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (shared, extra) = split_accounts(accounts)?;
    let [position] = extra else {
        return Err(BINDING);
    };
    let SharedAccounts {
        feed_account,
        user,
        collateral,
        escrow,
        liquidity,
        destination,
        vault,
        token_program,
        ..
    } = shared;
    if !user.is_signer() || token_program.address() != &TOKEN || !position.owned_by(program) {
        return Err(BINDING);
    }
    check_classic_feed(feed_account)?;
    let base = address_at(&feed_account.try_borrow()?, feed::BASE_MINT)?;

    let position_seeds: [&[u8]; 3] = [
        b"position",
        feed_account.address().as_ref(),
        user.address().as_ref(),
    ];
    let (position_pda, _) = Address::find_program_address(&position_seeds, program);
    let borrow_tag = [MIMIR_BORROW];
    let vault_seeds: [&[u8]; 3] = [b"vault", feed_account.address().as_ref(), &borrow_tag];
    let (authority, bump) = Address::find_program_address(&vault_seeds, program);
    if position.address() != &position_pda || vault.address() != &authority {
        return Err(BINDING);
    }
    check_token_account(collateral, &base, user.address())?;
    check_token_account(escrow, &base, &authority)?;
    check_token_account(liquidity, &USDC, &authority)?;
    check_token_account(destination, &USDC, user.address())?;

    let (held, debt) = {
        let position_data = position.try_borrow()?;
        let held = u64_at(&position_data, POSITION_COLLATERAL)?;
        let debt = u64_at(&position_data, POSITION_DEBT)?;
        (held, debt)
    };
    if data[0] == REPAY {
        let amount = u64_at(data, 9)?;
        if amount == 0 || amount > debt {
            return Err(LIMIT);
        }
        transfer(destination, liquidity, user, amount, None)?;
        write_u64(
            &mut position.try_borrow_mut()?,
            POSITION_DEBT,
            debt - amount,
        );
    } else {
        if debt != 0 || held == 0 {
            return Err(LIMIT);
        }
        let bump_seed = [bump];
        let signer_seeds = [
            Seed::from(b"vault".as_slice()),
            Seed::from(feed_account.address().as_ref()),
            Seed::from(borrow_tag.as_slice()),
            Seed::from(bump_seed.as_slice()),
        ];
        transfer(
            escrow,
            collateral,
            vault,
            held,
            Some(Signer::from(&signer_seeds[..])),
        )?;
        write_u64(&mut position.try_borrow_mut()?, POSITION_COLLATERAL, 0);
    }
    Ok(())
}

/// The loan limit in USDC atoms: collateral (token atoms) × price (Q32 USDC per token) × LTV,
/// rounded down.
fn loan_limit(
    collateral: u64,
    price_q32: u128,
    decimals: u8,
    ltv_bps: u128,
) -> Result<u128, ProgramError> {
    let value_q32 = mul(collateral as u128, price_q32)? / 10u128.pow(decimals as u32);
    let value_usdc_atoms = mul(value_q32, USDC_ATOMS)? / Q32;
    Ok(mul(value_usdc_atoms, ltv_bps)? / BPS)
}

/// Unclaimed fees on one side of a CPMM pool; they sit in the vault but are not liquidity.
fn cpmm_fees(pool: &[u8], side: usize) -> Result<u64, ProgramError> {
    let protocol = u64_at(pool, cpmm::PROTOCOL_FEES + 8 * side)?;
    let fund = u64_at(pool, cpmm::FUND_FEES + 8 * side)?;
    let creator = u64_at(pool, cpmm::CREATOR_FEES + 8 * side)?;
    protocol
        .checked_add(fund)
        .and_then(|sum| sum.checked_add(creator))
        .ok_or(ProgramError::ArithmeticOverflow)
}

/// The pool spot price in Q32 USDC per token, from the CPMM pool that is the feed's only
/// source. This is what a naive lender reads; recipe 03 shows why it is unsafe.
fn spot_price(
    feed_account: &AccountView,
    pool: &AccountView,
    base_vault: &AccountView,
    quote_vault: &AccountView,
) -> Result<u128, ProgramError> {
    let feed_data = feed_account.try_borrow()?;
    let pool_data = pool.try_borrow()?;
    let source_program = address_at(&feed_data, feed::SOURCE_PROGRAM)?;
    let pool_matches_feed = feed_data[feed::SOURCE_COUNT] == 1
        && feed_data[feed::SOURCE_KIND] == feed::SOURCE_KIND_CPMM
        && pool.owned_by(&source_program)
        && pool.address() == &address_at(&feed_data, feed::SOURCE_POOL)?;
    let pool_layout_ok =
        pool_data.len() == cpmm::LEN && pool_data.get(0..8) == Some(&cpmm::DISCRIMINATOR);
    if !pool_matches_feed || !pool_layout_ok {
        return Err(BINDING);
    }

    let base = address_at(&feed_data, feed::BASE_MINT)?;
    let mint_0 = address_at(&pool_data, cpmm::MINT_0)?;
    let mint_1 = address_at(&pool_data, cpmm::MINT_1)?;
    let base_is_side_0 = mint_0 == base && mint_1 == USDC;
    let base_is_side_1 = mint_1 == base && mint_0 == USDC;
    if !base_is_side_0 && !base_is_side_1 {
        return Err(BINDING);
    }
    let (base_vault_offset, quote_vault_offset, base_side, quote_side) = if base_is_side_0 {
        (cpmm::VAULT_0, cpmm::VAULT_1, 0, 1)
    } else {
        (cpmm::VAULT_1, cpmm::VAULT_0, 1, 0)
    };
    let vaults_match = base_vault.address() == &address_at(&pool_data, base_vault_offset)?
        && quote_vault.address() == &address_at(&pool_data, quote_vault_offset)?;
    if !vaults_match {
        return Err(BINDING);
    }
    let (pool_authority, _) =
        Address::find_program_address(&[cpmm::AUTHORITY_SEED], &source_program);
    check_token_account(base_vault, &base, &pool_authority)?;
    check_token_account(quote_vault, &USDC, &pool_authority)?;

    let base_reserve = u64_at(&base_vault.try_borrow()?, token_account::AMOUNT)?
        .checked_sub(cpmm_fees(&pool_data, base_side)?)
        .ok_or(BINDING)?;
    let quote_reserve = u64_at(&quote_vault.try_borrow()?, token_account::AMOUNT)?
        .checked_sub(cpmm_fees(&pool_data, quote_side)?)
        .ok_or(BINDING)?;
    if base_reserve == 0 || quote_reserve == 0 {
        return Err(BINDING);
    }
    let decimals = feed_data[feed::BASE_DECIMALS] as u32;
    let scaled_quote = mul(mul(quote_reserve as u128, 10u128.pow(decimals))?, Q32)?;
    Ok(scaled_quote / base_reserve as u128 / USDC_ATOMS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collateral_limit_rounds_down() {
        assert_eq!(
            loan_limit(1_000_000_000, Q32 * 2, 9, 5000).unwrap(),
            1_000_000
        );
        assert_eq!(loan_limit(1, Q32 / 10000, 9, LTV_BPS).unwrap(), 0);
        assert!(mul(u128::MAX, 2).is_err());
    }

    /// Snapshot prefix fields read by fresh_at(): status 104, valid from 116, valid until 124,
    /// lower bound 216.
    #[test]
    fn not_fresh_is_rejected_until_refreshed() {
        let mut data = [0u8; 258];
        assert_eq!(fresh_at(&data, 100), Err(NOT_FRESH));
        data[feed::REVISION] = 1;
        data[feed::VALID_FROM_SLOT] = 90;
        data[feed::VALID_UNTIL_SLOT] = 110;
        data[feed::PRICE_LOWER..feed::PRICE_LOWER + 16].copy_from_slice(&(Q32 * 3).to_le_bytes());
        assert_eq!(fresh_at(&data, 100), Ok(()));
        data[feed::STATUS] = 2;
        assert_eq!(fresh_at(&data, 100), Err(NOT_FRESH));
        data[feed::STATUS] = 0;
        assert_eq!(fresh_at(&data, 111), Err(NOT_FRESH));
        data[feed::VALID_UNTIL_SLOT] = 120;
        assert_eq!(fresh_at(&data, 111), Ok(()));
    }
}
