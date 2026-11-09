import { expect, test } from 'vitest';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { BrowserProfileOwner } from '../../src/browser/profile-owner.js';
import { captureObserved } from '../../src/adapters/observed-reader.js';
import { ObservedCommentReply } from '../../src/adapters/observed-comment-reply.js';
import { eventBinding, isStrong, digest } from '../../src/core/contracts.js';
import { observedMapping, mountCommentReply, commentReplyMapping } from '../fixtures/observed-site.js';
import { fixtureServer } from '../fixtures/site.js';
import { database, privateTemp } from '../helpers.js';

async function comments(page:Page,origin:string,rows:{html:string;text:string;at?:number}[]):Promise<void>{
  await page.goto(origin+'/video/10');
  await page.setContent('<a id="self">Self</a><section id="comment-list"></section>');
  await page.evaluate(({rows})=>{
    Object.defineProperty(document.querySelector('#self')!,'__reactFiber$fixture',
      {value:{return:{memoizedProps:{uid:'100',secUid:'self-sec'}}}});
    rows.forEach((item,index)=>{
      const row=document.createElement('div');row.className='comment';
      const id=String(50+index);
      row.innerHTML=`<a class="author" href="/user/peer-sec">Fixture peer</a><div class="tooltip" id="tooltip_${id}"><span class="body">${item.html}</span></div>`;
      Object.defineProperty(row,'__reactFiber$fixture',{value:{return:{memoizedProps:{awemeInfo:{awemeId:'10'},userInfo:{uid:'100'},
        commentInfo:{cid:id,text:item.text,createTime:item.at??Math.floor(Date.now()/1000),user:{uid:'200',secUid:'peer-sec'}}}}}});
      document.querySelector('#comment-list')!.append(row);
    });
  },{rows});
}

test.each([
  {html:'before <img width="16" height="16" src="/emoji.png" alt="[赞]"> after',text:'before [赞] after'},
  {html:'<img width="16" height="16" src="/emoji.png" alt="🥹">',text:'🥹'},
  {html:'  first<br>second <span>line</span>  ',text:'  first\nsecond line  '},
])('owned inline comment content preserves the exact native full text: $text',async row=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp('comment-text-'),'profile'),true);
  try{
    await comments(owner.notification,server.origin,[row]);
    const batch=await owner.notification.evaluate(captureObserved,{mapping:observedMapping(server.origin),channel:'comments' as const,index:0,evidenceId:'fixture',allCommentAuthors:true});
    expect(batch.events).toHaveLength(1);expect(batch.events[0]!.text).toBe(row.text);
    expect(isStrong(batch.events[0]!)).toBe(true);expect(batch.unsupported).toBe(0);
  }finally{await owner.close();await server.close();}
});

test('unverified comment bodies are isolated for review while other new comments collect and old history remains baseline',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp('comment-review-'),'profile'),true),store=database();
  const start=Date.now()-10_000;
  try{
    await comments(owner.notification,server.origin,[
      {html:'valid new comment',text:'valid new comment'},
      {html:'<img width="16" height="16" src="/emoji.png">',text:'[赞]'},
      {html:'<img width="16" height="16" src="/emoji.png" alt="[赞]">',text:'[哭]'},
      {html:'changed visible body',text:'different native body'},
      {html:'<video width="16" height="16"></video>',text:''},
      {html:'<img width="16" height="16" src="/emoji.png">',text:'[赞]',at:Math.floor(start/1000)-10},
    ]);
    const batch=await owner.notification.evaluate(captureObserved,{mapping:observedMapping(server.origin),channel:'comments' as const,index:0,evidenceId:'fixture',allCommentAuthors:true});
    expect(batch.events).toHaveLength(6);expect(batch.unsupported).toBe(5);
    expect(batch.events.slice(1).every(event=>!isStrong(event))).toBe(true);
    store.observe('COMMENT_NOTIFICATION','work:10',batch.events,'100','fixture',new Date().toISOString(),start);
    expect(store.events().filter(event=>event.status==='AWAITING_DRAFT')).toHaveLength(1);
    expect(store.events().filter(event=>event.status==='MANUAL_REVIEW')).toHaveLength(4);
    expect(store.events().filter(event=>event.status==='BASELINE')).toHaveLength(1);
    const auditCount=store.db.prepare('SELECT count(*) AS n FROM audit_events').get();
    store.observe('COMMENT_NOTIFICATION','work:10',batch.events,'100','fixture',new Date().toISOString(),start);
    expect(store.events()).toHaveLength(6);
    expect(store.db.prepare('SELECT count(*) AS n FROM source_collisions').get()).toEqual({n:0});
    expect(store.db.prepare('SELECT count(*) AS n FROM audit_events').get()).toEqual(auditCount);
    expect(store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
    const normal=batch.events[0]!;
    expect(eventBinding(normal)).toBe(digest([normal.accountId,normal.channel,normal.platformEventId,normal.actorId,normal.text,normal.occurredAt,
      normal.videoId,normal.commentId,normal.conversationId,normal.direction,normal.kind]));
  }finally{store.close();await owner.close();await server.close();}
});

test('comment reply inspection uses the same exact emoji text and rejects a changed emoji before any submit',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp('comment-emoji-reply-'),'profile'),true);
  let adapter:ObservedCommentReply|undefined;
  try{
    await mountCommentReply(owner,server.origin);
    await owner.notification.evaluate(()=>{
      const root=document.querySelector('#root-comment')!;
      Object.getOwnPropertyDescriptor(root,'__reactFiber$fixture')!.value.return.memoizedProps.commentInfo.text='root fixture input[赞]';
      root.querySelector('.body')!.innerHTML='root fixture input<img width="16" height="16" src="/emoji.png" alt="[赞]">';
    });
    const mapping=commentReplyMapping(server.origin);
    const batch=await owner.notification.evaluate(captureObserved,{mapping:mapping.observation,channel:'comments' as const,index:0,evidenceId:'fixture'});
    const event=batch.events[0]!;expect(isStrong(event)).toBe(true);
    adapter=new ObservedCommentReply(owner.notification,mapping);
    expect((await adapter.inspect(event)).targetKey).toBe('comment:10:11');
    await owner.notification.locator('.body img').evaluate(node=>node.setAttribute('alt','[哭]'));
    await expect(adapter.inspect(event)).rejects.toThrow('COMMENT_REPLY_ORIGINAL_CHANGED');
    expect(await owner.notification.evaluate(()=>(window as unknown as {commentClicks:number}).commentClicks)).toBe(0);
  }finally{adapter?.dispose();await owner.close();await server.close();}
});

test('unsupported images and nested bodies cannot manufacture exact comment text or stop the good sibling',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp('comment-unsafe-body-'),'profile'),true);
  try{
    await comments(owner.notification,server.origin,[
      {html:'verified text',text:'verified text'},
      {html:'<img width="16" height="16" src="/emoji.png" title="[赞]" aria-label="[赞]">',text:'[赞]'},
      {html:'<img width="16" height="16" src="javascript:void(0)" alt="[赞]">',text:'[赞]'},
      {html:'<a href="/outside"><img width="16" height="16" src="/emoji.png" alt="[赞]"></a>',text:'[赞]'},
      {html:'<img width="16" height="16" src="/emoji.png" alt="ordinary attachment">',text:'ordinary attachment'},
      {html:'<span style="display:none">[赞]</span>visible',text:'[赞]visible'},
      {html:'<span class="comment">nested private body</span>',text:'native parent body'},
      {html:Array.from({length:9},()=>'<img width="16" height="16" src="/emoji.png" alt="[赞]">').join(''),text:'[赞]'.repeat(9)},
    ]);
    const batch=await owner.notification.evaluate(captureObserved,{mapping:observedMapping(server.origin),channel:'comments' as const,index:0,evidenceId:'fixture',allCommentAuthors:true});
    expect(batch.events).toHaveLength(8);expect(isStrong(batch.events[0]!)).toBe(true);
    expect(batch.events.slice(1).every(event=>!isStrong(event))).toBe(true);
    expect(batch.events[6]!.text).toBe('native parent body');
    expect(JSON.stringify(batch)).not.toContain('nested private body');
  }finally{await owner.close();await server.close();}
});

test.each(['body','tooltip','self','list','roots'] as const)('missing comment %s is diagnosed without leaking its selector or private content',async missing=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp('comment-read-stage-'),'profile'),true);
  try{
    await comments(owner.notification,server.origin,[{html:'fixture text',text:'fixture text'}]);
    if(missing==='roots')await owner.notification.locator('#comment-list').evaluate(node=>(node as HTMLElement).style.minHeight='24px');
    const selector={body:'.body',tooltip:'.tooltip',self:'#self',list:'#comment-list',roots:'.comment'}[missing];
    await owner.notification.locator(selector).evaluate(node=>node.remove());
    const expected={body:'OBSERVATION_COMMENT_TEXT_DOM_NOT_READY',tooltip:'OBSERVATION_COMMENT_TOOLTIP_DOM_NOT_READY',self:'OBSERVATION_ACCOUNT_AVATAR_DOM_NOT_READY',
      list:'OBSERVATION_COMMENT_LIST_DOM_NOT_READY',roots:'OBSERVATION_COMMENT_ROOTS_DOM_NOT_READY'}[missing];
    await expect(owner.notification.evaluate(captureObserved,{mapping:observedMapping(server.origin),channel:'comments' as const,index:0,evidenceId:'fixture',allCommentAuthors:true}))
      .rejects.toThrow(expected);
  }finally{await owner.close();await server.close();}
});
