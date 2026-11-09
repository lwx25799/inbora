import {useState} from 'react';

export interface SharedWork {kind:'DOUYIN_WORK';url:string;workId:string}
export function validShare(share:SharedWork|undefined):SharedWork|null {
  if(share?.kind!=='DOUYIN_WORK')return null;
  const match=/^https:\/\/www\.douyin\.com\/(video|note)\/([0-9]{1,64})$/.exec(share.url);
  return match&&match[2]===share.workId?share:null;
}
export const sharedWorkLabel=(share:SharedWork)=>share.url.includes('/note/')?'图集':'视频';

export function ShareLink({share}:{share:SharedWork}){
  const [notice,setNotice]=useState(''),link=validShare(share);
  if(!link)return null;
  const label=sharedWorkLabel(link);
  async function copy(){
    try{await navigator.clipboard.writeText(link!.url);setNotice('链接已复制');}
    catch{setNotice('请选中链接后复制');}
  }
  return <section className="shared-work">
    <strong>分享{label}</strong>
    <input aria-label={`分享${label}链接`} readOnly value={link.url} onClick={event=>event.currentTarget.select()}/>
    <button type="button" onClick={()=>void copy()}>复制{label}链接</button>
    {notice&&<small role="status">{notice}</small>}
  </section>;
}
