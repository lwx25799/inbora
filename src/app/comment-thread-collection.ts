import {z} from 'zod';
import {eventBinding,isStrong,requireSafe} from '../core/contracts.js';
import type {ObservedReader,ObservationBatch} from '../adapters/observed-reader.js';

const nativeId=z.string().regex(/^[1-9]\d{0,63}$/);
export const commentThreadsSchema=z.array(z.object({workId:nativeId,id:nativeId,binding:z.string().regex(/^[a-f0-9]{64}$/),
  total:z.number().int().nonnegative().nullable(),seen:z.array(nativeId),offset:z.number().int().nonnegative(),done:z.boolean(),
  stalls:z.number().int().nonnegative().default(0),retryAt:z.number().int().nonnegative().default(0),turn:z.number().int().nonnegative().default(0)})).default([]);
export type CommentThreads=z.infer<typeof commentThreadsSchema>;

/** One exact root/one native expand click per collection turn, independent of model or send settings. */
export async function collectCommentThread(reader:ObservedReader,workId:string,batch:ObservationBatch,states:CommentThreads,now:number,
  persist:(batch:ObservationBatch)=>Promise<void>):Promise<boolean> {
  const roots=batch.commentThreads??[],pending:typeof roots=[];
  for(const root of roots){
    const event=batch.events.find(e=>e.commentId===root.id&&e.kind==='COMMENT');
    requireSafe(event&&isStrong(event)&&event.occurredAt&&Number.isFinite(Date.parse(event.occurredAt)),'OBSERVATION_COMMENT_THREAD_CHANGED');
    const binding=eventBinding(event);let state=states.find(item=>item.workId===workId&&item.id===root.id);
    if(!state){state={workId,id:root.id,binding,total:root.total,seen:[],offset:0,done:false,stalls:0,retryAt:0,
      turn:states.length?states.reduce((maximum,item)=>Math.max(maximum,item.turn),0)+1:0};states.push(state);}
    else if(state.binding!==binding){state.binding=binding;state.seen=[];state.offset=0;state.done=false;state.stalls=0;state.retryAt=0;}
    if(root.total!==state.total){if(root.total===null||state.total!==null&&root.total<state.total){state.seen=[];state.offset=0;}state.done=false;state.total=root.total;state.retryAt=0;}
    if(root.total===0&&!root.expandable&&root.mounted===0){state.seen=[];state.offset=0;state.done=true;state.retryAt=0;continue;}
    // An unchanged count cannot prove unchanged hidden native IDs after deletion and another incoming reply.
    if(state.done&&state.retryAt<=now&&(root.expandable||root.mounted!==root.total)){
      state.seen=[];state.offset=0;state.done=false;state.stalls=0;
    }
    if(!state.done&&state.retryAt<=now)pending.push(root);
  }
  pending.sort((a,b)=>states.find(item=>item.workId===workId&&item.id===a.id)!.turn-states.find(item=>item.workId===workId&&item.id===b.id)!.turn);
  const root=pending[0];if(!root)return false;
  const state=states.find(item=>item.workId===workId&&item.id===root.id)!,event=batch.events.find(e=>e.commentId===root.id&&e.kind==='COMMENT')!;
  state.turn=states.reduce((maximum,item)=>Math.max(maximum,item.turn),0)+1;state.retryAt=now+120_000;
  requireSafe(root.total!==null,'OBSERVATION_COMMENT_THREAD_METADATA_NOT_READY');
  const window=await reader.commentThread(event,state.offset);await persist(window);
  const coverage=window.commentThread;requireSafe(coverage,'OBSERVATION_COMMENT_THREAD_METADATA_NOT_READY');
  const seen=new Set(state.seen),previous=seen.size;
  for(const child of window.events)if(child.kind==='REPLY'&&child.rootCommentId===root.id&&child.replyToCommentId===child.commentId&&
    child.platformEventId===child.commentId&&child.occurredAt&&Number.isFinite(Date.parse(child.occurredAt)))seen.add(child.commentId!);
  state.seen=[...seen];state.total=coverage.total;state.offset=coverage.nextOffset;
  state.stalls=seen.size===previous&&coverage.nextOffset===0?state.stalls+1:0;
  state.done=coverage.beforeTotal===coverage.total&&state.seen.length===coverage.total&&!coverage.expandable&&coverage.nextOffset>=coverage.mounted;
  if(coverage.beforeTotal!==coverage.total){if(coverage.total<coverage.beforeTotal)state.offset=0;state.retryAt=0;return true;}
  requireSafe(state.stalls<2&&(state.done||coverage.expandable||coverage.nextOffset<coverage.mounted),'OBSERVATION_COMMENT_THREAD_INCOMPLETE');
  state.retryAt=state.done?now+120_000:0;return !state.done||pending.length>1;
}
