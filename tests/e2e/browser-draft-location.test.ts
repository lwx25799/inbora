import {expect,test} from 'vitest';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {ClientService} from '../../src/app/service.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {ObservedDmReply,captureDmReply} from '../../src/adapters/observed-dm-reply.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {digest} from '../../src/core/contracts.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountDmReply,dmReplyMapping} from '../fixtures/observed-site.js';
import {database,privateTemp} from '../helpers.js';

async function setup(){
  const root=privateTemp('browser-draft-location-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true),store=database();
  await mountDmReply(owner,server.origin);const mapping=dmReplyMapping(server.origin),batch=await new ObservedReader(owner.dm,mapping.observation).dm(0);
  const event=batch.events[0]!;store.observe('DIRECT_MESSAGE',event.conversationId!,[],'100','synthetic',new Date(Date.parse(event.occurredAt!)-1000).toISOString());
  const [eventId]=store.observe('DIRECT_MESSAGE',event.conversationId!,[event],'100','synthetic');
  await migrateClient(store,join(root,'client.sqlite'));
  const browser=new class extends BrowserService{
    override get actor(){return owner.actor;}
    override status(){return {state:'OPEN_LAST_READ_VERIFIED',mode:'headless' as const,version:owner.version()};}
    override async adapter(){const adapter=new ObservedDmReply(owner.dm,mapping,250);return{adapter,dispose:()=>adapter.dispose()};}
    override async close(){}
  }(root),service=new ClientService(store,browser);await service.loadSettings();const token=service.authority.issueSession();
  const draftId=randomUUID(),commandId=randomUUID(),text='Exact persisted automatic webpage reply';
  const grant=new AutomationStore(store).grant('AUTO_REPLY',{ownId:'100',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:2,sendLimit:2,expiresAt:null,
    workIds:[],futureOwnWorks:false,conversationIds:[],entireInbox:true,containsAny:[],excludesAny:[],instructions:'Synthetic only',startHour:0,endHour:24});
  store.db.prepare("INSERT INTO reply_drafts VALUES(?,?,?,'deepseek-flash',1,'DRAFT',NULL,NULL)").run(draftId,eventId,text);
  store.db.prepare("UPDATE inbound_events SET status='AWAITING_APPROVAL' WHERE id=?").run(eventId);
  store.db.prepare("INSERT INTO draft_revisions VALUES(?,1,'AUTO_POLICY',?,?,?)").run(draftId,text,'policy:'+grant.version,Date.now());
  const params={eventId:eventId!,generation:0,draftId,draftVersion:1,text,contextVersion:service.authority.contextVersion(store.event(eventId!)),selectionId:randomUUID()};
  store.db.prepare('INSERT INTO manual_send_commands VALUES(?,?,?,?,?,?,?,?,?)').run(commandId,eventId,service.authority.operator(token).id,digest(params),JSON.stringify(params),'FAILED_BEFORE_CLICK',null,'TARGET_CHANGED_REAPPROVE',Date.now());
  store.db.prepare('INSERT INTO policy_commands VALUES(?,?,0)').run(commandId,grant.version);
  const creator=new ObservedDmReply(owner.dm,mapping,250);await creator.inspect(event);await creator.prepare(event,text);creator.dispose();
  await owner.dm.evaluate(()=>{
    (document.querySelector('#chat') as HTMLElement).hidden=true;
    const host=window as unknown as {recoverySelections:number};host.recoverySelections=0;
    document.querySelector('.conversation')!.addEventListener('click',()=>{host.recoverySelections++;(document.querySelector('#chat') as HTMLElement).hidden=false;});
  });
  return{root,owner,store,service,token,event,eventId:eventId!,draftId,text,mapping,
    close:async()=>{await service.close();store.close();await owner.close();await server.close();}};
}

test.each(['list','foreign-input','foreign-chat','account','missing-original'] as const)('bounded saved-draft discovery uses only normal exact conversation selection and preserves input (%s)',async fault=>{
  const f=await setup();try{
    await f.owner.dm.evaluate(fault=>{
      const chat=document.querySelector('#chat') as HTMLElement,editor=document.querySelector('#native-editor')!;
      if(fault==='foreign-input'||fault==='foreign-chat'){chat.hidden=false;editor.textContent='Unsubmitted foreign human webpage text';}
      if(fault==='foreign-chat')Object.getOwnPropertyDescriptor(document.querySelector('#header')!,'__reactProps$fixture')!.value.children.props.conversation.id='outside';
      if(fault==='account')Object.getOwnPropertyDescriptor(document.querySelector('#self')!,'__reactFiber$fixture')!.value.return.memoizedProps.uid='outside';
      if(fault==='missing-original')Object.getOwnPropertyDescriptor(document.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message.serverId='99999';
    },fault);
    const before=await f.owner.dm.locator('#native-editor').textContent(),draft=f.store.draft(f.draftId),url=f.owner.dm.url();
    const result=f.service.dispatch(f.token,{command:'browser',action:'inspectSavedDraftRecovery'});
    if(fault==='account')await expect(result).rejects.toThrow('NATIVE_REPLY_ACCOUNT_CHANGED');
    else if(fault==='list')expect(await result).toMatchObject({eventId:f.eventId,draftId:f.draftId,text:f.text});
    else expect(await result).toBeNull();
    expect(await f.owner.dm.locator('#native-editor').textContent()).toBe(before);expect(f.store.draft(f.draftId)).toEqual(draft);expect(f.owner.dm.url()).toBe(url);
    const selected=await f.owner.dm.evaluate(()=>(window as unknown as {recoverySelections:number}).recoverySelections);
    expect(selected).toBe(fault==='list'||fault==='missing-original'?1:0);
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
    expect(f.store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});expect(f.store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});
  }finally{await f.close();}
});

test('a visible transitional header without native props can settle through normal bounded location without touching its saved input',async()=>{
  const f=await setup();try{
    await f.owner.dm.evaluate(()=>{
      const chat=document.querySelector('#chat') as HTMLElement,header=document.querySelector('#header')!;
      chat.hidden=false;const shell=header.cloneNode(true) as Element;header.replaceWith(shell);
      const state=window as unknown as {restoreRecoveryHeader:()=>void};state.restoreRecoveryHeader=()=>shell.replaceWith(header);
    });
    const input:Parameters<typeof captureDmReply>[0]={mapping:f.mapping,event:f.event,action:'snapshot',text:null,token:null,before:null,editorShape:null};
    await expect(f.owner.dm.evaluate(captureDmReply,input)).rejects.toThrow('NATIVE_REPLY_METADATA_MISSING');
    await f.owner.dm.evaluate(()=>setTimeout(()=>(window as unknown as {restoreRecoveryHeader:()=>void}).restoreRecoveryHeader(),150));
    const draft=f.store.draft(f.draftId),before=await f.owner.dm.locator('#native-editor').textContent();
    const choice=await f.service.dispatch(f.token,{command:'browser',action:'inspectSavedDraftRecovery'});
    expect(choice).toMatchObject({eventId:f.eventId,draftId:f.draftId,text:f.text});
    expect(await f.owner.dm.locator('#native-editor').textContent()).toBe(before);expect(f.store.draft(f.draftId)).toEqual(draft);
    expect(await f.owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
    expect(f.store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});expect(f.store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});
  }finally{await f.close();}
});
