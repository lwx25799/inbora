import {afterAll,beforeAll,beforeEach,expect,test} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountCommentReply,observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

let owner:BrowserProfileOwner,server:Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async()=>{server=await fixtureServer();owner=await BrowserProfileOwner.launch(join(privateTemp('nested-author-diagnostic-'),'profile'),true);});
afterAll(async()=>{await owner?.close();await server?.close();});
beforeEach(async()=>{await mountCommentReply(owner,server.origin);});
async function mount(fault='none'){
  await owner.notification.evaluate(fault=>{
    const root=document.querySelector('#root-comment')!;let getterCalls=0;
    for(let n=0;n<2;n++){
      const row=document.createElement('div');row.className='comment';row.innerHTML='<a class="author" href="/user/child-sec">Child</a><div class="body">private synthetic text</div>';
      const props:Record<string,unknown>={level:2,awemeInfo:{awemeId:'10'},commentInfo:{cid:String(21+n),replyId:'11',user:{uid:'201',secUid:'child-sec'}}};
      if(n===0&&fault==='getter')Object.defineProperty(props,'level',{get(){getterCalls++;throw Error('NEVER_EXECUTE_PRIVATE_GETTER');}});
      if(n===0&&fault==='ambiguous'){const link=row.querySelector('a')!.cloneNode(true) as Element;link.setAttribute('href','/user/context-sec');row.append(link);}
      if(n===0&&fault==='duplicate')row.append(row.querySelector('a')!.cloneNode(true));
      if(n===0&&fault==='mismatch')row.querySelector('a')!.setAttribute('href','/user/other-sec');
      Object.defineProperty(row,'__reactFiber$fixture',{value:{return:{memoizedProps:props}}});root.append(row);
    }
    Object.defineProperty(window,'fixtureGetterCalls',{get:()=>getterCalls});
  },fault);
}
function diagnostic(){return new ObservedReader(owner.notification,observedMapping(server.origin)).diagnostic('comments');}

test('a rejected child metadata descriptor cannot discard the report or a good sibling',async()=>{
  await mount('getter');const value=await diagnostic();
  expect(value.commentChildren).toMatchObject({rootRows:1,childRows:2,samples:[{metadataReadable:false},{metadataReadable:true,profileMatchesNative:true}]});
  expect(await owner.notification.evaluate(()=>(window as unknown as {fixtureGetterCalls:number}).fixtureGetterCalls)).toBe(0);
  expect(value.source).toBe('comments');expect(value.samples).toHaveLength(1);
});

test.each([{kind:'ambiguous',matches:1},{kind:'duplicate',matches:2},{kind:'mismatch',matches:0}])('native author overlap is reported as a bounded count without identifying links: $kind',async({kind,matches})=>{
  await mount(kind);const value=await diagnostic();
  expect(value.commentChildren?.samples[0]).toMatchObject({metadataReadable:true,nativeProfileMatches:matches});
  expect(value.commentChildren?.samples[1]).toMatchObject({metadataReadable:true,nativeProfileMatches:1});
  expect(JSON.stringify(value.commentChildren)).not.toMatch(/private synthetic|child-sec|other-sec|context-sec|\/user\//);
});
