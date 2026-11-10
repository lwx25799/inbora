import type {RefObject} from 'react';
import type {Status,Thread} from './api';

export interface ReplyViewProps {
  detailElement:RefObject<HTMLElement|null>;
  dialogElement:RefObject<HTMLDialogElement|null>;
  thread:Thread|null;
  status:Status;
  setStatus:(status:Status)=>void;
  selected:string|null;
  choose:(id:string)=>void;
  busy:string;
  act:(label:string,action:()=>Promise<void>)=>Promise<void>;
  setNotice:(text:string)=>void;
  openDialog:()=>Promise<void>;
  closeDialog:()=>Promise<void>;
  readOnly:boolean;
  saving:boolean;
  dirty:boolean;
  error:string;
  notice:string;
  text:string;
  setText:(text:string)=>void;
  setSuggestionId:(id:string|null)=>void;
  setReview:(value:null)=>void;
  refreshThread:()=>Promise<unknown>;
  block:string;
  send:{commandId:string;status:string;reason:string|null}|null;
  sendCurrentText:()=>Promise<void>;
}
