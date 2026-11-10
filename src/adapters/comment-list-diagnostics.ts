import type {Frame,Page,Request,Response} from 'playwright';
import {z} from 'zod';
import type {ObservationMapping} from '../config/site-mapping.js';
import {readNormalJsonResponse} from './normal-response-reader.js';

const count=z.number().int().nonnegative(),number=count.nullable();
const inlineShapeSchema=z.object({roots:count,arrays:count,missing:count,other:count,children:count,truncated:z.boolean(),duplicateIds:count,
  nativeId:count,workMatches:count,rootMatches:count,replyToMissing:count,replyToString:count,replyToNumber:count,replyToNull:count,replyToOther:count,
  toRoot:count,toKnownChild:count,toSelf:count,toUnknown:count,own:count,confirmed:count,timeValid:count,completeOwnChildRelations:count}).strict();
export const commentResponseSummarySchema=z.object({count,total:number,hasMore:z.boolean().nullable(),requestedCursor:number,cursor:number,cursorAdvances:z.boolean().nullable(),
  afterOrigin:count,fresh30m:count,older30m:count,unknownTime:count,futureTime:count,ownCount:count,metadataMissing:count,newestAgeMs:number,newestNonOwnAgeMs:number,
  inlineShape:inlineShapeSchema.optional()}).strict();
export type CommentResponseSummary=z.infer<typeof commentResponseSummarySchema>;
const envelope=z.object({status_code:z.literal(0),comments:z.array(z.unknown()).max(100)}).passthrough();
const numeric=(value:unknown):number|null=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
const native=(value:unknown):value is string=>typeof value==='string'&&/^[1-9]\d{0,63}$/u.test(value);

/** Diagnostic counts only. Inline shape never becomes a receipt or supplies a missing relation. */
function inlineShape(rows:unknown[],workId:string,ownId:string,now:number):z.infer<typeof inlineShapeSchema>{
  const result={roots:rows.length,arrays:0,missing:0,other:0,children:0,truncated:false,duplicateIds:0,nativeId:0,workMatches:0,rootMatches:0,
    replyToMissing:0,replyToString:0,replyToNumber:0,replyToNull:0,replyToOther:0,toRoot:0,toKnownChild:0,toSelf:0,toUnknown:0,
    own:0,confirmed:0,timeValid:0,completeOwnChildRelations:0};
  const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
  const rootIds=rows.map(row=>object(row).cid);
  for(const raw of rows){
    const root=object(raw),inline=root.reply_comment;
    if(inline===undefined){result.missing++;continue;}if(!Array.isArray(inline)){result.other++;continue;}
    result.arrays++;const samples=inline.slice(0,Math.max(0,100-result.children)).map(object);
    if(samples.length<inline.length)result.truncated=true;
    const rootBound=native(root.cid)&&rootIds.filter(id=>id===root.cid).length===1,
      ids=samples.map(row=>row.cid),known=new Set(samples.filter(row=>rootBound&&native(row.cid)&&row.reply_id===root.cid&&row.aweme_id===workId&&
        ids.filter(id=>id===row.cid).length===1).map(row=>row.cid));
    for(const row of samples){
      result.children++;const user=object(row.user),target=row.reply_to_reply_id,id=native(row.cid),work=row.aweme_id===workId,
        parent=rootBound&&row.reply_id===root.cid,own=user.uid===ownId,time=typeof row.create_time==='number'?row.create_time*1000:NaN,
        validTime=Number.isFinite(time)&&time>=Date.UTC(2000,0,1)&&time<=now,confirmed=row.status===1;
      if(id)result.nativeId++;if(work)result.workMatches++;if(parent)result.rootMatches++;if(own)result.own++;
      if(confirmed)result.confirmed++;if(validTime)result.timeValid++;
      if(id&&ids.filter(value=>value===row.cid).length>1)result.duplicateIds++;
      if(target===undefined)result.replyToMissing++;else if(target===null)result.replyToNull++;
      else if(typeof target==='string')result.replyToString++;else if(typeof target==='number')result.replyToNumber++;else result.replyToOther++;
      const toRoot=parent&&(target==='0'||target===root.cid),toSelf=id&&target===row.cid,
        toChild=parent&&native(target)&&target!==row.cid&&known.has(target);
      if(toRoot)result.toRoot++;else if(toSelf)result.toSelf++;else if(toChild)result.toKnownChild++;else result.toUnknown++;
      if(id&&work&&parent&&toChild&&own&&typeof user.sec_uid==='string'&&user.sec_uid.length>0&&
        typeof row.text==='string'&&row.text.length>0&&row.text.length<=4000&&validTime&&confirmed&&ids.filter(value=>value===row.cid).length===1)
        result.completeOwnChildRelations++;
    }
  }
  return result;
}

/** Counts only from this turn's normal root-list GET. It never issues requests or provides sending evidence. */
export class CommentListDiagnostics {
  private epoch=0;private sequence=0;private disposed=false;
  private result:CommentResponseSummary|null=null;private pending=new Set<Promise<void>>();
  private tokens=new WeakMap<Request,{epoch:number;sequence:number;cursor:number|null}>();
  constructor(private readonly page:Page,private readonly mapping:ObservationMapping,private readonly work:{id:string;url:string},
    private readonly now:()=>number,private readonly origin:number){
    page.on('request',this.request);page.on('response',this.response);page.on('framenavigated',this.navigation);
  }
  private current():boolean {try{return !this.disposed&&this.mapping.works.some(work=>work.id===this.work.id&&work.url===this.work.url)&&
    this.page.url().split('?')[0]===this.work.url.split('?')[0];}catch{return false;}}
  private navigation=(frame:Frame):void=>{if(frame===this.page.mainFrame()){this.epoch++;this.result=null;}};
  private request=(request:Request):void=>{
    try{const url=new URL(request.url());
      if(!this.current()||request.method()!=='GET'||request.frame()!==this.page.mainFrame()||url.origin!==this.mapping.origin||url.username||url.password||
        url.pathname!=='/aweme/v1/web/comment/list/'||url.searchParams.getAll('aweme_id').length!==1||url.searchParams.get('aweme_id')!==this.work.id)return;
      const raw=url.searchParams.getAll('cursor');const cursor=raw.length===1&&/^\d{1,16}$/u.test(raw[0]!)?numeric(Number(raw[0])):null;
      this.result=null;this.tokens.set(request,{epoch:this.epoch,sequence:++this.sequence,cursor});
    }catch{/* Unknown request metadata is not a response diagnostic. */}
  };
  private response=(response:Response):void=>{
    const task=this.capture(response).catch(()=>{});this.pending.add(task);void task.finally(()=>this.pending.delete(task));
  };
  private async capture(response:Response):Promise<void>{
    const token=this.tokens.get(response.request());if(!token)return;this.tokens.delete(response.request());
    if(response.status()!==200||response.fromServiceWorker()||this.pending.size>=4)return;
    const read=await readNormalJsonResponse(response,2*1024*1024);
    if(!read.ok||!this.current()||token.epoch!==this.epoch||token.sequence!==this.sequence)return;
    const parsed=envelope.safeParse(read.value);if(!parsed.success)return;
    const rows=parsed.data.comments,now=this.now(),past:number[]=[],nonOwn:number[]=[];let afterOrigin=0,fresh30m=0,older30m=0,unknownTime=0,futureTime=0,ownCount=0,metadataMissing=0;
    for(const raw of rows){
      const row=raw&&typeof raw==='object'?raw as Record<string,unknown>:{},user=row.user&&typeof row.user==='object'?row.user as Record<string,unknown>:{},own=user.uid===this.mapping.self.uid;
      const time=typeof row.create_time==='number'?row.create_time*1000:NaN,valid=Number.isFinite(time)&&time>=Date.UTC(2000,0,1);
      if(own)ownCount++;if(!native(row.cid)||!native(user.uid)||!valid)metadataMissing++;
      if(!valid){unknownTime++;continue;}if(time>now){futureTime++;continue;}
      const age=now-time;past.push(age);if(native(user.uid)&&!own)nonOwn.push(age);if(time>this.origin)afterOrigin++;if(age<=30*60_000)fresh30m++;else older30m++;
    }
    this.result=commentResponseSummarySchema.parse({count:rows.length,total:numeric(parsed.data.total),hasMore:parsed.data.has_more===0?false:parsed.data.has_more===1?true:null,
      requestedCursor:token.cursor,cursor:numeric(parsed.data.cursor),cursorAdvances:token.cursor!==null&&numeric(parsed.data.cursor)!==null?Number(parsed.data.cursor)>token.cursor:null,
      afterOrigin,fresh30m,older30m,unknownTime,futureTime,ownCount,metadataMissing,newestAgeMs:past.length?Math.min(...past):null,newestNonOwnAgeMs:nonOwn.length?Math.min(...nonOwn):null,
      inlineShape:inlineShape(rows,this.work.id,this.mapping.self.uid,now)});
  }
  async summary(signal:AbortSignal):Promise<CommentResponseSummary|null>{
    if(signal.aborted)return null;
    const epoch=this.epoch;let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([Promise.allSettled([...this.pending]),new Promise(resolve=>{timer=setTimeout(resolve,300);})]);}
    finally{if(timer)clearTimeout(timer);}
    return !signal.aborted&&this.current()&&epoch===this.epoch?this.result:null;
  }
  dispose():void {this.disposed=true;this.epoch++;this.result=null;this.page.off('request',this.request);this.page.off('response',this.response);this.page.off('framenavigated',this.navigation);}
}
