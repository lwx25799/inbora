import type {Page,Request,Response,Frame} from 'playwright';
import {digest,type InboundEvent,type SendProof} from '../core/contracts.js';
import type {ObservationMapping} from '../config/site-mapping.js';

type Fields=Map<number,(bigint|Buffer)[]>;
/** Bounded read-only protobuf wire decoder. Never encodes requests or evaluates page code. */
function fields(bytes:Buffer):Fields{
  if(bytes.length>65_536)throw Error('BODY_LIMIT');let pos=0,count=0;const out:Fields=new Map();
  const integer=():bigint=>{let value=0n;
    for(let n=0;n<10;n++){if(pos>=bytes.length)throw Error('TRUNCATED');const b=bytes[pos++]!;
      if(n===9&&b>1)throw Error('VARINT_LIMIT');value|=BigInt(b&127)<<BigInt(n*7);
      if(!(b&128)){if(n>0&&b===0)throw Error('NONCANONICAL');return value;}}
    throw Error('VARINT_LIMIT');};
  while(pos<bytes.length){if(++count>512)throw Error('FIELD_LIMIT');const key=integer(),tag=Number(key>>3n),wire=Number(key&7n);
    if(tag<1||tag>536_870_911)throw Error('INVALID_TAG');let value:bigint|Buffer;
    if(wire===0)value=integer();
    else if(wire===2){const size=integer();if(size>BigInt(bytes.length-pos))throw Error('TRUNCATED');value=bytes.subarray(pos,pos+Number(size));pos+=Number(size);}
    else if(wire===1||wire===5){const size=wire===1?8:4;if(pos+size>bytes.length)throw Error('TRUNCATED');value=bytes.subarray(pos,pos+size);pos+=size;}
    else throw Error('UNSUPPORTED_WIRE');
    out.set(tag,[...(out.get(tag)??[]),value]);
  }return out;
}
function one(f:Fields,tag:number):bigint|Buffer{const values=f.get(tag);if(values?.length!==1)throw Error('MISSING_OR_DUPLICATE_FIELD');return values[0]!;}
function number(f:Fields,tag:number,optional=false):bigint{if(optional&&!f.has(tag))return 0n;const value=one(f,tag);if(typeof value!=='bigint')throw Error('WRONG_WIRE');return value;}
function bytes(f:Fields,tag:number):Buffer{const value=one(f,tag);if(!Buffer.isBuffer(value))throw Error('WRONG_WIRE');return value;}
function string(f:Fields,tag:number):string{return new TextDecoder('utf-8',{fatal:true}).decode(bytes(f,tag));}
const native=(value:unknown):value is string=>typeof value==='string'&&/^[1-9]\d{0,63}$/.test(value);

export interface ParsedSubmission{conversation?:string;text:string;clientId?:string;sequence?:string}
export function decodeDmSubmission(body:Buffer):ParsedSubmission{
  const root=fields(body);if(number(root,1)!==100n)throw Error('WRONG_COMMAND');
  const message=fields(bytes(fields(bytes(root,8)),100)),content:unknown=JSON.parse(string(message,4));
  if(number(message,2)!==1n||number(message,6)!==7n||!content||typeof content!=='object'||
    typeof (content as {text?:unknown}).text!=='string')throw Error('NON_TEXT_MESSAGE');
  const clientId=string(message,8),sequence=number(root,2).toString(),conversation=string(message,1);
  if(!/^[A-Za-z0-9_.:-]{1,160}$/.test(clientId)||!native(sequence)||conversation.length>200)throw Error('INVALID_BINDING');
  return{conversation,text:(content as {text:string}).text,clientId,sequence};
}
export function decodeDmAcknowledgement(body:Buffer,sent:ParsedSubmission,ownId:string):string{
  const root=fields(body);if(number(root,1)!==100n||number(root,2).toString()!==sent.sequence||number(root,3,true)!==0n||
    number(root,13).toString()!==ownId)throw Error('RESPONSE_BINDING');
  const message=fields(bytes(fields(bytes(root,6)),100)),id=number(message,1).toString();
  if(!native(id)||string(message,4)!==sent.clientId||number(message,3,true)!==0n||number(message,5,true)!==0n||
    number(message,8,true)!==0n||message.has(7)&&string(message,7)!==sent.text)throw Error('UNCONFIRMED_RESPONSE');
  return id;
}
export interface SubmissionAck{ id:string;submission:NonNullable<SendProof['submission']> }

/** Observes only one armed attempt on its dedicated Page; no request issuance or fallback. */
export class SubmissionResponse{
  private epoch=0;private attempt:{event:InboundEvent;text:string;boundary:string}|null=null;
  private requestToken:{request:Request;epoch:number;at:string;digest:string;parsed:ParsedSubmission|undefined}|null=null;
  private count=0;private ack:SubmissionAck|null=null;private blocked=false;
  private failure:string|null=null;
  private refreshExpected=false;
  constructor(private readonly page:Page,private readonly mapping:ObservationMapping){
    page.on('request',this.request);page.on('response',this.response);page.on('framenavigated',this.navigation);page.once('close',this.dispose);
  }
  arm(event:InboundEvent,text:string,boundary:string):void{
    this.epoch++;this.attempt={event,text,boundary};this.requestToken=null;this.count=0;this.ack=null;this.blocked=false;this.failure=null;this.refreshExpected=false;
  }
  current():SubmissionAck|null{return !this.blocked&&this.count===1?this.ack:null;}
  diagnostics():{requestCount:number;acknowledged:boolean;failure:string|null}{return{requestCount:this.count,acknowledged:!!this.current(),failure:this.failure};}
  expectRefresh(ack:SubmissionAck):boolean{if(this.current()!==ack)return false;this.refreshExpected=true;return true;}
  private navigation=(frame:Frame):void=>{if(frame!==this.page.mainFrame())return;
    if(this.refreshExpected){this.refreshExpected=false;this.epoch++;this.requestToken=null;}else this.clear();};
  private clear():void{this.epoch++;this.attempt=null;this.requestToken=null;this.ack=null;}
  private request=(request:Request):void=>{try{
    const attempt=this.attempt;if(!attempt)return;const {event,text,boundary}=attempt,url=new URL(request.url());
    const comment=event.channel==='COMMENT_NOTIFICATION',origin=comment?this.mapping.origin:'https://imapi.douyin.com';
    if(request.method()!=='POST'||request.frame()!==this.page.mainFrame()||url.origin!==origin||url.username||url.password||
      (comment?!/^\/aweme\/v1\/web\/comment\/publish\/?$/.test(url.pathname):url.pathname!=='/v1/message/send'))return;
    if(++this.count!==1){this.blocked=true;this.failure='MULTIPLE_SUBMISSIONS';this.ack=null;return;}
    const at=new Date().toISOString(),body=request.postDataBuffer();
    if(!body||body.length>65_536||Date.parse(at)<Date.parse(boundary)||request.redirectedFrom())throw Error('INVALID_REQUEST');
    let parsed:ParsedSubmission|undefined;
    if(comment){
      if(!this.mapping.works.some(w=>w.id===event.videoId&&this.page.url().split('?')[0]===w.url.split('?')[0]))throw Error('WORK_CHANGED');
      const form=new URLSearchParams(body.toString('utf8'));
      for(const key of ['aweme_id','reply_id','text'])if(form.getAll(key).length!==1)throw Error('FORM_BINDING');
      const nested=event.kind==='REPLY',root=nested?event.rootCommentId:event.commentId;
      if(!root||nested&&event.replyToCommentId!==event.commentId||form.get('aweme_id')!==event.videoId||form.get('reply_id')!==root||form.get('text')!==text||
        (nested?form.getAll('reply_to_reply_id').length!==1||form.get('reply_to_reply_id')!==event.commentId:
          form.getAll('reply_to_reply_id').length>1||form.has('reply_to_reply_id')&&!['0',event.commentId].includes(form.get('reply_to_reply_id'))))
        throw Error('FORM_BINDING');
    }else{
      if(this.page.url().split('?')[0]!==new URL(this.mapping.entryUrl).href.split('?')[0]||!this.mapping.peers.some(p=>p.uid===event.actorId&&p.conversationId===event.conversationId))throw Error('DM_SCOPE');
      parsed=decodeDmSubmission(body);if(parsed.text!==text||parsed.conversation!==event.conversationId)throw Error('DM_BINDING');
    }
    this.requestToken={request,epoch:this.epoch,at,digest:digest(body.toString('base64')),parsed};
  }catch(error){this.blocked=true;this.ack=null;this.failure=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'INVALID_REQUEST';}};
  private response=(response:Response):void=>{void this.capture(response);};
  private async capture(response:Response):Promise<void>{
    const token=this.requestToken,attempt=this.attempt;if(!token||!attempt||response.request()!==token.request)return;
    this.requestToken=null;
    try{
      if(response.status()!==200||response.fromServiceWorker()||Number(response.headers()['content-length'])>65_536)throw Error('HTTP_STATUS');
      const body=await response.body();if(body.length>65_536)throw Error('BODY_LIMIT');
      let id:string;
      if(attempt.event.channel==='DIRECT_MESSAGE')id=decodeDmAcknowledgement(body,token.parsed!,this.mapping.self.uid);
      else{
        const data=JSON.parse(body.toString('utf8')),c=data.comment;
        const nested=attempt.event.kind==='REPLY',root=nested?attempt.event.rootCommentId:attempt.event.commentId;
        if(!root||data.status_code!==0||!c||!native(c.cid)||c.reply_id!==root||
          c.aweme_id!==undefined&&c.aweme_id!==attempt.event.videoId||c.text!==attempt.text||
          c.user?.uid!==this.mapping.self.uid||c.user?.sec_uid!==this.mapping.self.secUid||
          c.reply_to_reply_id!==(nested?attempt.event.commentId:'0')||c.status!==7||!Number.isFinite(c.create_time))throw Error('COMMENT_RESPONSE_BINDING');
        id=c.cid;
      }
      if(token.epoch!==this.epoch||attempt!==this.attempt||this.blocked||this.count!==1)return;
      this.ack={id,submission:{boundary:attempt.boundary,requestAt:token.at,responseAt:new Date().toISOString(),
        requestDigest:token.digest,responseDigest:digest(body.toString('base64'))}};
    }catch(error){if(token.epoch===this.epoch){this.blocked=true;this.ack=null;
      this.failure=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'INVALID_RESPONSE';}}
  }
  dispose=():void=>{this.clear();this.page.off('request',this.request);this.page.off('response',this.response);
    this.page.off('framenavigated',this.navigation);this.page.off('close',this.dispose);};
}
