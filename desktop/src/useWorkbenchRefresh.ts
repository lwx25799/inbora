import {useEffect,useRef,type Dispatch,type SetStateAction} from 'react';
import {listen} from '@tauri-apps/api/event';
import {request,explain,type Inbox,type Status} from './api';
import {ReadRefresh,refreshTargets} from './read-refresh';

export interface AuditRow {time:string;event_type:string;entity_id:string;detail_redacted:string}
interface RefreshView {
  connected:boolean;status:Status|null;selected:string|null;
  channel:'ALL'|'COMMENT_NOTIFICATION'|'DIRECT_MESSAGE';filter:'ALL'|'UNREAD'|'PENDING'|'MANUAL_ONLY'|'CONFIRMED';pageNumber:number;
  page:'inbox'|'settings'|'audit';auditPage:number;notice:string;sendStatus:string|undefined;
  readThread:(alive:()=>boolean)=>Promise<unknown>;
  setStatus:Dispatch<SetStateAction<Status|null>>;setInbox:Dispatch<SetStateAction<Inbox>>;
  setAudit:Dispatch<SetStateAction<AuditRow[]>>;setError:(error:string)=>void;
}
const allReads=['status','inbox','thread','audit'] as const;
const inboxKey=(view:RefreshView)=>[view.channel,view.filter,view.pageNumber].join('|');

/** Read-only refreshes share one queue per type; selection and human text stay owned by App. */
export function useWorkbenchRefresh(view:RefreshView):void {
  const latest=useRef(view);latest.current=view;
  const queue=useRef<ReadRefresh|null>(null);
  useEffect(()=>{
    if(!view.connected)return;
    let disposed=false,stopListening:(()=>void)|undefined;
    const alive=()=>!disposed&&latest.current.connected;
    const refresh=new ReadRefresh({
      status:async current=>{
        const previous=latest.current.status;
        const status=await request<Status>({command:'getStatus'});
        if(alive()&&current())latest.current.setStatus(existing=>existing===previous?status:existing);
      },
      inbox:async current=>{
        const view=latest.current,key=inboxKey(view);
        const inbox=await request<Inbox>({command:'getInbox',channel:view.channel,status:view.filter,page:view.pageNumber});
        if(alive()&&current()&&key===inboxKey(latest.current))latest.current.setInbox(inbox);
      },
      thread:async current=>{if(alive())await latest.current.readThread(()=>alive()&&current());},
      audit:async current=>{
        const view=latest.current;if(view.page!=='audit')return;
        const result=await request<{items:AuditRow[]}>({command:'getAudit',page:view.auditPage});
        if(alive()&&current()&&latest.current.page==='audit'&&latest.current.auditPage===view.auditPage)latest.current.setAudit(result.items);
      },
    },(error,target)=>{if(alive())latest.current.setError((target==='status'?'内核连接中断：':'')+explain(error));});
    queue.current=refresh;
    // Capture a fresh snapshot after asynchronous listener registration, including events during setup.
    const unlisten=listen<{event?:unknown}>('inbora_status_updated',event=>{
      if(alive()&&typeof event.payload?.event==='string')refresh.schedule(refreshTargets(event.payload.event));
    });
    void unlisten.then(stop=>{if(disposed)stop();else{stopListening=stop;refresh.schedule(allReads);}}).catch(()=>{});
    const focus=()=>refresh.schedule(allReads);
    window.addEventListener('focus',focus);
    const timer=setInterval(()=>refresh.schedule(allReads,0),15_000);
    return()=>{
      disposed=true;refresh.dispose();if(queue.current===refresh)queue.current=null;
      clearInterval(timer);window.removeEventListener('focus',focus);
      stopListening?.();
    };
  },[view.connected]);

  const status=view.status;
  useEffect(()=>{if(view.connected)queue.current?.schedule(['inbox'],0);},[
    view.connected,view.channel,view.filter,view.pageNumber,view.notice,view.sendStatus,
    status?.sync.runId,status?.sync.running,status?.sync.results.map(result=>result.state).join('|'),status?.automation?.inboxRevision,
  ]);
  useEffect(()=>{if(view.connected)queue.current?.schedule(['thread'],0);},[
    view.connected,view.selected,status?.browser.state,status?.browser.version,status?.paused,
    status?.automation?.emergencyStopped,status?.capabilities.map(capability=>capability.state+':'+capability.reason).join('|'),
    status?.automation?.inboxRevision,
  ]);
  useEffect(()=>{if(view.connected)queue.current?.schedule(['audit'],0);},[view.connected,view.page,view.auditPage,view.notice]);
}
