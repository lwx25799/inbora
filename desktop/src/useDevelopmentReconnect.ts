import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { listen } from '@tauri-apps/api/event';
import { request, explain, type Status, type Thread } from './api';

interface Editor {eventId:string|null;text:string;suggestionId:string|null}
interface Ref<T> {current:T}
interface ReconnectView {
  selectedRef:Ref<string|null>;selection:Ref<string>;detailRequest:Ref<number>;latestEditor:Ref<Editor>;dialogOpen:boolean;
  setStatus:Dispatch<SetStateAction<Status|null>>;setThread:Dispatch<SetStateAction<Thread|null>>;
  setReview:(value:null)=>void;setSend:(value:null)=>void;setError:(value:string)=>void;setNotice:(value:string)=>void;
}

/** Development transport recovery never replays a draft, provider request, or send. */
export function useDevelopmentReconnect(view:ReconnectView){
  const current=useRef(view);current.current=view;
  const epoch=useRef(0),draftGuard=useRef<Editor|null>(null);
  const [restoring,setRestoring]=useState(false);
  const editor=view.latestEditor.current,guard=draftGuard.current;
  if(guard&&(guard.eventId!==editor.eventId||guard.text!==editor.text||guard.suggestionId!==editor.suggestionId))draftGuard.current=null;
  useEffect(()=>{
    if(!import.meta.env.DEV)return;
    let disposed=false,unlisten:(()=>void)|undefined;
    const restore=async()=>{
      const version=++epoch.current,alive=()=>!disposed&&epoch.current===version;
      const start=current.current;start.detailRequest.current++;
      draftGuard.current={...start.latestEditor.current};
      start.setReview(null);start.setSend(null);setRestoring(true);
      start.setThread(thread=>thread?{...thread,ownership:{...thread.ownership,isMine:false}}:thread);
      try{
        const status=await request<Status>({command:'getStatus'});
        while(alive()){
          const state=current.current,eventId=state.selectedRef.current,dialog=state.dialogOpen;
          const selectionId=crypto.randomUUID();state.selection.current=selectionId;state.detailRequest.current++;
          const unchanged=()=>alive()&&current.current.selectedRef.current===eventId&&current.current.selection.current===selectionId;
          await request({command:'selectTarget',eventId,selectionId});
          if(!unchanged())continue;
          let thread=eventId?await request<Thread>({command:'getThread',eventId}):null;
          if(!unchanged())continue;
          if(eventId&&dialog&&current.current.dialogOpen&&!thread?.intent){
            thread=await request<Thread>({command:'openHumanDialog',eventId,selectionId});
            if(!unchanged())continue;
            if(!current.current.dialogOpen){
              if(thread.ownership.isMine)await request({command:'closeHumanDialog',eventId,generation:thread.ownership.generation});
              continue;
            }
          }
          const target=current.current;
          draftGuard.current={...target.latestEditor.current};
          target.detailRequest.current++;
          target.setThread(thread);target.setStatus(status);target.setError('');
          target.setNotice('开发内核已恢复；人稿保留，未重放模型、保存或发送');
          return;
        }
      }catch(error){if(alive())current.current.setError(explain(error));}
      finally{if(alive())setRestoring(false);}
    };
    void Promise.resolve().then(()=>listen<{event?:string}>('inbora_status_updated',event=>{
      if(event.payload?.event==='backend_restarted')void restore();
    })).then(stop=>{if(disposed)stop();else unlisten=stop;}).catch(()=>{});
    return()=>{disposed=true;epoch.current++;unlisten?.();};
  },[]);
  return {restoring,blockAutosave:restoring||draftGuard.current!==null};
}
