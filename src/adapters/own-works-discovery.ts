import type { Page, Response, Request, Frame } from "playwright";
import { z } from "zod";
import { Blocked, requireSafe } from "../core/contracts.js";
import type { ObservationMapping } from "../config/site-mapping.js";
import type { ObservedReader } from "./observed-reader.js";
import {readNormalJsonResponse} from './normal-response-reader.js';
import {runtimePerformance} from '../observability/runtime-performance.js';

const postPage = z.object({status_code: z.literal(0), has_more: z.union([z.literal(0), z.literal(1)]),
  aweme_list: z.array(z.object({aweme_id: z.string().regex(/^\d{1,64}$/), create_time: z.number().int().nonnegative().nullable().optional(),
    author: z.object({uid: z.string(), sec_uid: z.string()})})).max(100)});
export interface DiscoveredWork {id: string; ownId: string; url: string; publishedAt: number | null; precisionMs: number}
export type PendingWork = z.infer<typeof postPage>["aweme_list"][number];
interface ResponseToken {generation:number;epoch:number;sequence:number}

/** Candidate fields are accepted only from normal own-profile GETs and matching visible native links.
 * No request is manufactured; successful fixture parsing is not a claim of real-site calibration. */
export class OwnWorksDiscovery {
  private pending = new Set<Promise<void>>();
  private pages: {data:z.infer<typeof postPage>;sequence:number}[] = [];
  private error: string | null = null;
  private active = false;
  private disposed = false;
  private epoch = 0;
  private generation = 0;
  private sequence = 0;
  private tokens = new WeakMap<Request,ResponseToken>();
  private lastComplete = false;
  private current(token?:ResponseToken):boolean {
    return !this.disposed&&this.active&&(!token||token.generation===this.generation&&token.epoch===this.epoch)&&
      this.page.url().split('?')[0]===`${this.mapping.origin}/user/${this.mapping.self.secUid}`;
  }
  private readonly navigation=(frame:Frame):void=>{if(frame===this.page.mainFrame()){this.epoch++;this.pages=[];}};
  private readonly request=(request:Request):void=>{
    try {
      if(!this.current()||request.method()!=='GET'||request.frame()!==this.page.mainFrame())return;
      const url=new URL(request.url());
      if(url.origin!==this.mapping.origin||url.username||url.password||url.pathname!=='/aweme/v1/web/aweme/post/'||
        url.searchParams.getAll('sec_user_id').length!==1||url.searchParams.get('sec_user_id')!==this.mapping.self.secUid)return;
      this.tokens.set(request,{generation:this.generation,epoch:this.epoch,sequence:++this.sequence});
    }catch {/* Unknown request metadata is not own-work evidence. */}
  };
  private readonly listener = (response: Response) => {
    const request=response.request(),token=this.tokens.get(request);if(!token)return;this.tokens.delete(request);
    if(!this.current(token))return;
    if(this.pending.size>=4||this.pages.length>=20){this.error='OWN_WORKS_RESPONSE_LIMIT';return;}
    const task = this.accept(response,token).catch(cause => {
      if(this.current(token))this.error = cause instanceof Blocked?cause.code:"OWN_WORKS_METADATA_UNVERIFIED";
    });
    this.pending.add(task); void task.finally(() => this.pending.delete(task));
  };
  constructor(readonly page: Page, readonly mapping: ObservationMapping) {
    page.on('request',this.request);page.on("response", this.listener);page.on('framenavigated',this.navigation);page.once('close',this.dispose);
  }
  private async accept(response: Response,token:ResponseToken): Promise<void> {
    requireSafe(response.ok() && !response.fromServiceWorker() && response.request().frame() === this.page.mainFrame(), "OWN_WORKS_RESPONSE_UNVERIFIED");
    const read=await readNormalJsonResponse(response,2_000_000);if(!this.current(token))return;
    requireSafe(read.ok, !read.ok&&read.reason==='SIZE'?"OWN_WORKS_RESPONSE_TOO_LARGE":"OWN_WORKS_METADATA_UNVERIFIED");
    const endCheck=runtimePerformance.start('CONTENT_CHECK','COMMENT_NOTIFICATION');
    let data:z.infer<typeof postPage>;
    try {
      data = postPage.parse(read.value);
      requireSafe(data.aweme_list.every(w => w.author.uid === this.mapping.self.uid && w.author.sec_uid === this.mapping.self.secUid), "OWN_WORKS_ACCOUNT_CHANGED");
      endCheck();
    }catch(error){endCheck('FAILED');throw error;}
    requireSafe(this.pages.length < 20, "OWN_WORKS_RESPONSE_LIMIT");
    this.pages.push({data,sequence:token.sequence});this.pages.sort((a,b)=>a.sequence-b.sequence);
  }
  private async settle(signal:AbortSignal,deadline:number):Promise<void> {
    if(!this.pending.size||signal.aborted)return;
    await new Promise<void>(resolve=>{
      let timer:ReturnType<typeof setTimeout>;
      const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
      timer=setTimeout(done,Math.max(0,deadline-Date.now()));signal.addEventListener('abort',done,{once:true});
      void Promise.allSettled([...this.pending]).then(done);
    });
  }
  async scan(reader: ObservedReader, first: boolean, signal: AbortSignal, prior: PendingWork[] = []): Promise<{works: DiscoveredWork[]; pending: PendingWork[]; complete: boolean}> {
    requireSafe(!signal.aborted, "COLLECTION_CANCELLED");
    requireSafe(!this.active&&!this.disposed,'OWN_WORKS_SCAN_UNAVAILABLE');
    this.generation++;this.sequence=0;this.active = true; this.pages = []; this.error = null;
    try {
      const endLocation=runtimePerformance.start('TARGET_LOCATION','COMMENT_NOTIFICATION');
      try {
        if (first || this.page.url().split("?")[0] !== `${this.mapping.origin}/user/${this.mapping.self.secUid}`)
          await reader.navigate(`${this.mapping.origin}/user/${this.mapping.self.secUid}`);
        else {
          await reader.guard();
          await this.page.evaluate(() => window.scrollBy(0, Math.max(1, innerHeight * 0.8)));
        }
        endLocation();
      }catch(error){endLocation(signal.aborted?'CANCELLED':'FAILED');throw error;}
      const endWait=runtimePerformance.start('PAGE_WAIT','COMMENT_NOTIFICATION');
      try {
        const deadline = Date.now() + 5000;
        while (!this.pages.length && !this.error && Date.now() < deadline && !signal.aborted)
          await new Promise(resolve => setTimeout(resolve, 50));
        await this.settle(signal,deadline);
        requireSafe(!signal.aborted, "COLLECTION_CANCELLED");
        requireSafe(this.pending.size===0,"OWN_WORKS_METADATA_NOT_READY");
        requireSafe(this.current(),"OWN_WORKS_RESPONSE_UNVERIFIED");
        requireSafe(!this.error, this.error ?? "OWN_WORKS_METADATA_UNVERIFIED");
        requireSafe(this.pages.length > 0 || prior.length > 0, "OWN_WORKS_METADATA_NOT_READY");
        endWait();
      }catch(error){endWait(signal.aborted?'CANCELLED':'FAILED');throw error;}
      const epoch=this.epoch;
      const complete=this.pages.length?this.pages.at(-1)!.data.has_more===0:this.lastComplete;
      await reader.guard();
      const links = await this.page.evaluate(origin => Array.from(document.querySelectorAll("a[href]")).filter(a => {
        if(!a.getClientRects().length)return false;
        for(let n:Element|null=a;n;n=n.parentElement){const style=getComputedStyle(n);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)return false;}
        return true;
      }).map(a => {try {const u=new URL(a.getAttribute("href")!,location.href);return u.origin===origin&&!u.username&&!u.password&&/^\/(video|note)\/\d{1,64}$/.test(u.pathname)?u.origin+u.pathname:null;}catch{return null;}}).filter((s):s is string=>s!==null), this.mapping.origin);
      const visible = new Set(links), works: DiscoveredWork[] = [];
      const records=new Map(prior.map(raw=>[raw.aweme_id,raw]));
      requireSafe(this.current()&&this.epoch===epoch,"OWN_WORKS_RESPONSE_UNVERIFIED");
      for(const batch of this.pages)for(const raw of batch.data.aweme_list)records.set(raw.aweme_id,raw);
      const pending:PendingWork[]=[];
      for (const raw of records.values()) {
        const urls = [`${this.mapping.origin}/video/${raw.aweme_id}`, `${this.mapping.origin}/note/${raw.aweme_id}`].filter(url => visible.has(url));
        // Never infer a content route from its native ID alone.
        if(urls.length !== 1) {pending.push(raw);continue;}
        works.push({id: raw.aweme_id, ownId: raw.author.uid, url: urls[0]!,
          publishedAt: raw.create_time ? raw.create_time * 1000 : null, precisionMs: 1000});
      }
      this.lastComplete=complete;return {works, pending, complete};
    } finally {this.active = false;this.generation++;this.pending.clear();}
  }
  dispose=():void=> {
    this.disposed=true;this.active=false;this.generation++;this.epoch++;this.pages=[];
    this.page.off('request',this.request);this.page.off("response", this.listener);this.page.off('framenavigated',this.navigation);this.page.off('close',this.dispose);
  };
}
