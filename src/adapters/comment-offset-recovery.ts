import {digest,eventBinding,requireSafe} from '../core/contracts.js';
import type {ObservationBatch} from './observed-reader.js';
import type {Page} from 'playwright';
import {waitForCommentRender} from './comment-render.js';

/** Rebuild only a bounded native scroll prefix after navigation, without treating a clamped offset as restored. */
export async function recoverCommentOffset(page:Page,offset:number,position:(top?:number)=>Promise<ObservationBatch>,
  read:()=>Promise<ObservationBatch>,persist:((batch:ObservationBatch)=>Promise<void>)|undefined,signal?:AbortSignal):Promise<ObservationBatch>{
  const deadline=Date.now()+30_000;
  let batch:ObservationBatch|undefined,priorEnd:string|undefined,stableEnd=0,stalls=0;
  for(;;){
    requireSafe(!signal?.aborted,'OBSERVATION_CANCELLED');
    const before=await position();requireSafe(before.scroll,'OBSERVATION_COMMENT_SCROLL_UNAVAILABLE');
    if(!batch){batch=await read();batch.scroll=before.scroll;await persist?.(batch);}
    requireSafe(!signal?.aborted,'OBSERVATION_CANCELLED');if(Date.now()>=deadline)break;
    const step=Math.max(1,Math.floor(before.scroll.viewport*0.8)),target=Math.min(offset,before.scroll.top+step);
    await position(target);
    await waitForCommentRender(page,signal,deadline);
    // Native scroll may load a later page and remount its rows on subsequent rendering frames.
    await new Promise(resolve=>setTimeout(resolve,150));
    requireSafe(!signal?.aborted,'OBSERVATION_CANCELLED');
    batch=await read();const settled=await position();
    requireSafe(settled.scroll,'OBSERVATION_COMMENT_SCROLL_UNAVAILABLE');batch.scroll=settled.scroll;
    if(Date.now()>=deadline){await persist?.(batch);break;}
    if(Math.abs(batch.scroll.top-offset)<=1)return batch;
    const signature=batch.scroll.atEnd?digest([batch.scroll.top,batch.scroll.height,batch.events.map(eventBinding)]):undefined;
    stableEnd=signature!==undefined&&signature===priorEnd?stableEnd+1:1;priorEnd=signature;
    await persist?.(batch);
    stalls=batch.scroll.top===before.scroll.top&&batch.scroll.height===before.scroll.height?stalls+1:0;
    if(stalls>=2||Date.now()>=deadline)break;
  }
  return {...batch!,commentRestoreIncomplete:true,...(stableEnd>=2?{commentRestoreStableEnd:true as const}:{})};
}
