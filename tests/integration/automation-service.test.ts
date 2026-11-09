import { expect, test } from "vitest";
import { join } from "node:path";
import { ClientService } from "../../src/app/service.js";
import { BrowserService } from "../../src/app/browser-service.js";
import { migrateClient } from "../../src/storage/client-migration.js";
import { database, privateTemp, pending, candidate, approved, snapshot } from "../helpers.js";
import { randomUUID } from 'node:crypto';
import { DeepSeekProvider } from "../../src/ai/deepseek.js";
import { defaultSettings } from "../../src/app/contracts.js";
import { Blocked } from '../../src/core/contracts.js';

test.each([false,true])('single account startup clears ordinary send pause but retains emergency stop (%s)',async emergency=>{
  const root=privateTemp('single-online-'),store=database();await migrateClient(store,join(root,'client.sqlite'));
  let opens=0;
  class OnlineBrowser extends BrowserService {
    override async open(){opens++;}
    override async close(){}
  }
  let service=new ClientService(store,new OnlineBrowser(root));await service.loadSettings();let token=service.authority.issueSession();
  try{
    pending(store);store.db.prepare("UPDATE budgets SET used=CASE kind WHEN 'MODEL' THEN 1 ELSE 9 END").run();
    await service.dispatch(token,emergency?{command:'emergencyStop'}:{command:'pause',eventId:null});
    await service.close();
    service=new ClientService(store,new OnlineBrowser(root));await service.loadSettings();token=service.authority.issueSession();
    service.startOnline();
    if(!emergency)await expect.poll(()=>opens).toBe(1);
    expect(service.authority.paused()).toBe(emergency);
    expect(opens).toBe(emergency?0:1);
    expect(store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all()).toEqual([{kind:'MODEL',used:1},{kind:'SEND',used:9}]);
    expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
  }finally{await service.close();store.close();}
});

test('waiting replies include review and uncertain records while replied records remain separate',async()=>{
  const root=privateTemp('reply-buckets-'),store=database();await migrateClient(store,join(root,'client.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();
  try{
    const waiting=['AWAITING_DRAFT','AWAITING_APPROVAL','APPROVED','MANUAL_REVIEW','INTENT_RECORDED','UNCERTAIN','REJECTED'];
    const ids=new Map<string,string>();
    for(const status of [...waiting,'CONFIRMED','BASELINE']){
      const id=pending(store,candidate({platformEventId:status,conversationId:status}));ids.set(status,id);
      store.db.prepare('UPDATE inbound_events SET status=? WHERE id=?').run(status,id);
    }
    const input={command:'getInbox',channel:'ALL',page:0};
    const pendingReplies=await service.dispatch(token,{...input,status:'PENDING'}) as {items:{id:string;replyStatus:string}[]};
    expect(new Set(pendingReplies.items.map(e=>e.id))).toEqual(new Set(waiting.map(s=>ids.get(s))));
    expect(pendingReplies.items.every(e=>e.replyStatus==='WAITING')).toBe(true);
    expect(await service.dispatch(token,{...input,status:'CONFIRMED'})).toMatchObject({total:1,items:[{id:ids.get('CONFIRMED'),replyStatus:'REPLIED'}]});
    expect(store.event(ids.get('UNCERTAIN')!).status).toBe('UNCERTAIN');
  }finally{await service.close();store.close();}
});

test('saving an API key enables bounded model consent without a second checkbox or automatic sending',async()=>{
  const root=privateTemp('key-consent-'),store=database();await migrateClient(store,join(root,'backup.sqlite'));pending(store);
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();
  try{
    expect(await service.dispatch(token,{command:'configureAi',settings:defaultSettings,key:'synthetic-contract-key'}))
      .toMatchObject({keyPresent:true,modelAuthorized:true,configuredMode:'DRAFT_ONLY',automation:{replyPolicy:null}});
    expect(store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});
    expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
    expect(store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
  }finally{await service.close();store.close();}
});

test('a later delivery proof changes only the reply bucket and never unfreezes or rewrites an uncertain intent',async()=>{
  const root=privateTemp('reply-proof-bucket-'),store=database(),draft=store.draft(approved(store)),event=store.event(draft.eventId);
  const intent=store.recordIntent(draft.id,snapshot(event.payload),false);store.receipt(intent,'UNCERTAIN','synthetic-original-receipt');
  await migrateClient(store,join(root,'client.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();
  try{
    const receipt=store.receiptForEvent(event.id);
    store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)').run(randomUUID(),intent,1,'synthetic-followup-proof',Date.now());
    expect(await service.dispatch(token,{command:'getInbox',channel:'ALL',status:'CONFIRMED',page:0})).toMatchObject({total:1,items:[{replyStatus:'REPLIED'}]});
    expect(await service.dispatch(token,{command:'getThread',eventId:event.id})).toMatchObject({replyStatus:'REPLIED',frozen:true,intent:{status:'UNCERTAIN'}});
    store.db.prepare('INSERT INTO verification_results VALUES(?,?,?,?,?)').run(randomUUID(),intent,0,'synthetic-contradiction',Date.now()-1000);
    expect(await service.dispatch(token,{command:'getInbox',channel:'ALL',status:'PENDING',page:0})).toMatchObject({total:1,items:[{replyStatus:'WAITING'}]});
    expect(store.event(event.id).status).toBe('UNCERTAIN');expect(store.receiptForEvent(event.id)).toEqual(receipt);
  }finally{await service.close();store.close();}
});

test('single account reconnects with bounded backoff and does not cycle an online browser',async()=>{
  const root=privateTemp('single-reconnect-'),store=database();await migrateClient(store,join(root,'client.sqlite'));
  let opens=0,connected=false,now=Date.now();
  class OnlineBrowser extends BrowserService {
    override status(){return{state:connected?'OPEN_LAST_READ_VERIFIED':'CLOSED',mode:'headed' as const,version:null};}
    override async open(){opens++;if(opens===1)throw new Error('private fixture error must not be logged');connected=true;}
    override async close(){connected=false;}
  }
  const service=new ClientService(store,new OnlineBrowser(root),undefined,()=>now);await service.loadSettings();pending(store);
  try{
    service.startOnline();await service.drain();expect(opens).toBe(1);
    service.startOnline();await service.drain();expect(opens).toBe(1);
    now+=30_000;service.startOnline();await service.drain();expect(opens).toBe(2);
    now+=30_000;service.startOnline();await service.drain();expect(opens).toBe(2);
    connected=false;service.startOnline();await service.drain();expect(opens).toBe(3);
    expect(JSON.stringify(store.db.prepare('SELECT * FROM audit_events').all())).not.toContain('private fixture error');
  }finally{await service.close();store.close();}
});

test('an ordinary browser closure reconnects without converting into a persistent emergency stop',async()=>{
  const root=privateTemp('single-browser-closure-'),store=database();await migrateClient(store,join(root,'client.sqlite'));
  let opens=0,now=Date.now();
  class ClosingBrowser extends BrowserService {
    override async open(){opens++;if(opens===1)throw new Blocked('BROWSER_CLOSED');}
    override async close(){}
  }
  const service=new ClientService(store,new ClosingBrowser(root),undefined,()=>now);await service.loadSettings();pending(store);
  try{
    service.startOnline();await service.drain();
    expect(await service.dispatch(service.authority.issueSession(),{command:'getStatus'})).toMatchObject({automation:{emergencyStopped:false}});
    now+=30_000;service.startOnline();await service.drain();expect(opens).toBe(2);
  }finally{await service.close();store.close();}
});

test.each([false,true])('manual AI suggestion refuses an unverified comment before charging (later collision: %s)',async later=>{
  const root=privateTemp('unverified-suggestion-'),store=database();await migrateClient(store,join(root,'backup.sqlite'));
  let calls=0;
  const provider=new DeepSeekProvider(async()=>{calls++;return new Response(JSON.stringify({model:'deepseek-flash',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Fixture suggestion'}}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}}));});
  const service=new ClientService(store,new BrowserService(root),provider);
  try{
    const clean=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',videoId:'v1',commentId:'c1'}),issue={...clean,observationIssue:'COMMENT_TEXT_UNVERIFIED' as const};
    pending(store,later?clean:issue);const eventId=store.events()[0]!.id;
    if(later)store.observe(clean.channel,'notifications',[issue],'own-1','fixture');
    await service.loadSettings();const token=service.authority.issueSession();
    await service.dispatch(token,{command:'configureAi',settings:defaultSettings,key:'synthetic-contract-key'});
    await service.dispatch(token,{command:'setModelGrant',scope:{ownId:'own-1',channels:['COMMENT_NOTIFICATION'],model:'deepseek-flash',modelLimit:1,expiresAt:null},confirmed:true});
    await expect(service.dispatch(token,{command:'generateSuggestion',eventId,draftVersion:0})).rejects.toThrow('COMMENT_TEXT_UNVERIFIED');
    expect(calls).toBe(0);expect(store.db.prepare("SELECT used FROM budgets WHERE kind='MODEL'").get()).toEqual({used:0});
    expect(store.db.prepare('SELECT count(*) AS n FROM grant_reservations').get()).toEqual({n:0});
  }finally{await service.close();store.close();}
});

test("scope consent survives service restart and ordinary settings saves preserve Key and grant usage",async()=>{
  const root=privateTemp('automation-service-'),store=database();
  await migrateClient(store,join(root,'backup.sqlite'));
  let calls=0;
  const provider=new DeepSeekProvider(async()=>{calls++;return new Response(JSON.stringify({model:'deepseek-flash',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Fixture suggestion'}}],
    usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}}));});
  let service=new ClientService(store,new BrowserService(root),provider);
  try {
    const eventId=pending(store);await service.loadSettings();let token=service.authority.issueSession();
    await service.dispatch(token,{command:'configureAi',settings:defaultSettings,key:'synthetic-contract-key'});
    await service.dispatch(token,{command:'setModelGrant',scope:{ownId:'own-1',channels:['DIRECT_MESSAGE'],model:'deepseek-flash',modelLimit:1,expiresAt:null},confirmed:true});
    const modelVersion=(await service.dispatch(token,{command:'getStatus'}) as {automation:{modelGrant:{version:number}}}).automation.modelGrant.version;
    await service.dispatch(token,{command:'configureAi',settings:{...defaultSettings,business:'Ordinary business update'},key:''});
    expect(await service.dispatch(token,{command:'getStatus'})).toMatchObject({keyPresent:true,modelAuthorized:true});
    await service.dispatch(token,{command:'generateSuggestion',eventId,draftVersion:0});expect(calls).toBe(1);
    await expect(service.dispatch(token,{command:'generateSuggestion',eventId,draftVersion:0})).rejects.toThrow('MODEL_GRANT_EXHAUSTED');
    expect(calls).toBe(1);
    await service.close();
    service=new ClientService(store,new BrowserService(root),provider);await service.loadSettings();token=service.authority.issueSession();
    expect(await service.dispatch(token,{command:'getStatus'})).toMatchObject({keyPresent:false,modelAuthorized:true,paused:false,automation:{modelGrant:{version:modelVersion}}});
    await service.dispatch(token,{command:'setModelGrant',scope:null,confirmed:true});
    expect(await service.dispatch(token,{command:'getStatus'})).toMatchObject({modelAuthorized:false});
    await expect(service.dispatch(token,{command:'authorizeAi',authorized:true})).rejects.toThrow('USE_PERSISTENT_MODEL_GRANT');
    expect(store.db.prepare("SELECT used FROM budgets WHERE kind='MODEL'").get()).toEqual({used:1});
  }finally{await service.close();store.close();}
});

test.each(['setKeyStorage','clearModelKey'] as const)('later %s cannot be undone by an earlier asynchronous configuration save',async command=>{
  const root=privateTemp('credential-config-race-'),store=database();await migrateClient(store,join(root,'client.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();const token=service.authority.issueSession();
  try{
    const saving=service.dispatch(token,{command:'configureAi',settings:defaultSettings,key:'synthetic-late-config-key'});
    const clearing=service.dispatch(token,command==='setKeyStorage'?{command,storage:'DELETE'}:{command});
    await Promise.all([saving,clearing]);
    expect(await service.dispatch(token,{command:'getStatus'})).toMatchObject({keyPresent:false,keyStored:false});
  }finally{await service.close();store.close();}
});
