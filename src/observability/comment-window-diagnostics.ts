import {lstat,mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {digest,isEligible,isStrong} from '../core/contracts.js';
import type {ObservationBatch} from '../adapters/observed-reader.js';
import {commentResponseSummarySchema,type CommentResponseSummary} from '../adapters/comment-list-diagnostics.js';

const count=z.number().int().nonnegative(),position=z.number().finite().nonnegative().nullable();
const relationField=z.object({type:z.enum(['ABSENT','ACCESSOR','CONFLICT','STRING','NUMBER','NULL','OTHER']),nativeId:z.boolean(),zero:z.boolean(),root:z.boolean(),child:z.boolean(),self:z.boolean()}).strict();
const relationShape=z.object({sampled:count.max(3),truncated:z.boolean(),samples:z.array(z.object({own:z.boolean(),rootBound:z.boolean(),
  replyToReplyId:relationField,replyToReplyID:relationField}).strict()).max(3)}).strict();
const windowSchema=z.object({workDigest:z.string().regex(/^[a-f0-9]{64}$/u),at:z.number().int().positive(),stage:z.enum(['ROOTS','THREAD']),
  headRead:z.boolean(),requestedOffset:position,scrollTop:position,childOffset:position,mappedWork:z.boolean(),includedWork:z.boolean(),historicalWork:z.boolean(),
  eventCount:count,roots:count,children:count,strong:count,nativeCount:count,ownEvents:count,eligibleEvents:count,afterOrigin:count,fresh30m:count,older30m:count,unknownTime:count,futureTime:count,
  newestAgeMs:position,newestEligibleAgeMs:position,loaded:count,unsupported:count,responseSummary:commentResponseSummarySchema.nullable().default(null),
  commentRelations:relationShape.optional()}).strict();
const reportSchema=z.object({version:z.literal(1),windows:z.array(windowSchema).max(16)}).strict();
export interface CommentWindowRead {headRead:boolean;requestedOffset:number;responseSummary?:CommentResponseSummary|null}

/** One bounded private success snapshot, separate from stale error reports; never retains bodies or native IDs. */
export async function recordCommentWindow(root:string,scope:string,batch:ObservationBatch,now:number,origin:number,
  state:{mappedWork:boolean;includedWork:boolean;historicalWork:boolean;ownId:string},window?:CommentWindowRead):Promise<void> {
  const ages=batch.events.map(event=>Date.parse(event.occurredAt??'')).filter(at=>Number.isFinite(at)),past=ages.filter(at=>at<=now),
    eligible=batch.events.filter(event=>isEligible(event,state.ownId)),eligiblePast=eligible.map(event=>Date.parse(event.occurredAt??'')).filter(at=>Number.isFinite(at)&&at<=now),
    workDigest=digest(scope),directory=join(root,'evidence'),destination=join(directory,'work-comment-window-latest.json'),temporary=join(directory,randomUUID()+'.window-tmp');
  try{
    const item=windowSchema.parse({workDigest,at:now,stage:batch.commentThread?'THREAD':'ROOTS',headRead:window?.headRead??false,
      requestedOffset:window?.requestedOffset??null,scrollTop:batch.scroll?.top??null,childOffset:batch.commentThread?.offset??null,
      mappedWork:state.mappedWork,includedWork:state.includedWork,historicalWork:state.historicalWork,
      eventCount:batch.events.length,roots:batch.events.filter(event=>event.kind==='COMMENT').length,children:batch.events.filter(event=>event.kind==='REPLY').length,
      strong:batch.events.filter(isStrong).length,nativeCount:new Set(batch.events.map(event=>event.platformEventId).filter(Boolean)).size,
      ownEvents:batch.events.filter(event=>event.actorId===state.ownId).length,eligibleEvents:eligible.length,
      afterOrigin:past.filter(at=>at>origin).length,fresh30m:past.filter(at=>now-at<=30*60_000).length,older30m:past.filter(at=>now-at>30*60_000).length,
      unknownTime:batch.events.length-ages.length,futureTime:ages.length-past.length,newestAgeMs:past.length?now-Math.max(...past):null,
      newestEligibleAgeMs:eligiblePast.length?now-Math.max(...eligiblePast):null,
      loaded:batch.loaded,unsupported:batch.unsupported,responseSummary:window?.responseSummary??null,...(batch.commentRelations?{commentRelations:batch.commentRelations}:{})});
    await mkdir(directory,{recursive:true});const dir=await lstat(directory);if(!dir.isDirectory()||dir.isSymbolicLink())return;
    let previous:z.infer<typeof windowSchema>[]=[];
    try{
      const file=await lstat(destination);if(!file.isFile()||file.isSymbolicLink()||file.size>40_000)return;
      const parsed=reportSchema.safeParse(JSON.parse(await readFile(destination,'utf8')));if(parsed.success)previous=parsed.data.windows;
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SyntaxError))return;}
    const report=reportSchema.parse({version:1,windows:[item,...previous.filter(row=>row.workDigest!==workDigest)].slice(0,16)});
    await writeFile(temporary,JSON.stringify(report),{flag:'wx',mode:0o600});await rename(temporary,destination);
  }catch{/* A fixed success diagnostic cannot fail collection or expose private exceptions. */}
  finally{await unlink(temporary).catch(()=>{});}
}
