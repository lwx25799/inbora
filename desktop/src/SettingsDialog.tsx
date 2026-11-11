import {useEffect,useRef,type ReactNode} from 'react';

/** Keep fields mounted so closing an editor never discards its unsaved React state. */
export function SettingsDialog({title,open,onClose,children}:{
  title:string;open:boolean;onClose:()=>void;children:ReactNode;
}) {
  const element=useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    if(open&&!element.current?.open)element.current?.showModal();
    if(!open&&element.current?.open)element.current.close();
  },[open]);
  return <dialog ref={element} className="settings-dialog" aria-label={title}
    onCancel={event=>{event.preventDefault();onClose();}}>
    <div className="dialog-heading"><h2>{title}</h2>
      <button onClick={onClose}>关闭并保留输入</button></div>
    {children}
  </dialog>;
}
