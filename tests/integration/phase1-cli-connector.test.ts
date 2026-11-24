import { EventEmitter } from 'node:events';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { expect, test, vi } from 'vitest';
import { DomAdapter } from '../../src/adapters/dom-adapter.js';
import { ObservedCommentReply } from '../../src/adapters/observed-comment-reply.js';
import { ObservedReader } from '../../src/adapters/observed-reader.js';
import { AccountActor } from '../../src/browser/account-actor.js';
import { BrowserProfileOwner } from '../../src/browser/profile-owner.js';
import { main } from '../../src/cli.js';
import { Blocked } from '../../src/core/contracts.js';
import { SendCoordinator } from '../../src/core/send-coordinator.js';
import { DouyinPlatformConnector } from '../../src/platform/douyin-platform-connector.js';
import { AutomationStore } from '../../src/storage/automation-store.js';
import { migrateAutomation } from '../../src/storage/automation-migration.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { holdSecurityChannel, resolveSecurityHold } from '../../src/storage/security-holds.js';
import { EventStore } from '../../src/storage/store.js';
import { commentReplyMapping } from '../fixtures/observed-site.js';
import { mapping } from '../fixtures/site.js';
import { approved, candidate, privateTemp, snapshot } from '../helpers.js';

const origin = 'https://www.douyin.com';

function mockBrowser() {
  const page = () => Object.assign(new EventEmitter(), { url: () => origin+'/' });
  const owner = { actor: new AccountActor(), context: new EventEmitter(), notification: page(), dm: page(),
    open: vi.fn(async () => {}), close: vi.fn(async () => {}), version: () => '123.0.0.0' };
  return vi.spyOn(BrowserProfileOwner, 'launch').mockResolvedValue(owner as unknown as BrowserProfileOwner);
}

async function fixture() {
  const root = privateTemp('phase1-cli-');
  let store: EventStore | undefined;
  const close = async () => {
    try { vi.restoreAllMocks(); }
    finally { try { store?.close(); } finally { await rm(root, { recursive: true, force: true }); } }
  };
  try {
    store = new EventStore(join(root, 'poc.sqlite'), true);
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ version: 1, modelGrant: null, evidenceRetentionDays: 14 }));
    const run = (...args: string[]) => main([...args, '--runtime', root, '--real-account', '--private-access']);
    return { root, store, run, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test.each(['notifications', 'dm', 'works'] as const)('observe %s honors its channel hold and keeps its CLI output', async source => {
  const f = await fixture();
  try {
    const legacy = source === 'notifications', channel = source === 'dm' ? 'DIRECT_MESSAGE' : 'COMMENT_NOTIFICATION';
    const observation = { ...commentReplyMapping(origin).observation, environment: 'douyin' };
    if (legacy) {
      await writeFile(join(f.root, 'site-mapping.json'), JSON.stringify({ ...mapping(origin), environment: 'douyin' }));
    } else {
      await writeFile(join(f.root, 'observation-mapping.json'), JSON.stringify(observation));
    }
    const own=legacy?'own-1':observation.self.uid;
    const scope=legacy?'notifications':source==='dm'?observation.peers[0]!.conversationId:`work:${observation.works[0]!.id}`;
    const event=candidate({channel,kind:source==='dm'?'DM':'COMMENT',platformEventId:'123456',actorId:'200',
      conversationId:source==='dm'?scope:null,videoId:source==='dm'?null:observation.works[0]!.id,commentId:source==='dm'?null:'123456'});
    f.store.observe(channel,scope,[],own,'fixture',new Date(Date.parse(event.occurredAt!)-1000).toISOString());
    const held = holdSecurityChannel(f.store, channel, { incidentId: 'cli-observe', reason: 'OBSERVATION_SECURITY_SUSPECT', mode: 'headless' });
    const launch = mockBrowser(), output = vi.spyOn(stdout, 'write').mockReturnValue(true);
    const read = legacy
      ? vi.spyOn(DomAdapter.prototype, 'observeNotifications').mockResolvedValue({ events: [event], evidenceId: 'fixture', loaded: 1 })
      : vi.spyOn(ObservedReader.prototype, source === 'dm' ? 'dm' : 'comments').mockResolvedValue({
        events: [event], loaded: 2, unsupported: 1, evidenceId: 'fixture',
      });
    await expect(f.run('observe', source)).rejects.toThrow('SECURITY_CHANNEL_HELD');
    expect(launch).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(resolveSecurityHold(f.store, channel, held.revision)).toBe(true);
    await f.run('observe', source);
    expect(read).toHaveBeenCalledOnce();
    const saved=f.store.events();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.payload).toMatchObject({accountId:event.accountId,channel,platformEventId:event.platformEventId});
    expect(f.store.accountOwnId(event.accountId)).toBe(own);
    expect(JSON.parse(String(output.mock.lastCall?.[0]))).toEqual(legacy
      ? { newEventIds: [saved[0]!.id] }
      : { newEventIds: [saved[0]!.id], loaded: 2, unsupported: 1, sendsEnabled: false });
  } finally { await f.close(); }
});

test('verify-comment honors holds and uses the retry boundary without changing the original ledger', async () => {
  const f = await fixture();
  try {
    const native = commentReplyMapping(origin);
    native.observation.environment = 'douyin';
    await writeFile(join(f.root, 'comment-reply-mapping.json'), JSON.stringify(native));
    const event = candidate({ channel: 'COMMENT_NOTIFICATION', kind: 'COMMENT', actorId: '200', videoId: '10',
      commentId: '11', platformEventId: '11', conversationId: null });
    const draftId = approved(f.store, event), target = snapshot(event);
    const intentId = f.store.recordIntent(draftId, target, false);
    f.store.receipt(intentId, 'UNCERTAIN', 'original-receipt');
    const grant = f.store.authorizeCommentRetry(draftId, target, 'fixture');
    const retry = f.store.recordCommentRetryIntent(grant, target, false);
    f.store.db.prepare('UPDATE audit_events SET time=? WHERE id=?').run('2030-01-01T00:00:00Z', retry);
    f.store.db.prepare('UPDATE accounts SET own_id=?').run(native.observation.self.uid);
    const held = holdSecurityChannel(f.store, event.channel, { incidentId: 'cli-readback', reason: 'OBSERVATION_SECURITY_SUSPECT', mode: 'headless' });
    const launch = mockBrowser(), output = vi.spyOn(stdout, 'write').mockReturnValue(true);
    const verify = vi.spyOn(ObservedCommentReply.prototype, 'verifyExisting').mockResolvedValue(null);
    const prepare = vi.spyOn(ObservedCommentReply.prototype, 'prepare'), click = vi.spyOn(ObservedCommentReply.prototype, 'clickOnce');
    const ledger = () => ['send_intents','delivery_receipts'].map(table => f.store.db.prepare('SELECT * FROM '+table).all());
    const before = ledger();
    await expect(f.run('verify-comment', draftId)).rejects.toThrow('SECURITY_CHANNEL_HELD');
    expect(launch).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(resolveSecurityHold(f.store, event.channel, held.revision)).toBe(true);
    await f.run('verify-comment', draftId);
    expect(verify).toHaveBeenCalledExactlyOnceWith(f.store.event(f.store.draft(draftId).eventId).payload,
      f.store.draft(draftId).text, f.store.commentRetryBoundary(retry));
    expect(prepare).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(JSON.parse(String(output.mock.lastCall?.[0]))).toEqual({
      verified: false, evidenceId: expect.any(String), originalReceiptsRetained: true,
    });
    verify.mockResolvedValue({id:'synthetic-proof',ownId:'100',targetKey:target.targetKey,text:f.store.draft(draftId).text,
      pending:false,sentAt:'2030-01-01T00:00:01Z'});
    await f.run('verify-comment', draftId);
    expect(JSON.parse(String(output.mock.lastCall?.[0]))).toEqual({
      verified: true, evidenceId: expect.any(String), originalReceiptsRetained: true,
    });
    expect(ledger()).toEqual(before);
    expect(f.store.db.prepare("SELECT id FROM audit_events WHERE event_type='MANUAL_RETRY_RECEIPT'").all()).toEqual([]);
  } finally { await f.close(); }
});

test('a strong failure from a schema2 CLI page persists through the next schema3 startup', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'site-mapping.json'), JSON.stringify({ ...mapping(origin), environment: 'douyin' }));
    mockBrowser();
    const read = vi.spyOn(DomAdapter.prototype, 'observeNotifications').mockRejectedValue(new Blocked('UNEXPECTED_ORIGIN'));
    await expect(f.run('observe', 'notifications')).rejects.toThrow('UNEXPECTED_ORIGIN');
    await expect(f.run('observe', 'notifications')).rejects.toThrow('EMERGENCY_STOPPED');
    expect(read).toHaveBeenCalledOnce();
    await migrateClient(f.store,join(f.root,'client.sqlite'));
    await migrateAutomation(f.store,join(f.root,'automation.sqlite'));
    const data=new AutomationStore(f.store);
    data.initialize(Date.now());
    expect(data.state().emergencyStopped).toBe(true);
    expect(data.state().emergencyStop?.reason).toBe('UNEXPECTED_ORIGIN');
  } finally { await f.close(); }
});

test.each(['permission','hold'] as const)('observe denied by %s leaves a pending intent and receipts untouched',async denied=>{
  const f=await fixture();
  try{
    const event=candidate(),draft=approved(f.store,event),id=f.store.recordIntent(draft,snapshot(event),false);
    if(denied==='hold')holdSecurityChannel(f.store,event.channel,{incidentId:'cli-pending',reason:'OBSERVATION_SECURITY_SUSPECT',mode:'headless'});
    const launch=mockBrowser();
    const run=denied==='hold'?f.run('observe','dm'):main(['observe','dm','--runtime',f.root]);
    await expect(run).rejects.toThrow(denied==='hold'?'SECURITY_CHANNEL_HELD':'EXPLICIT_PRIVATE_ACCESS_REQUIRED');
    expect(launch).not.toHaveBeenCalled();
    expect(f.store.db.prepare('SELECT status FROM send_intents WHERE id=?').get(id)).toEqual({status:'INTENT_RECORDED'});
    expect(f.store.db.prepare('SELECT id FROM delivery_receipts').all()).toEqual([]);
  }finally{await f.close();}
});

test.each(['notifications','dm','works'] as const)('observe %s opens the established URL with unrelated reply mappings broken',async source=>{
  const f=await fixture();
  try{
    const observation={...commentReplyMapping(origin).observation,environment:'douyin',entryUrl:origin+'/profile/fixture'};
    await writeFile(join(f.root,'observation-mapping.json'),JSON.stringify(observation));
    await writeFile(join(f.root,'site-mapping.json'),JSON.stringify({...mapping(origin),environment:'douyin'}));
    for(const file of ['dm-reply-mapping.json','comment-reply-mapping.json'])await writeFile(join(f.root,file),'{broken');
    const launch=mockBrowser();vi.spyOn(stdout,'write').mockReturnValue(true);
    const read=source==='notifications'
      ?vi.spyOn(DomAdapter.prototype,'observeNotifications').mockResolvedValue({events:[],loaded:0,evidenceId:'fixture'})
      :vi.spyOn(ObservedReader.prototype,source==='dm'?'dm':'comments').mockResolvedValue({events:[],loaded:0,unsupported:0,evidenceId:'fixture'});
    await f.run('observe',source);
    expect(read).toHaveBeenCalledOnce();
    const owner=await launch.mock.results[0]!.value;
    expect(vi.mocked(owner.open).mock.calls[0]?.[0]).toBe(source==='notifications'?origin:observation.entryUrl);
  }finally{await f.close();}
});

test('login uses the connector for the headed account homepage and still requires an interactive terminal',async()=>{
  const f=await fixture();
  try{
    const launch=mockBrowser(),login=vi.spyOn(DouyinPlatformConnector.prototype,'beginLoginRecovery');
    const current=Object.getOwnPropertyDescriptor(stdin,'isTTY');
    Object.defineProperty(stdin,'isTTY',{value:false,configurable:true});
    try{await expect(f.run('login','--headed')).rejects.toThrow('INTERACTIVE_TERMINAL_REQUIRED');}
    finally{if(current)Object.defineProperty(stdin,'isTTY',current);else Reflect.deleteProperty(stdin,'isTTY');}
    expect(login).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledExactlyOnceWith(join(f.root,'profile'),false);
    const owner=await launch.mock.results[0]!.value;
    expect(owner.open).toHaveBeenCalledWith(origin,undefined);
    expect(owner.close).toHaveBeenCalledOnce();
  }finally{await f.close();}
});

test.each([true,false])('real-test checks both channel pages before attestation (DM blocked: %s)',async blocked=>{
  const f=await fixture();
  try{
    await writeFile(join(f.root,'site-mapping.json'),JSON.stringify({...mapping(origin),environment:'douyin'}));
    const launch=mockBrowser(),calls:{channel:string;page:DomAdapter['page']}[]=[];
    const verify=vi.spyOn(DouyinPlatformConnector.prototype,'verifyManualCheck');
    vi.spyOn(DomAdapter.prototype,'guard').mockImplementation(async function(this:DomAdapter){
      calls.push({channel:this.channel,page:this.page});
      if(blocked&&this.channel==='DIRECT_MESSAGE')throw new Blocked('ACCOUNT_NOT_VERIFIED');
    });
    const current=Object.getOwnPropertyDescriptor(stdin,'isTTY');
    Object.defineProperty(stdin,'isTTY',{value:false,configurable:true});
    try{await expect(f.run('real-test','--case','C01')).rejects.toThrow(blocked?'ACCOUNT_NOT_VERIFIED':'INTERACTIVE_TERMINAL_REQUIRED');}
    finally{if(current)Object.defineProperty(stdin,'isTTY',current);else Reflect.deleteProperty(stdin,'isTTY');}
    expect(verify).toHaveBeenCalledOnce();
    const owner=await launch.mock.results[0]!.value;
    expect(calls).toEqual([{channel:'COMMENT_NOTIFICATION',page:owner.notification},{channel:'DIRECT_MESSAGE',page:owner.dm}]);
    expect(owner.close).toHaveBeenCalledOnce();
  }finally{await f.close();}
});

test('legacy send-once uses the connector and records intent before exactly one submission',async()=>{
  const f=await fixture();
  try{
    const event=candidate(),draft=approved(f.store,event),target=snapshot(event);
    await writeFile(join(f.root,'site-mapping.json'),JSON.stringify({...mapping(origin),environment:'douyin'}));
    mockBrowser();vi.spyOn(stdout,'write').mockReturnValue(true);
    const handle=vi.spyOn(DouyinPlatformConnector.prototype,'adapter'),send=vi.spyOn(SendCoordinator.prototype,'send');
    vi.spyOn(DomAdapter.prototype,'inspect').mockResolvedValue(target);
    vi.spyOn(DomAdapter.prototype,'prepare').mockResolvedValue();
    vi.spyOn(DomAdapter.prototype,'verifyPrepared').mockResolvedValue(target);
    vi.spyOn(DomAdapter.prototype,'baseline').mockResolvedValue([]);
    vi.spyOn(DomAdapter.prototype,'readback').mockResolvedValue(null);
    const click=vi.spyOn(DomAdapter.prototype,'clickOnce').mockResolvedValue();
    await f.run('send-once',draft);
    expect(handle).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    const [intent]=f.store.uncertain();
    expect(intent).toBeDefined();
    expect(click.mock.calls[0]?.[0]).toBe(f.store.intentBoundary(intent!.id));
  }finally{await f.close();}
});

test('legacy comment retry inspects through the connector and never authorizes without interactive approval',async()=>{
  const f=await fixture();
  try{
    const event=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',actorId:'200',videoId:'10',commentId:'11',
      platformEventId:'11',conversationId:null});
    const target=snapshot(event),draft=approved(f.store,event),intent=f.store.recordIntent(draft,target,false);
    f.store.receipt(intent,'UNCERTAIN','original');
    const native=commentReplyMapping(origin);native.observation.environment='douyin';
    f.store.db.prepare('UPDATE accounts SET own_id=?').run(native.observation.self.uid);
    await writeFile(join(f.root,'comment-reply-mapping.json'),JSON.stringify(native));
    const launch=mockBrowser(),handle=vi.spyOn(DouyinPlatformConnector.prototype,'adapter');
    const inspect=vi.spyOn(ObservedCommentReply.prototype,'inspect').mockResolvedValue(target);
    const click=vi.spyOn(ObservedCommentReply.prototype,'clickOnce');
    const current=Object.getOwnPropertyDescriptor(stdin,'isTTY');
    Object.defineProperty(stdin,'isTTY',{value:false,configurable:true});
    try{await expect(f.run('retry-comment-once',draft)).rejects.toThrow('INTERACTIVE_TERMINAL_REQUIRED');}
    finally{if(current)Object.defineProperty(stdin,'isTTY',current);else Reflect.deleteProperty(stdin,'isTTY');}
    expect(handle).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
    expect(f.store.stats().manualRetries).toEqual([]);
    expect(f.store.uncertain()).toMatchObject([{id:intent}]);
    expect(launch).toHaveBeenCalledExactlyOnceWith(join(f.root,'profile'),true);
  }finally{await f.close();}
});
