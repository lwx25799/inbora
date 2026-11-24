import { EventEmitter } from 'node:events';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, test, vi } from 'vitest';
import { BrowserService } from '../../src/app/browser-service.js';
import { ClientService } from '../../src/app/service.js';
import { WorkbenchAuthority } from '../../src/app/authority.js';
import { deliverCommand } from '../../src/app/service-delivery.js';
import { DouyinPlatformConnector } from '../../src/platform/douyin-platform-connector.js';
import { SecurityIncidents } from '../../src/app/security-incidents.js';
import { ObservedReader, captureObserved } from '../../src/adapters/observed-reader.js';
import { InboxCollector } from '../../src/app/inbox-collector.js';
import { AccountActor } from '../../src/browser/account-actor.js';
import type { BrowserProfileOwner } from '../../src/browser/profile-owner.js';
import * as runtime from '../../src/config/runtime.js';
import { validateObservationMapping } from '../../src/config/site-mapping.js';
import { ObservedCommentReply } from '../../src/adapters/observed-comment-reply.js';
import { SendCoordinator } from '../../src/core/send-coordinator.js';
import { ManualCommentRetry } from '../../src/core/manual-comment-retry.js';
import { emergencyRevision, recordEmergencyStop } from '../../src/storage/emergency-stop.js';
import { Blocked, digest, eventBinding } from '../../src/core/contracts.js';
import { AutomationStore } from '../../src/storage/automation-store.js';
import { migrateAutomation } from '../../src/storage/automation-migration.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { holdSecurityChannel, readSecurityHold, resolveSecurityHold, securityRevision } from '../../src/storage/security-holds.js';
import { EventStore } from '../../src/storage/store.js';
import { commentReplyMapping, dmReplyMapping, observedMapping } from '../fixtures/observed-site.js';
import { mapping } from '../fixtures/site.js';
import { approved, candidate, privateTemp, snapshot } from '../helpers.js';

const origin = 'https://www.douyin.com', event = candidate();

function fakeOwner() {
  const page = () => Object.assign(new EventEmitter(), { url: () => origin+'/', evaluate: vi.fn() });
  return { actor: new AccountActor(), context: new EventEmitter(), notification: page(), dm: page(),
    open: vi.fn(async () => {}), close: vi.fn(async () => {}), version: () => 'synthetic' };
}

test.each(['native', 'legacy'])('closure during %s mapping load discards the stale handle and identity', async kind => {
  const root = privateTemp('phase1-adapter-load-'), owner = fakeOwner();
  const browser = BrowserService.adopt(root, owner as unknown as BrowserProfileOwner, 'headless');
  const native = dmReplyMapping(origin), legacy = mapping(origin);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const delay = async <T>(result: T) => { entered.resolve(); await release.promise; return result; };
  const lookup = kind === 'native'
    ? vi.spyOn(runtime, 'loadDmReplyMapping').mockImplementationOnce(() => delay(native))
    : vi.spyOn(runtime, 'loadMapping').mockImplementationOnce(() => delay(legacy));
  const handle = browser.adapter(event);
  try {
    await entered.promise;
    owner.context.emit('close');
    release.resolve();
    await expect(handle.then(() => null, error => error.code)).resolves.toBe('BROWSER_CLOSED');
    expect(browser.identity(event.channel)).toBeNull();
  } finally {
    release.resolve();
    await handle.then(value => value.dispose(), () => {});
    lookup.mockRestore();
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a queued adapter task rejects a stale handle before touching the old page', async () => {
  const root = privateTemp('phase1-adapter-epoch-'), old = fakeOwner(), next = fakeOwner();
  const browser = new BrowserService(root, vi.fn()
    .mockResolvedValueOnce(old).mockResolvedValueOnce(next));
  try {
    await writeFile(join(root, 'site-mapping.json'), JSON.stringify({ ...mapping(origin), environment: 'douyin' }));
    const handle = await browser.adapter(event);
    const release = Promise.withResolvers<void>();
    const pending = old.actor.run(() => release.promise);
    const queued = old.actor.run(() => handle.adapter.prepare(event, 'fixture reply'));
    try {
      old.context.emit('close');
      await browser.open();
      expect(browser.actor).toBe(next.actor);
      release.resolve();
      await pending;
      await expect(queued).rejects.toMatchObject({ code: 'BROWSER_CLOSED' });
      await expect(next.actor.run(() => handle.adapter.prepare(event, 'fixture reply'))).rejects.toMatchObject({ code: 'BROWSER_CLOSED' });
      expect(old.dm.evaluate).not.toHaveBeenCalled();
      expect(next.dm.evaluate).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await queued.catch(() => {});
      handle.dispose();
    }
  } finally { await browser.close(); await rm(root, { recursive: true, force: true }); }
});

test('a closed browser can rebind its safety and manual recovery to another store', async () => {
  const root = privateTemp('phase1-browser-rebind-'), owner = fakeOwner();
  const browser = BrowserService.adopt(root, owner as unknown as BrowserProfileOwner, 'headless');
  let a: EventStore | undefined, b: EventStore | undefined;
  try {
    a = new EventStore(join(root, 'a.sqlite'), true);
    const second = b = new EventStore(join(root, 'b.sqlite'), true);
    browser.bindStore(a);
    expect(() => browser.bindStore(second)).toThrow('BROWSER_STORE_IN_USE');
    holdSecurityChannel(a,event.channel,{incidentId:'store-a',reason:'OBSERVATION_SECURITY_SUSPECT',mode:'headless'});
    await browser.close();
    a.close();
    browser.bindStore(second);
    holdSecurityChannel(second,event.channel,{incidentId:'store-b',reason:'OBSERVATION_SECURITY_SUSPECT',mode:'headless'});
    await expect(browser.adapter(event,second)).rejects.toThrow('SECURITY_CHANNEL_HELD');
    await expect(browser.securityRecovery({command:'securityRecovery',action:'start',channel:event.channel},'fixture',()=>{}))
      .rejects.toThrow('MANUAL_RECOVERY_HEADLESS_REQUIRED');
  } finally {
    try { await browser.close(); }
    finally {
      try { if (a?.db.open) a.close(); }
      finally { try { b?.close(); } finally { await rm(root, { recursive: true, force: true }); } }
    }
  }
});

test('a late collection fault from the closed owner cannot stop a freshly bound store', async () => {
  const root=privateTemp('phase1-collector-epoch-'),a=new EventStore(join(root,'a.sqlite'),true),
    b=new EventStore(join(root,'b.sqlite'),true),owner=fakeOwner();
  const browser=BrowserService.adopt(root,owner as unknown as BrowserProfileOwner,'headless');
  const started=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const observedFault=vi.fn();
  const collect=vi.spyOn(InboxCollector.prototype,'collect').mockImplementation(async(_source,_signal,fault)=>{
    started.resolve();await release.promise;expect(fault).toBeTypeOf('function');await fault!(new Blocked('UNEXPECTED_ORIGIN'));observedFault();
  });
  try{
    for(const [name,store] of [['a',a],['b',b]] as const){
      await migrateClient(store,join(root,name+'-client.sqlite'));
      await migrateAutomation(store,join(root,name+'-automation.sqlite'));
      new AutomationStore(store).initialize(Date.now());
    }
    await writeFile(join(root,'observation-mapping.json'),JSON.stringify({...observedMapping(origin),environment:'douyin'}));
    const data=new AutomationStore(a),next=new AutomationStore(b);
    const before=[a,b].map(store=>emergencyRevision(store));
    const turn=browser.collect(data,'works',new AbortController().signal).catch(error=>error);
    await Promise.race([started.promise,turn.then(error=>{if(error)throw error;})]);
    owner.context.emit('close');await browser.close();
    browser.bindStore(b);
    release.resolve();
    await expect(turn).resolves.toMatchObject({code:'BROWSER_CLOSED'});
    expect(observedFault).toHaveBeenCalledOnce();
    expect(data.state().emergencyStopped).toBe(false);
    expect(next.state().emergencyStopped).toBe(false);
    expect([a,b].map(store=>emergencyRevision(store))).toEqual(before);
  }finally{
    release.resolve();collect.mockRestore();
    await browser.close();a.close();b.close();await rm(root,{recursive:true,force:true});
  }
});

test.each(['close', 'epoch', 'stop', 'abort', 'refreeze', 'retry-stop', 'takeover', 'target pause', 'retry revoked'] as const)(
  'comment submission makes no submit page call after %s during the clock wait', async fault => {
    const root=privateTemp('phase1-comment-clock-'),store=new EventStore(join(root,'fixture.sqlite'),true);
    const owner=fakeOwner(),browser=BrowserService.adopt(root,owner as unknown as BrowserProfileOwner,'headless');
    const controller=new AbortController();
    const event=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',actorId:'200',videoId:'10',commentId:'11',
      platformEventId:'11',conversationId:null});
    const target=snapshot(event),draftId=approved(store,event);
    const native=commentReplyMapping(origin);
    native.submissionReceipts=false;
    const lookup=vi.spyOn(runtime,'loadCommentReplyMapping').mockResolvedValue(native);
    const inspect=vi.spyOn(ObservedCommentReply.prototype,'inspect').mockResolvedValue(target);
    const prepare=vi.spyOn(ObservedCommentReply.prototype,'prepare').mockResolvedValue();
    const arm=vi.spyOn(ObservedCommentReply.prototype,'verifyPrepared').mockImplementation(async function (this: ObservedCommentReply) {
      Object.assign(this,{token:'fixture-token'});return target;
    });
    const baseline=vi.spyOn(ObservedCommentReply.prototype,'baseline').mockResolvedValue([]);
    const read=vi.spyOn(ObservedCommentReply.prototype,'readback').mockResolvedValue(null);
    const entered=Promise.withResolvers<void>(),click=ObservedCommentReply.prototype.clickOnce;
    const attempt=vi.spyOn(ObservedCommentReply.prototype,'clickOnce').mockImplementation(function (this: ObservedCommentReply,...args) {
      entered.resolve();return click.apply(this,args);
    });
    let handle:Awaited<ReturnType<BrowserService['adapter']>>|undefined;
    try{
      handle=await browser.adapter(event,store,controller.signal);
      owner.notification.evaluate.mockResolvedValue(true);
      const retry=fault==='retry-stop'||fault==='retry revoked';
      let grant:string|undefined;
      if(retry){
        const original=store.recordIntent(draftId,target,false);
        store.receipt(original,'UNCERTAIN','original');
        grant=store.authorizeCommentRetry(draftId,target,'explicit fixture retry');
      }
      const draft=store.draft(draftId);
      let command:{authority:WorkbenchAuthority;token:string;id:string;params:Parameters<typeof deliverCommand>[3]}|undefined;
      if(fault==='takeover'||fault==='target pause'){
        await migrateClient(store,join(root,'client.sqlite'));
        store.invalidateApproval(draftId);
        const authority=new WorkbenchAuthority(store),token=authority.issueSession(),selectionId='fixture-selection';
        authority.select(token,draft.eventId,selectionId);
        const stored=store.event(draft.eventId),generation=authority.claim(token,stored.id,0).generation;
        const identity=browser.identity(event.channel)!;
        authority.attest(event.channel,'SEND_AVAILABLE',identity,'synthetic-evidence');
        authority.setMode(token,'MANUAL');
        vi.spyOn(browser,'refreshIdentity').mockResolvedValue(identity);
        const params={eventId:stored.id,draftId,draftVersion:draft.version,text:draft.text,generation,selectionId,contextVersion:authority.contextVersion(stored)};
        const {commandId:id}=authority.preview(token,params,target,identity);
        authority.queue(token,id,params,identity);command={authority,token,id,params};
      }
      vi.useFakeTimers({now:Date.now()});
      const send=command?deliverCommand({
        store,authority:command.authority,browser:new DouyinPlatformConnector(browser),getAutomation:()=>null,
        getVerification:()=>null,isClosing:()=>false,suspendForVisible:()=>{},resetOnlineAbort:()=>controller.signal,
        resumeAfterLogin:()=>{},bumpInboxRevision:()=>{},emit:()=>{},errorCode:error=>error instanceof Blocked?error.code:'UNCLASSIFIED',
      },command.token,command.id,command.params).then(()=>command!.authority.command(command!.id).status)
        :grant?new ManualCommentRetry(store,browser.actor).send(grant,handle.adapter,false)
        :new SendCoordinator(store,browser.actor).send(draftId,handle.adapter,false);
      await Promise.race([entered.promise,send.then(()=>{throw Error('SUBMISSION_WAIT_NOT_ENTERED');})]);
      if(retry)expect(store.stats().manualRetries).toMatchObject([{result:'INTENT_RECORDED'}]);
      else expect(store.event(store.draft(draftId).eventId).status).toBe('INTENT_RECORDED');
      let closing:Promise<void>|undefined;
      if(fault==='close')closing=browser.close();
      else if(fault==='epoch')owner.context.emit('close');
      else if(fault==='abort')controller.abort();
      else if(fault==='refreeze'){
        const hold=holdSecurityChannel(store,event.channel,{incidentId:'clock-hold',reason:'OBSERVATION_SECURITY_SUSPECT',mode:'headless'});
        resolveSecurityHold(store,event.channel,hold.revision);
      }else if(fault==='takeover')command!.authority.claim(command!.token,draft.eventId,command!.params.generation);
      else if(fault==='target pause')store.pause(target.targetKey,true);
      else if(fault==='retry revoked')store.revokeCommentRetry(grant!);
      else recordEmergencyStop(store,true,Date.now(),'MANUAL_EMERGENCY_STOP','MANUAL');
      await vi.advanceTimersByTimeAsync(1100);
      await expect(send).resolves.toBe('UNCERTAIN');
      await closing;
      expect(attempt).toHaveBeenCalledOnce();
      expect(owner.notification.evaluate.mock.calls.filter(([action])=>String(action).includes('gate.submit()'))).toEqual([]);
      expect(read).not.toHaveBeenCalled();
      expect(store.uncertain()).toHaveLength(1);
      if(retry)expect(store.stats().manualRetries).toMatchObject([{result:'UNCERTAIN'}]);
      if(command){
        const code=fault==='takeover'?'OWNERSHIP_CHANGED':'TARGET_PAUSED';
        expect(command.authority.command(command.id)).toMatchObject({status:'UNCERTAIN',reason:`POST_INTENT_FAILURE:DISPATCH:${code}`});
        expect(command.authority.queue(command.token,command.id,command.params,browser.identity(event.channel))).toBe(false);
      }
      if(fault==='retry revoked'){
        await expect(new ManualCommentRetry(store,browser.actor).send(grant!,handle.adapter,false)).rejects.toThrow('AUTHORIZATION_REVOKED');
      }
    }finally{
      vi.useRealTimers();handle?.dispose();
      for(const mock of [lookup,inspect,prepare,arm,baseline,read,attempt])mock.mockRestore();
      await browser.close();store.close();await rm(root,{recursive:true,force:true});
    }
  });

test.each(['service close','owner epoch','new hold','operator revoked'] as const)(
  'recovery preserves the freeze when %s invalidates the held document check',async fault=>{
    const root=privateTemp('phase1-hold-race-'),store=new EventStore(join(root,'fixture.sqlite'),true);
    const owner=fakeOwner(),browser=BrowserService.adopt(root,owner as unknown as BrowserProfileOwner,'headless');
    const mapping=validateObservationMapping({...observedMapping(origin),entryUrl:origin+'/',environment:'douyin'},true);
    const channel='COMMENT_NOTIFICATION',entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
    const incident=vi.spyOn(SecurityIncidents.prototype,'readRecovery').mockImplementation(async id=>({
      version:1,id,channel,createdAt:Date.now(),context:{mode:'headless',epoch:0,instanceId:null,selectors:[],mappingDigest:digest(mapping)},
      initial:null,afterFailure:null,afterScreenshot:null,frames:[],sameDocument:false,screenshot:null,incomplete:[],fromFallback:true,
    }));
    const guard=vi.spyOn(ObservedReader.prototype,'guard').mockResolvedValue();
    let service:ClientService|undefined,recovery:Promise<unknown>|undefined,closed:Promise<void>|undefined;
    const closeGate=Promise.withResolvers<void>();
    try{
      await migrateClient(store,join(root,'client.sqlite'));
      await writeFile(join(root,'observation-mapping.json'),JSON.stringify(mapping));
      store.bindAccount(mapping.self.uid);
      service=new ClientService(store,browser);await service.loadSettings();
      const token=service.authority.issueSession();
      const held=holdSecurityChannel(store,channel,{incidentId:'original',reason:'OBSERVATION_SECURITY_SUSPECT',mode:'headless'});
      owner.notification.url=()=>mapping.entryUrl;
      owner.notification.evaluate.mockImplementation(async action=>{
        if(action===captureObserved){entered.resolve();await release.promise;return {};}
        return {href:mapping.entryUrl,started:1};
      });
      const run=service.dispatch(token,{command:'resume',eventId:null});
      recovery=run.catch(error=>error);
      await Promise.race([entered.promise,run.then(()=>{throw Error('RECOVERY_READ_NOT_REACHED');})]);
      if(fault==='service close'){
        const activeKnowledge=(service as unknown as {knowledge:{cancelActiveParse():Promise<void>}}).knowledge;
        const cancel=vi.spyOn(activeKnowledge,'cancelActiveParse').mockReturnValueOnce(closeGate.promise);
        closed=service.close();expect(cancel).toHaveBeenCalledOnce();
      }else if(fault==='owner epoch')owner.context.emit('close');
      else if(fault==='operator revoked')service.authority.revoke(token);
      else holdSecurityChannel(store,channel,{incidentId:'replacement',reason:'OBSERVATION_SECURITY_SUSPECT',mode:'headless'});
      const revision=securityRevision(store,channel);
      release.resolve();
      expect(await recovery).toMatchObject({code:({
        'service close':'CLIENT_CLOSING','owner epoch':'BROWSER_CLOSED','new hold':'SECURITY_RECOVERY_CHANGED','operator revoked':'OPERATOR_EXPIRED',
      })[fault]});
      expect(incident).toHaveBeenCalledOnce();expect(guard).toHaveBeenCalledOnce();
      expect(securityRevision(store,channel)).toBe(revision);
      expect(readSecurityHold(store,channel)?.incidentId).toBe(fault==='new hold'?'replacement':held.incidentId);
      expect(store.db.prepare("SELECT id FROM audit_events WHERE event_type='SECURITY_CHANNEL_RESOLVED'").all()).toEqual([]);
    }finally{
      release.resolve();closeGate.resolve();await recovery;
      if(closed)await closed;else await service?.close();
      await browser.close();incident.mockRestore();guard.mockRestore();vi.restoreAllMocks();
      store.close();await rm(root,{recursive:true,force:true});
    }
  });

test('native comment cancellation removes its armed listener before the coordinator reports a pre-intent failure',async()=>{
  const root=privateTemp('phase1-native-cancel-');
  const owner=fakeOwner(),browser=BrowserService.adopt(root,owner as unknown as BrowserProfileOwner,'headless');
  let store:EventStore|undefined,handle:Awaited<ReturnType<BrowserService['adapter']>>|undefined;
  try{
    store=new EventStore(join(root,'fixture.sqlite'),true);
    const event=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',actorId:'200',videoId:'10',commentId:'11',
      platformEventId:'11',conversationId:null});
    const mapped=commentReplyMapping(origin);mapped.submissionReceipts=false;
    const own=mapped.observation.self.uid;
    store.observe(event.channel,'notifications',[],own,'fixture',new Date(Date.parse(event.occurredAt!)-1000).toISOString());
    const [eventId]=store.observe(event.channel,'notifications',[event],own,'fixture');
    const draft=store.saveDraft(eventId!,'fixture reply','mock');
    vi.spyOn(runtime,'loadCommentReplyMapping').mockResolvedValue(mapped);
    const inspect=vi.spyOn(ObservedCommentReply.prototype,'inspect');
    vi.spyOn(ObservedCommentReply.prototype,'prepare').mockImplementation(async function(this:ObservedCommentReply,e,text){
      Object.assign(this,{prepared:{binding:eventBinding(e),text,shape:'fixture'}});
    });
    const baseline=vi.spyOn(ObservedCommentReply.prototype,'baseline').mockRejectedValue(new Blocked('COMMENT_REPLY_DOM_CHANGED'));
    let gateToken:string|undefined;
    owner.notification.evaluate.mockImplementation(async(action,input)=>{
      if(input?.action==='arm'){gateToken=input.token;return {context:[]};}
      if(typeof input==='string'&&input===gateToken&&String(action).includes('gate.remove()'))gateToken=undefined;
      return null;
    });
    handle=await browser.adapter(event,store);
    // Match the pre-preparation snapshot to the actual arm snapshot so the failure occurs at baseline.
    await handle.adapter.prepare(event,draft.text);
    const prepared=await handle.adapter.verifyPrepared(event,draft.text);
    store.approve(draft.id,prepared,draft.version,draft.text);
    inspect.mockResolvedValue(prepared);
    await expect(new SendCoordinator(store,browser.actor).send(draft.id,handle.adapter,false)).rejects.toThrow('COMMENT_REPLY_DOM_CHANGED');
    expect(baseline).toHaveBeenCalledOnce();
    const armed=owner.notification.evaluate.mock.calls.filter(([,input])=>input?.action==='arm');
    expect(armed).toHaveLength(2);
    const last=armed.at(-1)![1].token;
    expect(owner.notification.evaluate.mock.calls.some(([action,input])=>input===last&&String(action).includes('gate.remove()'))).toBe(true);
    expect(gateToken).toBeUndefined();
    expect(store.db.prepare('SELECT id FROM send_intents').all()).toEqual([]);
  }finally{
    try{await handle?.dispose();}
    finally{
      try{await browser.close();}
      finally{
        try{vi.restoreAllMocks();}
        finally{try{store?.close();}finally{await rm(root,{recursive:true,force:true});}}
      }
    }
  }
});

test('native comment rearming keeps both old click listeners until the new ones are installed in the same page call',async()=>{
  const owner=fakeOwner(),event=candidate({channel:'COMMENT_NOTIFICATION',kind:'COMMENT',actorId:'200',videoId:'10',commentId:'11',
    occurredAt:'2026-11-04T01:00:00.000Z'}),
    mapping=commentReplyMapping(origin),text='fixture reply';
  const {observation}=mapping,s=observation.selectors;
  class PageNode {
    readonly isConnected=true;
    readonly selectors=new Map<string,PageNode[]>();
    readonly clicks=new Set<(event:unknown)=>void>();
    readonly remainingAfterRemoval:number[]=[];
    children:PageNode[]=[];
    childNodes:unknown[]=[];
    parentElement:PageNode|null=null;
    textContent='';
    innerText='';
    innerHTML='';
    isContentEditable=false;
    id='';
    constructor(readonly tagName='DIV',private readonly selector=''){}
    get firstElementChild(){return this.children[0];}
    matches(selector:string){return this.selector===selector;}
    closest(selector:string):PageNode|null{return this.matches(selector)?this:this.parentElement?.closest(selector)??null;}
    querySelectorAll(selector:string){return this.selectors.get(selector)??[];}
    querySelector(selector:string){return this.querySelectorAll(selector)[0]??null;}
    getClientRects(){return [{}];}
    getAttribute(name:string){return name==='href'?'/user/peer-sec':null;}
    contains(){return false;}
    addEventListener(_type:string,listener:(event:unknown)=>void){this.clicks.add(listener);}
    removeEventListener(_type:string,listener:(event:unknown)=>void){
      if(this.clicks.delete(listener))this.remainingAfterRemoval.push(this.clicks.size);
    }
  }
  const host=new PageNode(),button=new PageNode('BUTTON'),document=new PageNode(),self=new PageNode(),list=new PageNode(),
    root=new PageNode('DIV',s.commentRows),scope=new PageNode('DIV',mapping.composerScope),body=new PageNode(),
    editor=new PageNode(),contents=new PageNode(),block=new PageNode(),line=new PageNode('DIV','div.public-DraftStyleDefault-block'),
    tooltip=new PageNode(),author=new PageNode('A');
  const fiber=(node:PageNode,depth:number,props:unknown)=>{
    let data:unknown={memoizedProps:props};
    for(let level=0;level<depth;level++)data={return:data};
    Object.defineProperty(node,'__reactFiber$fixture',{value:data});
  };
  const awemeInfo={awemeId:event.videoId};
  fiber(self,s.selfFiberDepth,observation.self);
  fiber(root,s.commentFiberDepth,{level:1,awemeInfo,userInfo:{uid:'100'},
    commentInfo:{cid:event.commentId,replyId:'0',text:event.text,user:{uid:event.actorId,secUid:'peer-sec'},
      createTime:Date.parse(event.occurredAt!)/1000,status:1,replyComment:[],replyTotal:0}});
  fiber(scope,mapping.composerFiberDepth,{level:1,awemeInfo,cid:event.commentId});
  document.selectors.set(s.selfAvatar,[self]);document.selectors.set(s.commentList,[list]);
  list.selectors.set(s.commentRows,[root]);root.parentElement=list;
  root.selectors.set(s.commentText,[body]);root.selectors.set(s.commentTooltip,[tooltip]);root.selectors.set(s.commentAuthor,[author]);
  body.parentElement=tooltip.parentElement=author.parentElement=scope.parentElement=root;
  body.childNodes=[{nodeType:3,nodeValue:event.text}];tooltip.id='tooltip_11';
  root.selectors.set(mapping.composerScope,[scope]);scope.selectors.set(mapping.composer,[editor]);scope.selectors.set(mapping.send,[button]);
  editor.parentElement=button.parentElement=scope;
  editor.children=[contents];contents.parentElement=editor;contents.children=[block];block.parentElement=contents;block.children=[line];
  editor.selectors.set('[data-contents="true"]',[contents]);editor.selectors.set('[data-block="true"]',[block]);
  editor.isContentEditable=true;editor.textContent=editor.innerText=editor.innerHTML=text;
  const context={window:host,document:Object.assign(document,{title:''}),location:{origin,href:observation.works[0]!.url},
    Node:{TEXT_NODE:3},Element:PageNode,HTMLElement:PageNode,URL,
    getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1',pointerEvents:'auto'})};
  const adapter=new ObservedCommentReply(owner.notification as unknown as import('playwright').Page,mapping);
  Object.assign(adapter,{prepared:{binding:eventBinding(event),text,shape:editor.innerHTML}});
  let armingCalls=0,blocked=0;
  owner.notification.evaluate.mockImplementation(async(fn,input)=>{
    if(input?.action==='arm'&&++armingCalls===2){
      expect(host.clicks.size).toBe(1);
      expect(button.clicks.size).toBe(1);
      for(const oldListener of host.clicks)oldListener({composedPath:()=>[button,host],currentTarget:host,
        preventDefault:()=>{blocked++;},stopImmediatePropagation:()=>{}});
    }
    return runInNewContext(`(${fn.toString()})`,context)(input);
  });
  try{
    await adapter.verifyPrepared(event,text);
    owner.notification.evaluate.mockClear();
    await adapter.verifyPrepared(event,text);
    expect(owner.notification.evaluate).toHaveBeenCalledOnce();
    expect(blocked).toBe(1);
    expect(host.remainingAfterRemoval).toEqual([1]);
    expect(button.remainingAfterRemoval).toEqual([1]);
    await adapter.cancelPreparation();
    expect(host.clicks.size+button.clicks.size).toBe(0);
  }finally{await adapter.dispose();}
});
