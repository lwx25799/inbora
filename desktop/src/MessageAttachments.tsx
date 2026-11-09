import {useEffect,useState} from 'react';
import {request,type TimelineItem} from './api';
import type {MessagePreviewData} from '../../src/storage/message-previews.js';

const mediaPlaceholders={IMAGE:'[图片或表情消息，需人工查看]',VIDEO:'[视频消息，需人工查看]',AUDIO:'[音频消息，需人工查看]',MIXED:'[含媒体的消息，需人工查看]'};
export const isMediaPlaceholder=(text:string,contentType?:TimelineItem['contentType'])=>contentType
  ?text===mediaPlaceholders[contentType]:Object.values(mediaPlaceholders).includes(text);

export function MessageAttachments({message}:{message:Pick<TimelineItem,'eventId'|'attachments'>}){
  const [images,setImages]=useState<Record<string,string>>({});
  const [failed,setFailed]=useState<Record<string,boolean>>({});
  const attachments=message.attachments??[],identity=JSON.stringify(attachments.map(item=>[item.previewId,item.state,item.reason]));
  useEffect(()=>{
    let cancelled=false;setImages({});setFailed({});
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
  return <div className="message-attachments">{ready.map((attachment,index)=><figure key={attachment.previewId??index}>
    {attachment.previewId&&images[attachment.previewId]
      ?<img src={images[attachment.previewId]} alt={attachment.label||'私信图片预览'}/>
      :<span className="attachment-loading">正在读取图片预览</span>}
    {attachment.label&&<figcaption>{attachment.label}</figcaption>}
  </figure>)}{unavailable&&<span className="attachment-unavailable">消息预览暂不可用</span>}</div>;
}
