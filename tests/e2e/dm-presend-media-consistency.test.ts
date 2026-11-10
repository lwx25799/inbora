import {expect,test} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {captureObserved} from '../../src/adapters/observed-reader.js';
import {captureDmReply} from '../../src/adapters/observed-dm-reply.js';
import {isStrong,type InboundEvent} from '../../src/core/contracts.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountDmReply,dmReplyMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

test('a formerly strong text original is blocked when its exact row gains visible external media',async()=>{
  const root=privateTemp('dm-presend-media-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  try{
    await mountDmReply(owner,server.origin);const mapping=dmReplyMapping(server.origin),at=Date.now()-1000,text='EXACT NATIVE TEXT';
    await owner.dm.evaluate(({at,text})=>{
      const chat=document.querySelector('#chat')!,first=chat.querySelector('.box')!;
      for(const box of chat.querySelectorAll('.box'))if(box!==first)box.remove();
      const row=first.querySelector('.message')!;row.innerHTML='<span class="text"></span>';row.querySelector('.text')!.textContent=text;
      first.setAttribute('data-index','0');
      const native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
      native.serverId='88951';native.type=7;native.serverStatus=0;native.createdAt=new Date(at);native._parsedContent.text=text;
    },{at,text});
    const event:InboundEvent={accountId:'account_001',channel:'DIRECT_MESSAGE',platformEventId:'88951',actorId:'200',actorName:'Fixture peer',text,
      occurredAt:new Date(at).toISOString(),videoId:null,commentId:null,conversationId:'conv-a',direction:'INCOMING',kind:'DM',evidenceId:'synthetic-presend-media'};
    const input:Parameters<typeof captureDmReply>[0]={mapping,event,action:'snapshot',text:null,token:null,before:null,editorShape:null};
    expect(isStrong(event)).toBe(true);
    expect(((await owner.dm.evaluate(captureDmReply,input)).context[0] as unknown[])[2]).toBe(text);
    await owner.dm.locator('.message').evaluate(row=>{
      const image=document.createElement('img');image.width=16;image.height=16;image.alt='external media';row.append(image);
    });
    const batch=await owner.dm.evaluate(captureObserved,{mapping:mapping.observation,channel:'dm' as const,index:0,evidenceId:'synthetic-after-media',
      peer:mapping.observation.peers[0]!,dmWindow:true});
    expect(batch.events).toHaveLength(1);expect(batch.events[0]?.observationIssue).toBe('DM_CONTENT_UNVERIFIED');
    expect(isStrong(batch.events[0]!)).toBe(false);
    await expect(owner.dm.evaluate(captureDmReply,input)).rejects.toThrow(/NATIVE_REPLY_(?:MESSAGE_TEXT_UNVERIFIED|ORIGINAL_CHANGED)/u);
    expect(await owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
  }finally{await owner.close();await server.close();}
});

test('an outgoing row with external media cannot prove the approved plain reply text',async()=>{
  const root=privateTemp('dm-proof-media-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  try{
    await mountDmReply(owner,server.origin);const mapping=dmReplyMapping(server.origin),at=Date.now()-1000;
    await owner.dm.evaluate(at=>{
      const chat=document.querySelector('#chat')!,first=chat.querySelector('.box')!;
      for(const box of chat.querySelectorAll('.box'))if(box!==first)box.remove();
      const row=first.querySelector('.message')!;row.innerHTML='<span class="text">INCOMING BODY</span>';
      const native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
      native.serverId='88961';native.type=7;native.serverStatus=0;native.createdAt=new Date(at);native._parsedContent.text='INCOMING BODY';
    },at);
    const event=(await owner.dm.evaluate(captureObserved,{mapping:mapping.observation,channel:'dm' as const,index:0,
      evidenceId:'synthetic-proof-media',peer:mapping.observation.peers[0]!,dmWindow:true})).events[0]!;
    expect(isStrong(event)).toBe(true);
    await owner.dm.evaluate(at=>{
      document.querySelector('.box')!.setAttribute('data-index','1');
      const box=document.createElement('div'),row=document.createElement('div');box.className='box from-me';box.setAttribute('data-index','0');row.className='message';
      row.innerHTML='<span class="text">APPROVED REPLY BODY</span>';
      Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:'88962',conversationId:'conv-a',sender:'100',type:7,
        serverStatus:0,createdAt:new Date(at+500),_parsedContent:{text:'APPROVED REPLY BODY'}}}}}});
      box.append(row);document.querySelector('#chat')!.append(box);
    },at);
    const input:Parameters<typeof captureDmReply>[0]={mapping,event,action:'proofs',text:null,token:null,before:null,editorShape:null};
    expect((await owner.dm.evaluate(captureDmReply,input)).proofs).toHaveLength(1);
    await owner.dm.locator('.box.from-me .message').evaluate(row=>{
      const image=document.createElement('img');image.width=16;image.height=16;row.append(image);
    });
    const frame=await owner.dm.evaluate(captureDmReply,input);
    expect(frame.proofs).toHaveLength(0);
    expect(await owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
  }finally{await owner.close();await server.close();}
});
