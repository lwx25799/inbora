import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixtureServer} from '../tests/fixtures/site.ts';
import {mountObserved,observedMapping} from '../tests/fixtures/observed-site.ts';

const source=process.argv[2]==='source',directory=source?'src':'dist';
const moduleUrl=name=>pathToFileURL(resolve(directory,name.replace(/\.js$/,source?'.ts':'.js'))).href;
const {BrowserProfileOwner}=await import(moduleUrl('browser/profile-owner.js'));
const {captureObserved}=await import(moduleUrl('adapters/observed-reader.js'));
const {inspectMessageImage,saveMessagePreviews}=await import(moduleUrl('adapters/message-preview.js'));
const {MessagePreviewStore}=await import(moduleUrl('storage/message-previews.js'));
const root=resolve('.local/message-preview-carrier-smoke',source?'source':'built');await mkdir(root,{recursive:true});
const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jntkAAAAASUVORK5CYII=';
let assertions=0;const equal=(actual,expected)=>{assert.deepEqual(actual,expected);assertions++;};
try{
  const imageSource=server.origin+'/emoji.png';
  await owner.dm.route(imageSource,route=>route.fulfill({contentType:'image/png',body:Buffer.from(png.split(',')[1],'base64')}));
  for(const outgoing of [false,true]){
    await mountObserved(owner,server.origin);const mapping=observedMapping(server.origin),at=Date.now()-1000;
    await owner.dm.evaluate(({at,png,outgoing})=>{
      const chat=document.querySelector('#chat'),first=chat.querySelector('.box');
      for(const box of chat.querySelectorAll('.box'))if(box!==first)box.remove();
      first.className=outgoing?'box from-me':'box';const row=first.querySelector('.message');
      row.innerHTML='<span class="text">hello <img width="16" height="16" alt="[微笑]" src="'+png+'"></span>';
      const native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture').value.children.props.message;
      native.serverId=outgoing?'99722':'99721';native.type=7;native.sender=outgoing?'100':'200';native.createdAt=new Date(at);native._parsedContent.text='hello [微笑]';
    },{at,png:imageSource,outgoing});
    await owner.dm.locator('.message img').evaluate(image=>image.decode());
    const input={mapping,channel:'dm',index:0,evidenceId:'synthetic-carrier-smoke',dmWindow:true,peer:mapping.peers[0]};
    const batch=await owner.dm.evaluate(captureObserved,input),fresh=batch.events[0];
    equal(fresh.text,'hello [微笑]');equal(fresh.observationIssue,undefined);
    const event={...fresh,text:'[含媒体的消息，需人工查看]',contentType:'MIXED',observationIssue:'DM_CONTENT_UNVERIFIED'};
    const original=JSON.stringify(event),cache=new MessagePreviewStore(root),storedBatch={...batch,events:[event]};
    await saveMessagePreviews(owner.dm,mapping,storedBatch,root,new AbortController().signal,mapping.peers[0]);
    const attachment=cache.list(event,'100')[0];equal(attachment.state,'READY');equal(attachment.label,'[微笑]');
    equal(cache.displayText(event,'100'),'hello [微笑]');equal(JSON.stringify(event),original);
    equal(cache.read(event,'100',attachment.previewId).mime,'image/png');
    equal((await owner.context.pages()).length,2);
    await owner.dm.evaluate(()=>{
      const chat=document.querySelector('#chat'),row=document.querySelector('.message');chat.style.display='flex';chat.style.flexDirection='column';
      row.parentElement.style.display='block';row.style.display='flex';row.style.isolation='isolate';
      const bounds=row.querySelector('img').getBoundingClientRect(),group=document.createElement('div');
      group.id='synthetic-preview-layer';group.style.cssText=`display:grid;isolation:isolate;position:fixed;left:${bounds.left}px;top:${bounds.top}px;width:16px;height:16px;pointer-events:none`;
      const background=document.createElement('div');background.style.cssText='width:16px;height:16px;background:red;pointer-events:none';group.append(background);row.before(group);
      HTMLCanvasElement.prototype.toDataURL=function(){throw new DOMException('Synthetic screenshot fallback','SecurityError');};
    });
    const inspectInput={mapping,event,imageIndex:0,peer:mapping.peers[0],mode:'CANVAS'};
    const behind=await owner.dm.evaluate(inspectMessageImage,inspectInput);equal(behind.canvasTainted,true);equal(behind.reason,null);
    await owner.dm.evaluate(()=>document.querySelector('.message').after(document.querySelector('#synthetic-preview-layer')));
    const foreground=await owner.dm.evaluate(inspectMessageImage,inspectInput);equal(foreground.reason,'MESSAGE_PREVIEW_OBSCURED');
    equal(foreground.obstruction.stack.treeOrder.foreign.display,'GRID');equal(foreground.obstruction.stack.treeOrder.image.display,'FLEX');
  }
  console.log(JSON.stringify({messagePreviewCarrierSmoke:'PASS',runtime:source?'tsx-source':'compiled-node',assertions,realSends:0,modelCalls:0}));
}finally{await owner.close();await server.close();}
