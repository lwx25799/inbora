import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixtureServer} from '../tests/fixtures/site.ts';
import {mountObserved,observedMapping} from '../tests/fixtures/observed-site.ts';
const source=process.argv[2]==='source',directory=source?'src':'dist',moduleUrl=name=>pathToFileURL(resolve(directory,name.replace(/\.js$/,source?'.ts':'.js'))).href;
const {BrowserProfileOwner}=await import(moduleUrl('browser/profile-owner.js'));
const {ObservedReader}=await import(moduleUrl('adapters/observed-reader.js'));
const {inspectMessageImage,saveMessagePreviews}=await import(moduleUrl('adapters/message-preview.js'));
const {MessagePreviewStore}=await import(moduleUrl('storage/message-previews.js'));
const base=resolve('.local/message-preview-canvas-smoke');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'run-'));
const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
try{
  await mountObserved(owner,server.origin);const mapping=observedMapping(server.origin),at=Date.now()-1000;
  const png=await owner.dm.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=640;const context=canvas.getContext('2d');
    context.fillStyle='rgb(12,100,200)';context.fillRect(0,0,canvas.width,canvas.height);return canvas.toDataURL('image/png');
  });
  let requests=0;await owner.dm.route('https://cdn.fixture.invalid/loaded.png',route=>{requests++;return route.fulfill({contentType:'image/png',body:Buffer.from(png.split(',')[1],'base64')});});
  await owner.dm.evaluate(({at,png})=>{
    const chat=document.querySelector('#chat');chat.querySelectorAll('.box').forEach(node=>node.remove());
    const box=document.createElement('div'),row=document.createElement('div');box.className='box';row.className='message';row.style.minHeight='32px';
    row.innerHTML='<img width="24" height="24" alt="owned emoji">';const image=row.querySelector('img');image.src=png;box.append(row);chat.append(box);
    Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:'99001',conversationId:'conv-a',sender:'200',createdAt:new Date(at),_parsedContent:{text:''}}}}}});
    const overlay=document.createElement('div');overlay.style.cssText='position:fixed;inset:0;background:red;z-index:10000';document.body.append(overlay);
  },{at,png});
  await owner.dm.locator('.message img').evaluate(image=>image.decode());
  const batch=await new ObservedReader(owner.dm,mapping).dmWindow(mapping.peers[0]),event=batch.events[0],input={mapping,event,imageIndex:0,peer:mapping.peers[0]};
  assert.equal((await owner.dm.evaluate(inspectMessageImage,input)).reason,'MESSAGE_PREVIEW_OBSCURED');
  const image=await owner.dm.evaluate(inspectMessageImage,{...input,mode:'CANVAS'});
  assert.equal(image.reason,null);assert.equal(image.canvas.width,512);assert.equal(image.canvas.height,320);assert.match(image.canvas.dataUrl,/^data:image\/png;base64,/u);
  const verified=await owner.dm.evaluate(inspectMessageImage,{...input,mode:'CANVAS_VERIFY'});assert.equal(verified.sourceFingerprint,image.sourceFingerprint);
  const count=requests;await saveMessagePreviews(owner.dm,mapping,batch,root,new AbortController().signal);
  const cache=new MessagePreviewStore(root),attachment=cache.list(event,'100')[0];assert.equal(attachment.state,'READY');assert.equal(attachment.width,512);assert.equal(requests,count);
  await owner.dm.evaluate(async()=>{const image=document.querySelector('.message img');image.src='https://cdn.fixture.invalid/loaded.png';await image.decode();});
  const tainted=await owner.dm.evaluate(inspectMessageImage,{...input,mode:'CANVAS'});assert.equal(tainted.canvasTainted,true);assert.equal(tainted.reason,'MESSAGE_PREVIEW_OBSCURED');
  const diagnostics=await readFile(join(root,'evidence','message-preview-latest.json'),'utf8');assert.doesNotMatch(diagnostics,/cdn\.fixture|99001|conv-a|owned emoji/u);
  console.log(JSON.stringify({messagePreviewCanvasSmoke:'PASS',runtime:source?'tsx-source':'compiled-node',assertions:12,realSends:0,modelCalls:0}));
}finally{await owner.close();await server.close();}
