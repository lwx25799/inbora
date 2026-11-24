import {useEffect,useRef,useState,type PointerEvent as ReactPointerEvent,type KeyboardEvent as ReactKeyboardEvent} from 'react';
import {request,type Status} from './api';
import type {ManualRecoveryFrame,ManualRecoverySession,ManualRecoveryCommand} from '../../src/app/manual-recovery-contracts.js';
import {recoveryError,recoveryPoint} from './security-recovery-input';
import './security-recovery.css';

type RecoveryInput=Extract<ManualRecoveryCommand,{action:'input'}>['input'];
type QueuedInput={input:RecoveryInput;frameId:string;completed?:()=>void};
const allowedKeys=new Set(['Backspace','Delete','ArrowLeft','ArrowRight','Home','End','Enter']);

export function SecurityRecoveryDialog({session,update,onClosed}:{session:ManualRecoverySession;update:(status:Status)=>void;onClosed:()=>void}){
  const [frame,setFrame]=useState<ManualRecoveryFrame|null>(null),[error,setError]=useState('');
  const [closing,setClosing]=useState(false),[finishing,setFinishing]=useState(false),[text,setText]=useState('');
  const dialog=useRef<HTMLElement>(null),image=useRef<HTMLImageElement>(null),displayed=useRef<ManualRecoveryFrame|null>(null);
  const active=useRef(true),stopped=useRef(false),finalized=useRef(false),finalizing=useRef(false),sequence=useRef(0);
  const pointer=useRef<number|null>(null),queue=useRef<QueuedInput[]>([]),sending=useRef(false);
  const lastMove=useRef(0),moveTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const pendingMove=useRef<QueuedInput|null>(null),closeAction=useRef<()=>void>(()=>{});

  const fail=(cause:unknown)=>{
    stopped.current=true;queue.current=[];pendingMove.current=null;
    if(moveTimer.current)clearTimeout(moveTimer.current);
    if(active.current)setError(recoveryError(cause));
  };
  const drain=async()=>{
    if(sending.current||stopped.current||!active.current)return;
    sending.current=true;
    try{
      while(queue.current.length&&!stopped.current&&active.current){
        const item=queue.current.shift()!;
        await request({command:'securityRecovery',action:'input',sessionId:session.sessionId,frameId:item.frameId,
          sequence:++sequence.current,input:item.input});
        if(active.current)item.completed?.();
      }
    }catch(cause){fail(cause);}
    finally{sending.current=false;}
  };
  const enqueue=(item:QueuedInput)=>{
    if(stopped.current||!active.current||finalized.current||finalizing.current)return;
    const last=queue.current.at(-1);
    if(item.input.kind==='pointer'&&item.input.phase==='move'&&last?.input.kind==='pointer'&&last.input.phase==='move'){
      queue.current[queue.current.length-1]=item;
    }else if(queue.current.length<8)queue.current.push(item);
    else{fail('MANUAL_RECOVERY_INPUT_QUEUE_FULL');void closeAction.current();return;}
    void drain();
  };
  const flushMove=()=>{
    if(moveTimer.current)clearTimeout(moveTimer.current);
    moveTimer.current=undefined;
    const item=pendingMove.current;pendingMove.current=null;
    if(item){lastMove.current=performance.now();enqueue(item);}
  };
  const input=(value:RecoveryInput,completed?:()=>void)=>{
    const current=displayed.current;
    if(!current||Date.now()>current.expiresAt){fail('MANUAL_RECOVERY_FRAME_EXPIRED');return;}
    flushMove();enqueue({input:value,frameId:current.frameId,completed});
  };
  const pointerInput=(event:ReactPointerEvent<HTMLImageElement>,phase:'down'|'move'|'up')=>{
    if(stopped.current||finalized.current||finalizing.current||event.button!==0&&phase==='down')return;
    if(phase!=='down'&&pointer.current!==event.pointerId)return;
    const current=displayed.current,box=image.current?.getBoundingClientRect();
    const point=current&&box?recoveryPoint(current,box,event.clientX,event.clientY):null;
    event.preventDefault();
    if(!point){if(pointer.current!==null)void closeAction.current();return;}
    if(phase==='down'){
      if(pointer.current!==null)return;
      pointer.current=event.pointerId;event.currentTarget.setPointerCapture(event.pointerId);event.currentTarget.focus();
    }
    const item:QueuedInput={input:{kind:'pointer',phase,...point},frameId:current!.frameId};
    if(phase==='move'){
      pendingMove.current=item;
      if(!moveTimer.current){const remaining=Math.max(0,50-(performance.now()-lastMove.current));moveTimer.current=setTimeout(flushMove,remaining);}
    }else{
      flushMove();enqueue(item);
      if(phase==='up'){
        pointer.current=null;
        if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
      }
    }
  };
  const close=async()=>{
    if(finalized.current)return;
    finalized.current=true;stopped.current=true;queue.current=[];pendingMove.current=null;
    if(moveTimer.current)clearTimeout(moveTimer.current);
    if(active.current)setClosing(true);
    try{
      const status=await request<Status>({command:'securityRecovery',action:'close',sessionId:session.sessionId});
      update(status);if(active.current)onClosed();
    }catch(cause){
      if(active.current){finalized.current=false;setClosing(false);setError(recoveryError(cause));}
    }
  };
  closeAction.current=()=>{void close();};
  const finish=async()=>{
    if(finishing||finalized.current)return;
    if(pointer.current!==null){setError('请先松开画面中的拖动，再完成核验。');return;}
    finalizing.current=true;setFinishing(true);
    if(moveTimer.current)clearTimeout(moveTimer.current);
    try{
      // A submitted human input completes before verification; it is never replayed.
      const deadline=Date.now()+5000;
      while(sending.current||queue.current.length){
        if(Date.now()>deadline)throw Error('MANUAL_RECOVERY_INPUT_TIMEOUT');
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      stopped.current=true;pendingMove.current=null;
      const status=await request<Status>({command:'securityRecovery',action:'finish',sessionId:session.sessionId});
      finalized.current=true;update(status);onClosed();
    }catch(cause){fail(cause);setFinishing(false);}
  };
  useEffect(()=>{
    // Identical consecutive images do not dispatch another load event.
    if(frame&&image.current?.complete&&image.current.naturalWidth>0&&image.current.getAttribute('src')===frame.image)
      displayed.current=frame;
  },[frame]);
  const keyInput=(event:ReactKeyboardEvent<HTMLImageElement>)=>{
    if(event.key==='Escape'){event.preventDefault();void close();return;}
    if(event.altKey||event.ctrlKey||event.metaKey||!allowedKeys.has(event.key))return;
    event.preventDefault();input({kind:'key',key:event.key as Extract<RecoveryInput,{kind:'key'}>['key']});
  };
  const dialogKeys=(event:ReactKeyboardEvent<HTMLElement>)=>{
    if(event.key==='Escape'){event.preventDefault();void close();return;}
    if(event.key!=='Tab')return;
    const controls=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]')??[]);
    const first=controls[0],last=controls.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  };

  useEffect(()=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const previousFocus=document.activeElement as HTMLElement|null;
    active.current=true;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const poll=async()=>{
      if(stopped.current||finalized.current)return;
      try{
        const next=await request<ManualRecoveryFrame>({command:'securityRecovery',action:'frame',sessionId:session.sessionId});
        if(active.current&&!stopped.current)setFrame(next);
      }catch(cause){fail(cause);}
      if(active.current&&!stopped.current)timer=setTimeout(()=>void poll(),500);
    };
    void poll();
    // Do not close on window blur or visibility change so switching apps for SMS codes or IME focus never drops the session.
    const pageHide=()=>closeAction.current();
    window.addEventListener('pagehide',pageHide);
    return()=>{
      active.current=false;stopped.current=true;
      if(timer)clearTimeout(timer);if(moveTimer.current)clearTimeout(moveTimer.current);
      window.removeEventListener('pagehide',pageHide);
      queue.current=[];pendingMove.current=null;
      if(previousFocus?.isConnected)previousFocus.focus();
      if(!finalized.current){finalized.current=true;void request({command:'securityRecovery',action:'close',sessionId:session.sessionId}).catch(()=>{});}
    };
  },[session.sessionId]);

  return <div className="security-recovery-backdrop">
    <section ref={dialog} className="security-recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="security-recovery-title" onKeyDown={dialogKeys}>
      <div className="security-recovery-heading"><h2 id="security-recovery-title">{session.recreated?'处理当前验证页面':'处理原验证页面'}</h2>
        <button disabled={closing||finishing} onClick={()=>void close()} aria-label="关闭验证页面">关闭</button></div>
      <p>{session.recreated?'原现场已丢失，这是在原授权地址重新检查后出现的新验证。':'这是'+(session.channel==='DIRECT_MESSAGE'?'私信':'评论')+'原无头页面的实时画面。'}请在画面内完成验证，可点击或拖动；处理期间后台浏览器操作暂停。</p>
      <p className="security-recovery-note">关闭后保留当前拦截；完成验证后点击“完成并核验”。</p>
      {error&&<p className="security-recovery-error" role="alert">{error}</p>}
      <div className="security-recovery-viewport" aria-busy={!frame}>
        {frame?<img ref={image} src={frame.image} alt="原验证页面实时画面" width={frame.width} height={frame.height} draggable={false} tabIndex={0}
          className={error?'security-recovery-image blocked':'security-recovery-image'}
          onLoad={()=>{displayed.current=frame;}}
          onPointerDown={event=>pointerInput(event,'down')} onPointerMove={event=>pointerInput(event,'move')}
          onPointerUp={event=>pointerInput(event,'up')}
          onPointerCancel={()=>void close()} onLostPointerCapture={()=>{if(pointer.current!==null)void close();}}
          onKeyDown={keyInput} onContextMenu={event=>event.preventDefault()}/>:<p>正在取得原页面画面…</p>}
      </div>
      <div className="security-recovery-text">
        <label htmlFor="security-recovery-code">文字验证码</label>
        <input id="security-recovery-code" value={text} maxLength={100} autoComplete="off" disabled={!!error||closing||finishing}
          onChange={event=>setText(event.target.value)} placeholder="先在画面中点击验证码输入框"/>
        <button disabled={!text||!frame||!!error||closing||finishing} onClick={()=>{
          const submitted=text;input({kind:'text',text:submitted},()=>setText(current=>current===submitted?'':current));
        }}>输入到验证框</button>
      </div>
      <div className="security-recovery-actions"><button disabled={!frame||closing||finishing} onClick={()=>void finish()}>
        {finishing?'正在核验…':'完成并核验'}</button><button disabled={closing||finishing} onClick={()=>void close()}>暂不处理</button></div>
    </section>
  </div>;
}
