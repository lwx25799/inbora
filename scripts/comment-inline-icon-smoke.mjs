import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixtureServer} from '../tests/fixtures/site.ts';
import {mountCommentReply,commentReplyMapping} from '../tests/fixtures/observed-site.ts';
const source=process.argv[2]==='source',root=source?'src':'dist';
const moduleUrl=name=>pathToFileURL(resolve(root,name.replace(/\.js$/,source?'.ts':'.js'))).href;
const {BrowserProfileOwner}=await import(moduleUrl('browser/profile-owner.js'));
const {captureObserved}=await import(moduleUrl('adapters/observed-reader.js'));
const {captureCommentReply}=await import(moduleUrl('adapters/observed-comment-reply.js'));
const {isStrong}=await import(moduleUrl('core/contracts.js'));
const base=resolve('.local/tests/comment-inline-icon-smoke');await mkdir(base,{recursive:true});
const dir=await mkdtemp(join(base,'run-')),server=await fixtureServer();
const owner=await BrowserProfileOwner.launch(join(dir,'profile'),true),checks=[];
try{
  await mountCommentReply(owner,server.origin);
  const mapping=commentReplyMapping(server.origin);
  await owner.notification.evaluate(()=>{
    document.querySelector('#root-comment .body').innerHTML='root <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><path d="M0 0L12 12"/></svg>fixture input';
    const root=document.querySelector('#root-comment');
    Object.getOwnPropertyDescriptor(root,'__reactFiber$fixture').value.return.memoizedProps.commentInfo.replyTotal=1;
    const child=document.createElement('div');child.className='comment';child.id='inline-icon-child';
    child.innerHTML='<a class="author" href="/user/self-sec">Self</a><div class="body">synthetic <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><path d="M0 0L12 12"/></svg>English token-123 reply</div><div class="tooltip" id="tooltip_901">Actions</div>';
    Object.defineProperty(child,'__reactFiber$fixture',{value:{return:{memoizedProps:{level:2,levelOneCid:'11',awemeInfo:{awemeId:'10'},
      commentInfo:{cid:'901',replyId:'11',text:'synthetic English token-123 reply',createTime:Math.floor(Date.now()/1000)-1,
        status:1,user:{uid:'100',secUid:'self-sec'}}}}}});
    root.append(child);
  });
  const read=()=>owner.notification.evaluate(captureObserved,{mapping:mapping.observation,channel:'comments',index:0,evidenceId:'synthetic'});
  const batch=await read(),event=batch.events[0];
  checks.push(['incoming inline icon preserves exact text',isStrong(event)&&event.text==='root fixture input']);
  // Keep the proof check independent so a collection failure cannot mask a readback failure.
  await owner.notification.evaluate(()=>{document.querySelector('#root-comment .body').textContent='root fixture input';});
  const plain=(await read()).events[0];
  const proof=()=>owner.notification.evaluate(captureCommentReply,{mapping,event:plain,action:'proofs',text:null,token:null,before:null,shape:null});
  checks.push(['own reply inline icon preserves full proof',(await proof()).proofs.length===1]);
  await owner.notification.locator('#inline-icon-child .body').evaluate(node=>{node.innerHTML='<custom-body>synthetic English token-123 reply</custom-body>';});
  checks.push(['unknown body element cannot become proof',(await proof()).proofs.length===0]);
  for(const icon of ['<svg width="12" height="12"><text>extra</text></svg>',
    '<svg width="12" height="12"><use href="https://example.invalid/icon"/></svg>',
    '<svg width="200" height="200"><path d="M0 0L12 12"/></svg>',
    '<svg width="12" height="12" aria-label="additional image"><path d="M0 0L12 12"/></svg>']){
    await owner.notification.locator('#inline-icon-child .body').evaluate((node,icon)=>{node.innerHTML='synthetic English token-123 reply'+icon;},icon);
    checks.push(['nondecorative or external SVG cannot become proof: '+icon,(await proof()).proofs.length===0]);
  }
  await owner.notification.locator('#inline-icon-child .body').evaluate(node=>{node.innerHTML='synthetic different reply';});
  checks.push(['changed visible text cannot become proof',(await proof()).proofs.length===0]);
  await owner.notification.evaluate(()=>{document.querySelector('#root-comment .body').innerHTML='root <custom-body>fixture</custom-body> input';});
  checks.push(['incoming unknown element remains weak',!isStrong((await read()).events[0])]);
  const failed=checks.filter(([,ok])=>!ok).map(([name])=>name);
  assert.deepEqual(failed,[]);console.log(`${source?'source':'built'}: ${checks.length} comment inline-icon assertions passed`);
}finally{await owner.close();await server.close();}
