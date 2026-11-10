import {expect,test} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {captureObserved} from '../../src/adapters/observed-reader.js';
import {captureDmReply} from '../../src/adapters/observed-dm-reply.js';
import {isStrong,type InboundEvent} from '../../src/core/contracts.js';
import {EventStore} from '../../src/storage/store.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountDmReply,dmReplyMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

const emoji='<img alt="[微笑]" src="/emoji.png" width="16" height="16">';
const cases=[
  {name:'unicode text',html:'hello 😊',native:'hello 😊',strong:true},
  {name:'inline emoji',html:'hello '+emoji+' tail',native:'hello [微笑] tail',strong:true},
  {name:'emoji only inside text',html:emoji,native:'[微笑]',strong:true},
  {name:'nested emoji and break',html:'hello <b>'+emoji+'</b><br>tail',native:'hello [微笑]\ntail',strong:true},
  {name:'mismatched label',html:'hello '+emoji,native:'hello [哭]',strong:false},
  {name:'missing label',html:'hello '+emoji.replace(' alt="[微笑]"',''),native:'hello [微笑]',strong:false},
  {name:'ordinary image label',html:'hello '+emoji.replace('[微笑]','ordinary attachment'),native:'hello ordinary attachment',strong:false},
  {name:'linked image',html:'hello <a href="/outside">'+emoji+'</a>',native:'hello [微笑]',strong:false},
  {name:'external attachment',html:'hello',native:'hello',extra:emoji,strong:false},
  {name:'true mixed media',html:'hello '+emoji,native:'hello [微笑]',extra:'<video width="16" height="16"></video>',strong:false},
  {name:'sticker with a coincidental text label',html:emoji,native:'[微笑]',nativeKind:90,strong:false},
] as const;

test.each(cases)('mapped native DM $name retains exact text only with complete inline proof',async spec=>{
  const root=privateTemp('dm-inline-emoji-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  try{
    await mountDmReply(owner,server.origin);const mapping=dmReplyMapping(server.origin),at=Date.now()-1000;
    await owner.dm.evaluate(({html,text,extra,at,nativeKind})=>{
      const chat=document.querySelector('#chat')!;const first=chat.querySelector('.box')!;
      for(const box of chat.querySelectorAll('.box'))if(box!==first)box.remove();
      const row=first.querySelector('.message')!;row.innerHTML='<span class="text"></span>'+extra;
      row.querySelector('.text')!.innerHTML=html;first.setAttribute('data-index','0');
      const native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
      native.serverId='88101';native.type=nativeKind;native.serverStatus=0;native.createdAt=new Date(at);native._parsedContent.text=text;
      document.querySelector('#dm-panel')!.setAttribute('data-e2e','im-dialog');
    },{html:spec.html,text:spec.native,extra:'extra'in spec?spec.extra:'',at,nativeKind:'nativeKind'in spec?spec.nativeKind:7});
    const input={mapping:mapping.observation,channel:'dm' as const,index:0,evidenceId:'synthetic-inline-emoji',peer:mapping.observation.peers[0]!,dmWindow:true};
    const batch=await owner.dm.evaluate(captureObserved,input),event=batch.events[0]!;
    expect(batch.events).toHaveLength(1);
    if(spec.strong){
      expect(event).toMatchObject({platformEventId:'88101',text:spec.native});
      expect(event.contentType).toBeUndefined();expect(event.observationIssue).toBeUndefined();expect(isStrong(event)).toBe(true);
      const replyInput:Parameters<typeof captureDmReply>[0]={mapping,event,action:'snapshot',text:null,token:null,before:null,editorShape:null};
      const frame=await owner.dm.evaluate(captureDmReply,replyInput);
      expect((frame.context[0] as unknown[])[2]).toBe(spec.native);expect(frame.media).toBeUndefined();
    }else{
      expect(event.observationIssue).toBe('DM_CONTENT_UNVERIFIED');expect(isStrong(event)).toBe(false);
      expect(event.text).toMatch(/^\[(?:含媒体的|图片或表情)消息，需人工查看\]$/u);
    }
    expect(await owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
  }finally{await owner.close();await server.close();}
});

test('an already stored media event keeps its native identity, payload and old binding when later inline text is proved',()=>{
  const root=privateTemp('dm-inline-binding-'),store=new EventStore(join(root,'poc.sqlite'),true);
  try{
    const strong:InboundEvent={accountId:'account_001',channel:'DIRECT_MESSAGE',platformEventId:'88102',actorId:'200',actorName:'Fixture peer',
      text:'hello [微笑]',occurredAt:'2026-11-09T12:00:00Z',videoId:null,commentId:null,conversationId:'conv-a',direction:'INCOMING',kind:'DM',evidenceId:'synthetic-inline-binding'};
    const weak={...strong,text:'[含媒体的消息，需人工查看]',contentType:'MIXED' as const,observationIssue:'DM_CONTENT_UNVERIFIED' as const};
    store.observe('DIRECT_MESSAGE','conv-a',[],'100','fixture','2026-11-09T11:00:00Z');
    store.observe('DIRECT_MESSAGE','conv-a',[weak],'100','fixture','2026-11-09T12:01:00Z');const before=store.events()[0]!;
    expect(store.observe('DIRECT_MESSAGE','conv-a',[strong],'100','fixture','2026-11-09T12:02:00Z')).toEqual([]);
    const after=store.events();expect(after).toHaveLength(1);expect(after[0]).toMatchObject({id:before.id,binding:before.binding,payload:before.payload,status:'MANUAL_REVIEW'});
    expect(store.db.prepare('SELECT count(*) n FROM source_collisions').get()).toEqual({n:1});
    expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{store.close();}
});

test('a strong native text event with a proved inline emoji must pass the same exact pre-send original gate without submitting',async()=>{
  const root=privateTemp('dm-inline-presend-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  try{
    await mountDmReply(owner,server.origin);const mapping=dmReplyMapping(server.origin),at=Date.now()-1000,text='hello [微笑] tail';
    await owner.dm.evaluate(({html,text,at})=>{
      const chat=document.querySelector('#chat')!,first=chat.querySelector('.box')!;
      for(const box of chat.querySelectorAll('.box'))if(box!==first)box.remove();
      const row=first.querySelector('.message')!;row.innerHTML='<span class="text">'+html+'</span>';first.setAttribute('data-index','0');
      const native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
      native.serverId='88103';native.type=7;native.serverStatus=0;native.createdAt=new Date(at);native._parsedContent.text=text;
    },{html:'hello '+emoji+' tail',text,at});
    const event:InboundEvent={accountId:'account_001',channel:'DIRECT_MESSAGE',platformEventId:'88103',actorId:'200',actorName:'Fixture peer',text,
      occurredAt:new Date(at).toISOString(),videoId:null,commentId:null,conversationId:'conv-a',direction:'INCOMING',kind:'DM',evidenceId:'synthetic-presend-inline'};
    const replyInput:Parameters<typeof captureDmReply>[0]={mapping,event,action:'snapshot',text:null,token:null,before:null,editorShape:null};
    const frame=await owner.dm.evaluate(captureDmReply,replyInput);
    expect((frame.context[0] as unknown[])[2]).toBe(text);expect(frame.media).toBeUndefined();
    expect(await owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
  }finally{await owner.close();await server.close();}
});
