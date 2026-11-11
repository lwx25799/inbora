import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ClientService} from '../src/app/service.js';
import {BrowserService} from '../src/app/browser-service.js';
import {AccountActor} from '../src/browser/account-actor.js';
import {DeepSeekProvider} from '../src/ai/deepseek.js';
import {AutomationStore} from '../src/storage/automation-store.js';
import {migrateClient} from '../src/storage/client-migration.js';
import {migrateLocalAssistant} from '../src/storage/local-assistant-migration.js';
import {digest,targetKey,type InboundEvent} from '../src/core/contracts.js';
import {candidate,database,pending,privateTemp,snapshot} from './helpers.js';

export class AssistantBrowser extends BrowserService{
  private serial=new AccountActor();clicks=0;unknown=false;
  inspectGate:()=>Promise<void>=async()=>{};beforeCommit:()=>void=()=>{};afterClick:()=>void=()=>{};
  override get actor(){return this.serial;}
  override identity(){return {identityDigest:digest('own-1'),mappingDigest:'fixture',browserVersion:'1',browserMode:'headless' as const};}
  override async refreshIdentity(){return this.identity();}
  override async open(..._args:Parameters<BrowserService['open']>){}
  override async collect(..._args:Parameters<BrowserService['collect']>){}
  override async close(){}
  override async adapter(event:InboundEvent){let text='';return {dispose:()=>{},adapter:{
    inspect:async()=>{await this.inspectGate();return snapshot(event);},prepare:async(_event:InboundEvent,value:string)=>{text=value;},
    verifyPrepared:async()=>{this.beforeCommit();return snapshot(event);},baseline:async()=>[],
    clickOnce:async()=>{this.clicks++;this.afterClick();await new Promise(resolve=>setTimeout(resolve,5));},
    readback:async()=>this.unknown?null:{id:randomUUID(),ownId:'own-1',targetKey:targetKey(event),text,pending:false,sentAt:new Date().toISOString()},
  }};}
}
export async function setupAssistant(options:{media?:boolean;sendLimit?:number;modelLimit?:number;modelGate?:()=>Promise<void>}={}){
  const store=database(),root=privateTemp('assistant-send-');await migrateClient(store,join(root,'client.sqlite'));
  const start=Date.now()-3600_000,payload=candidate({occurredAt:new Date(start+60000).toISOString(),
    ...(options.media?{observationIssue:'DM_CONTENT_UNVERIFIED' as const,contentType:'IMAGE' as const}:{} )});
  pending(store,payload);
  const eventId=store.events().find(event=>event.payload.platformEventId===payload.platformEventId)!.id,browser=new AssistantBrowser(root);let calls=0;
  const provider=new DeepSeekProvider(async()=>{calls++;await options.modelGate?.();return new Response(JSON.stringify({model:'deepseek-flash',
    choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Synthetic assistant suggestion'}}],
    usage:{prompt_tokens:1,completion_tokens:2,total_tokens:3}}));});
  const service=new ClientService(store,browser,provider,Date.now,start);await service.loadSettings();
  await migrateLocalAssistant(store,join(root,'assistant.sqlite'));const auto=new AutomationStore(store);
  auto.configureCollection({ownId:'own-1',comments:true,inbox:true,commentIntervalMs:30000,dmIntervalMs:30000});
  store.db.prepare('INSERT INTO collection_targets VALUES(?,?,?,?,?,?,?)').run(targetKey(payload),'own-1',payload.actorId,'peer-sec','Fixture peer',payload.conversationId,Date.now());
  store.db.prepare('INSERT INTO discovered_conversations VALUES(?,?,?,?,?,?,?,0)').run(payload.conversationId,'own-1',payload.actorId,'peer-sec','Fixture peer',Date.now(),Date.now());
  const grant=service.authority.assistant.grant({ownId:'own-1',channels:['DIRECT_MESSAGE'],permissions:{read:true,editControl:true,send:true},
    expiresAt:Date.now()+86400_000,modelLimit:options.modelLimit??2,sendLimit:options.sendLimit??2});
  const gui=service.authority.issueSession();await service.dispatch(gui,{command:'setMode',mode:'MANUAL'});
  const token=service.authority.issueAssistantSession(grant.version),selectionId=randomUUID();service.authority.select(token,eventId,selectionId);
  const owner=service.authority.claim(token,eventId,0);
  const input={eventId,selectionId,generation:owner.generation,expectedVersion:0,text:'Synthetic assistant reply',
    contextVersion:service.authority.contextVersion(store.event(eventId)),suggestionId:null};
  return {store,root,eventId,payload,browser,service,auto,grant,gui,token,input,calls:()=>calls,async close(){await service.close();store.close();}};
}
