import { expect,test } from 'vitest';
import { join } from 'node:path';
import { BrowserProfileOwner } from '../../src/browser/profile-owner.js';
import { BrowserService } from '../../src/app/browser-service.js';
import { ClientService } from '../../src/app/service.js';
import { DomAdapter } from '../../src/adapters/dom-adapter.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { DeepSeekProvider } from '../../src/ai/deepseek.js';
import { digest,type InboundEvent } from '../../src/core/contracts.js';
import { defaultSettings } from '../../src/app/contracts.js';
import { fixtureServer,mapping,rowData } from '../fixtures/site.js';
import { database,privateTemp } from '../helpers.js';

test('one persistent GUI-style strategy completes both real synthetic DOM channels, with no manual draft or confirmation commands',async()=>{
  const server=await fixtureServer(),root=privateTemp('automatic-policy-dom-'),owner=await BrowserProfileOwner.launch(join(root,'profile'),true),store=database();
  let service:ClientService|undefined;
  try{
    await owner.open(server.origin);const config=mapping(server.origin);
    const dm=new DomAdapter(owner.dm,'DIRECT_MESSAGE',config),comment=new DomAdapter(owner.notification,'COMMENT_NOTIFICATION',config);
    for(const [channel,scope,adapter]of [['DIRECT_MESSAGE','conversation-1',dm],['COMMENT_NOTIFICATION','notifications',comment]] as const){
      const batch=channel==='DIRECT_MESSAGE'?await adapter.observeDm(scope,'peer-1'):await adapter.observeNotifications();
      store.observe(channel,scope,batch.events,config.ownId,batch.evidenceId);
    }
    await owner.dm.evaluate(e=>(window as unknown as {addDm:(id:string,e:unknown)=>void}).addDm('conversation-1',e),rowData('dm'));
    await owner.notification.evaluate(e=>(window as unknown as {addNotification:(e:unknown)=>void}).addNotification(e),rowData('comment'));
    for(const [channel,scope,adapter]of [['DIRECT_MESSAGE','conversation-1',dm],['COMMENT_NOTIFICATION','notifications',comment]] as const){
      const batch=channel==='DIRECT_MESSAGE'?await adapter.observeDm(scope,'peer-1'):await adapter.observeNotifications();
      store.observe(channel,scope,batch.events,config.ownId,batch.evidenceId);
    }
    await migrateClient(store,join(root,'before-client.sqlite'));
    class Browser extends BrowserService{
      override get actor(){return owner.actor;}
      override identity(){return{identityDigest:digest(config.ownId),mappingDigest:digest(config),browserVersion:owner.version(),browserMode:'headless' as const};}
      override async refreshIdentity(){return this.identity();}
      override async close(){}
      override async adapter(e:InboundEvent){return{adapter:e.channel==='DIRECT_MESSAGE'?dm:comment,dispose:()=>{}};}
    }
    let calls=0;
    const provider=new DeepSeekProvider(async()=>{calls++;return new Response(JSON.stringify({model:'deepseek-flash',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Synthetic policy answer '+calls}}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}}));});
    service=new ClientService(store,new Browser(root),provider);await service.loadSettings();const token=service.authority.issueSession();
    await service.dispatch(token,{command:'configureAi',settings:defaultSettings,key:'synthetic-contract-key'});
    const video=store.events().find(e=>e.payload.channel==='COMMENT_NOTIFICATION')!.payload.videoId!;
    await service.dispatch(token,{command:'setReplyPolicy',confirmed:true,policy:{ownId:config.ownId,channels:['DIRECT_MESSAGE','COMMENT_NOTIFICATION'],model:'deepseek-flash',modelLimit:2,sendLimit:2,
      expiresAt:null,workIds:[video],futureOwnWorks:false,conversationIds:['conversation-1'],entireInbox:false,containsAny:[],excludesAny:[],instructions:'Reply briefly.',startHour:0,endHour:24}});
    await service.dispatch(token,{command:'setMode',mode:'LIMITED_AUTO'});
    await service.runAutomaticReply();await service.runAutomaticReply();await service.runAutomaticReply();
    expect(store.events().map(e=>e.status)).toEqual(['CONFIRMED','CONFIRMED']);expect(calls).toBe(2);
    for(const page of [owner.dm,owner.notification])expect(await page.evaluate(()=>(window as unknown as {clicks:number}).clicks)).toBe(1);
    expect(store.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type='AUTO_POLICY_APPROVED'").get()).toEqual({n:2});
    expect(store.db.prepare("SELECT used FROM budgets ORDER BY kind").all()).toEqual([{used:2},{used:2}]);
  }finally{await service?.close();store.close();await owner.close();await server.close();}
});
