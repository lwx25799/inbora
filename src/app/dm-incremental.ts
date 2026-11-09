import {z} from 'zod';
import type {ObservationBatch} from '../adapters/observed-reader.js';

export const dmLatestSchema=z.object({side:z.enum(['MIN','MAX']),ids:z.array(z.string().min(1)).min(1).max(100),
  maximumTime:z.number().finite(),height:z.number().nonnegative(),coverage:z.literal('POST_ORIGIN').optional(),startedAt:z.number().finite().optional()});
export type DmLatest=z.infer<typeof dmLatestSchema>;

/** Metadata covers old excluded history, not its unread body. Every on/after-origin row must have a captured event. */
export function dmWindowCoverage(batch:ObservationBatch,boundary?:number):ObservationBatch['dmCoverage'] {
  if(batch.dmCoverage){
    const rows=batch.dmCoverage,events=new Map(batch.events.map(event=>[event.platformEventId,event]));
    if(!rows.length||rows.length!==batch.loaded||rows.length>100||new Set(rows.map(row=>row.id)).size!==rows.length||
      rows.some(row=>!/^[1-9]\d{0,63}$/u.test(row.id)||!Number.isFinite(Date.parse(row.occurredAt))||row.precisionMs!==1||
        (row.captured?events.get(row.id)?.occurredAt!==row.occurredAt:events.has(row.id)||boundary===undefined||Date.parse(row.occurredAt)+row.precisionMs>boundary)))return;
    return rows;
  }
  if(batch.incomplete||batch.unsupported||!batch.events.length||batch.events.length!==batch.loaded||
    batch.events.some(event=>!event.platformEventId||!Number.isFinite(Date.parse(event.occurredAt??''))))return;
  return batch.events.map(event=>({id:event.platformEventId!,occurredAt:event.occurredAt!,precisionMs:event.occurredAtPrecisionMs??1,captured:true}));
}

/** Only the post-origin collection scope is complete; this does not claim old attachment bodies were read. */
export function latestDmWindow(batch:ObservationBatch,prior?:DmLatest,boundary?:number):DmLatest|undefined {
  const view=batch.dmViewport;
  const rows=dmWindowCoverage(batch,boundary);if(!view||!rows)return prior;
  const ids=rows.map(row=>row.id),times=rows.map(row=>Date.parse(row.occurredAt));
  const side=Math.abs(view.top-view.minimum)<=1?'MIN':Math.abs(view.top-view.maximum)<=1?'MAX':null;
  if(!side)return prior;
  const maximumTime=Math.max(...times);
  return !prior||maximumTime>prior.maximumTime||maximumTime===prior.maximumTime&&ids.some(id=>prior.ids.includes(id!))?
    {side,ids,maximumTime,height:view.height,...(boundary!==undefined?{coverage:'POST_ORIGIN' as const,startedAt:boundary}:{})}:prior;
}
export function overlapsCompletedDm(batch:ObservationBatch,saved:DmLatest,boundary?:number):boolean {
  const view=batch.dmViewport;
  const rows=dmWindowCoverage(batch,boundary);
  return !!view&&!!rows&&(saved.coverage!=='POST_ORIGIN'||saved.startedAt===boundary)&&
    Math.abs(view.top-(saved.side==='MIN'?view.minimum:view.maximum))<=1&&
    rows.some(row=>saved.ids.includes(row.id));
}
