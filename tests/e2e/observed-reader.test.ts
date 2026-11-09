import { expect, test } from 'vitest';
import { join } from 'node:path';
import { BrowserProfileOwner } from '../../src/browser/profile-owner.js';
import { ObservedReader, captureObserved } from '../../src/adapters/observed-reader.js';
import { validateObservationMapping } from '../../src/config/site-mapping.js';
import { observedMapping as config, mountObserved as mount, mountVirtualizedConversations, mountCommentReply, reloadableCommentReply } from '../fixtures/observed-site.js';
import { fixtureServer } from '../fixtures/site.js';
import { database, privateTemp } from '../helpers.js';

test.each([false,true])('background comments reveal an offscreen list without discarding webpage input (human input: %s)',async humanInput=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mountCommentReply(owner,server.origin);
    await reloadableCommentReply(owner.notification,server.origin);
    await owner.notification.addInitScript(humanInput=>document.addEventListener('DOMContentLoaded',()=>{
      (document.querySelector('#comment-list') as HTMLElement).style.marginTop='818px';
      if(humanInput){const input=document.createElement('textarea');input.value='keep unsent webpage draft';input.style.cssText='position:fixed;top:0';document.body.append(input);}
    }),humanInput);
    const task=new ObservedReader(owner.notification,config(server.origin)).comments(0,true);
    if(humanInput){
      await expect(task).rejects.toThrow('OBSERVATION_EXISTING_HUMAN_INPUT');
      expect(await owner.notification.locator('textarea').inputValue()).toBe('keep unsent webpage draft');
      expect(await owner.notification.evaluate(()=>scrollY)).toBe(0);
    }else{
      expect((await task).events).toHaveLength(1);
      expect(await owner.notification.evaluate(()=>scrollY)).toBeGreaterThan(0);
    }
  }finally{await owner.close();await server.close();}
});

test('DM window scrolling stays in its exact native chat and preserves existing webpage input',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);
    await owner.dm.evaluate(()=>{
      const list=document.createElement('div');list.id='history-window';list.style.cssText='height:40px;overflow-y:auto;width:300px';
      for(const box of document.querySelectorAll('.box'))list.append(box);
      document.querySelector('#chat')!.append(list);
    });
    const reader=new ObservedReader(owner.dm,config(server.origin)),peer=config(server.origin).peers[0]!;
    const batch=await reader.dmWindow(peer,0);
    expect(batch.dmViewport).toMatchObject({top:0,viewport:40,minimum:0});
    expect(batch.events.length).toBeGreaterThan(0);expect(batch.events.length).toBeLessThan(4);
    expect(batch.events[0]!.platformEventId).toBe('1');
    await expect(reader.scrollDm({...peer,conversationId:'outside'},50)).rejects.toThrow('OBSERVATION_CONVERSATION_CHANGED');
    expect(await owner.dm.locator('#history-window').evaluate(node=>node.scrollTop)).toBe(0);
    await owner.dm.evaluate(()=>{const input=document.createElement('textarea');input.value='unsent human text';document.querySelector('#chat')!.append(input);});
    await expect(reader.scrollDm(peer,50)).rejects.toThrow('OBSERVATION_EXISTING_HUMAN_INPUT');
    expect(await owner.dm.locator('textarea').inputValue()).toBe('unsent human text');
    expect(await owner.dm.locator('#history-window').evaluate(node=>node.scrollTop)).toBe(0);
  }finally{await owner.close();await server.close();}
});

test('bounded read diagnostics report geometry without reading bodies, inputs or native identifiers',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mountCommentReply(owner,server.origin);await mount(owner,server.origin);
    await owner.notification.evaluate(()=>{
      document.querySelector('#root-comment')!.setAttribute('style','display:contents');
      document.querySelector('.body')!.textContent='PRIVATE-BODY-MUST-NOT-LEAVE';
      const input=document.createElement('input');input.value='PRIVATE-KEY-MUST-NOT-LEAVE';document.querySelector('#comment-list')!.append(input);
    });
    const diagnostic=await new ObservedReader(owner.notification,config(server.origin)).diagnostic('comments');
    expect(diagnostic).toMatchObject({source:'comments',containers:1,visibleContainers:1,roots:1,samples:[{displayContents:true,hasBox:false,bodies:1,visibleBodies:1}]});
    const dm=await new ObservedReader(owner.dm,config(server.origin)).diagnostic('dm');
    expect(dm).toMatchObject({source:'dm',visibleContainers:1,chatVisible:true,chatInViewport:true,backVisible:true,backInViewport:true,rows:1});
    const serialized=JSON.stringify([diagnostic,dm]);
    for(const forbidden of ['PRIVATE-BODY','PRIVATE-KEY','conv-a','peer-sec','controlled-1'])expect(serialized).not.toContain(forbidden);
    const wrong=config(server.origin);wrong.works[0]!.url=server.origin+'/video/999';
    await expect(new ObservedReader(owner.notification,wrong).diagnostic('comments')).rejects.toThrow('OBSERVATION_WORK_CHANGED');
    await owner.dm.evaluate(()=>{Object.getOwnPropertyDescriptor(document.querySelector('#self')!,'__reactFiber$fixture')!.value.return.memoizedProps.uid='outside';});
    await expect(new ObservedReader(owner.dm,config(server.origin)).diagnostic('dm')).rejects.toThrow('OBSERVATION_ACCOUNT_CHANGED');
  }finally{await owner.close();await server.close();}
});

test('failed DM diagnostics expose only bounded owned parsed field shapes without reading bodies or getters',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);await owner.dm.evaluate(()=>{
      const row=document.querySelector('.message')!,native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
      native._parsedContent={text:'PRIVATE_BODY_MUST_NOT_LEAVE',itemId:'1234567890123456789',link:'https://www.douyin.com/video/1234567890123456789',
        privateUrl:'https://private.invalid/SECRET',nested:{private:'PRIVATE_NESTED'}};
      Object.defineProperty(native._parsedContent,'notRead',{get(){throw Error('PRIVATE_GETTER_EXECUTED');},enumerable:true});
    });
    const report=await new ObservedReader(owner.dm,config(server.origin)).diagnostic('dm',0,config(server.origin).peers[0]!);
    expect(report.shareStage).toBe('VERIFIED');
    expect(report.messageSamples![0]).toMatchObject({nativeIdPresent:true,conversationMatches:true,senderKnown:true,
      parsedFields:expect.arrayContaining([{key:'itemId',type:'string',digitId:true,urlKind:'NONE'},
        {key:'link',type:'string',digitId:false,urlKind:'DOUYIN_VIDEO'},{key:'notRead',type:'accessor',digitId:false,urlKind:'NONE'}])});
    expect(report.messageSamples!.length).toBeLessThanOrEqual(6);
    for(const forbidden of ['PRIVATE_','1234567890123456789','private.invalid','conv-a','peer-sec'])expect(JSON.stringify(report)).not.toContain(forbidden);
  }finally{await owner.close();await server.close();}
});

test('failed DM parsed diagnostics stop at unverified native headers and row ownership',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);const mapping=config(server.origin),reader=new ObservedReader(owner.dm,mapping);
    const wrong=await reader.diagnostic('dm',0,{...mapping.peers[0]!,conversationId:'outside'});
    expect(wrong).toMatchObject({shareStage:'CONVERSATION_UNVERIFIED',messageSamples:[]});
    await owner.dm.evaluate(()=>{const native=Object.getOwnPropertyDescriptor(document.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message;
      native.conversationId='outside';native._parsedContent={secret:'PRIVATE_BODY_MUST_NOT_LEAVE'};});
    const report=await reader.diagnostic('dm',0,mapping.peers[0]!);
    expect(report.messageSamples![0]).toMatchObject({conversationMatches:false,parsedFields:[]});
    expect(JSON.stringify(report)).not.toContain('secret');expect(JSON.stringify(report)).not.toContain('PRIVATE');
  }finally{await owner.close();await server.close();}
});

test('failed DM parsed diagnostics cap messages and keys without treating absent content as a successful read',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);await owner.dm.evaluate(()=>{
      const row=document.querySelector('.message')!,native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
      native._parsedContent=Object.fromEntries(Array.from({length:50},(_,index)=>['field'+index,false]));
      const box=row.closest('.box')!;
      for(let index=0;index<10;index++){const clone=box.cloneNode(true) as Element,child=clone.querySelector('.message')!;
        Object.defineProperty(child,'__reactProps$fixture',{value:{children:{props:{message:{...native,serverId:String(300+index)}}}}});box.parentElement!.append(clone);}
    });
    const report=await new ObservedReader(owner.dm,config(server.origin)).diagnostic('dm',0,config(server.origin).peers[0]!);
    expect(report.messageSamples).toHaveLength(6);expect(report.messageSamples![0]!.parsedFields).toHaveLength(32);
    expect(report.messageSamples![0]!.parsedTruncated).toBe(true);
  }finally{await owner.close();await server.close();}
});

test('DM list diagnostic distinguishes missing title and native metadata using fixed bounded booleans',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);await owner.dm.evaluate(()=>{
      const row=document.querySelector('.conversation')!,title=row.querySelector('.title')!;
      title.textContent='PRIVATE_CONTACT_NAME';
      const empty=row.cloneNode(true) as Element;empty.querySelector('.title')!.textContent='';
      Object.defineProperty(empty,'__reactFiber$fixture',{value:{return:{memoizedProps:{conversation:{_toParticipantSecUserId:'PRIVATE_SEC'}}}}});
      row.parentElement!.append(empty);
      for(let index=0;index<8;index++)row.parentElement!.append(row.cloneNode(true));
      (document.querySelector('#chat') as HTMLElement).hidden=true;
    });
    const report=await new ObservedReader(owner.dm,config(server.origin)).diagnostic('dm');
    expect(report.conversationSamples!.slice(0,2)).toMatchObject([
      {titleCount:1,titleVisible:true,titleNonEmpty:true,nativeConversationPresent:true,securePeerPresent:true,metadataReadable:true},
      {titleCount:1,titleVisible:true,titleNonEmpty:false,nativeConversationPresent:false,securePeerPresent:true,metadataReadable:true},
    ]);
    expect(report.conversationSamples).toHaveLength(6);
    for(const value of ['PRIVATE_','conv-a','peer-sec'])expect(JSON.stringify(report)).not.toContain(value);
  }finally{await owner.close();await server.close();}
});

test('DM message diagnostic distinguishes a visible card from absent or empty mapped text without exposing content',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);await owner.dm.evaluate(()=>{
      const row=document.querySelector('.message')!;row.querySelector('.text')!.textContent='';
      const card=document.createElement('div');card.className='MessageItemShareAwemecontainer';card.textContent='PRIVATE_CARD_BODY';row.append(card);
      const nested=document.createElement('div');nested.className='message';nested.innerHTML='<span class="text">PRIVATE_NESTED_BODY</span><img src="/private-image">';row.append(nested);
    });
    const report=await new ObservedReader(owner.dm,config(server.origin)).diagnostic('dm',0,config(server.origin).peers[0]!);
    expect(report.messageSamples![0]).toMatchObject({textNodes:1,visibleTextNodes:1,nonEmptyTextNodes:0,visibleMediaNodes:0,visibleCardNodes:1});
    for(const value of ['PRIVATE_','private-image','conv-a','peer-sec'])expect(JSON.stringify(report)).not.toContain(value);
  }finally{await owner.close();await server.close();}
});

test.each(['inherited-data','getter','own-prototype-conflict'] as const)('DM parsed diagnostic respects safe descriptor ownership (%s)',async shape=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);await owner.dm.evaluate(shape=>{
      const native=Object.getOwnPropertyDescriptor(document.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message;
      const parsed={text:'PRIVATE_MESSAGE_BODY',itemId:'1234567890123456789'};delete native._parsedContent;
      const parent=Object.create(Object.getPrototypeOf(native));
      Object.defineProperty(parent,'_parsedContent',shape==='getter'?{get(){throw Error('PRIVATE_GETTER_RAN');},configurable:true}:{value:parsed,configurable:true});
      Object.setPrototypeOf(native,parent);
      if(shape==='own-prototype-conflict')Object.defineProperty(native,'_parsedContent',{value:{text:'PRIVATE_CONFLICT'},configurable:true});
    },shape);
    const report=await new ObservedReader(owner.dm,config(server.origin)).diagnostic('dm',0,config(server.origin).peers[0]!);
    const sample=report.messageSamples![0]!;
    if(shape==='inherited-data')expect(sample).toMatchObject({parsedPresent:true,parsedRejected:false,parsedFields:expect.arrayContaining([
      {key:'itemId',type:'string',digitId:true,urlKind:'NONE'},
    ])});
    else expect(sample).toMatchObject({parsedPresent:false,parsedRejected:true,parsedFields:[]});
    for(const value of ['PRIVATE_','1234567890123456789'])expect(JSON.stringify(report)).not.toContain(value);
  }finally{await owner.close();await server.close();}
});

test.each([false,true])('DM diagnostic samples the business window and prioritizes its missing content (window gap: %s)',async missing=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);await owner.dm.evaluate(missing=>{
      const first=document.querySelector('.box')!,native=Object.getOwnPropertyDescriptor(first.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message;
      const list=document.createElement('div');list.id='diagnostic-window';list.style.cssText='position:fixed;top:120px;left:10px;height:96px;width:300px;overflow-y:auto';
      for(let index=0;index<12;index++){
        const box=first.cloneNode(true) as HTMLElement,row=box.querySelector('.message') as HTMLElement;
        box.style.cssText='height:32px';row.style.cssText='height:24px';
        Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{...native,serverId:String(1000+index),type:800,serverStatus:0}}}}});
        if(index===0||missing&&index===4)row.replaceChildren();
        if(index===1)row.style.display='none';
        if(missing&&index===4)Object.assign(Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message,
          {type:1001,serverStatus:2,createdAt:new Date(NaN)});
        list.append(box);
      }
      for(const box of document.querySelectorAll('#chat > .box'))box.remove();
      document.querySelector('#chat')!.append(list);list.scrollTop=64;
    },missing);
    const mapping=config(server.origin),peer=mapping.peers[0]!,input={mapping,channel:'dm' as const,index:0,evidenceId:'fixture-window',peer,dmWindow:true};
    if(missing)await expect(owner.dm.evaluate(captureObserved,input)).rejects.toThrow('OBSERVATION_DM_CONTENT_DOM_NOT_READY');
    else expect((await owner.dm.evaluate(captureObserved,input)).events.map(event=>event.platformEventId)).toEqual(['1002','1003','1004']);
    const report=await new ObservedReader(owner.dm,mapping).diagnostic('dm',0,peer);
    expect(report.messageSamples![0]!.textNodes).toBe(missing?0:1);
    expect(report.messageSamples).toHaveLength(3);
    expect(report).toMatchObject({windowRows:3,contentMissingRows:missing?1:0});
    expect(report.messageSamples![0]).toMatchObject(missing
      ?{windowIndex:2,contentMissing:true,textNodes:0,nativeKind:1001,nativeStatus:2,timeValid:false}
      :{windowIndex:0,contentMissing:false,textNodes:1,nativeKind:800,nativeStatus:0,timeValid:true});
    expect(report.messageSamples!.map(row=>row.windowIndex).sort()).toEqual([0,1,2]);
    for(const value of ['controlled-1','1000','1002','conv-a','peer-sec'])expect(JSON.stringify(report)).not.toContain(value);
  }finally{await owner.close();await server.close();}
});

test('DM diagnostic rejects invalid native state values and never invokes state getters',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);await owner.dm.evaluate(()=>{
      const native=Object.getOwnPropertyDescriptor(document.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message;
      Object.assign(native,{type:-1,serverStatus:'PRIVATE_STATUS',createdAt:'PRIVATE_TIME'});
    });
    const reader=new ObservedReader(owner.dm,config(server.origin));
    expect((await reader.diagnostic('dm')).messageSamples![0]).toMatchObject({nativeKind:null,nativeStatus:null,timeValid:false});
    await owner.dm.evaluate(()=>{
      const native=Object.getOwnPropertyDescriptor(document.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message;
      const state=window as unknown as {stateGetterCalls:number};state.stateGetterCalls=0;
      Object.defineProperty(native,'type',{get(){state.stateGetterCalls++;throw Error('PRIVATE_GETTER_RAN');}});
    });
    const report=await reader.diagnostic('dm');expect(report.messageSamples![0]).toMatchObject({nativeKind:null,nativeStatus:null,parsedFields:[]});
    expect(await owner.dm.evaluate(()=>(window as unknown as {stateGetterCalls:number}).stateGetterCalls)).toBe(0);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_');
  }finally{await owner.close();await server.close();}
});

test('DM diagnostic uses the same unique native sender proof for an uncalibrated peer and exposes bounded share types',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);await owner.dm.evaluate(()=>{
      const native=Object.getOwnPropertyDescriptor(document.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message;
      native.type=8;native.serverStatus=0;Object.assign(native._parsedContent,{itemId:'1234567890123456789',aweType:800,awemeType:55});
    });
    const mapping=config(server.origin),peer={...mapping.peers[0]!,conversationId:mapping.peers[0]!.conversationId!,uid:null},reader=new ObservedReader(owner.dm,mapping);
    const report=await reader.diagnostic('dm',0,peer);
    expect(report.messageSamples![0]).toMatchObject({senderKnown:true,nativeKind:8,nativeStatus:0,timeValid:true,
      nativeShare:{aweType:800,awemeType:55,slides:null,itemIdPresent:true,route:'VIDEO'}});
    const input:Parameters<typeof captureObserved>[0]={mapping,channel:'dm',index:0,evidenceId:'fixture-unknown-peer',peer,dmWindow:true};
    const batch=await owner.dm.evaluate(captureObserved,input);
    expect(batch.bindings![0]!.uid).toBe('200');
    for(const secret of ['1234567890123456789','conv-a','peer-sec','controlled-1'])expect(JSON.stringify(report)).not.toContain(secret);
    for(const data of [{awemeType:68,is_slides:true,route:'NOTE'},{awemeType:55,is_slides:'false',route:'UNAVAILABLE'}]){
      await owner.dm.evaluate(data=>Object.assign(Object.getOwnPropertyDescriptor(document.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message._parsedContent,data),data);
      expect((await reader.diagnostic('dm',0,peer)).messageSamples![0]!.nativeShare).toMatchObject({route:data.route});
    }
  }finally{await owner.close();await server.close();}
});

test('DM kind77 diagnostic measures existing share fields without promoting a missing-content row',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);await owner.dm.evaluate(()=>{
      const row=document.querySelector('.message') as HTMLElement,native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
      row.style.minHeight='24px';row.replaceChildren();native.type=77;native.serverStatus=0;
      native._parsedContent={aweType:800,awemeType:68,is_slides:true,itemId:'1234567890123456789',image_count:3,index:0};
    });
    const mapping=config(server.origin),peer={...mapping.peers[0]!,conversationId:mapping.peers[0]!.conversationId!,uid:null};
    const report=await new ObservedReader(owner.dm,mapping).diagnostic('dm',0,peer);
    expect(report.messageSamples![0]).toMatchObject({nativeKind:77,contentMissing:true,senderKnown:true,
      nativeShare:{aweType:800,awemeType:68,slides:true,itemIdPresent:true,route:'NOTE'}});
    const input:Parameters<typeof captureObserved>[0]={mapping,channel:'dm',index:0,evidenceId:'fixture-kind77-measurement',peer,dmWindow:true};
    await expect(owner.dm.evaluate(captureObserved,input)).rejects.toThrow('OBSERVATION_DM_CONTENT_DOM_NOT_READY');
    for(const secret of ['1234567890123456789','conv-a','peer-sec'])expect(JSON.stringify(report)).not.toContain(secret);
  }finally{await owner.close();await server.close();}
});

test.each(['MULTIPLE','KNOWN_CONFLICT','GETTER'] as const)('DM diagnostic and business reject the same unproven native sender (%s)',async fault=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);await owner.dm.evaluate(fault=>{
      const state=window as unknown as {senderGetterCalls:number};state.senderGetterCalls=0;
      const native=Object.getOwnPropertyDescriptor(document.querySelectorAll('.message')[1]!,'__reactProps$fixture')!.value.children.props.message;
      if(fault==='MULTIPLE')native.sender='999';
      if(fault==='GETTER')Object.defineProperty(native,'sender',{get(){state.senderGetterCalls++;throw Error('PRIVATE_SENDER_GETTER');}});
    },fault);
    const mapping=config(server.origin),peer={...mapping.peers[0]!,conversationId:mapping.peers[0]!.conversationId!,uid:fault==='KNOWN_CONFLICT'?'999':null};
    const code=fault==='GETTER'?'RENDERED_ACCESSOR_UNSUPPORTED':'OBSERVATION_SENDER_UNVERIFIED';
    await expect(new ObservedReader(owner.dm,mapping).diagnostic('dm',0,peer)).rejects.toThrow(code);
    const input:Parameters<typeof captureObserved>[0]={mapping,channel:'dm',index:0,evidenceId:'fixture-sender-conflict',peer,dmWindow:true};
    await expect(owner.dm.evaluate(captureObserved,input)).rejects.toThrow(code);
    expect(await owner.dm.evaluate(()=>(window as unknown as {senderGetterCalls:number}).senderGetterCalls)).toBe(0);
  }finally{await owner.close();await server.close();}
});

test('bounded back diagnostics distinguish a child control, occlusion and offscreen geometry without leaking content or invoking handlers',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);
    await owner.dm.evaluate(()=>{
      const state=window as unknown as {backHandlers:number};state.backHandlers=0;
      const wrapper=document.createElement('div');wrapper.id='back';wrapper.className='PRIVATE-WRAPPER';
      wrapper.style.cssText='position:fixed;left:24px;top:24px;width:80px;height:40px;z-index:1000';
      wrapper.setAttribute('data-private','PRIVATE-ATTRIBUTE');
      const button=document.createElement('button');button.style.cssText='position:absolute;inset:0;width:80px;height:40px';
      button.innerHTML='<span style="pointer-events:none">PRIVATE-CONTROL-TEXT</span>';
      Object.defineProperty(button,'__reactProps$private',{value:{onClick:()=>state.backHandlers++,onMouseDown:()=>state.backHandlers++,
        onPointerDown:()=>state.backHandlers++,onMouseUp:()=>state.backHandlers++,privateValue:'PRIVATE-PROPS-VALUE'}});
      wrapper.append(button);
      for(let i=0;i<16;i++){const child=document.createElement('private-secret-tag');child.hidden=true;wrapper.append(child);}
      document.querySelector('#back')!.replaceWith(wrapper);
    });
    const reader=new ObservedReader(owner.dm,config(server.origin)),diagnostic=await reader.diagnostic('dm');
    expect(diagnostic.back).toMatchObject({count:1,centerHit:'DESCENDANT',centerIndex:1});
    expect(diagnostic.back!.nodes).toHaveLength(12);
    expect(diagnostic.back!.nodes![0]).toMatchObject({index:0,parentIndex:null,tag:'DIV',visible:true,inViewport:true,width:80,height:40,props:'NONE'});
    expect(diagnostic.back!.nodes![1]).toMatchObject({index:1,parentIndex:0,tag:'BUTTON',props:'DATA',
      handlers:{onClick:true,onMouseDown:true,onPointerDown:true,onMouseUp:true}});
    expect(diagnostic.back!.nodes![3]!.tag).toBe('OTHER');
    for(const forbidden of ['PRIVATE-WRAPPER','PRIVATE-ATTRIBUTE','PRIVATE-CONTROL-TEXT','PRIVATE-PROPS-VALUE','PRIVATE-SECRET-TAG','private-secret-tag','conv-a','peer-sec'])
      expect(JSON.stringify(diagnostic)).not.toContain(forbidden);
    await owner.dm.evaluate(()=>{
      const cover=document.createElement('div');cover.id='cover';cover.textContent='PRIVATE-OVERLAY';
      cover.style.cssText='position:fixed;left:24px;top:24px;width:80px;height:40px;z-index:2000';document.body.append(cover);
    });
    expect((await reader.diagnostic('dm')).back).toMatchObject({centerHit:'OUTSIDE',centerIndex:null});
    await owner.dm.evaluate(()=>{
      document.querySelector('#cover')!.remove();
      for(const child of document.querySelector('#back')!.querySelectorAll<HTMLElement>('*'))child.style.pointerEvents='none';
    });
    expect((await reader.diagnostic('dm')).back).toMatchObject({centerHit:'SELF',centerIndex:0});
    await owner.dm.evaluate(()=>(document.querySelector('#back') as HTMLElement).style.left='-5000px');
    expect((await reader.diagnostic('dm')).back).toMatchObject({centerHit:'OFFSCREEN',centerIndex:null});
    expect(await owner.dm.evaluate(()=>(window as unknown as {backHandlers:number}).backHandlers)).toBe(0);
  }finally{await owner.close();await server.close();}
});

test.each(['props','handler','multiple'])('back diagnostic rejects %s descriptors without invoking a getter and omits shapes for multiple mapped controls',async kind=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);
    await owner.dm.evaluate(kind=>{
      const state=window as unknown as {backGetters:number};state.backGetters=0;
      const back=document.querySelector('#back')!,props={};
      if(kind==='props')Object.defineProperty(back,'__reactProps$private',{get(){state.backGetters++;throw new Error('PRIVATE-GETTER');}});
      else if(kind==='handler'){
        Object.defineProperty(props,'onClick',{get(){state.backGetters++;throw new Error('PRIVATE-HANDLER');}});
        Object.defineProperty(back,'__reactProps$private',{value:props});
      }else{
        Object.defineProperty(back,'__reactProps$first',{value:{onClick:()=>state.backGetters++}});
        Object.defineProperty(back,'__reactProps$second',{value:{onClick:()=>state.backGetters++}});
      }
    },kind);
    const reader=new ObservedReader(owner.dm,config(server.origin));
    expect((await reader.diagnostic('dm')).back!.nodes![0]).toMatchObject({props:'REJECTED',
      handlers:{onClick:false,onMouseDown:false,onPointerDown:false,onMouseUp:false}});
    expect(await owner.dm.evaluate(()=>(window as unknown as {backGetters:number}).backGetters)).toBe(0);
    await owner.dm.evaluate(()=>document.querySelector('#chat')!.append(document.querySelector('#back')!.cloneNode(true)));
    expect((await reader.diagnostic('dm')).back).toEqual({count:2});
    expect(await owner.dm.evaluate(()=>(window as unknown as {backGetters:number}).backGetters)).toBe(0);
  }finally{await owner.close();await server.close();}
});

test('conversation discovery waits for native back transition before returning or reopening the same chat',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);
    await owner.dm.evaluate(()=>{
      const chat=document.querySelector('#chat') as HTMLElement;
      const state=window as unknown as {backs:number;opens:number};state.backs=0;state.opens=0;
      document.querySelector('#back')!.addEventListener('click',()=>{state.backs++;setTimeout(()=>{chat.hidden=true;},180);});
      document.querySelector('.conversation')!.addEventListener('click',()=>{state.opens++;chat.hidden=false;});
    });
    const reader=new ObservedReader(owner.dm,config(server.origin)),found=await reader.conversations();
    expect(await owner.dm.locator('#chat').isVisible()).toBe(false);
    expect(found.peers).toHaveLength(1);
    const batch=await reader.dm(0,found.peers![0]);
    expect(batch.events.map(e=>e.platformEventId)).toEqual(['1','2','3','4','5']);
    expect(batch.events[4]).toMatchObject({platformEventId:'5',contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'});
    await new Promise(r=>setTimeout(r,220));
    expect(await owner.dm.locator('#chat').isVisible()).toBe(true);
    expect(await owner.dm.evaluate(()=>({backs:(window as unknown as {backs:number}).backs,opens:(window as unknown as {opens:number}).opens}))).toEqual({backs:1,opens:1});
  }finally{await owner.close();await server.close();}
});

test('native-bound conversation title may settle after metadata without selecting another row',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);
    await owner.dm.evaluate(()=>{
      (document.querySelector('#chat') as HTMLElement).hidden=true;
      const title=document.querySelector('.conversation .title')!,row=document.querySelector('.conversation')!;
      title.textContent='Loading rendered display name';
      (window as unknown as {opened:number}).opened=0;
      row.addEventListener('click',()=>{(window as unknown as {opened:number}).opened++;(document.querySelector('#chat') as HTMLElement).hidden=false;});
      setTimeout(()=>title.textContent='Fixture peer',200);
    });
    expect((await new ObservedReader(owner.dm,config(server.origin)).dm(0)).events).toHaveLength(5);
    expect(await owner.dm.evaluate(()=>(window as unknown as {opened:number}).opened)).toBe(1);
  }finally{await owner.close();await server.close();}
});

test.each([false,true])('a virtualized permitted conversation is found beyond the first viewport (same title: %s)',async sameTitle=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);await mountVirtualizedConversations(owner.dm,sameTitle);
    const mapping=config(server.origin);
    Object.assign(mapping.selectors,{conversationList:'#conversation-list'});
    const batch=await owner.actor.run(()=>new ObservedReader(owner.dm,mapping).dm(0));
    expect(batch.events.map(e=>e.platformEventId)).toEqual(['1','2','3','4','5']);
    expect(batch.events[4]).toMatchObject({platformEventId:'5',contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'});
    expect(await owner.dm.evaluate(()=>(window as unknown as {opened:number}).opened)).toBe(1);
    expect(await owner.dm.evaluate(()=>(window as unknown as {outsideOpened:number}).outsideOpened)).toBe(0);
    expect(await owner.dm.evaluate(()=>(window as unknown as {listScrolls:number}).listScrolls)).toBeGreaterThan(0);
  }finally{await owner.close();await server.close();}
});

test('duplicate native conversations remain unselected after scrolling',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);await mountVirtualizedConversations(owner.dm);
    await owner.dm.evaluate(()=>document.querySelector('#conversation-list')!.addEventListener('scroll',()=>{
      const target=document.querySelector('.conversation')!;
      const native=Object.getOwnPropertyDescriptor(target,'__reactFiber$fixture')!.value;
      if(native.return.memoizedProps.conversation.id!=='conv-a')return;
      const copy=target.cloneNode(true);
      Object.defineProperty(copy,'__reactFiber$fixture',{value:native});target.parentElement!.append(copy);
    }));
    const mapping=config(server.origin);Object.assign(mapping.selectors,{conversationList:'#conversation-list'});
    await expect(new ObservedReader(owner.dm,mapping).dm(0)).rejects.toThrow('OBSERVATION_CONVERSATION_NOT_UNIQUE');
    expect(await owner.dm.evaluate(()=>(window as unknown as {opened:number}).opened)).toBe(0);
  }finally{await owner.close();await server.close();}
});

test('account change during a list scroll cannot select a conversation',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await mount(owner,server.origin);await mountVirtualizedConversations(owner.dm);
    await owner.dm.evaluate(()=>document.querySelector('#conversation-list')!.addEventListener('scroll',()=>{
      Object.getOwnPropertyDescriptor(document.querySelector('#self')!,'__reactFiber$fixture')!.value.return.memoizedProps.uid='outside';
    }));
    const mapping=config(server.origin);mapping.selectors.conversationList='#conversation-list';
    await expect(new ObservedReader(owner.dm,mapping).dm(0)).rejects.toThrow('OBSERVATION_ACCOUNT_CHANGED');
    expect(await owner.dm.evaluate(()=>(window as unknown as {opened:number}).opened)).toBe(0);
    expect(await owner.dm.evaluate(()=>(window as unknown as {outsideOpened:number}).outsideOpened)).toBe(0);
  }finally{await owner.close();await server.close();}
});

test('calibrated rendered reader preserves text and media identities, excludes outgoing tasks and blocks partial data', async () => {
  const server = await fixtureServer(), owner = await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  const store = database();
  try {
    await mount(owner,server.origin); const mapping = config(server.origin), reader = new ObservedReader(owner.dm,mapping);
    const batch = await owner.actor.run(()=>reader.dm(0));
    expect(batch.events.map(e=>e.platformEventId)).toEqual(['1','2','3','4','5']);
    expect(batch.unsupported).toBe(1);
    expect(batch.events[4]).toMatchObject({text:'[图片或表情消息，需人工查看]',contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'});
    store.observe('DIRECT_MESSAGE','conv-a',[],'100','fixture');
    for(let n=0;n<5;n++) store.observe('DIRECT_MESSAGE','conv-a',batch.events,'100','fixture');
    expect(store.events()).toHaveLength(4);
    expect(store.events().filter(e=>e.status==='AWAITING_DRAFT').map(e=>e.payload.platformEventId)).toEqual(['1','2','3']);
    expect(store.events().find(e=>e.payload.platformEventId==='5')).toMatchObject({status:'MANUAL_REVIEW',payload:{contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'}});
    expect(store.events().every(e=>e.payload.discovery==='DIRECT_MESSAGE')).toBe(true);
    expect(store.events().some(e=>e.payload.platformEventId==='4')).toBe(false);
    await owner.dm.locator('.message').first().evaluate(row=>{
      const p=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value;
      Object.defineProperty(p.children.props.message,'createdAt',{get(){ throw new Error('getter must never execute'); }});
    });
    await expect(reader.dm(0)).rejects.toThrow('RENDERED_ACCESSOR_UNSUPPORTED');
    expect(store.db.prepare('SELECT id FROM send_intents').all()).toEqual([]);
  } finally {store.close();await owner.close();await server.close();}
});
test('rendered metadata cannot override a conflicting conversation or direction', async () => {
  const server = await fixtureServer(), owner = await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try {
    await mount(owner,server.origin); const reader=new ObservedReader(owner.dm,config(server.origin));
    await owner.dm.locator('.message').first().evaluate(row=>{
      Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message.conversationId='conv-other';
    });
    await expect(reader.dm(0)).rejects.toThrow('OBSERVATION_MESSAGE_CONVERSATION_CONFLICT');
    await owner.dm.locator('.message').first().evaluate(row=>{
      const m=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
      m.conversationId='conv-a';m.sender='100';
    });
    await expect(reader.dm(0)).rejects.toThrow('OBSERVATION_DIRECTION_CONFLICT');
  } finally {await owner.close();await server.close();}
});
test('same-title unpermitted conversation is blocked before opening, not just before persistence',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try {
    await mount(owner,server.origin);
    await owner.dm.evaluate(()=>{
      (document.querySelector('#chat') as HTMLElement).hidden=true;
      const row=document.querySelector('.conversation')!;
      Object.getOwnPropertyDescriptor(row,'__reactFiber$fixture')!.value.return.memoizedProps.conversation.id='outside';
      (window as unknown as {opened:number}).opened=0;
      row.addEventListener('mousedown',()=>{
        (window as unknown as {opened:number}).opened++;
        (document.querySelector('#chat') as HTMLElement).hidden=false;
        Object.getOwnPropertyDescriptor(document.querySelector('#header')!,'__reactProps$fixture')!.value.children.props.conversation.id='outside';
      });
    });
    await new ObservedReader(owner.dm,config(server.origin)).dm(0).catch(()=>undefined);
    expect(await owner.dm.evaluate(()=>(window as unknown as {opened:number}).opened)).toBe(0);
  } finally {await owner.close();await server.close();}
});
test('hidden messages are excluded, missing visible content waits, and conflicting conversation aliases fail closed',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try {
    await mount(owner,server.origin);const reader=new ObservedReader(owner.dm,config(server.origin));
    await owner.dm.locator('.message').nth(0).evaluate(row=>(row as HTMLElement).hidden=true);
    expect((await reader.dm(0)).events.map(e=>e.platformEventId)).toEqual(['2','3','4','5']);
    await owner.dm.locator('.message .text').nth(1).evaluate(text=>(text as HTMLElement).style.visibility='hidden');
    await expect(reader.dm(0)).rejects.toThrow('OBSERVATION_DM_CONTENT_DOM_NOT_READY');
    await owner.dm.locator('#header').evaluate(header=>{
      Object.getOwnPropertyDescriptor(header,'__reactProps$fixture')!.value.children.props.conversation.conversationId='different';
    });
    await expect(reader.dm(0)).rejects.toThrow('OBSERVATION_CONVERSATION_ID_CONFLICT');
  } finally {await owner.close();await server.close();}
});
test('two different rendered conversation identity aliases are rejected',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try {
    await mount(owner,server.origin);
    await owner.dm.locator('#header').evaluate(header=>{
      Object.getOwnPropertyDescriptor(header,'__reactProps$fixture')!.value.children.props.conversation.conversationId='conv-a';
      Object.getOwnPropertyDescriptor(header,'__reactProps$fixture')!.value.children.props.conversation.id='outside';
    });
    await expect(new ObservedReader(owner.dm,config(server.origin)).dm(0)).rejects.toThrow('OBSERVATION_CONVERSATION_ID_CONFLICT');
  } finally {await owner.close();await server.close();}
});
test('a valid active chat remains readable when the covered conversation list is hidden',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try {
    await mount(owner,server.origin);owner.dm.setDefaultTimeout(300);
    await owner.dm.locator('.conversation').evaluate(row=>(row as HTMLElement).hidden=true);
    expect((await new ObservedReader(owner.dm,config(server.origin)).dm(0)).events).toHaveLength(5);
  } finally {await owner.close();await server.close();}
});
test('the full bounded visible window includes a twenty-first new inbound message',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  const store=database();
  try {
    await mount(owner,server.origin);
    await owner.dm.evaluate(()=>{
      for(let id=6;id<=21;id++){
        const box=document.createElement('div');box.className='box';
        const row=document.createElement('div');row.className='message';
        const text=document.createElement('span');text.className='text';text.textContent=`tail-${id}`;row.append(text);box.append(row);
        Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:String(id),
          conversationId:'conv-a',sender:'200',createdAt:new Date('2026-11-05T00:00:00Z'),_parsedContent:{text:text.textContent}}}}}});
        document.querySelector('#chat')!.append(box);
      }
    });
    const reader=new ObservedReader(owner.dm,config(server.origin));const batch=await reader.dm(0);
    expect(batch.events.map(e=>e.platformEventId)).toContain('21');
    expect(batch.events).toHaveLength(21);
    expect(batch.events.find(event=>event.platformEventId==='5')).toMatchObject({contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'});
    store.observe('DIRECT_MESSAGE','conv-a',[],'100','fixture');
    store.observe('DIRECT_MESSAGE','conv-a',batch.events,'100','fixture');
    expect(store.events()).toHaveLength(20);
    expect(store.events().find(event=>event.payload.platformEventId==='5')?.status).toBe('MANUAL_REVIEW');
    expect(store.events().filter(event=>event.payload.platformEventId!=='5').every(event=>event.status==='AWAITING_DRAFT')).toBe(true);
    expect(store.events().some(event=>event.payload.platformEventId==='4')).toBe(false);
    expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
  } finally {store.close();await owner.close();await server.close();}
});
test('conversation identity changed in document mousedown cannot open an outside peer',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try {
    await mount(owner,server.origin);
    await owner.dm.evaluate(()=>{
      (document.querySelector('#chat') as HTMLElement).hidden=true;
      (window as unknown as {outsideOpened:number}).outsideOpened=0;
      document.addEventListener('mousedown',()=>{
        const row=document.querySelector('.conversation')!;
        Object.getOwnPropertyDescriptor(row,'__reactFiber$fixture')!.value.return.memoizedProps.conversation.id='outside';
      },true);
      document.querySelector('.conversation')!.addEventListener('mousedown',()=>{
        (window as unknown as {outsideOpened:number}).outsideOpened++;
        (document.querySelector('#chat') as HTMLElement).hidden=false;
        Object.getOwnPropertyDescriptor(document.querySelector('#header')!,'__reactProps$fixture')!.value.children.props.conversation.id='outside';
      });
    });
    const mapping=config(server.origin);mapping.selectors.conversationSelectEvent='mousedown';
    await expect(new ObservedReader(owner.dm,mapping).dm(0)).rejects.toThrow('OBSERVATION_ROW_SELECTION_BLOCKED');
    expect(await owner.dm.evaluate(()=>(window as unknown as {outsideOpened:number}).outsideOpened)).toBe(0);
  } finally {await owner.close();await server.close();}
});
test('work discovery requires exact work, author, tooltip ID and visible text', async () => {
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try {
    owner.notification.setDefaultTimeout(80);
    owner.notification.setDefaultNavigationTimeout(5000);
    const url=server.origin+'/video/10';
    await owner.notification.route(url,route=>route.fulfill({contentType:'text/html',body:`<a id="self" style="visibility:hidden">Self</a>
      <section id="comment-list" style="min-height:24px"><div class="comment"><a class="author" href="/user/peer-sec">Fixture peer</a>
      <div class="tooltip" id="tooltip_50"><span class="body">one comment</span></div></div></section>`}));
    await owner.notification.addInitScript(() => {
      document.addEventListener('DOMContentLoaded',()=>{
        setTimeout(()=>{
          const self=document.querySelector('#self') as HTMLElement;
          Object.defineProperty(self,'__reactFiber$fixture',{value:{return:{memoizedProps:{uid:'100',secUid:'self-sec'}}}});
          self.style.visibility='visible';
        },300);
        const delayed=document.querySelector('.comment')!;
        Object.defineProperty(delayed,'__reactFiber$fixture',{value:{return:{memoizedProps:{
          awemeInfo:{awemeId:'10'},userInfo:{uid:'100'},commentInfo:{cid:'50',text:'one comment',createTime:1793836800,
            user:{uid:'200',secUid:'peer-sec'}}}}}});
        delayed.remove();setTimeout(()=>document.querySelector('#comment-list')!.append(delayed),1000);
      });
    });
    const reader=new ObservedReader(owner.notification,config(server.origin));
    const batch=await reader.comments(0);
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({platformEventId:'50',videoId:'10',commentId:'50',actorId:'200',discovery:'ALLOWED_WORK'});
    await owner.notification.locator('.body').evaluate(e=>e.textContent='changed visible text');
    const changed=await owner.notification.evaluate(captureObserved,
      {mapping:config(server.origin),channel:'comments' as const,index:0,evidenceId:'fixture'});
    expect(changed.events[0]).toMatchObject({text:'one comment',observationIssue:'COMMENT_TEXT_UNVERIFIED'});
    expect(changed.unsupported).toBe(1);
    const outside=config(server.origin);outside.works[0]!.url='https://example.com/video/10';
    expect(()=>validateObservationMapping(outside,false)).toThrow('UNSAFE_OBSERVATION_URL');
  } finally {await owner.close();await server.close();}
});
test('only an explicitly mapped empty comment state permits a successful empty work observation',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);
  try{
    await owner.notification.route(server.origin+'/video/10',route=>route.fulfill({contentType:'text/html',
      body:'<a id="self">Self</a><section id="comment-list"><div id="empty-comments">No comments</div></section>'}));
    await owner.notification.addInitScript(()=>document.addEventListener('DOMContentLoaded',()=>{
      Object.defineProperty(document.querySelector('#self')!,'__reactFiber$fixture',{value:{return:{memoizedProps:{uid:'100',secUid:'self-sec'}}}});
    }));
    const batch=await new ObservedReader(owner.notification,config(server.origin)).comments(0);
    expect(batch.loaded).toBe(0);expect(batch.events).toEqual([]);
    const unmapped=config(server.origin);unmapped.selectors.commentEmpty=null;
    await expect(owner.notification.evaluate(captureObserved,{mapping:unmapped,channel:'comments' as const,index:0,evidenceId:'fixture'}))
      .rejects.toThrow('OBSERVATION_COMMENT_ROOTS_DOM_NOT_READY');
    await owner.notification.locator('#empty-comments').evaluate(node=>node.remove());
    await expect(owner.notification.evaluate(captureObserved,{mapping:config(server.origin),channel:'comments' as const,index:0,evidenceId:'fixture'}))
      .rejects.toThrow('OBSERVATION_COMMENT_ROOTS_DOM_NOT_READY');
  }finally{await owner.close();await server.close();}
});
