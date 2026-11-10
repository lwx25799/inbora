import {Blocked,requireSafe,type InboundEvent} from '../core/contracts.js';
import type {DiscoveredPeer,ObservationBatch,ObservedReader} from '../adapters/observed-reader.js';

interface Anchor {top:number;height:number;ids:string[];phase:'MIN'|'MAX'|'PROBE_MIN'|'PROBE_MAX'}
export type PreviewTargetResult={found:boolean;windows:number;persisted:number;reason:'FOUND'|'NOT_FOUND'|'CANCELLED'|'IDENTITY_CHANGED'|'INTERRUPTED'};
interface Input {reader:ObservedReader;peer:DiscoveredPeer;target:InboundEvent;initial:ObservationBatch;anchors:Anchor[];
  check():void;persist(batch:ObservationBatch):Promise<void|boolean>;record(result:PreviewTargetResult):void;viewNativeTarget?():Promise<boolean>}
const identity=(event:InboundEvent)=>JSON.stringify([event.accountId,event.channel,event.platformEventId,event.actorId,event.conversationId,
  event.direction,event.kind,event.occurredAt,event.occurredAtPrecisionMs,event.videoId,event.commentId,event.rootCommentId,event.replyToCommentId]);

/** One retry quantum: current window, two locating candidates, one forward window. Only native identity proves a hit. */
export async function locatePreviewTarget(input:Input):Promise<{found:boolean;windows:number}> {
  const {reader,peer,target}=input;let current=input.initial,windows=0,persisted=0,found=false,reason:PreviewTargetResult['reason']='NOT_FOUND';
  const visit=async(batch:ObservationBatch)=>{
    windows++;input.check();
    const matches=batch.events.filter(event=>event.platformEventId===target.platformEventId);
    requireSafe(matches.length<=1&&matches.every(event=>identity(event)===identity(target)),'OBSERVATION_ROW_IDENTITY_CONFLICT');
    if(await input.persist(batch)!==false)persisted++;input.check();
    return input.viewNativeTarget?input.viewNativeTarget():matches.length===1;
  };
  try{
  if(await visit(current)){found=true;reason='FOUND';return {found,windows};}
  const view=current.dmViewport;if(!view)return {found:false,windows};
  const anchor=input.anchors.find(item=>item.ids.includes(target.platformEventId!))??input.anchors[0];
  const clamp=(top:number)=>Math.max(view.minimum,Math.min(view.maximum,top));
  const offsets=anchor?[anchor.top,anchor.top+(view.minimum<0?-1:1)*(view.height-anchor.height)]:[view.minimum,view.maximum];
  const tried=new Set([view.top]);
  for(const top of [...new Set(offsets.map(clamp))].slice(0,2)){
    if(tried.has(top))continue;input.check();tried.add(top);current=await reader.dmWindow(peer,top,true);
    if(await visit(current)){found=true;reason='FOUND';return {found,windows};}
  }
  const last=current.dmViewport;
  if(last){
    const direction=anchor?(anchor.phase==='MIN'||anchor.phase==='PROBE_MIN'?-1:1):Math.abs(last.top-last.maximum)<=1?-1:1;
    const top=Math.max(last.minimum,Math.min(last.maximum,last.top+direction*Math.max(1,Math.floor(last.viewport*0.8))));
    if(!tried.has(top)){input.check();current=await reader.dmWindow(peer,top,true);if(await visit(current)){found=true;reason='FOUND';return {found,windows};}}
  }
  return {found,windows};
  }catch(error){reason=error instanceof Blocked&&['COLLECTION_CANCELLED','OBSERVATION_CANCELLED'].includes(error.code)?'CANCELLED':
    error instanceof Blocked&&error.code==='OBSERVATION_ROW_IDENTITY_CONFLICT'?'IDENTITY_CHANGED':'INTERRUPTED';throw error;}
  finally{input.record({found,windows,persisted,reason});}
}
