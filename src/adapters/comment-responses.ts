import type {Page,Request,Response,Frame} from 'playwright';
import {z} from 'zod';
import {nativeCommentReplyPath,type CommentReplyMapping} from '../config/site-mapping.js';
import {eventBinding,type InboundEvent} from '../core/contracts.js';

const id=z.string().regex(/^[1-9]\d{0,63}$/);
const nativeReply=z.object({cid:id,aweme_id:id,reply_id:id,reply_to_reply_id:z.union([id,z.literal('0')]).optional(),text:z.string().max(4000),status:z.number().int(),
  create_time:z.number().finite(),user:z.object({uid:id,sec_uid:z.string().min(1).max(300)})});
export type NativeCommentReply=z.infer<typeof nativeReply>;
const batch=z.object({status_code:z.literal(0),comments:z.array(nativeReply).max(100)});

/** Passive, ephemeral evidence from the exact page's normal GET. Never issues a request. */
export class CommentResponses{
  private event:InboundEvent|null=null;
  private epoch=0;
  private sequence=0;
  private active=0;
  private clockSequence=0;
  private clock:{sampledAt:number;lagMs:number}|null=null;
  private rows:NativeCommentReply[]=[];
  private requests=new WeakMap<Request,{epoch:number;sequence:number;clock:boolean}>();
  constructor(private readonly page:Page,private readonly mapping:CommentReplyMapping){
    page.on('request',this.request);page.on('response',this.response);page.on('framenavigated',this.navigation);page.once('close',this.dispose);
  }
  watch(event:InboundEvent):void{
    if(!this.event||eventBinding(this.event)!==eventBinding(event)){this.epoch++;this.rows=[];this.clock=null;}
    this.event=event;
  }
  snapshot(event:InboundEvent):NativeCommentReply[]{
    return this.event&&eventBinding(this.event)===eventBinding(event)?this.rows:[];
  }
  clockLag():number|null{return this.clock&&Date.now()>=this.clock.sampledAt&&Date.now()-this.clock.sampledAt<=30_000?this.clock.lagMs:null;}
  private navigation=(frame:Frame):void=>{if(frame===this.page.mainFrame()){this.epoch++;this.rows=[];this.clock=null;}};
  private request=(request:Request):void=>{
    try{
      const e=this.event,url=new URL(request.url()),o=this.mapping.observation;
      if(!e||request.method()!=='GET'||request.frame()!==this.page.mainFrame()||url.origin!==o.origin||url.username||url.password||
        !o.works.some(w=>w.id===e.videoId&&this.page.url().split('?')[0]===w.url.split('?')[0]))return;
      const clock=url.pathname==='/aweme/v1/web/comment/list/'&&url.searchParams.getAll('aweme_id').length===1&&url.searchParams.get('aweme_id')===e.videoId;
      if(clock){this.clock=null;this.requests.set(request,{epoch:this.epoch,sequence:++this.clockSequence,clock:true});return;}
      if(url.pathname!==nativeCommentReplyPath||url.searchParams.getAll('comment_id').length!==1||url.searchParams.get('comment_id')!==(e.rootCommentId??e.commentId))return;
      this.rows=[];this.requests.set(request,{epoch:this.epoch,sequence:++this.sequence,clock:false});
    }catch{/* Unknown/service-worker requests are not evidence. */}
  };
  private response=(response:Response):void=>{void this.capture(response);};
  private async capture(response:Response):Promise<void>{
    const request=response.request(),token=this.requests.get(request);
    if(!token||response.status()!==200||response.fromServiceWorker()||this.active>=4)return;
    this.requests.delete(request);
    this.active++;
    try{
      const length=Number(response.headers()['content-length']);if(Number.isFinite(length)&&length>1_000_000)return;
      const raw=await response.text();if(raw.length>1_000_000)return;
      const body:unknown=JSON.parse(raw),e=this.event;
      if(!e||token.epoch!==this.epoch)return;
      const work=this.mapping.observation.works.find(w=>w.id===e.videoId);
      if(!work||this.page.url().split('?')[0]!==work.url.split('?')[0])return;
      if(token.clock){
        const sample=z.object({status_code:z.literal(0),extra:z.object({now:z.number().int().positive()})}).safeParse(body),at=Date.now();
        if(!sample.success||token.sequence!==this.clockSequence)return;
        const server=sample.data.extra.now,header=Date.parse(response.headers()['date']??''),lag=at-server;
        if(Math.floor(server/1000)*1000===header&&lag>=0&&lag<=5000)this.clock={sampledAt:at,lagMs:lag};
        return;
      }
      const result=batch.safeParse(body);if(!result.success||token.sequence!==this.sequence)return;
      const rows=result.data.comments;
      if(new Set(rows.map(r=>r.cid)).size!==rows.length||rows.some(r=>r.aweme_id!==e.videoId||r.reply_id!==(e.rootCommentId??e.commentId)))return;
      this.rows=rows;
    }catch{/* Missing/invalid body never supplies a confirmation status. */}
    finally{this.active--;}
  }
  dispose=():void=>{
    this.epoch++;this.rows=[];this.event=null;this.clock=null;
    this.page.off('request',this.request);this.page.off('response',this.response);this.page.off('framenavigated',this.navigation);this.page.off('close',this.dispose);
  };
}
