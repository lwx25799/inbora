import type {Page} from 'playwright';
import {requireSafe} from '../core/contracts.js';

/** A bounded browser rendering opportunity; no page handlers, synthetic input or network operations. */
export async function waitForCommentRender(page:Page,signal?:AbortSignal,deadline=Date.now()+5000):Promise<void>{
  requireSafe(!signal?.aborted,'OBSERVATION_CANCELLED');
  const remaining=Math.max(0,Math.min(5000,deadline-Date.now()));
  requireSafe(remaining>0,'OBSERVATION_COMMENT_RENDER_NOT_READY');
  const ready=await page.evaluate(timeout=>new Promise<boolean>(resolve=>{
    const frames={first:0,second:0,done:false,finish(value:boolean):void{
      if(frames.done)return;frames.done=true;clearTimeout(timer);
      cancelAnimationFrame(frames.first);cancelAnimationFrame(frames.second);resolve(value);
    }};
    const timer=setTimeout(()=>frames.finish(false),timeout);
    frames.first=requestAnimationFrame(()=>{frames.second=requestAnimationFrame(()=>frames.finish(true));});
  }),remaining);
  requireSafe(!signal?.aborted,'OBSERVATION_CANCELLED');
  requireSafe(ready,'OBSERVATION_COMMENT_RENDER_NOT_READY');
}
