import {useEffect,useRef,useState} from 'react';
import {request,type TimelineItem} from './api';
import type {MessagePreviewData} from '../../src/storage/message-previews.js';

const mediaPlaceholders={IMAGE:'[图片或表情消息，需人工查看]',VIDEO:'[视频消息，需人工查看]',AUDIO:'[音频消息，需人工查看]',MIXED:'[含媒体的消息，需人工查看]'};
export const isMediaPlaceholder=(text:string,contentType?:TimelineItem['contentType'])=>contentType
  ?text===mediaPlaceholders[contentType]:Object.values(mediaPlaceholders).includes(text);

export function MessageAttachments({message,allowRefresh=true}:{message:Pick<TimelineItem,'eventId'|'attachments'>&Partial<Pick<TimelineItem,'contentType'|'observationIssue'>>;allowRefresh?:boolean}){
  const [images,setImages]=useState<Record<string,string>>({});
  const [failed,setFailed]=useState<Record<string,boolean>>({});
  const [refreshing,setRefreshing]=useState<string|null>(null),[notice,setNotice]=useState('');
  const pending=useRef<string|null>(null),current=useRef(message.eventId);current.current=message.eventId;
  const attachments=message.attachments??[],identity=JSON.stringify(attachments.map(item=>[item.previewId,item.state,item.reason]));
  useEffect(()=>{
    let cancelled=false;setImages({});setFailed({});setNotice('');
    for(const attachment of attachments.slice(0,4)){
      if(attachment.state!=='READY'||!attachment.previewId)continue;
      const previewId=attachment.previewId;
      void request<MessagePreviewData>({command:'getMessagePreview',eventId:message.eventId,previewId}).then(image=>{
        if(cancelled)return;
        if(image.previewId!==previewId||image.mime!=='image/png'||image.dataUrl.length>220000||
          !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image.dataUrl)||image.width<1||image.width>512||image.height<1||image.height>512){setFailed(previous=>({...previous,[previewId]:true}));return;}
        setImages(previous=>({...previous,[previewId]:image.dataUrl}));
      }).catch(()=>{if(!cancelled)setFailed(previous=>({...previous,[previewId]:true}));});
    }
    return()=>{cancelled=true;};
  },[message.eventId,identity]);
  const ready=attachments.slice(0,4).filter(attachment=>attachment.state==='READY'&&attachment.previewId&&!failed[attachment.previewId]);
  const unavailable=attachments.slice(0,4).some(attachment=>attachment.state!=='READY'||!attachment.previewId||failed[attachment.previewId]);
  const missing=unavailable||attachments.length===0&&message.observationIssue==='DM_CONTENT_UNVERIFIED'&&['IMAGE','MIXED'].includes(message.contentType??'');
  const shareUnavailable=attachments.some(attachment=>attachment.reason==='MESSAGE_PREVIEW_SHARE_LINK_UNVERIFIED');
  const identified=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(message.eventId);
  async function refresh(){
    const eventId=message.eventId;if(pending.current===eventId||!identified)return;pending.current=eventId;setRefreshing(eventId);setNotice('');
    try{
      const result=await request<{scheduled:boolean}>({command:'getMessagePreview',eventId,refresh:true});
      if(current.current===eventId)setNotice(result.scheduled?'已请求更新预览，结果会自动显示':'暂时无法更新，请稍后再试');
    }catch{if(current.current===eventId)setNotice('暂时无法更新，请稍后再试');}
    finally{if(pending.current===eventId)pending.current=null;if(current.current===eventId)setRefreshing(null);}
  }
  return <div className="message-attachments">{ready.map((attachment,index)=><figure key={attachment.previewId??index}>
    {attachment.previewId&&images[attachment.previewId]
      ?<img src={images[attachment.previewId]} alt={attachment.label||'私信图片预览'}/>
      :<span className="attachment-loading">正在读取图片预览</span>}
    {attachment.label&&<figcaption>{attachment.label}</figcaption>}
  </figure>)}{missing&&<><span className="attachment-unavailable">{shareUnavailable?'分享作品链接暂未取得':'消息预览暂不可用'}</span>
    {allowRefresh&&(identified?<button type="button" disabled={refreshing===message.eventId} onClick={event=>{event.stopPropagation();void refresh();}}>更新预览</button>:
      <small>消息身份暂不可核对，无法更新预览</small>)}</>}{notice&&<small role="status">{notice}</small>}</div>;
}
