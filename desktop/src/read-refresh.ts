export type ReadTarget = 'status'|'inbox'|'thread'|'audit'|'diagnostics';
const allTargets:readonly ReadTarget[]=['status','inbox','thread','audit'];

/** Backend notifications only invalidate read views; they never repeat business commands. */
export function refreshTargets(event:string):readonly ReadTarget[] {
  if(event==='diagnostics_updated')return [];
  if(event==='backend_restarted')return ['status','inbox','audit'];
  if(['sidecar_closed','backend_unavailable','backend_watch_unavailable'].includes(event))return ['status','audit'];
  if(event==='draft_updated')return ['inbox','thread','audit'];
  if(event==='suggestion_updated')return ['status','thread','audit'];
  if(event==='takeover_updated'||event==='status_updated')return ['status','thread','audit'];
  return allTargets;
}

interface Lane {pending:boolean;running:boolean;timer:ReturnType<typeof setTimeout>|undefined}

/** A fixed merge window per read type, then at most one trailing read after an in-flight query. */
export class ReadRefresh {
  private readonly lanes=new Map<ReadTarget,Lane>();
  private disposed=false;
  constructor(private readonly reads:Partial<Record<ReadTarget,(current:()=>boolean)=>Promise<unknown>>>,
    private readonly failed:(error:unknown,target:ReadTarget)=>void=()=>{}){}

  schedule(targets:readonly ReadTarget[],delay=150):void {
    if(this.disposed)return;
    for(const target of targets){
      if(!this.reads[target])continue;
      let lane=this.lanes.get(target);
      if(!lane){lane={pending:false,running:false,timer:undefined};this.lanes.set(target,lane);}
      lane.pending=true;
      if(lane.running)continue;
      if(lane.timer!==undefined){if(delay!==0)continue;clearTimeout(lane.timer);}
      lane.timer=setTimeout(()=>{lane.timer=undefined;void this.run(target,lane);},delay);
    }
  }
  private async run(target:ReadTarget,lane:Lane):Promise<void> {
    if(this.disposed)return;
    lane.pending=false;lane.running=true;
    // Ordinary notifications request a trailing snapshot; they cannot starve a completed read.
    const current=()=>!this.disposed;
    try{await this.reads[target]!(current);}
    catch(error){if(current())this.failed(error,target);}
    finally{
      lane.running=false;
      if(lane.pending&&!this.disposed)this.schedule([target]);
    }
  }
  dispose():void {
    this.disposed=true;
    for(const lane of this.lanes.values())clearTimeout(lane.timer);
  }
}
