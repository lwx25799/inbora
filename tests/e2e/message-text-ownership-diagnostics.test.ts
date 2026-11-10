import {expect,test} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {captureObserved} from '../../src/adapters/observed-reader.js';
import {inspectMessageShare} from '../../src/adapters/message-share.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountObserved,observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

async function setup(){
  const root=privateTemp('text-ownership-diag-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  await mountObserved(owner,server.origin);const mapping=observedMapping(server.origin),at=Date.now()-1000;
  await owner.dm.route('https://PRIVATE.invalid/**',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jntkAAAAASUVORK5CYII=','base64')}));
  await owner.dm.evaluate(at=>{
    const chat=document.querySelector('#chat')!,first=chat.querySelector('.box')!;
    for(const box of chat.querySelectorAll('.box'))if(box!==first)box.remove();
    const row=first.querySelector('.message')!;row.innerHTML='<span class="text">PRIVATE_EXACT_TEXT</span><span><img width="16" height="16"></span>';
    row.querySelector('img')!.setAttribute('src','https://PRIVATE.invalid/PRIVATE_IMAGE.png');row.querySelector('img')!.setAttribute('alt','PRIVATE_LABEL');
    const native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
    native.serverId='77201';native.createdAt=new Date(at);native.type=7;native._parsedContent.text='PRIVATE_EXACT_TEXT';
  },at);
  const capture={mapping,channel:'dm' as const,index:0,evidenceId:'synthetic-text-ownership',peer:mapping.peers[0]!,dmWindow:true};
  const batch=await owner.dm.evaluate(captureObserved,capture),event=batch.events[0]!;
  return {owner,mapping,event,capture,close:async()=>{await owner.close();await server.close();}};
}

test('independent exact text proof is measured beside external media without classifying it as text',async()=>{
  const f=await setup();try{
    const before=await f.owner.dm.evaluate(()=>document.body.innerHTML),report=await f.owner.dm.evaluate(inspectMessageShare,{mapping:f.mapping,event:f.event,peer:f.mapping.peers[0]!});
    expect(report).toMatchObject({share:null,detected:false,diagnostic:{calibration:{text:{ownedTextCount:1,visibleTextCount:1,inlineImages:0,otherMedia:1,
      reconstructed:false,matchesNative:false,bodyReconstructed:true,bodyMatchesNative:true,mediaShapesTruncated:false,
      textPath:{steps:[{tag:'SPAN',childIndex:0}],reachedRow:true,truncated:false},
      mediaShapes:[{path:{steps:[{tag:'IMG',childIndex:0},{tag:'SPAN',childIndex:1}],reachedRow:true,truncated:false},
        textRelation:'AFTER',commonDepth:0,inRowRect:true,inTextRect:false,anchor:false,menu:false,dialog:false,ariaHidden:false,quote:false}]}}}});
    expect(f.event).toMatchObject({text:'[含媒体的消息，需人工查看]',contentType:'MIXED',observationIssue:'DM_CONTENT_UNVERIFIED'});
    expect(await f.owner.dm.evaluate(captureObserved,f.capture)).toMatchObject({events:[f.event]});
    expect(await f.owner.dm.evaluate(()=>document.body.innerHTML)).toBe(before);
    expect(JSON.stringify(report.diagnostic)).not.toMatch(/PRIVATE|77201|conv-a|https?:\/\//u);
  }finally{await f.close();}
});

test('a mismatched or nonunique text body never reports an exact independent match',async()=>{
  const f=await setup();try{
    await f.owner.dm.locator('.text').evaluate(node=>node.textContent='PRIVATE_CHANGED');
    let report=await f.owner.dm.evaluate(inspectMessageShare,{mapping:f.mapping,event:f.event,peer:f.mapping.peers[0]!});
    expect(report.diagnostic.calibration?.text).toMatchObject({bodyReconstructed:true,bodyMatchesNative:false});
    await f.owner.dm.locator('.message').evaluate(row=>row.append(row.querySelector('.text')!.cloneNode(true)));
    report=await f.owner.dm.evaluate(inspectMessageShare,{mapping:f.mapping,event:f.event,peer:f.mapping.peers[0]!});
    expect(report.diagnostic.calibration?.text).toMatchObject({bodyReconstructed:false,bodyMatchesNative:false,textPath:null});
    expect(report.share).toBeNull();expect(report.detected).toBe(false);
  }finally{await f.close();}
});

test('media ownership metadata is bounded to four nodes and six path steps without invoking page attribute getters',async()=>{
  const f=await setup();try{
    await f.owner.dm.evaluate(()=>{
      const row=document.querySelector('.message')!,image=row.querySelector('img')!;let group=image.parentElement!;
      for(let index=0;index<8;index++){const next=document.createElement('div');group.append(next);next.append(image);group=next;}
      group.setAttribute('role','menu');group.setAttribute('aria-hidden','true');
      for(let index=0;index<5;index++){const extra=image.cloneNode() as Element;row.append(extra);}
      for(const node of row.querySelectorAll('*'))Object.defineProperty(node,'getAttribute',{value(){throw Error('PRIVATE_GETTER_MUST_NOT_RUN');}});
    });
    const report=await f.owner.dm.evaluate(inspectMessageShare,{mapping:f.mapping,event:f.event,peer:f.mapping.peers[0]!}),shape=report.diagnostic.calibration?.text;
    expect(shape).toMatchObject({bodyReconstructed:true,bodyMatchesNative:true,otherMedia:6,mediaShapesTruncated:true});
    expect(shape?.mediaShapes).toHaveLength(4);expect(shape?.mediaShapes[0]).toMatchObject({path:{reachedRow:false,truncated:true},menu:true,ariaHidden:true});
    expect(shape?.mediaShapes.every(item=>item.path.steps.length<=6)).toBe(true);
    expect(JSON.stringify(report.diagnostic)).not.toMatch(/PRIVATE|77201|conv-a|https?:\/\//u);expect(report.share).toBeNull();expect(report.detected).toBe(false);
  }finally{await f.close();}
});
