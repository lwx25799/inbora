import {expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {ObservedDmReply,captureDmReply,type DmReadbackDiagnostic} from '../../src/adapters/observed-dm-reply.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountDmReply,dmReplyMapping} from '../fixtures/observed-site.js';
import {database,privateTemp} from '../helpers.js';

async function setup(mode:string){
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp('dm-clock-context-window-'),'profile'),true),store=database();
  await mountDmReply(owner,server.origin);const mapping=dmReplyMapping(server.origin),text='synthetic unique historical context reply',boundary=new Date().toISOString();
  await owner.dm.evaluate(()=>{for(const row of document.querySelectorAll('.message')){
    const native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
    native.createdAt=new Date(Date.UTC(2026,10,5,0,0,Number(native.serverId)-1));
  }});
  const event=(await new ObservedReader(owner.dm,mapping.observation).dm(0)).events.find(item=>item.platformEventId==='3')!;
  if(mode==='DEFERRED_CONTEXT')await owner.dm.evaluate(()=>{
    const row=document.querySelectorAll<HTMLElement>('.message')[1]!,native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
    native.type=110;native._parsedContent={};row.replaceChildren();row.style.minHeight='20px';
  });
  const prior=new ObservedDmReply(owner.dm,mapping,750),approved=await prior.inspect(event);prior.dispose();
  await owner.dm.addInitScript(({mode})=>document.addEventListener('DOMContentLoaded',()=>{
    const chat=document.querySelector('#chat')!;
    const load=Number(sessionStorage.getItem('proof-loads')??'0')+1;sessionStorage.setItem('proof-loads',String(load));
    document.querySelector('#native-editor')!.textContent='';
    for(const row of chat.querySelectorAll('.message')){
      const native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
      if(Number(native.serverId)<=5)native.createdAt=new Date(Date.UTC(2026,10,5,0,0,Number(native.serverId)-1));
    }
    const fixture={create(id:string,body:string,at:string):HTMLElement{
      const box=document.createElement('div'),row=document.createElement('div'),text=document.createElement('span');box.className='box';box.dataset.index='9';
      row.className='message';text.className='text';text.textContent=body;row.append(text);box.append(row);
      Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:id,conversationId:'conv-a',sender:'200',
        createdAt:new Date(at),serverStatus:0,type:7,_parsedContent:{text:body}}}}}});return box;
    }};
    if(mode.startsWith('EXTRA_')){
      const at=mode==='EXTRA_NEW'?'2026-11-05T00:00:03.000Z':mode==='EXTRA_SAME'?'2026-11-05T00:00:02.000Z':'2026-11-04T23:59:00.000Z';
      const extra=fixture.create('99','older boundary text',at);
      if(mode==='EXTRA_SUFFIX')chat.append(extra);else if(mode==='EXTRA_MIDDLE')chat.querySelectorAll('.box')[2]!.before(extra);else chat.prepend(extra);
    }
    if(mode.startsWith('MISSING')){
      const viewport=document.createElement('div');viewport.id='synthetic-proof-scroll';viewport.style.cssText='height:180px;width:320px;overflow:auto';
      chat.insertBefore(viewport,document.querySelector('#native-controls'));const boxes=Array.from(chat.querySelectorAll<HTMLElement>('.box'));
      for(const box of boxes){box.style.height='20px';viewport.append(box);}
      boxes[0]!.remove();const space=document.createElement('div');space.style.height='600px';viewport.append(space);
      viewport.addEventListener('scroll',()=>{
        if(mode!=='MISSING_FOREVER'&&!Array.from(viewport.querySelectorAll('.message')).some(row=>
          Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message.serverId==='1'))
          viewport.prepend(fixture.create('1','controlled-1','2026-11-05T00:00:00.000Z'));
        if(mode==='MISSING_CHANGED'){
          const row=viewport.querySelectorAll('.message')[1]!,native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
          native._parsedContent.text='changed retained body';row.querySelector('.text')!.textContent=native._parsedContent.text;
        }
        if(mode==='MISSING_NEW'&&!viewport.querySelector('[data-extra]')){
          const extra=fixture.create('98','new incoming during proof','2026-11-05T00:00:04.500Z');extra.dataset.extra='true';viewport.append(extra);
        }
        if(mode==='MISSING_HUMAN')document.querySelector('#native-editor')!.textContent='actual webpage human draft';
        if(mode==='MISSING_SCOPE')Object.getOwnPropertyDescriptor(document.querySelector('#header')!,'__reactProps$fixture')!.value.children.props.conversation.id='outside';
      });
    }
    const rows=Array.from(chat.querySelectorAll('.message')),row=rows.find(row=>Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message.serverId==='2')!,
      native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
    if(mode==='DEFERRED_CONTEXT'){native.type=110;native._parsedContent={};row.replaceChildren();(row as HTMLElement).style.minHeight='20px';}
    if(mode==='CHANGED'){native._parsedContent.text='changed native historical full text';row.querySelector('.text')!.textContent=native._parsedContent.text;}
    if(mode==='STATUS')native.serverStatus=1;if(mode==='REORDERED')chat.append(row.closest('.box')!);
    const outgoing=rows.find(row=>Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message.serverId==='888')!,
      sent=Object.getOwnPropertyDescriptor(outgoing,'__reactProps$fixture')!.value.children.props.message;
    if(mode==='OLD')sent.createdAt=new Date(sent.createdAt.getTime()-1052);
    if(mode==='PENDING')sent.serverStatus=1;
    if(load>1&&mode==='REFRESH_DIFFERENT_ID')sent.serverId='889';
    if(load>1&&mode==='REFRESH_PENDING')sent.serverStatus=1;
    if(mode==='DUPLICATE'){
      const box=outgoing.closest('.box')!.cloneNode(true) as HTMLElement;box.dataset.index='9';Object.defineProperty(box.querySelector('.message')!,'__reactProps$fixture',
        {value:{children:{props:{message:{...sent,serverId:'889'}}}}});chat.append(box);
    }
  }),{mode});
  await owner.dm.evaluate(({text,boundary})=>sessionStorage.setItem('native-receipt',JSON.stringify({id:'888',text,createdAt:new Date(Date.parse(boundary)-949).toISOString(),clicks:0})),{text,boundary});
  await owner.dm.reload({waitUntil:'domcontentloaded'});
  const reports:DmReadbackDiagnostic[]=[],abort=new AbortController(),adapter=new ObservedDmReply(owner.dm,mapping,750,{readonlySignal:abort.signal,
    onReadbackDiagnostic:report=>{reports.push(report);if(mode==='CALLBACK_THROW')throw Error('PRIVATE_CALLBACK_FAILURE');}});
  return {server,owner,store,mapping,event,text,boundary,approved,adapter,reports,abort,close:async()=>{adapter.dispose();store.close();await owner.close();await server.close();}};
}

test.each(['EXTRA_PREFIX','EXTRA_SUFFIX','MISSING','CALLBACK_THROW','DEFERRED_CONTEXT'])('a fresh exact approved context hash can verify a -949ms native reply with %s older boundary rendering',async mode=>{
  const f=await setup(mode);try{
    const prepare=vi.spyOn(f.adapter,'prepare'),click=vi.spyOn(f.adapter,'clickOnce');
    const proof=await f.owner.actor.run(()=>f.adapter.verifyExisting(f.event,f.text,f.boundary,f.approved.contextDigest)).catch(error=>{
      if(mode==='DEFERRED_CONTEXT')expect(f.reports).toContainEqual(expect.objectContaining({stage:'RESELECT',code:'OBSERVATION_DM_CONTENT_DOM_NOT_READY'}));throw error;
    });
    expect(proof).toMatchObject({id:'888',text:f.text,pending:false,clockSkew:{boundary:f.boundary,baselineContextDigest:f.approved.contextDigest,
      remainingContextDigest:f.approved.contextDigest,refreshedId:'888'}});
    expect(prepare).not.toHaveBeenCalled();expect(click).not.toHaveBeenCalled();
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    expect(f.store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:0}]);
    expect(Math.max(...f.reports.map(report=>report.windowReads))).toBeLessThanOrEqual(2);
    if(mode==='MISSING'){
      expect(Math.max(...f.reports.map(report=>report.windowReads))).toBe(2);
      expect(await f.owner.dm.locator('#synthetic-proof-scroll').evaluate(node=>node.scrollTop)).toBe(0);
    }
    expect(f.reports.some(report=>report.stage==='FIRST_POLL'&&report.contextMatches)).toBe(true);
    expect(f.reports.some(report=>report.stage==='REFRESH_POLL'&&report.contextMatches)).toBe(true);
    expect(JSON.stringify(f.reports)).not.toMatch(/synthetic unique|controlled-|conv-a|888|949|https?:/u);
  }finally{vi.restoreAllMocks();await f.close();}
});

test.each(['EXTRA_NEW','EXTRA_SAME','EXTRA_MIDDLE','CHANGED','STATUS','REORDERED','OLD','PENDING','MISSING_FOREVER','MISSING_CHANGED','MISSING_NEW','REFRESH_DIFFERENT_ID','REFRESH_PENDING','UNBOUND_HASH'])
  ('current native context cannot discard or invent evidence (%s)',async mode=>{
  const f=await setup(mode);try{
    expect(await f.owner.actor.run(()=>f.adapter.verifyExisting(f.event,f.text,f.boundary,mode==='UNBOUND_HASH'?'0'.repeat(64):f.approved.contextDigest))).toBeNull();
    expect(Math.max(...f.reports.map(report=>report.windowReads))).toBeLessThanOrEqual(2);
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{await f.close();}
});

test.each(['DUPLICATE','MISSING_HUMAN','MISSING_SCOPE','CANCEL_BEFORE','CANCEL_DURING'])('proof-only recovery stops safely on %s',async mode=>{
  const f=await setup(mode==='CANCEL_DURING'?'MISSING':mode);try{
    if(mode==='CANCEL_BEFORE')f.abort.abort();
    const scroll=ObservedReader.prototype.scrollDm;
    if(mode==='CANCEL_DURING')vi.spyOn(ObservedReader.prototype,'scrollDm').mockImplementation(async function(this:ObservedReader,peer,top){await scroll.call(this,peer,top);f.abort.abort();});
    await expect(f.owner.actor.run(()=>f.adapter.verifyExisting(f.event,f.text,f.boundary,f.approved.contextDigest))).rejects.toThrow();
    if(mode==='MISSING_HUMAN')expect(await f.owner.dm.locator('#native-editor').textContent()).toBe('actual webpage human draft');
    const code=mode==='DUPLICATE'?'NATIVE_REPLY_RECEIPT_AMBIGUOUS':mode==='MISSING_HUMAN'?'OBSERVATION_EXISTING_HUMAN_INPUT':
      mode==='MISSING_SCOPE'?'NATIVE_REPLY_CONVERSATION_CHANGED':'VERIFICATION_CANCELLED';
    expect(f.reports.some(report=>report.code===code)).toBe(true);
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{vi.restoreAllMocks();await f.close();}
});

test('cancellation at the second native read cannot initiate a subsequent refresh',async()=>{
  const f=await setup('EXTRA_PREFIX');try{
    let reads=0,reloads=0;const evaluate=f.owner.dm.evaluate.bind(f.owner.dm);
    f.owner.dm.on('framenavigated',frame=>{if(frame===f.owner.dm.mainFrame())reloads++;});
    vi.spyOn(f.owner.dm,'evaluate').mockImplementation(async(fn,arg)=>{
      const result=await evaluate(fn,arg);
      if((fn as unknown)===captureDmReply&&(arg as {action?:string})?.action==='proofs'&&++reads===2)f.abort.abort();
      return result;
    });
    await expect(f.owner.actor.run(()=>f.adapter.verifyExisting(f.event,f.text,f.boundary,f.approved.contextDigest))).rejects.toThrow('VERIFICATION_CANCELLED');
    expect(reloads).toBe(0);expect(await evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
  }finally{vi.restoreAllMocks();await f.close();}
});
