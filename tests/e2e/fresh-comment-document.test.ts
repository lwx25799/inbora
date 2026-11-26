import {expect,test} from 'vitest';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {claimFreshCommentDocument,markCommentDocumentRead} from '../../src/adapters/fresh-comment-document.js';
import {privateTemp} from '../helpers.js';

async function fixture(){
  const root=privateTemp('fresh-comment-document-'),url='https://www.douyin.com/video/10';
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  await owner.context.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:
    '<!doctype html><title>Synthetic fresh comment document</title><p>Synthetic comments</p>'}));
  await owner.notification.goto(url);
  return {root,url,owner,page:owner.notification,close:async()=>{await owner.close();await rm(root,{recursive:true});}};
}

test('a newly loaded exact comment document can be claimed only once, including concurrent claims',async()=>{
  const f=await fixture();
  try{
    expect(await claimFreshCommentDocument(f.page,f.url,30_000)).toBe(true);
    expect(await claimFreshCommentDocument(f.page,f.url,30_000)).toBe(false);
    await f.page.reload();
    const claims=await Promise.all(Array.from({length:8},()=>claimFreshCommentDocument(f.page,f.url,30_000)));
    expect(claims.filter(Boolean)).toHaveLength(1);
  }finally{await f.close();}
});

test('marking the guarded document read prevents it being reused; new navigation has a new qualification',async()=>{
  const f=await fixture();
  try{
    await markCommentDocumentRead(f.page);
    expect(await claimFreshCommentDocument(f.page,f.url,30_000)).toBe(false);
    const before=await f.page.evaluate(()=>performance.timeOrigin);
    await f.page.reload();
    expect(await f.page.evaluate(()=>performance.timeOrigin)).toBeGreaterThan(before);
    expect(await claimFreshCommentDocument(f.page,f.url,30_000)).toBe(true);
  }finally{await f.close();}
});

test('an older document and invalid age limits do not qualify or consume a later valid claim',async()=>{
  const f=await fixture();
  try{
    for(const limit of [0,-1,NaN,Infinity])expect(await claimFreshCommentDocument(f.page,f.url,limit)).toBe(false);
    await f.page.waitForTimeout(30);
    expect(await claimFreshCommentDocument(f.page,f.url,1)).toBe(false);
    expect(await claimFreshCommentDocument(f.page,f.url,30_000)).toBe(true);
  }finally{await f.close();}
});

test('query differences are allowed while another work, origin, credentials and fragments are rejected',async()=>{
  const f=await fixture();
  try{
    for(const expected of ['https://www.douyin.com/video/11','https://example.invalid/video/10',
      'https://person@www.douyin.com/video/10',f.url+'#changed','not a URL'])
      expect(await claimFreshCommentDocument(f.page,expected,30_000),expected).toBe(false);
    await f.page.goto(f.url+'?from=synthetic#changed');
    expect(await claimFreshCommentDocument(f.page,f.url,30_000)).toBe(false);
    await f.page.goto('https://person@www.douyin.com/video/10');
    // Edge removes URL credentials during navigation; only its actual credential-free document can qualify.
    expect(await f.page.evaluate(()=>new URL(location.href).username)).toBe('');
    expect(await claimFreshCommentDocument(f.page,f.url,30_000)).toBe(true);
    await f.page.goto('https://example.invalid/video/10');
    expect(await claimFreshCommentDocument(f.page,f.url,30_000)).toBe(false);
    await f.page.goto(f.url+'?from=synthetic');
    expect(await claimFreshCommentDocument(f.page,f.url+'?from=expected',30_000)).toBe(true);
  }finally{await f.close();}
});

test('replacement Pages have independent first-read qualifications',async()=>{
  const f=await fixture();
  try{
    expect(await claimFreshCommentDocument(f.page,f.url,30_000)).toBe(true);
    const replacement=await f.owner.context.newPage();
    await replacement.goto(f.url);
    expect(await claimFreshCommentDocument(replacement,f.url,30_000)).toBe(true);
    expect(await claimFreshCommentDocument(f.page,f.url,30_000)).toBe(false);
  }finally{await f.close();}
});
