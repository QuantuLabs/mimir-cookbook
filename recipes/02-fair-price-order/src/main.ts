import { Buffer } from "buffer";
import "./style.css";
globalThis.Buffer??=Buffer;
(globalThis as any).process??={env:{}};
import baseline from "../../../fixtures/dood-shock/baseline.json";
import moved from "../../../fixtures/dood-shock/after-buy.json";
const {atoms,connectWallet,Connection,demo,explain,fill,preview,tokenMint}=await import("mimir-easy/consumer");
const c=new Connection(demo.rpc,"confirmed"),$=(id:string)=>document.getElementById(id)!;
// The order sells tokens worth about this much USDC.
const ORDER_USDC=1;
let wallet:Awaited<ReturnType<typeof connectWallet>>|undefined;const getWallet=async()=>wallet??=await connectWallet();
const token=tokenMint(c);
const card=(id:string,kind:string,title:string,detail:string)=>{$(id).className=`decision ${kind}`;$(id).innerHTML=`<small>PROTECTED ORDER</small><b>${title}</b><span>${detail}</span>`;};
// A saved fill is shown only if it belongs to this cluster and its signature is still confirmed for that wallet.
const KEY='mimir-fair-fill',short=(s:string)=>`${s.slice(0,8)}…${s.slice(-8)}`;
(async()=>{try{const s=JSON.parse(localStorage.getItem(KEY)??'null');if(!s||s.genesis!==await c.getGenesisHash())return;
const t=await c.getTransaction(s.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});
if(t&&!t.meta?.err&&t.transaction.message.staticAccountKeys[0]!.toBase58()===s.wallet)card('normal','pass','Order filled',short(s.signature));else localStorage.removeItem(KEY);}catch{}})();
// Recorded replay: one fixed maker quote before and after a +25% buy on the DOOD pool (unsigned simulations).
type Quote={payout:string;slot:number;err:unknown;reason:string|null};
const q=[baseline.makerQuote,moved.makerQuote] as Quote[];
$('replay').innerHTML=q.map((x,i)=>`<li class="${x.err?'fail':'pass'}"><b>${i?'After a +25% pool buy':'Before the move'}: ${x.err?'refused':'passes'}</b><span>${(Number(x.payout)/1e6).toFixed(6)} USDC for 100 DOOD · ${x.reason??'inside the Mimir bound ± 1%'} · slot ${x.slot}</span></li>`).join('');
$('refresh').onclick=async()=>{try{const p=await preview(c,wallet?.address);$('evidence').textContent=`Mimir bound refreshed at slot ${p.slot}: ${p.token.lower.toPrecision(6)} to ${p.token.upper.toPrecision(6)} USDC per ${p.token.ticker}${p.token.fresh?'':' (not Fresh)'}.`;}catch(e){$('evidence').textContent=explain(e);}};
$('fill').onclick=async()=>{try{const w=await getWallet(),t=await token,p=await preview(c,w.address),amount=ORDER_USDC/p.token.price,collateral=atoms(amount,t.decimals),payout=BigInt(Math.floor(p.token.price*Number(collateral)/10**t.decimals*1e6));
card('normal','neutral','Checking onchain…','Refresh + protected exchange');const r=await fill(c,w,collateral,payout);localStorage.setItem(KEY,JSON.stringify({wallet:w.address,genesis:await c.getGenesisHash(),signature:r.signature}));card('normal','pass','Order filled',short(r.signature));$('evidence').textContent=r.signature;}catch(e){card('normal','fail','Order declined',explain(e));}};
