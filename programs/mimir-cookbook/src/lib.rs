#![cfg_attr(not(test), no_std)]
// Teaching vault: borrow, repay and release; no liquidation. Never fund this on mainnet.
use pinocchio::{AccountView, Address, ProgramResult, error::ProgramError,
    instruction::{InstructionAccount, InstructionView},
    cpi::{invoke_with_bounds, invoke_signed_with_bounds, Seed, Signer, set_return_data},
    sysvars::{clock::Clock, instructions::Instructions, rent::Rent, Sysvar}};
// hBYrGHXVCQsnduDERkVnViCXNYawpHCvN5y3GsMiMiR, the Mimir V1 program on mainnet.
const MIMIR: Address = Address::new_from_array([10,75,41,9,91,115,107,245,77,34,137,133,150,137,74,160,54,103,163,3,197,155,195,107,129,51,46,96,136,98,253,218]);
const TOKEN: Address = Address::new_from_array([6,221,246,225,215,101,161,147,217,203,225,70,206,235,121,172,28,180,133,237,95,91,55,145,58,140,245,133,126,255,0,169]);
const USDC: Address = Address::new_from_array([198,250,122,243,190,219,173,58,61,101,243,106,171,201,116,49,177,187,228,194,210,246,224,228,124,166,2,3,69,47,93,97]);
const Q32: u128 = 1 << 32;
const LTV_BPS: u128 = 9000;
const NOT_FRESH: ProgramError = ProgramError::Custom(1);
const LIMIT: ProgramError = ProgramError::Custom(2);
const ORDER: ProgramError = ProgramError::Custom(3);
const BINDING: ProgramError = ProgramError::Custom(4);
#[cfg(not(feature = "no-entrypoint"))]
pinocchio::program_entrypoint!(process_instruction);
#[cfg(not(feature = "no-entrypoint"))]
pinocchio::default_allocator!();
#[cfg(not(feature = "no-entrypoint"))]
pinocchio::nostd_panic_handler!();

fn bytes<const N: usize>(d: &[u8], o: usize) -> Result<[u8;N], ProgramError> {
    d.get(o..o+N).ok_or(ProgramError::InvalidAccountData)?.try_into().map_err(|_| ProgramError::InvalidAccountData)
}
fn u64_at(d: &[u8], o: usize) -> Result<u64, ProgramError> { Ok(u64::from_le_bytes(bytes(d,o)?)) }
fn u128_at(d: &[u8], o: usize) -> Result<u128, ProgramError> { Ok(u128::from_le_bytes(bytes(d,o)?)) }
fn addr(d: &[u8], o: usize) -> Result<Address, ProgramError> { Ok(Address::new_from_array(bytes(d,o)?)) }
fn mul(a: u128, b: u128) -> Result<u128, ProgramError> { a.checked_mul(b).ok_or(ProgramError::ArithmeticOverflow) }

// V1 Classic retains the fixture's 512-byte V0 public snapshot prefix. The
// generated SDK layouts own these offsets: v1/layout/classic + common.
fn classic(a: &AccountView) -> ProgramResult {
    if !a.owned_by(&MIMIR) || a.is_signer() { return Err(BINDING); }
    let d=a.try_borrow()?;
    if d.len()<2506 || d.get(0..8)!=Some(b"MIMIRSNP") || bytes::<2>(&d,8)? != [0,0]
        || bytes::<2>(&d,10)? != 512u16.to_le_bytes() || d.get(593..601)!=Some(b"MIMIRCLX")
        || bytes::<2>(&d,601)? != 2u16.to_le_bytes() || d[652]!=1 { return Err(BINDING); }
    let feed_id=bytes::<32>(&d,16)?;
    let (pda,_) = Address::find_program_address(&[b"feed_snapshot",&feed_id],&MIMIR);
    if a.address()!=&pda { return Err(BINDING); }
    Ok(())
}
fn refreshed(a: &AccountView, ix: &AccountView) -> ProgramResult {
    let sys=Instructions::try_from(ix)?;
    let current=sys.load_current_index() as usize;
    // At most two feeds are refreshed, immediately before this consumer.
    for i in current.saturating_sub(2)..current {
        let prev=sys.load_instruction_at(i)?;
        if prev.get_program_id()==&MIMIR && prev.get_instruction_data().first()==Some(&89)
            && prev.get_instruction_account_at(0)?.key==*a.address() { return Ok(()); }
    }
    Err(BINDING)
}
fn fresh(a: &AccountView, ix: &AccountView) -> ProgramResult {
    classic(a)?; refreshed(a,ix)?;
    fresh_at(&a.try_borrow()?,Clock::get()?.slot)
}
fn fresh_at(d: &[u8], slot: u64) -> ProgramResult {
    if u64_at(d,96)?==0 || d[104]!=0 || d[105]>=4 || d[257]!=0
        || u64_at(d,124)?<slot || u64_at(d,116)?>slot || u128_at(d,216)?==0 {return Err(NOT_FRESH);}
    Ok(())
}
fn token(a: &AccountView, mint: &Address, owner: &Address) -> ProgramResult {
    if !a.owned_by(&TOKEN) { return Err(BINDING); }
    let d=a.try_borrow()?;
    if d.len()!=165 || addr(&d,0)?!=*mint || addr(&d,32)?!=*owner || d[108]!=1 { return Err(BINDING); }
    Ok(())
}
fn transfer(from: &AccountView,to: &AccountView,authority: &AccountView,amount: u64,signer: Option<Signer>) -> ProgramResult {
    let mut data=[0u8;9]; data[0]=3; data[1..].copy_from_slice(&amount.to_le_bytes());
    let metas=[InstructionAccount::writable(from.address()),InstructionAccount::writable(to.address()),InstructionAccount::readonly_signer(authority.address())];
    let ix=InstructionView { program_id: &TOKEN,accounts:&metas,data:&data };
    if let Some(s)=signer {invoke_signed_with_bounds::<3>(&ix,&[from,to,authority],&[s])}
    else {invoke_with_bounds::<3>(&ix,&[from,to,authority])}
}
// Return the actual onchain decision inputs (Q32 USDC/token, loan limit in USDC atoms).
fn receipt(price: u128,limit: u128) -> ProgramResult {
    let mut out=[0u8;40];out[..16].copy_from_slice(&price.to_le_bytes());out[16..32].copy_from_slice(&limit.to_le_bytes());
    out[32..40].copy_from_slice(&Clock::get()?.slot.to_le_bytes());set_return_data(&out);Ok(())
}

pub fn process_instruction(program: &Address,a: &[AccountView],d: &[u8]) -> ProgramResult {
    match d.first() {Some(0..=2)=>borrow(program,a,d),Some(3|4)=>settle(program,a,d),_=>Err(ProgramError::InvalidInstructionData)}
}
// 0 borrows at the Mimir lower bound; 1 sells collateral at a protected price; 2 is the spot lender.
// Accounts: 9 shared, then 0: position + system program; 2: CPMM pool + base/quote vaults.
fn borrow(program: &Address,a: &[AccountView],d: &[u8]) -> ProgramResult {
    let n=[11,9,12][d[0] as usize];
    if d.len()!=17 || a.len()!=n {return Err(ProgramError::InvalidInstructionData);}
    let [feed,user,collateral,escrow,liquidity,destination,vault,token_program,sys,extra @ ..]=a else {return Err(BINDING)};
    if !user.is_signer() || token_program.address()!=&TOKEN || collateral.address()==escrow.address()
        || liquidity.address()==destination.address() {return Err(BINDING);}
    classic(feed)?;
    let f=feed.try_borrow()?;
    if addr(&f,993)?!=USDC {return Err(BINDING);}
    let base=addr(&f,961)?;let decimals=*f.get(1031).ok_or(BINDING)?;
    if decimals>12 {return Err(BINDING);}
    drop(f);
    let price=if let [pool,base_vault,quote_vault]=extra {spot_price(feed,pool,base_vault,quote_vault)?}
        else {fresh(feed,sys)?;u128_at(&feed.try_borrow()?,216)? >>32};
    let deposit=u64_at(d,1)?;let loan=u64_at(d,9)?;
    let limit=loan_limit(deposit,price,decimals,if d[0]==1 {10000} else {LTV_BPS})?;
    if deposit==0 || loan==0 {return Err(LIMIT);}
    if d[0]==1 {
        // A maker pays USDC for the user's tokens. Refuse execution outside the envelope +/- 1%.
        let upper=u128_at(&feed.try_borrow()?,232)? >>32;
        let maximum=mul(loan_limit(deposit,upper,decimals,10000)?,10100)?/10000;
        if (loan as u128)<mul(limit,9900)?/10000 || loan as u128>maximum {return Err(ORDER);}
    } else if loan as u128>limit {return Err(LIMIT);}
    let tag=[d[0]];let (authority,bump)=Address::find_program_address(&[b"vault",feed.address().as_ref(),&tag],program);
    if vault.address()!=&authority {return Err(BINDING);}
    token(collateral,&base,user.address())?;token(escrow,&base,&authority)?;
    token(liquidity,&USDC,&authority)?;token(destination,&USDC,user.address())?;
    transfer(collateral,escrow,user,deposit,None)?;
    let bump_seed=[bump];let seeds=[Seed::from(b"vault".as_slice()),Seed::from(feed.address().as_ref()),Seed::from(tag.as_slice()),Seed::from(bump_seed.as_slice())];
    transfer(liquidity,destination,vault,loan,Some(Signer::from(&seeds[..])))?;
    if let [position,system]=extra {record(program,feed,user,position,system,deposit,loan)?;}
    receipt(price,limit)
}
// Position PDA ["position", feed, user]: collateral and debt, both u64.
fn record(program: &Address,feed: &AccountView,user: &AccountView,position: &AccountView,system: &AccountView,deposit: u64,loan: u64) -> ProgramResult {
    let (pda,bump)=Address::find_program_address(&[b"position",feed.address().as_ref(),user.address().as_ref()],program);
    if position.address()!=&pda || system.address()!=&Address::default() {return Err(BINDING);}
    if position.lamports()==0 {
        let mut data=[0u8;52];data[4..12].copy_from_slice(&Rent::get()?.try_minimum_balance(16)?.to_le_bytes());
        data[12..20].copy_from_slice(&16u64.to_le_bytes());data[20..].copy_from_slice(program.as_ref());
        let metas=[InstructionAccount::writable_signer(user.address()),InstructionAccount::writable_signer(position.address())];
        let b=[bump];let seeds=[Seed::from(b"position".as_slice()),Seed::from(feed.address().as_ref()),Seed::from(user.address().as_ref()),Seed::from(b.as_slice())];
        invoke_signed_with_bounds::<2>(&InstructionView{program_id:system.address(),accounts:&metas,data:&data},&[user,position],&[Signer::from(&seeds[..])])?;
    }
    if !position.owned_by(program) {return Err(BINDING);}
    let mut p=position.try_borrow_mut()?;
    let c=u64_at(&p,0)?.checked_add(deposit).ok_or(ProgramError::ArithmeticOverflow)?;
    let debt=u64_at(&p,8)?.checked_add(loan).ok_or(ProgramError::ArithmeticOverflow)?;
    p[..8].copy_from_slice(&c.to_le_bytes());p[8..16].copy_from_slice(&debt.to_le_bytes());Ok(())
}
// 3 repays USDC debt; 4 releases all collateral once the debt is zero. No price is needed.
// Accounts: the 9 shared borrow accounts (sysvar unused), then the position.
fn settle(program: &Address,a: &[AccountView],d: &[u8]) -> ProgramResult {
    if d.len()!=17 || a.len()!=10 {return Err(ProgramError::InvalidInstructionData);}
    let [feed,user,collateral,escrow,liquidity,destination,vault,token_program,_,position]=a else {return Err(BINDING)};
    if !user.is_signer() || token_program.address()!=&TOKEN || !position.owned_by(program) {return Err(BINDING);}
    classic(feed)?;let base=addr(&feed.try_borrow()?,961)?;
    let (pda,_)=Address::find_program_address(&[b"position",feed.address().as_ref(),user.address().as_ref()],program);
    let (authority,bump)=Address::find_program_address(&[b"vault",feed.address().as_ref(),&[0]],program);
    if position.address()!=&pda || vault.address()!=&authority {return Err(BINDING);}
    token(collateral,&base,user.address())?;token(escrow,&base,&authority)?;
    token(liquidity,&USDC,&authority)?;token(destination,&USDC,user.address())?;
    let (held,debt)={let p=position.try_borrow()?;(u64_at(&p,0)?,u64_at(&p,8)?)};
    if d[0]==3 {
        let amount=u64_at(d,9)?;if amount==0 || amount>debt {return Err(LIMIT);}
        transfer(destination,liquidity,user,amount,None)?;
        position.try_borrow_mut()?[8..16].copy_from_slice(&(debt-amount).to_le_bytes());
    } else {
        if debt!=0 || held==0 {return Err(LIMIT);}
        let b=[bump];let seeds=[Seed::from(b"vault".as_slice()),Seed::from(feed.address().as_ref()),Seed::from([0u8].as_slice()),Seed::from(b.as_slice())];
        transfer(escrow,collateral,vault,held,Some(Signer::from(&seeds[..])))?;
        position.try_borrow_mut()?[..8].copy_from_slice(&0u64.to_le_bytes());
    }
    Ok(())
}
fn loan_limit(collateral: u64, price_q32: u128,decimals: u8,ltv_bps: u128) -> Result<u128,ProgramError> {
    Ok(mul(mul(mul(collateral as u128,price_q32)?/10u128.pow(decimals as u32),1_000_000)?/Q32,ltv_bps)?/10000)
}
fn spot_price(feed: &AccountView,pool: &AccountView,base_vault: &AccountView,quote_vault: &AccountView) -> Result<u128,ProgramError> {
    let f=feed.try_borrow()?;let p=pool.try_borrow()?;let src=1574;
    if f[649]!=1 || f[src+49]!=2 || !pool.owned_by(&addr(&f,src+104)?) || pool.address()!=&addr(&f,src+136)?
        || p.len()!=637 || p.get(0..8)!=Some(&[247,237,227,245,215,195,222,70]) {return Err(BINDING);}
    let base=addr(&f,961)?;
    let zero=addr(&p,168)?==base && addr(&p,200)?==USDC;
    if !zero && !(addr(&p,200)?==base && addr(&p,168)?==USDC) {return Err(BINDING);}
    let (bv,qv,bi,qi)=if zero {(72,104,0,1)} else {(104,72,1,0)};
    if base_vault.address()!=&addr(&p,bv)? || quote_vault.address()!=&addr(&p,qv)? {return Err(BINDING);}
    let (authority,_)=Address::find_program_address(&[b"vault_and_lp_mint_auth_seed"],&addr(&f,src+104)?);
    token(base_vault,&base,&authority)?;token(quote_vault,&USDC,&authority)?;
    let fees=|i: usize| -> Result<u64,ProgramError> {u64_at(&p,341+8*i)?.checked_add(u64_at(&p,357+8*i)?).and_then(|x|x.checked_add(u64_at(&p,397+8*i).ok()?)).ok_or(ProgramError::ArithmeticOverflow)};
    let b=u64_at(&base_vault.try_borrow()?,64)?.checked_sub(fees(bi)?).ok_or(BINDING)?;
    let q=u64_at(&quote_vault.try_borrow()?,64)?.checked_sub(fees(qi)?).ok_or(BINDING)?;
    if b==0 || q==0 {return Err(BINDING);}
    Ok(mul(mul(q as u128,10u128.pow(f[1031] as u32))?,Q32)?/b as u128/1_000_000)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn collateral_limit_rounds_down() {
        assert_eq!(loan_limit(1_000_000_000,Q32*2,9,5000).unwrap(),1_000_000);
        assert_eq!(loan_limit(1,Q32/10000,9,LTV_BPS).unwrap(),0);
        assert!(mul(u128::MAX,2).is_err());
    }
    // Snapshot prefix fields read by fresh(): status 104, valid from 116, valid until 124, price 216.
    #[test] fn not_fresh_is_rejected_until_refreshed() {
        let mut d=[0u8;258];
        assert_eq!(fresh_at(&d,100),Err(NOT_FRESH));
        d[96]=1;d[116]=90;d[124]=110;d[216..232].copy_from_slice(&(Q32*3).to_le_bytes());
        assert_eq!(fresh_at(&d,100),Ok(()));
        d[104]=2;assert_eq!(fresh_at(&d,100),Err(NOT_FRESH));
        d[104]=0;assert_eq!(fresh_at(&d,111),Err(NOT_FRESH));
        d[124]=120;assert_eq!(fresh_at(&d,111),Ok(()));
    }
}
