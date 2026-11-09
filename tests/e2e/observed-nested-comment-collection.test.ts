import {afterAll,beforeAll,beforeEach,expect,test} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {captureObserved} from '../../src/adapters/observed-reader.js';
import {eventBinding,isStrong,targetKey} from '../../src/core/contracts.js';
import {EventStore} from '../../src/storage/store.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountCommentReply,observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

let owner:BrowserProfileOwner,server:Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async()=>{server=await fixtureServer();owner=await BrowserProfileOwner.launch(join(privateTemp('nested-comment-collection-'),'profile'),true);});
afterAll(async()=>{await owner?.close();await server?.close();});
beforeEach(async()=>{await mountCommentReply(owner,server.origin);});

async function mountChild(fault='none'){
  await owner.notification.evaluate(({fault,at})=>{
    const root=document.querySelector('#root-comment')!,child=document.createElement('div');child.className='comment';
    child.innerHTML='<a class="author" href="/user/child-sec">Child author</a><div class="body">new child input</div><div class="tooltip" id="tooltip_21">Actions</div>';
    const comment:Record<string,unknown>={cid:'21',replyId:'11',text:'new child input',createTime:at,user:{uid:'201',secUid:'child-sec'},status:1};
    const props:Record<string,unknown>={commentInfo:comment,level:2,levelOneCid:'11',awemeInfo:{awemeId:'10'}};
    if(fault==='missing-root')delete comment.replyId;
    if(fault==='wrong-root')comment.replyId='12';
    if(fault==='wrong-level-one')props.levelOneCid='12';
    if(fault==='wrong-work')props.awemeInfo={awemeId:'12'};
    if(fault==='wrong-author')comment.user={uid:'201',secUid:'other-sec'};
    if(fault==='unsafe-secure'){(window as unknown as {secureStringCalls:number}).secureStringCalls=0;
      comment.user={uid:'201',secUid:{toString(){(window as unknown as {secureStringCalls:number}).secureStringCalls++;throw Error('DO_NOT_CONVERT_PRIVATE_METADATA');}}};}
    if(fault==='wrong-text')comment.text='native text differs';
    if(fault==='hidden')child.style.display='none';
    if(fault==='multi-author'||fault==='duplicate-author'){const extra=child.querySelector('a')!.cloneNode(true) as Element;
      extra.setAttribute('href',fault==='multi-author'?'/user/peer-sec':'/user/child-sec');extra.textContent='Reply context author';child.prepend(extra);}
    Object.defineProperty(child,'__reactFiber$fixture',{value:{return:{memoizedProps:props}}});root.append(child);
  },{fault,at:Math.floor(Date.now()/1000)-10});
}
function capture(){return owner.notification.evaluate(captureObserved,{mapping:observedMapping(server.origin),channel:'comments' as const,index:0,
  evidenceId:'synthetic-nested',allCommentAuthors:true});}

test('automatic collection retains root and child separately, using exact native identity and persistent baseline',async()=>{
  await mountChild();const batch=await capture(),file=join(privateTemp('nested-comment-events-'),'poc.sqlite');let store=new EventStore(file,true);
  try{
    expect(batch.events).toHaveLength(2);const root=batch.events.find(e=>e.commentId==='11')!,child=batch.events.find(e=>e.commentId==='21')!;
    expect(root.kind).toBe('COMMENT');expect(root).not.toHaveProperty('rootCommentId');
    expect(child).toMatchObject({kind:'REPLY',rootCommentId:'11',replyToCommentId:'21',actorId:'201',text:'new child input'});
    expect(isStrong(child)).toBe(true);expect(targetKey(child)).toBe('comment:10:21');
    const origin=Date.now()-60_000;store.observe('COMMENT_NOTIFICATION','work:10',batch.events,'100','synthetic',new Date().toISOString(),origin);
    expect(store.events().find(e=>e.payload.commentId==='11')?.status).toBe('BASELINE');
    expect(store.events().find(e=>e.payload.commentId==='21')?.status).toBe('AWAITING_DRAFT');
    const again=await capture();expect(eventBinding(again.events.find(e=>e.commentId==='21')!)).toBe(eventBinding(child));
    expect(store.observe('COMMENT_NOTIFICATION','work:10',again.events,'100','synthetic')).toEqual([]);expect(store.events()).toHaveLength(2);
    store.close();store=new EventStore(file);expect(store.observe('COMMENT_NOTIFICATION','work:10',again.events,'100','synthetic')).toEqual([]);
    expect(store.events()).toHaveLength(2);expect((store.db.prepare('SELECT count(*) n FROM source_collisions').get() as {n:number}).n).toBe(0);
    expect(store.budget('MODEL').used).toBe(0);expect(store.budget('SEND').used).toBe(0);
    expect((store.db.prepare('SELECT count(*) n FROM send_intents').get() as {n:number}).n).toBe(0);
  }finally{store.close();}
});

test.each(['missing-root','wrong-root','wrong-level-one'])('uncertain native parent retains a weak child without changing the valid root: %s',async fault=>{
  await mountChild(fault);const batch=await capture(),child=batch.events.find(e=>e.commentId==='21')!;
  expect(batch.events).toHaveLength(2);expect(child).toMatchObject({kind:'REPLY',observationIssue:'COMMENT_PARENT_UNVERIFIED'});
  expect(child).not.toHaveProperty('rootCommentId');expect(isStrong(child)).toBe(false);expect(isStrong(batch.events[0]!)).toBe(true);
});

test('child text conflict keeps native text and forbids automatic treatment',async()=>{
  await mountChild('wrong-text');const child=(await capture()).events.find(e=>e.commentId==='21')!;
  expect(child).toMatchObject({text:'native text differs',observationIssue:'COMMENT_TEXT_UNVERIFIED',rootCommentId:'11'});expect(isStrong(child)).toBe(false);
});

test.each(['wrong-work','wrong-author'])('foreign native identity still blocks the capture: %s',async fault=>{
  await mountChild(fault);await expect(capture()).rejects.toThrow(fault==='wrong-work'?'OBSERVATION_COMMENT_WORK_CONFLICT':'OBSERVATION_COMMENT_AUTHOR_UNVERIFIED');
});

test('hidden child never provides an inbound event',async()=>{
  await mountChild('hidden');expect((await capture()).events.map(e=>e.commentId)).toEqual(['11']);
});

test.each([true,false])('one exact native child author is selected among reply-context links (all authors: %s)',async allCommentAuthors=>{
  await mountChild('multi-author');const mapping=observedMapping(server.origin);mapping.commentAuthors=[{uid:'201',secUid:'child-sec',title:'Child author'}];
  const value=await owner.notification.evaluate(captureObserved,{mapping,channel:'comments' as const,index:0,evidenceId:'synthetic-multi-author',allCommentAuthors});
  const child=value.events.find(event=>event.commentId==='21')!;
  expect(child).toMatchObject({actorId:'201',actorName:'Child author',rootCommentId:'11',replyToCommentId:'21'});expect(isStrong(child)).toBe(true);
});

test('two links matching the same native child identity remain ambiguous',async()=>{
  await mountChild('duplicate-author');await expect(capture()).rejects.toThrow('OBSERVATION_COMMENT_AUTHOR_UNVERIFIED');
});

test('malformed native secure identity cannot invoke a page object string conversion',async()=>{
  await mountChild('unsafe-secure');await expect(capture()).rejects.toThrow('OBSERVATION_COMMENT_AUTHOR_UNVERIFIED');
  expect(await owner.notification.evaluate(()=>(window as unknown as {secureStringCalls:number}).secureStringCalls)).toBe(0);
});

test('comment child diagnostics expose only fixed identity shape and distinguish roots from children',async()=>{
  await mountChild('wrong-author');const value=await owner.notification.evaluate(captureObserved,{mapping:observedMapping(server.origin),channel:'diagnostic' as const,
    diagnosticSource:'comments' as const,index:0,evidenceId:'synthetic-child-diagnostic'});
  expect(value.diagnostic?.commentChildren).toMatchObject({rootRows:1,childRows:1,samples:[{ownedAuthors:1,visibleProfiles:1,nativeUidPresent:true,
    nativeSecurePresent:true,profileMatchesNative:false,metadataReadable:true,hasRootNative:true,levelIs2:true,rootMatches:true,visibleBodies:1}]});
  expect(JSON.stringify(value.diagnostic?.commentChildren)).not.toMatch(/child-sec|other-sec|new child input|\/user\//);
});
