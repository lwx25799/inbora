import {expect,test} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader,captureObserved} from '../../src/adapters/observed-reader.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {fixtureServer} from '../fixtures/site.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {database,privateTemp} from '../helpers.js';

async function fixture(terminal?:boolean){
  const root=privateTemp('comment-tail-range-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  const mapping=observedMapping(server.origin),origin=Date.now()-60_000,page=owner.notification;
  await page.route(server.origin+'/video/10',route=>route.fulfill({contentType:'text/html',body:`
    <style>body{margin:0}#self{display:block;height:56px}#viewport{height:664px;overflow-y:auto}.comment{height:184px}</style>
    <a id="self">Self</a><div id="viewport"><div style="height:762px">Video area</div><section id="comment-list"></section><div style="height:1092px">Outside comment list</div></div>`}));
  await page.route(server.origin+'/aweme/v1/web/comment/list/**',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({
    status_code:0,total:5,has_more:terminal===false?1:0,cursor:5,comments:[]})}));
  await page.addInitScript(({origin,response})=>document.addEventListener('DOMContentLoaded',()=>{
    Object.defineProperty(document.querySelector('#self')!,'__reactFiber$fixture',{value:{return:{memoizedProps:{uid:'100',secUid:'self-sec'}}}});
    const list=document.querySelector('#comment-list')!;
    for(let index=0;index<5;index++){
      const row=document.createElement('div'),id=String(1000+index),text='synthetic tail root '+id;row.className='comment';
      row.innerHTML='<a class="author" href="/user/peer-sec">Peer</a><div class="body">'+text+'</div><div class="tooltip" id="tooltip_'+id+'">Actions</div>';
      Object.defineProperty(row,'__reactFiber$fixture',{value:{return:{memoizedProps:{level:1,userInfo:{uid:'100'},awemeInfo:{awemeId:'10'},
        commentInfo:{cid:id,replyId:'0',replyTotal:0,text,createTime:(origin+1000)/1000,user:{uid:'200',secUid:'peer-sec'},status:1}}}}});list.append(row);
    }
    const footer=document.createElement('div');footer.style.height='100px';footer.textContent='No more comments';list.append(footer);
    if(response)document.querySelector('#viewport')!.addEventListener('scroll',()=>void fetch('/aweme/v1/web/comment/list/?aweme_id=10&cursor=0'));
  }),{origin,response:terminal!==undefined});
  await page.goto(server.origin+'/video/10');await page.bringToFront();
  return {root,owner,mapping,origin,page,close:async()=>{await owner.close();await server.close();}};
}

test('comment scrolling ends at the exact list rather than unrelated later page content',async()=>{
  const f=await fixture();
  try{
    const scroll:Parameters<typeof captureObserved>[0]={mapping:f.mapping,channel:'commentScroll',index:0,evidenceId:'synthetic-tail-range',commentOffset:1784};
    const result=await f.page.evaluate(captureObserved,scroll);
    expect(result.scroll).toMatchObject({top:1118,height:2874,viewport:664,atEnd:true});
    const read:Parameters<typeof captureObserved>[0]={mapping:f.mapping,channel:'comments',index:0,evidenceId:'synthetic-tail-roots',allCommentAuthors:true};
    const batch=await f.page.evaluate(captureObserved,read);
    expect(batch.events.some(event=>event.commentId==='1004')).toBe(true);
  }finally{await f.close();}
});

test.each([true,false,undefined])('an old footer offset recovers roots and needs a terminal response before replacing its checkpoint (%s)',async terminal=>{
  const f=await fixture(terminal),store=database();let collector:InboxCollector|undefined;
  try{
    await migrateClient(store,join(f.root,'client.sqlite'));await migrateAutomation(store,join(f.root,'automation.sqlite'));
    const data=new AutomationStore(store);data.initialize(f.origin);store.bindAccount('100');
    data.configureCollection({ownId:'100',comments:true,inbox:false,commentIntervalMs:30_000,dmIntervalMs:30_000});
    store.db.prepare("INSERT INTO work_collection_progress VALUES('10',1784,2874,0,0,NULL,0)").run();
    store.db.prepare("UPDATE collection_progress SET cursor_json=? WHERE source='works'").run(JSON.stringify({phase:'comments',pendingRootPages:['10']}));
    await f.page.locator('#viewport').evaluate(node=>{node.scrollTop=1784;});
    const diagnostic=await new ObservedReader(f.page,f.mapping).diagnostic('comments');
    expect(diagnostic).toMatchObject({roots:5,windowRoots:0});expect(diagnostic.containerBottom).toBeGreaterThan(0);
    collector=new InboxCollector(f.owner,f.mapping,data,f.root,'headless');
    await expect(collector.collect('works',new AbortController().signal)).resolves.toBeUndefined();
    const progress=store.db.prepare("SELECT scroll_top,last_read,last_error FROM work_collection_progress WHERE work_id='10'").get() as {scroll_top:number;last_read:number;last_error:string|null};
    if(terminal===true){expect(progress.last_error).toBeNull();expect(progress.last_read).toBeGreaterThan(0);}
    else expect(progress).toEqual({scroll_top:1784,last_read:0,last_error:'OBSERVATION_COMMENT_RESTORE_LIMIT'});
    expect(store.events().some(event=>event.payload.commentId==='1004')).toBe(true);
    expect(store.budgets().map(b=>b.used)).toEqual([0,0]);expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    expect(data.state().startedAt).toBe(f.origin);
  }finally{collector?.dispose();store.close();await f.close();}
});

test('revealing a footer checkpoint keeps existing page input and its physical position intact',async()=>{
  const f=await fixture();
  try{
    await f.page.evaluate(()=>{
      document.querySelector('#viewport')!.scrollTop=1784;
      const editor=document.createElement('textarea');editor.value='keep synthetic unsent input';document.body.prepend(editor);
    });
    await expect(new ObservedReader(f.page,f.mapping).comments(0,true,1784,{holdScroll:true,stay:true})).rejects.toThrow('OBSERVATION_EXISTING_HUMAN_INPUT');
    expect(await f.page.locator('#viewport').evaluate(node=>node.scrollTop)).toBe(1784);
    expect(await f.page.locator('textarea').inputValue()).toBe('keep synthetic unsent input');
  }finally{await f.close();}
});
