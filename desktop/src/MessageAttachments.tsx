import {useEffect,useState} from 'react';
import {request,type TimelineItem} from './api';
import type {MessagePreviewData} from '../../src/storage/message-previews.js';

export function MessageAttachments({message}:{message:Pick<TimelineItem,'eventId'|'attachments'>}){
  const [images,setImages]=useState<Record<string,string>>({});
  const [failed,setFailed]=useState<Record<string,boolean>>({});
  const attachments=message.attachments??[],identity=attachments.map(item=>item.previewId).join(':');
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
  return <div className="message-attachments">{attachments.slice(0,4).map((attachment,index)=><figure key={attachment.previewId??index}>
    {attachment.previewId&&images[attachment.previewId]
      ?<img src={images[attachment.previewId]} alt={attachment.label||'私信图片预览'}/>
      :<span className="attachment-unavailable">{attachment.state==='READY'&&attachment.previewId&&!failed[attachment.previewId]?'正在读取图片预览':'图片预览暂不可用'}</span>}
    {attachment.label&&<figcaption>{attachment.label}</figcaption>}
  </figure>)}</div>;
}
