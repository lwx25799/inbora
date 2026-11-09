import type {Response} from 'playwright';
import {runtimePerformance} from '../observability/runtime-performance.js';

/* Response classification adapted from Yht20927/douyin-cli, lib/shared/parseResponse.js
 * commit 4073159bea585de6d33a4747a475669440737932, Copyright (c) 2026 Yht20927, MIT; see third_party/douyin-cli/LICENSE.
 * Source: https://github.com/Yht20927/douyin-cli/blob/4073159bea585de6d33a4747a475669440737932/lib/shared/parseResponse.js
 * Unlike the upstream diagnostic strings, only fixed enums leave this reader; no response snippet is retained.
 */
export const NORMAL_RESPONSE_MAX_BYTES=2*1024*1024;
export const NORMAL_RESPONSE_TIMEOUT_MS=5000;
export type NormalResponseFailure='HTTP'|'SERVICE_WORKER'|'SIZE'|'EMPTY'|'HTML'|'JSON'|'NETWORK';
export type NormalJsonResponseResult={ok:true;value:unknown;byteLength:number}|{ok:false;reason:NormalResponseFailure};
const reads=new WeakMap<Response,Promise<NormalJsonResponseResult>>();
const failure=(reason:NormalResponseFailure):NormalJsonResponseResult=>Object.freeze({ok:false,reason});

/** JSON.parse creates an acyclic graph. Freeze it once without recursive calls or per-consumer copies. */
function freezeJson(value:unknown):void {
  const pending:object[]=value!==null&&typeof value==='object'?[value]:[];
  while(pending.length){
    const item=pending.pop()!;Object.freeze(item);
    for(const child of Object.values(item))if(child!==null&&typeof child==='object')pending.push(child);
  }
}

async function readOnce(response:Response):Promise<NormalJsonResponseResult> {
  let bytes:Buffer,contentType:string;
  try {
    if(response.status()<200||response.status()>=300)return failure('HTTP');
    if(response.fromServiceWorker())return failure('SERVICE_WORKER');
    const headers=response.headers(),declared=Number(headers['content-length']);
    if(Number.isFinite(declared)&&declared>NORMAL_RESPONSE_MAX_BYTES)return failure('SIZE');
    contentType=headers['content-type']??'';
    const end=runtimePerformance.start('RESPONSE_READ');
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      bytes=await Promise.race([response.body(),new Promise<never>((_resolve,reject)=>{
        timer=setTimeout(()=>reject(new Error('NORMAL_RESPONSE_TIMEOUT')),NORMAL_RESPONSE_TIMEOUT_MS);
      })]);end();
    }catch {end('FAILED');return failure('NETWORK');}
    finally {if(timer)clearTimeout(timer);}
  }catch {return failure('NETWORK');}
  if(bytes.byteLength>NORMAL_RESPONSE_MAX_BYTES)return failure('SIZE');
  const end=runtimePerformance.start('RESPONSE_PARSE');
  try {
    const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    if(!text.trim()){end('FAILED');return failure('EMPTY');}
    if(/^\s*</u.test(text)||/text\/html/iu.test(contentType)){end('FAILED');return failure('HTML');}
    // Native ID fields must subsequently pass their consumers' string schemas. Never coerce rounded JSON numbers.
    const value:unknown=JSON.parse(text);freezeJson(value);end();
    return Object.freeze({ok:true as const,value,byteLength:bytes.byteLength});
  }catch {end('FAILED');return failure('JSON');}
}

/** Shared only within the lifetime of this exact normal response. Consumers still verify epoch, sequence and target.
 * The byte limit bounds accepted/parsing input; Playwright buffers body() before the actual size can be checked. */
export async function readNormalJsonResponse(response:Response,maxBytes=NORMAL_RESPONSE_MAX_BYTES):Promise<NormalJsonResponseResult> {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>NORMAL_RESPONSE_MAX_BYTES)return failure('SIZE');
  try {
    const declared=Number(response.headers()['content-length']);
    if(Number.isFinite(declared)&&declared>maxBytes)return failure('SIZE');
  }catch {return failure('NETWORK');}
  let pending=reads.get(response);
  if(!pending){pending=readOnce(response);reads.set(response,pending);}
  const result=await pending;
  return result.ok&&result.byteLength>maxBytes?failure('SIZE'):result;
}
