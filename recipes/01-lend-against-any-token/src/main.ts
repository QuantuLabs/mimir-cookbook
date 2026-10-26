import { Buffer } from "buffer";
import "./style.css";
globalThis.Buffer??=Buffer;
(globalThis as any).process??={env:{}};
const {atoms,borrow,connectWallet,Connection,demo,explain,position,preview,settle,tokenMint}=await import("mimir-easy/consumer");
const c=new Connection(demo.rpc,"confirmed"),$=(id:string)=>document.getElementById(id)!;
// The loan in USDC; the collateral is sized at twice its value at Mimir's lower bound.
const LOAN_USDC=1;
let wallet:Awaited<ReturnType<typeof connectWallet>>|undefined;
const getWallet=async()=>wallet??=await connectWallet();
const token=tokenMint(c);
const show=(kind:string,title:string,detail:string)=>{$("decision").className=`decision ${kind}`;$('decision').innerHTML=`<b>${title}</b><span>${detail}</span>`;};
$('refresh').onclick=async()=>{try{const p=await preview(c,wallet?.address);show(p.token.fresh?'pass':'fail',p.token.fresh?'Price is Fresh':'Loan declined',`Lower bound: ${p.token.lower.toPrecision(6)} USDC per ${p.token.ticker}`);}catch(e){show('fail','Refresh refused',explain(e));}};
const held=async(w:{address:string})=>{const p=await position(c,w.address),t=await token;$('position').textContent=`Your position: ${Number(p.collateral)/10**t.decimals} ${t.ticker} collateral · ${Number(p.debt)/1e6} USDC debt`;return p;};
$('borrow').onclick=async()=>{try{const w=await getWallet(),t=await token;show('neutral','Checking onchain…','Mimir refresh + lower-bound LTV');
const p=await preview(c,w.address),amount=2*LOAN_USDC/p.token.lower,r=await borrow(c,w,atoms(amount,t.decimals),atoms(LOAN_USDC,6));
show('pass','Loan approved',`${LOAN_USDC} USDC sent · ${amount.toPrecision(4)} ${t.ticker} locked`);$('evidence').textContent=`Transaction ${r.signature}`;await held(w);}catch(e){show('fail','Loan declined',explain(e));}};
// Repay all debt, then release all collateral. Neither step reads a price.
$('repay').onclick=async()=>{try{const w=await getWallet(),p=await held(w);if(p.debt>0n){const r=await settle(c,w,3,p.debt);$('evidence').textContent=`Repaid: transaction ${r.signature}`;}
const x=await settle(c,w,4);show('pass','Collateral released','Debt repaid · collateral back in your wallet');$('evidence').textContent=`Released: transaction ${x.signature}`;await held(w);}catch(e){show('fail','Release refused',explain(e));}};
