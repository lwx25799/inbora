import {afterAll,beforeAll,expect,test} from 'vitest';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {ObservedDmReply,captureDmReply} from '../../src/adapters/observed-dm-reply.js';
import {digest,type InboundEvent} from '../../src/core/contracts.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {ClientService} from '../../src/app/service.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountDmReply,dmReplyMapping} from '../fixtures/observed-site.js';
import {database,privateTemp} from '../helpers.js';

let server:Awaited<ReturnType<typeof fixtureServer>>,owner:BrowserProfileOwner;
beforeAll(async()=>{
  server=await fixtureServer();owner=await BrowserProfileOwner.launch(join(privateTemp('human-share-shell-'),'profile'),true);
  await owner.dm.addInitScript(()=>window.addEventListener('load',()=>{
    const config=sessionStorage.getItem('native-share-shell');if(!config)return;
    const row=document.querySelectorAll<HTMLElement>('.message')[4];if(!row)return;
    const message=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
    const data=JSON.parse(config) as {awemeType:number;slides?:boolean};
    message.type=8;message._parsedContent={text:'',itemId:'123456',awemeType:data.awemeType,...(data.slides===undefined?{}:{is_slides:data.slides})};
    row.replaceChildren();row.style.minHeight='24px';
  }));
});
afterAll(async()=>{await owner?.close();await server?.close();});

async function setup(awemeType=0,slides?:boolean){
  await owner.dm.goto(server.origin);await owner.dm.evaluate(()=>sessionStorage.clear());
  await mountDmReply(owner,server.origin);const store=database(),mapping=dmReplyMapping(server.origin);
  const batch=await new ObservedReader(owner.dm,mapping.observation).dm(0);
  store.observe('DIRECT_MESSAGE','conv-a',[],'100','synthetic');store.observe('DIRECT_MESSAGE','conv-a',batch.events,'100','synthetic');
  const event=store.events().find(item=>item.payload.platformEventId==='5')!;
  await owner.dm.evaluate(data=>{
    sessionStorage.setItem('native-share-shell',JSON.stringify(data));
    const row=document.querySelectorAll<HTMLElement>('.message')[4]!,message=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
    message.type=8;message._parsedContent={text:'',itemId:'123456',awemeType:data.awemeType,...(data.slides===undefined?{}:{is_slides:data.slides})};
    row.replaceChildren();row.style.minHeight='24px';
  },{awemeType,...(slides===undefined?{}:{slides})});
  await migrateClient(store,join(privateTemp('human-share-shell-db-'),'backup.sqlite'));
  let inspections=0,afterFirstProof:(()=>Promise<void>)|undefined;
  const browser=new class extends BrowserService{
    override get actor(){return owner.actor;}
    override identity(){return {identityDigest:digest('100'),mappingDigest:digest(mapping),browserVersion:owner.version(),browserMode:'headless' as const};}
    override async refreshIdentity(){return this.identity();}
    override async adapter(_event:InboundEvent,_store?:unknown,_signal?:AbortSignal,options:{manualMedia?:boolean}={}){
      const adapter=new ObservedDmReply(owner.dm,mapping,300,options),inspect=adapter.inspect.bind(adapter);
      adapter.inspect=async event=>{const proof=await inspect(event);if(++inspections===1)await afterFirstProof?.();return proof;};
      return {adapter,dispose:()=>adapter.dispose()};
    }
    override async close(){}
  }(privateTemp('human-share-shell-service-'));
  const service=new ClientService(store,browser);await service.loadSettings();const token=service.authority.issueSession();
  await service.dispatch(token,{command:'setMode',mode:'MANUAL'});const selectionId=randomUUID();
  const detail=await service.dispatch(token,{command:'openHumanDialog',eventId:event.id,selectionId}) as {ownership:{generation:number};contextVersion:string};
  return {store,mapping,event,service,afterProof:(action:()=>Promise<void>)=>{afterFirstProof=action;},send:async()=>{
    const commandId=randomUUID();await service.dispatch(token,{command:'sendHumanReply',commandId,input:{eventId:event.id,
      generation:detail.ownership.generation,expectedVersion:0,text:'已人工查看分享作品的准确回复',contextVersion:detail.contextVersion,selectionId,suggestionId:null}});
    await service.drain();return service.dispatch(token,{command:'getSendResult',commandId});
  },close:async()=>{await service.close();store.close();}};
}

test('a native shared-work shell without text, image or card has the same manual proof as its visible card',async()=>{
  const f=await setup();try{
    const ordinary=new ObservedDmReply(owner.dm,f.mapping,100);await expect(ordinary.inspect(f.event.payload)).rejects.toThrow('NATIVE_REPLY_SCOPE_REQUIRED');
    const input:Parameters<typeof captureDmReply>[0]={mapping:f.mapping,event:f.event.payload,action:'snapshot',text:null,
      token:null,before:null,editorShape:null,manualMedia:true};
    const captured=await owner.dm.evaluate(captureDmReply,input);
    expect(captured.media).toMatchObject({nativeKind:8,contentType:'IMAGE'});
    const manual=new ObservedDmReply(owner.dm,f.mapping,100,{manualMedia:true}),shell=await manual.inspect(f.event.payload);
    expect(shell.manualObservation).toMatchObject({kind:'DM_MEDIA',nativeKind:8,contentType:'IMAGE',freshExact:true});
    await owner.dm.evaluate(()=>{const card=document.createElement('div');card.className='MessageItemShareAwemecontainer';
      card.style.cssText='width:80px;height:24px';document.querySelectorAll('.message')[4]!.append(card);});
    const card=await manual.inspect(f.event.payload);expect(card.contextDigest).toBe(shell.contextDigest);
    expect(card.manualObservation?.mediaDigest).toBe(shell.manualObservation?.mediaDigest);
    expect(await owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
  }finally{await f.close();}
});

test.each([{awemeType:0},{awemeType:55,slides:false},{awemeType:68,slides:true}])('native share route $awemeType/$slides completes one human command with refreshed readback',async route=>{
  const f=await setup(route.awemeType,route.slides);try{
    expect(await f.send()).toMatchObject({status:'CONFIRMED'});
    expect(await owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(1);
    expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:1});
    expect(f.store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:1}]);
    expect(f.store.event(f.event.id).binding).toBe(f.event.binding);expect(f.store.event(f.event.id).payload).toEqual(f.event.payload);
  }finally{await f.close();}
});

test.each(['item','type','time','text','actor','conversation'] as const)('a changed native share %s after fresh proof cannot commit an intent',async change=>{
  const f=await setup();try{
    f.afterProof(()=>owner.dm.evaluate(change=>{
      const row=document.querySelectorAll('.message')[4]!,message=Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message;
      if(change==='item')message._parsedContent.itemId='654321';if(change==='type')message.type=9;
      if(change==='time')message.createdAt=new Date('2020-01-01T00:00:00Z');if(change==='actor')message.sender='999';
      if(change==='conversation')message.conversationId='wrong-conversation';
      if(change==='text'){const body=document.createElement('span');body.className='text';body.textContent='conflicting visible text';row.append(body);}
    },change));
    expect(await f.send()).toMatchObject({status:'FAILED_BEFORE_CLICK'});
    expect(f.store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    expect(f.store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:0},{kind:'SEND',used:0}]);
    expect(await owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
  }finally{await f.close();}
});
