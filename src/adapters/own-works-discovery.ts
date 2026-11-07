import type { Page, Response } from "playwright";
import { z } from "zod";
import { Blocked, requireSafe } from "../core/contracts.js";
import type { ObservationMapping } from "../config/site-mapping.js";
import type { ObservedReader } from "./observed-reader.js";

const postPage = z.object({status_code: z.literal(0), has_more: z.union([z.literal(0), z.literal(1)]),
  aweme_list: z.array(z.object({aweme_id: z.string().regex(/^\d{1,64}$/), create_time: z.number().int().nonnegative().nullable().optional(),
    author: z.object({uid: z.string(), sec_uid: z.string()})})).max(100)});
export interface DiscoveredWork {id: string; ownId: string; url: string; publishedAt: number | null; precisionMs: number}
export type PendingWork = z.infer<typeof postPage>["aweme_list"][number];

/** Candidate fields are accepted only from normal own-profile GETs and matching visible native links.
 * No request is manufactured; successful fixture parsing is not a claim of real-site calibration. */
export class OwnWorksDiscovery {
  private pending = new Set<Promise<void>>();
  private pages: z.infer<typeof postPage>[] = [];
  private error: string | null = null;
  private active = false;
  private lastComplete = false;
  private readonly listener = (response: Response) => {
    if (!this.active) return;
    const url = new URL(response.url()), request = response.request();
    if (url.origin !== this.mapping.origin || url.pathname !== "/aweme/v1/web/aweme/post/" ||
      url.searchParams.get("sec_user_id") !== this.mapping.self.secUid || request.method() !== "GET") return;
    const task = this.accept(response).catch(cause => {this.error = cause instanceof Blocked?cause.code:"OWN_WORKS_METADATA_UNVERIFIED";});
    this.pending.add(task); void task.finally(() => this.pending.delete(task));
  };
  constructor(readonly page: Page, readonly mapping: ObservationMapping) { page.on("response", this.listener); }
  private async accept(response: Response): Promise<void> {
    requireSafe(response.ok() && !response.fromServiceWorker() && response.request().frame() === this.page.mainFrame(), "OWN_WORKS_RESPONSE_UNVERIFIED");
    const declared = Number(response.headers()["content-length"]);
    requireSafe(!Number.isFinite(declared) || declared <= 2_000_000, "OWN_WORKS_RESPONSE_TOO_LARGE");
    const body = await response.body(); requireSafe(body.byteLength <= 2_000_000, "OWN_WORKS_RESPONSE_TOO_LARGE");
    const data = postPage.parse(JSON.parse(body.toString("utf8")));
    requireSafe(data.aweme_list.every(w => w.author.uid === this.mapping.self.uid && w.author.sec_uid === this.mapping.self.secUid), "OWN_WORKS_ACCOUNT_CHANGED");
    requireSafe(this.pages.length < 20, "OWN_WORKS_RESPONSE_LIMIT");
    this.pages.push(data);
  }
  async scan(reader: ObservedReader, first: boolean, signal: AbortSignal, prior: PendingWork[] = []): Promise<{works: DiscoveredWork[]; pending: PendingWork[]; complete: boolean}> {
    requireSafe(!signal.aborted, "COLLECTION_CANCELLED");
    this.active = true; this.pages = []; this.error = null;
    try {
      if (first || this.page.url().split("?")[0] !== `${this.mapping.origin}/user/${this.mapping.self.secUid}`)
        await reader.navigate(`${this.mapping.origin}/user/${this.mapping.self.secUid}`);
      else {
        await reader.guard();
        await this.page.evaluate(() => window.scrollBy(0, Math.max(1, innerHeight * 0.8)));
      }
      const deadline = Date.now() + 5000;
      while (!this.pages.length && !this.error && Date.now() < deadline && !signal.aborted)
        await new Promise(resolve => setTimeout(resolve, 50));
      await Promise.allSettled([...this.pending]);
      requireSafe(!signal.aborted, "COLLECTION_CANCELLED");
      requireSafe(!this.error, this.error ?? "OWN_WORKS_METADATA_UNVERIFIED");
      requireSafe(this.pages.length > 0 || prior.length > 0, "OWN_WORKS_METADATA_NOT_READY");
      if(this.pages.length)this.lastComplete=this.pages.at(-1)!.has_more===0;
      await reader.guard();
      const links = await this.page.evaluate(origin => Array.from(document.querySelectorAll("a[href]")).filter(a => {
        if(!a.getClientRects().length)return false;
        for(let n:Element|null=a;n;n=n.parentElement){const style=getComputedStyle(n);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)return false;}
        return true;
      }).map(a => {try {const u=new URL(a.getAttribute("href")!,location.href);return u.origin===origin&&!u.username&&!u.password&&/^\/(video|note)\/\d{1,64}$/.test(u.pathname)?u.origin+u.pathname:null;}catch{return null;}}).filter((s):s is string=>s!==null), this.mapping.origin);
      const visible = new Set(links), works: DiscoveredWork[] = [];
      const records=new Map(prior.map(raw=>[raw.aweme_id,raw]));
      for(const batch of this.pages)for(const raw of batch.aweme_list)records.set(raw.aweme_id,raw);
      const pending:PendingWork[]=[];
      for (const raw of records.values()) {
        const urls = [`${this.mapping.origin}/video/${raw.aweme_id}`, `${this.mapping.origin}/note/${raw.aweme_id}`].filter(url => visible.has(url));
        // Never infer a content route from its native ID alone.
        if(urls.length !== 1) {pending.push(raw);continue;}
        works.push({id: raw.aweme_id, ownId: raw.author.uid, url: urls[0]!,
          publishedAt: raw.create_time ? raw.create_time * 1000 : null, precisionMs: 1000});
      }
      return {works, pending, complete: this.lastComplete};
    } finally {this.active = false;}
  }
  dispose():void { this.active = false; this.page.off("response", this.listener); }
}
