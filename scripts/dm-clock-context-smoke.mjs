import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixtureServer} from '../tests/fixtures/site.ts';
import {mountDmReply,dmReplyMapping} from '../tests/fixtures/observed-site.ts';
const source=process.argv[2]==='source',base=source?'src':'dist';
const moduleUrl=name=>pathToFileURL(resolve(base,name.replace(/\.js$/,source?'.ts':'.js'))).href;
const {BrowserProfileOwner}=await import(moduleUrl('browser/profile-owner.js'));
const {ObservedReader}=await import(moduleUrl('adapters/observed-reader.js'));
const {ObservedDmReply}=await import(moduleUrl('adapters/observed-dm-reply.js'));
const parent=resolve('.local/dm-clock-context-smoke');await mkdir(parent,{recursive:true});
const root=await mkdtemp(join(parent,'run-')),server=await fixtureServer();
try{
  for(const mode of ['EXTRA','MISSING','DEFERRED']){
    const owner=await BrowserProfileOwner.launch(join(root,mode,'profile'),true);let adapter;
    try{
      await mountDmReply(owner,server.origin);const mapping=dmReplyMapping(server.origin);
      await owner.dm.evaluate(()=>{for(const row of document.querySelectorAll('.message')){
        const native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture').value.children.props.message;
        native.createdAt=new Date(Date.UTC(2026,10,5,0,0,Number(native.serverId)-1));
      }});
      const event=(await new ObservedReader(owner.dm,mapping.observation).dm(0)).events.find(item=>item.platformEventId==='3');
      if(mode==='DEFERRED')await owner.dm.evaluate(()=>{
        const row=document.querySelectorAll('.message')[1],native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture').value.children.props.message;
        native.type=110;native._parsedContent={};row.replaceChildren();row.style.minHeight='20px';
      });
      adapter=new ObservedDmReply(owner.dm,mapping,750);const snapshot=await adapter.inspect(event);adapter.dispose();
      await owner.dm.addInitScript(mode=>document.addEventListener('DOMContentLoaded',()=>{
        document.querySelector('#native-editor').textContent='';const chat=document.querySelector('#chat');
        for(const row of chat.querySelectorAll('.message')){
          const native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture').value.children.props.message;
          if(Number(native.serverId)<=5)native.createdAt=new Date(Date.UTC(2026,10,5,0,0,Number(native.serverId)-1));
        }
        const fixture={old(extra){const box=document.createElement('div'),row=document.createElement('div'),text=document.createElement('span');
          box.className='box';box.dataset.index='9';row.className='message';text.className='text';text.textContent=extra?'extra older fixture':'controlled-1';
          Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:extra?'99':'1',sender:'200',conversationId:'conv-a',
            createdAt:new Date(extra?'2026-11-04T23:59:00.000Z':'2026-11-05T00:00:00.000Z'),type:7,serverStatus:0,_parsedContent:{text:text.textContent}}}}}});
          row.append(text);box.append(row);return box;}};
        if(mode==='EXTRA')chat.prepend(fixture.old(true));
        else if(mode==='DEFERRED'){
          const row=document.querySelectorAll('.message')[1],native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture').value.children.props.message;
          native.type=110;native._parsedContent={};row.replaceChildren();row.style.minHeight='20px';
        }else{
          const viewport=document.createElement('div');viewport.id='proof-scroll';viewport.style.cssText='height:180px;width:320px;overflow:auto';
          chat.insertBefore(viewport,document.querySelector('#native-controls'));const boxes=Array.from(chat.querySelectorAll('.box'));
          for(const box of boxes){box.style.height='20px';viewport.append(box);}boxes[0].remove();
          const spacer=document.createElement('div');spacer.style.height='600px';viewport.append(spacer);
          viewport.addEventListener('scroll',()=>{if(!Array.from(viewport.querySelectorAll('.message')).some(row=>
            Object.getOwnPropertyDescriptor(row,'__reactProps$fixture').value.children.props.message.serverId==='1'))viewport.prepend(fixture.old(false));});
        }
      }),mode);
      const boundary=new Date().toISOString(),text='synthetic clock-context smoke';
      await owner.dm.evaluate(({text,boundary})=>sessionStorage.setItem('native-receipt',JSON.stringify({id:'888',text,createdAt:new Date(Date.parse(boundary)-949).toISOString(),clicks:0})),{text,boundary});
      await owner.dm.reload({waitUntil:'domcontentloaded'});const reports=[];
      adapter=new ObservedDmReply(owner.dm,mapping,750,{onReadbackDiagnostic:report=>reports.push(report)});
      const proof=await owner.actor.run(()=>adapter.verifyExisting(event,text,boundary,snapshot.contextDigest));
      assert.equal(proof.id,'888');assert.equal(proof.clockSkew.remainingContextDigest,snapshot.contextDigest);assert.equal(proof.clockSkew.refreshedId,proof.id);
      assert.equal(proof.text,text);assert.equal(await owner.dm.evaluate(()=>window.nativeClicks),0);
      assert.ok(reports.some(report=>report.stage==='FIRST_POLL'&&report.contextMatches));assert.ok(reports.some(report=>report.stage==='REFRESH_POLL'&&report.contextMatches));
      assert.ok(!JSON.stringify(reports).includes(text));assert.ok(Math.max(...reports.map(report=>report.windowReads))<=2);
      if(mode==='MISSING'){assert.equal(Math.max(...reports.map(report=>report.windowReads)),2);assert.equal(await owner.dm.locator('#proof-scroll').evaluate(node=>node.scrollTop),0);}
    }finally{adapter?.dispose();await owner.close();}
  }
  const result={scope:'SYNTHETIC_ONLY',source,cases:3,assertions:29,extraOlderWindow:true,freshMissingRowRead:true,partialRefreshKeepsExactNativeContext:true,normalRefreshSameId:true,maximumWindowReads:2,restoredOffset:true,
    bodyFreeDiagnostics:true,clicks:0,modelCalls:0,productionDatabase:false};
  await writeFile(resolve('.local',source?'dm-clock-context-source-smoke.json':'dm-clock-context-built-smoke.json'),JSON.stringify(result,null,2));process.stdout.write(JSON.stringify(result)+'\n');
}finally{await server.close();}
