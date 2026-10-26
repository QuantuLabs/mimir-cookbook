import { Connection, PublicKey, TransactionInstruction, ComputeBudgetProgram, TransactionMessage, VersionedTransaction, SYSVAR_INSTRUCTIONS_PUBKEY, type AddressLookupTableAccount } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { decodeV1ClassicFeed } from '@quantulabs/mimir-sdk/v1';
import { decodeFeedSnapshotHeader } from '@quantulabs/mimir-sdk';
import { refreshInstructions, connectWallet, signAndSend, type MimirWallet, type PreparedTransaction } from './index.ts';
export { Connection, connectWallet, signAndSend };
export type { MimirWallet };
// Defaults: mainnet and the SOL/USDC Mimir feed. The consumer, its CPMM pool and lookup table are yours to deploy and set.
export const demo = {
  rpc: import.meta.env?.VITE_RPC_URL || 'https://api.mainnet-beta.solana.com',
  feed: import.meta.env?.VITE_FEED || 'F5fXuWuVFwBF3eBVtFkxXS5PMY651uVQ1bL4W4mse5Qj',
  program: import.meta.env?.VITE_CONSUMER || '',
  pool: import.meta.env?.VITE_POOL || '',
  lookup: import.meta.env?.VITE_LOOKUP || '',
};
export const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const pk=(v:string)=>new PublicKey(v);
export const q64=(v:bigint)=>Number(v>>32n)/2**32;
export type Price = { fresh:boolean; price:number; lower:number; upper:number; confidence:number; slot:number; base:string; decimals:number; ticker:string };
const tickerOf=(t:Uint8Array)=>String.fromCharCode(...t.subarray(1,1+Math.min(t[0]??0,t.length-1)));
export function snapshot(data:Uint8Array,slot:number):Price {
  const f=decodeV1ClassicFeed(data),h=decodeFeedSnapshotHeader(f.prefix),d=Buffer.from(data),at=BigInt(slot);
  // Same predicate as the consumer's fresh_at(): revision, status, routeability, quote status, slot window, lower bound.
  const fresh=d.readBigUInt64LE(96)>0n&&d[104]===0&&d[105]!<4&&d[257]===0&&d.readBigUInt64LE(124)>=at&&d.readBigUInt64LE(116)<=at&&(d.readBigUInt64LE(216)|d.readBigUInt64LE(224))>0n;
  return {fresh,price:q64(h.priceX64),lower:q64(h.priceLowerX64),upper:q64(h.priceUpperX64),confidence:h.confidenceBps,slot,base:new PublicKey(f.definition.feedImage.slice(48,80)).toBase58(),decimals:f.definition.feedImage[118]!,ticker:tickerOf(f.definition.ticker)};
}
export const ata=(owner:string,mint:PublicKey)=>getAssociatedTokenAddressSync(mint,pk(owner),true);
export function vaultAddress(tag:0|1|2,feed=demo.feed) { return PublicKey.findProgramAddressSync([Buffer.from('vault'),pk(feed).toBuffer(),Buffer.from([tag])],pk(demo.program))[0]; }
export function positionAddress(user:string,feed=demo.feed) { return PublicKey.findProgramAddressSync([Buffer.from('position'),pk(feed).toBuffer(),pk(user).toBuffer()],pk(demo.program))[0]; }
/** Token amount in atoms from the feed's mint decimals. */
export const atoms=(amount:number,decimals:number)=>BigInt(Math.round(amount*10**decimals));
/** A readable error; the public mainnet endpoint refuses browser requests. */
export const explain=(e:unknown)=>/\b403\b|Access forbidden/.test(String(e))?'This RPC endpoint refuses browser requests. Set VITE_RPC_URL in .env.local to your own endpoint.':e instanceof Error?e.message:String(e);
/** The borrow, fill and settle steps need your own deployment of programs/mimir-cookbook. The price refresh does not. */
export async function assertConsumer(c:Connection) {
  if(!demo.program||!(await c.getAccountInfo(pk(demo.program),'confirmed'))?.executable)throw Error('This step needs your own deployment of programs/mimir-cookbook: set VITE_CONSUMER. Refresh price works without it.');
}
export async function transaction(c:Connection,payer:string,ixs:TransactionInstruction[],lookup?:AddressLookupTableAccount):Promise<PreparedTransaction> {
  const {blockhash,lastValidBlockHeight}=await c.getLatestBlockhash('confirmed');
  if(!lookup&&demo.lookup)lookup=(await c.getAddressLookupTable(pk(demo.lookup))).value??undefined;
  const message=new TransactionMessage({payerKey:pk(payer),recentBlockhash:blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),...ixs.filter(ix=>!ix.programId.equals(ComputeBudgetProgram.programId))]}).compileToV0Message(lookup?[lookup]:[]);
  const bytes=new VersionedTransaction(message).serialize();
  return {version:0,bytes,blockhash,lastValidBlockHeight};
}
export async function refreshed(c:Connection,payer:string,feed=demo.feed) {
  return (await refreshInstructions(c,feed,payer)).filter(ix=>!ix.programId.equals(ComputeBudgetProgram.programId));
}
export async function simulate(c:Connection,tx:PreparedTransaction,addresses:string[]) {
  const r=await (c as unknown as {_rpcRequest(m:string,p:unknown[]):Promise<any>})._rpcRequest('simulateTransaction',[Buffer.from(tx.bytes).toString('base64'),{encoding:'base64',sigVerify:false,replaceRecentBlockhash:true,commitment:'confirmed',accounts:{encoding:'base64',addresses}}]);
  if(r.error||!r.result)throw Error(r.error?.message??'No simulation response');
  return r.result as {context:{slot:number};value:{err:any;logs:string[];unitsConsumed:number;accounts:any[];returnData?:{programId:string;data:[string,string]}}};
}
/** Simulates Mimir's refresh: no signature, no fee. Without a wallet, the feed's creator pays the simulation. */
export async function preview(c:Connection,payer?:string,feed=demo.feed) {
  if(!payer){const a=await c.getAccountInfo(pk(feed),'confirmed');if(!a)throw Error('Feed missing');payer=decodeV1ClassicFeed(a.data).owner.creator!;}
  const tx=await transaction(c,payer,await refreshed(c,payer,feed)),r=await simulate(c,tx,[feed]);
  if(r.value.err)throw decisionError(r.value.err,tx,r.value.logs);
  return {token:snapshot(Buffer.from(r.value.accounts[0].data[0],'base64'),r.context.slot),slot:r.context.slot,cu:r.value.unitsConsumed};
}
export async function tokenMint(c:Connection,feed=demo.feed) { const a=await c.getAccountInfo(pk(feed),'confirmed');if(!a)throw Error('Feed missing');const d=decodeV1ClassicFeed(a.data).definition,i=d.feedImage;return {mint:new PublicKey(i.slice(48,80)),decimals:i[118]!,ticker:tickerOf(d.ticker)}; }
export async function poolVaults(c:Connection,base:PublicKey) {
  if(!demo.pool)throw Error('Set VITE_POOL to the feed\'s Raydium CPMM pool.');
  const a=await c.getAccountInfo(pk(demo.pool),'confirmed'),d=a?.data;
  if(!d||d.length!==637||!Buffer.from(d.subarray(0,8)).equals(Buffer.from([247,237,227,245,215,195,222,70])))throw Error('Pool binding changed.');
  const mint0=new PublicKey(d.subarray(168,200)),mint1=new PublicKey(d.subarray(200,232));
  if(mint0.equals(base)&&mint1.equals(USDC))return {baseVault:new PublicKey(d.subarray(72,104)),quoteVault:new PublicKey(d.subarray(104,136))};
  if(mint1.equals(base)&&mint0.equals(USDC))return {baseVault:new PublicKey(d.subarray(104,136)),quoteVault:new PublicKey(d.subarray(72,104))};
  throw Error('Pool pair changed.');
}
// Tags: 0 Mimir borrow, 1 protected fill, 2 spot lender, 3 repay, 4 release.
export function consumerInstruction(user:string,base:PublicKey,collateral:bigint,loan:bigint,tag:0|1|2|3|4,feed=demo.feed,vaults?:{baseVault:PublicKey;quoteVault:PublicKey}) {
  const vault=vaultAddress(tag>2?0:tag as 0|1|2,feed),data=Buffer.alloc(17);data[0]=tag;data.writeBigUInt64LE(collateral,1);data.writeBigUInt64LE(loan,9);
  const ro=(pubkey:PublicKey,isWritable=false)=>({pubkey,isWritable,isSigner:false});
  const extra=tag===2?[pk(demo.pool),vaults!.baseVault,vaults!.quoteVault].map(k=>ro(k)):tag===0?[ro(positionAddress(user,feed),true),ro(PublicKey.default)]:tag>2?[ro(positionAddress(user,feed),true)]:[];
  const keys=[ro(pk(feed)),{pubkey:pk(user),isSigner:true,isWritable:tag===0},
    ...[ata(user,base),ata(vault.toBase58(),base),ata(vault.toBase58(),USDC),ata(user,USDC)].map(k=>ro(k,true)),
    ...[vault,TOKEN_PROGRAM_ID,SYSVAR_INSTRUCTIONS_PUBKEY].map(k=>ro(k)),...extra];
  return new TransactionInstruction({programId:pk(demo.program),data,keys});
}
async function run(c:Connection,w:MimirWallet,check:{tx:PreparedTransaction;simulation:Awaited<ReturnType<typeof simulate>>}) {
  if(check.simulation.value.err)throw decisionError(check.simulation.value.err,check.tx,check.simulation.value.logs);
  return {signature:await signAndSend(c,w,check.tx),simulation:check.simulation};
}
export const borrow=async(c:Connection,w:MimirWallet,collateral:bigint,loan:bigint,feed=demo.feed)=>run(c,w,await checkBorrow(c,w.address,collateral,loan,0,feed));
/** Tag 0 reads only the Mimir feed; tag 2 (the spot lender) also reads the CPMM pool. */
export async function checkBorrow(c:Connection,payer:string,collateral:bigint,loan:bigint,tag:0|2,feed=demo.feed) {
  await assertConsumer(c);
  const {mint}=await tokenMint(c,feed),vaults=tag===2?await poolVaults(c,mint):undefined,refresh=tag===0?await refreshed(c,payer,feed):[];
  const tx=await transaction(c,payer,[...refresh,consumerInstruction(payer,mint,collateral,loan,tag,feed,vaults)]);
  return {tx,simulation:await simulate(c,tx,[])};
}
/** Repay USDC debt (tag 3) or release all collateral once the debt is zero (tag 4). No price is read. */
export async function settle(c:Connection,w:MimirWallet,tag:3|4,amount=0n,feed=demo.feed) {
  await assertConsumer(c);
  const {mint}=await tokenMint(c,feed),tx=await transaction(c,w.address,[consumerInstruction(w.address,mint,0n,amount,tag,feed)]);
  return run(c,w,{tx,simulation:await simulate(c,tx,[])});
}
export async function position(c:Connection,user:string,feed=demo.feed) {
  if(!demo.program)return {collateral:0n,debt:0n};
  const a=await c.getAccountInfo(positionAddress(user,feed),'confirmed');
  return a?{collateral:a.data.readBigUInt64LE(0),debt:a.data.readBigUInt64LE(8)}:{collateral:0n,debt:0n};
}
const reasons:Record<number,string>={1:'price is not Fresh',2:'above the collateral limit',3:'outside the price bound',4:'feed or account binding refused'};
/** Names the failing instruction by its program, and the innermost failing program from the logs:
 * a Mimir refresh or token-transfer error is not a consumer decision. */
export function decisionError(err:any,tx?:PreparedTransaction,logs?:string[]|null) {
  const [index,inner]=err?.InstructionError??[];
  const m=tx&&index!==undefined?VersionedTransaction.deserialize(tx.bytes).message:undefined;
  const program=m?m.staticAccountKeys[m.compiledInstructions[index]!.programIdIndex]!.toBase58():undefined;
  const failed=logs?.find(l=>/^Program \w+ failed/.test(l))?.split(' ')[1]??program;
  if(failed===TOKEN_PROGRAM_ID.toBase58())return Error(`Token transfer refused: ${inner?.Custom===1?'insufficient token balance':JSON.stringify(inner)}.`);
  if(program===demo.program&&failed===program&&inner?.Custom in reasons)return Error(`Declined by the consumer: ${reasons[inner.Custom]}.`);
  return Error(`${program===MIMIR_PROGRAM?'Mimir refresh':program?`Instruction ${index} (${program})`:'Transaction'} refused: ${JSON.stringify(inner??err)}`);
}
const MIMIR_PROGRAM='hBYrGHXVCQsnduDERkVnViCXNYawpHCvN5y3GsMiMiR';
/** The consumer's 40-byte return data: Q32 price (USDC per token), loan limit in USDC atoms, slot. */
export function receipt(sim:{value:{returnData?:{programId:string;data:[string,string]}}}) {
  const r=sim.value.returnData;if(!r||r.programId!==demo.program||r.data[1]!=='base64')return null;
  const b=Buffer.from(r.data[0],'base64');if(b.length!==40||b.readBigUInt64LE(24)!==0n)return null;
  return {price:Number(b.readBigUInt64LE(0)+(b.readBigUInt64LE(8)<<64n))/2**32,limit:b.readBigUInt64LE(16),slot:Number(b.readBigUInt64LE(32))};
}
export const fill=async(c:Connection,w:MimirWallet,collateral:bigint,payout:bigint,feed=demo.feed)=>run(c,w,await checkFill(c,w.address,collateral,payout,feed));
export async function checkFill(c:Connection,payer:string,collateral:bigint,payout:bigint,feed=demo.feed) {
  await assertConsumer(c);
  const {mint}=await tokenMint(c,feed);
  const tx=await transaction(c,payer,[...await refreshed(c,payer,feed),consumerInstruction(payer,mint,collateral,payout,1,feed)]);
  return {tx,simulation:await simulate(c,tx,[])};
}
