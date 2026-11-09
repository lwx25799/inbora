import {z} from 'zod';
import {Blocked,digest,requireSafe} from '../core/contracts.js';
import type {ObservedReader,DiscoveredPeer,ObservationBatch} from '../adapters/observed-reader.js';
import type {AutomationStore} from '../storage/automation-store.js';
import {collectionStops,DeferredObjectRead} from './collection-scheduler.js';

export const dmActivitySchema=z.object({next:z.number().default(0),initialized:z.boolean().default(false),
  items:z.array(z.object({id:z.string(),signature:z.string()})).max(1000).default([])}).default({next:0,initialized:false,items:[]});
type Activity=z.infer<typeof dmActivitySchema>;

/** Latest-list hints only select a read. Every message still passes the normal account/native identity reader. */
export async function readDmActivity(reader:ObservedReader,data:AutomationStore,activity:Activity,signal:AbortSignal,
  persist:(peer:DiscoveredPeer,batch:ObservationBatch)=>Promise<void>,save:()=>void):Promise<boolean>{
  if(data.now()<activity.next)return false;
  const current=await reader.conversations(),offset=current.scroll?.top;
  let restore=true;
  try{
    const list=offset&&offset>0?(await reader.conversations('start'),await reader.conversations()):current;
    requireSafe(!signal.aborted,'COLLECTION_CANCELLED');activity.next=data.now()+30_000;
    const peers=list.peers??[],prior=new Map(activity.items.map(item=>[item.id,item.signature]));
    const selected=activity.initialized?peers.find(peer=>prior.get(peer.conversationId)!==digest(peer.activity??peer.title)):undefined;
    if(!activity.initialized){activity.items=peers.map(peer=>({id:peer.conversationId,signature:digest(peer.activity??peer.title)}));activity.initialized=true;save();return false;}
    if(!selected){save();return false;}
    const old=data.store.db.prepare('SELECT own_id,sec_uid FROM discovered_conversations WHERE id=?').get(selected.conversationId) as {own_id:string;sec_uid:string}|undefined;
    const own=data.state().collection!.ownId;requireSafe(!old||old.own_id===own&&old.sec_uid===selected.secUid,'OBSERVATION_CONVERSATION_CHANGED');
    data.store.db.prepare(`INSERT INTO discovered_conversations VALUES(?,?,?,?,?,?,?,0)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,last_seen=excluded.last_seen`)
      .run(selected.conversationId,own,selected.uid,selected.secUid,selected.title,data.now(),data.now());
    activity.items=activity.items.filter(item=>item.id!==selected.conversationId);
    activity.items.push({id:selected.conversationId,signature:digest(selected.activity??selected.title)});activity.items=activity.items.slice(-1000);
    save();
    const batch=await reader.dmWindow(selected,undefined,true);await persist(selected,batch);
    save();return true;
  }catch(error){
    save();if(signal.aborted)throw error;
    const code=error instanceof Blocked?error.code:'DM_ACTIVITY_READ_FAILED';
    if(collectionStops.has(code)||code==='BROWSER_CLOSED'){restore=false;throw error;}
    throw new DeferredObjectRead(code);
  }finally{
    if(restore&&!signal.aborted)await reader.conversations(undefined,offset);
  }
}
