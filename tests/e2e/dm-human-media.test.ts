import {expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {ObservedDmReply,captureDmReply} from '../../src/adapters/observed-dm-reply.js';
import {digest,isStrong,type InboundEvent} from '../../src/core/contracts.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {WorkbenchAuthority} from '../../src/app/authority.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {ClientService} from '../../src/app/service.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountDmReply,dmReplyMapping} from '../fixtures/observed-site.js';
import {database,privateTemp,snapshot} from '../helpers.js';

async function setup(){
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp('human-media-'),'profile'),true),store=database();
  await mountDmReply(owner,server.origin);const mapping=dmReplyMapping(server.origin);
  await owner.dm.addInitScript(()=>{
    window.addEventListener('load',()=>{
      const row=document.querySelectorAll('.message')[4];if(!row)return;const image=row.querySelector('img') as HTMLImageElement|null;if(!image)return;
      image.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';image.width=24;image.height=24;
      const native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;native.type=90;
      if(sessionStorage.getItem('human-media-kind')==='SHARE'){
        const card=document.createElement('div');card.className='MessageItemShareAwemecontainer';image.replaceWith(card);card.append(image);
        Object.assign(native._parsedContent,{itemId:'123456',awemeType:0,is_slides:false});
      }
    });
  });
  await owner.dm.evaluate(()=>{
    const row=document.querySelectorAll('.message')[4]!,image=row.querySelector('img') as HTMLImageElement;
    image.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';image.width=24;image.height=24;
    Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message.type=90;
  });
  await owner.dm.locator('.message img').evaluate(node=>(node as HTMLImageElement).decode());
  const batch=await new ObservedReader(owner.dm,mapping.observation).dm(0);
  store.observe('DIRECT_MESSAGE','conv-a',[],'100','fixture');store.observe('DIRECT_MESSAGE','conv-a',batch.events,'100','fixture');
  const event=store.events().find(item=>item.payload.platformEventId==='5')!;
  await migrateClient(store,join(privateTemp('human-media-backup-'),'schema.sqlite'));
  const authority=new WorkbenchAuthority(store),token=authority.issueSession();authority.setMode(token,'DRAFT_ONLY');
  authority.select(token,event.id,randomUUID());const ownership=authority.claim(token,event.id,0);
  const draft=authority.save(token,event.id,ownership.generation,0,'人工查看媒体后的准确回复');
  return {server,owner,store,mapping,event,draft,authority,token,ownership,close:async()=>{store.close();await owner.close();await server.close();}};
}

function serviceBrowser(f:Awaited<ReturnType<typeof setup>>){
  return new class extends BrowserService {
    override get actor(){return f.owner.actor;}
    override identity(){return {identityDigest:digest('100'),mappingDigest:digest(f.mapping),browserVersion:f.owner.version(),browserMode:'headless' as const};}
    override async refreshIdentity(){return this.identity();}
    override async adapter(_event:InboundEvent,_store?:unknown,_signal?:AbortSignal,options:{manualMedia?:boolean}={}){
      const adapter=new ObservedDmReply(f.owner.dm,f.mapping,300,options);return {adapter,dispose:()=>adapter.dispose()};
    }
    override async close(){}
  }(privateTemp('human-media-service-'));
}

test('current generic media gates reject without preparing or clicking, while an explicit manual adapter must obtain fresh exact proof',async()=>{
  const f=await setup();
  try{
    const ordinary=new ObservedDmReply(f.owner.dm,f.mapping,100),prepare=vi.spyOn(ordinary,'prepare');
    expect(isStrong(f.event.payload)).toBe(false);
    expect(()=>f.store.approve(f.draft.id,snapshot(f.event.payload),f.draft.version,f.draft.text)).toThrow('NOT_AWAITING_APPROVAL');
    await expect(ordinary.inspect(f.event.payload)).rejects.toThrow('NATIVE_REPLY_SCOPE_REQUIRED');
    const capture:Parameters<typeof captureDmReply>[0]={mapping:f.mapping,event:f.event.payload,action:'snapshot',text:null,token:null,before:null,editorShape:null};
    await expect(f.owner.dm.evaluate(captureDmReply,capture)).rejects.toThrow('NATIVE_REPLY_ORIGINAL_CHANGED');
    expect(prepare).not.toHaveBeenCalled();expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
    expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    const manual=new ObservedDmReply(f.owner.dm,f.mapping,100,{manualMedia:true});
    const proof=await manual.inspect(f.event.payload);
    expect(proof).toMatchObject({manualObservation:{kind:'DM_MEDIA',channel:'DIRECT_MESSAGE',contentType:'IMAGE',nativeKind:90,freshExact:true}});
    expect(JSON.stringify(proof)).not.toContain('data:image');expect(JSON.stringify(proof)).not.toContain('R0lGOD');
  }finally{await f.close();}
});

test.each(['IMAGE','SHARE'] as const)('the normal human workflow sends one exact %s reply through the native adapter and strict refreshed readback',async kind=>{
  const f=await setup(),browser=serviceBrowser(f),service=new ClientService(f.store,browser);await service.loadSettings();
  try{
    if(kind==='SHARE')await f.owner.dm.evaluate(()=>{
      const row=document.querySelectorAll('.message')[4]!,card=document.createElement('div');card.className='MessageItemShareAwemecontainer';
      const image=row.querySelector('img')!;image.replaceWith(card);card.append(image);sessionStorage.setItem('human-media-kind','SHARE');
      Object.assign(Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message._parsedContent,
        {itemId:'123456',awemeType:0,is_slides:false});
    });
    const token=service.authority.issueSession();await service.dispatch(token,{command:'setMode',mode:'MANUAL'});
    const selectionId=randomUUID(),detail=await service.dispatch(token,{command:'openHumanDialog',eventId:f.event.id,selectionId}) as {ownership:{generation:number};contextVersion:string};
    const commandId=randomUUID();await service.dispatch(token,{command:'sendHumanReply',commandId,input:{eventId:f.event.id,generation:detail.ownership.generation,
      expectedVersion:f.draft.version,text:f.draft.text,contextVersion:detail.contextVersion,selectionId,suggestionId:null}});
    await service.drain();const result=await service.dispatch(token,{command:'getSendResult',commandId});
    expect(result,JSON.stringify(result)).toMatchObject({status:'CONFIRMED'});
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(1);
    expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:1});
    expect(f.store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:1}]);
    expect(f.store.event(f.event.id).binding).toBe(f.event.binding);expect(f.store.event(f.event.id).payload).toEqual(f.event.payload);
  }finally{await service.close();await f.close();}
});

test('GIF repaint and an unrelated unloaded historical image preserve the stable exact original proof',async()=>{
  const f=await setup();
  try{
    const adapter=new ObservedDmReply(f.owner.dm,f.mapping,100,{manualMedia:true}),before=await adapter.inspect(f.event.payload);
    await f.owner.dm.evaluate(()=>{
      const original=document.querySelectorAll('.message')[4]!.querySelector('img') as HTMLImageElement;original.style.filter='brightness(0.9)';
      const other=document.querySelector('.message')!,image=document.createElement('img');image.width=24;image.height=24;image.src='/unloaded-old-image.png';other.replaceChildren(image);
    });
    const historical=await adapter.inspect(f.event.payload);expect(historical.manualObservation?.mediaDigest).toEqual(before.manualObservation?.mediaDigest);
    const repaint=await adapter.inspect(f.event.payload);expect(repaint).toEqual(historical);
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
  }finally{await f.close();}
});

test.each(['source','kind','actor','time','conversation','duplicate','draft','inline-conflict'] as const)('a changed original %s is rejected before any media reply click',async change=>{
  const f=await setup();
  try{
    const adapter=new ObservedDmReply(f.owner.dm,f.mapping,100,{manualMedia:true}),approved=await adapter.inspect(f.event.payload);
    await f.owner.dm.evaluate(change=>{
      const row=document.querySelectorAll('.message')[4]!,native=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
      if(change==='source')(row.querySelector('img') as HTMLImageElement).src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jntkAAAAASUVORK5CYII=';
      if(change==='kind')native.type=91;if(change==='actor')native.sender='999';if(change==='time')native.createdAt=new Date('2026-11-04T00:00:00Z');
      if(change==='conversation')native.conversationId='outside';
      if(change==='duplicate'){const copy=row.cloneNode(true);Object.defineProperty(copy,'__reactProps$fixture',{value:Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value});row.after(copy);}
      if(change==='draft')document.querySelector('#native-editor')!.textContent='user web draft';
      if(change==='inline-conflict'){const text=document.createElement('span');text.className='text';text.textContent='wrong visible text';row.append(text);native._parsedContent.text='different native text';}
    },change);
    let rejected=false;try{const current=await adapter.inspect(f.event.payload);rejected=digest(current)!==digest(approved);}catch{rejected=true;}
    expect(rejected).toBe(true);expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
    expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    if(change==='draft')expect(await f.owner.dm.locator('#native-editor').textContent()).toBe('user web draft');
  }finally{await f.close();}
});
