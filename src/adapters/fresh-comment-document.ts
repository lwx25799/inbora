import type {Page} from 'playwright';

const readDocuments=new WeakMap<Page,number>();

async function snapshot(page:Page):Promise<{href:string;timeOrigin:number;now:number}>{
  return page.evaluate(()=>({href:location.href,timeOrigin:performance.timeOrigin,now:Date.now()}));
}

/** Consume an unread, recently loaded exact work document once; normal later polls still refresh. */
export async function claimFreshCommentDocument(page:Page,url:string,maxAgeMs:number):Promise<boolean>{
  if(!Number.isFinite(maxAgeMs)||maxAgeMs<=0)return false;
  const current=await snapshot(page);
  let expected:URL,actual:URL;
  try{expected=new URL(url);actual=new URL(current.href);}catch{return false;}
  if(!['http:','https:'].includes(expected.protocol)||expected.username||expected.password||expected.hash||
    actual.username||actual.password||actual.hash||actual.origin!==expected.origin||
    actual.href.split('?')[0]!==expected.href.split('?')[0])return false;
  const age=current.now-current.timeOrigin;
  if(!Number.isFinite(current.timeOrigin)||current.timeOrigin<=0||!Number.isFinite(age)||age<0||age>maxAgeMs||
    readDocuments.get(page)===current.timeOrigin)return false;
  readDocuments.set(page,current.timeOrigin);
  return true;
}

/** The caller has guarded this document and is about to start its normal comment read. */
export async function markCommentDocumentRead(page:Page):Promise<void>{
  const current=await snapshot(page);
  if(Number.isFinite(current.timeOrigin)&&current.timeOrigin>0)readDocuments.set(page,current.timeOrigin);
}
