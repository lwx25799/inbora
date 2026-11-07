#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { runtimeRoot, initRuntime, loadRuntime, loadMapping, loadObservationMapping, loadDmReplyMapping,loadCommentReplyMapping } from './config/runtime.js';
import { validateMapping, validateObservationMapping, validateDmReplyMapping,validateCommentReplyMapping } from './config/site-mapping.js';
import { OwnerLock } from './browser/owner-lock.js';
import { BrowserProfileOwner } from './browser/profile-owner.js';
import { DomAdapter } from './adapters/dom-adapter.js';
import { ObservedReader } from './adapters/observed-reader.js';
import { ObservedDmReply } from './adapters/observed-dm-reply.js';
import { ObservedCommentReply } from './adapters/observed-comment-reply.js';
import { EventStore } from './storage/store.js';
import { HttpDraftProvider, generateDraft } from './ai/draft-service.js';
import { Blocked, digest, requireSafe, targetKey, type ReplyAdapter } from './core/contracts.js';
import { SendCoordinator } from './core/send-coordinator.js';
import { ManualCommentRetry } from './core/manual-comment-retry.js';
import { diagnostic } from './observability/audit.js';
import { caseIds, pruneEvidence, recordEvidence } from './observability/evidence.js';
import { browserMetrics } from './observability/browser-metrics.js';
import { ClientService } from './app/service.js';
import { BrowserService } from './app/browser-service.js';
import { randomUUID } from 'node:crypto';
import { WorkbenchAuthority } from './app/authority.js';

const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')) as {version:string};
const help = `inbora ${manifest.version} · 单账号双通道内核 / 自动化客户端

pnpm inbora <command> [id] [options]
  init                         初始化私有运行目录（只执行一次）
  status                       脱敏任务状态、预算和未知态统计
  login --real-account --private-access --headed
  install-mapping --file PATH --real-account --private-access
  observe notifications|dm|works --real-account --private-access
  draft EVENT_ID                确定性 Mock 草稿；--real-model 需另行授权
  show EVENT_ID                 仅本机交互终端查看目标及草稿
  edit DRAFT_ID --file PATH     读取 UTF-8 文本，旧审批失效
  approve DRAFT_ID --real-account --private-access
  reject DRAFT_ID
  send-once DRAFT_ID --real-account --private-access
  calibrate-client DRAFT_ID --real-account --private-access
  retry-comment-once DRAFT_ID --real-account --private-access
  verify-comment DRAFT_ID --real-account --private-access
  pause EVENT_ID | resume EVENT_ID
  review-uncertain              查看未知态（仅人工核对，不提供自动重发）
  compare-modes --real-account --private-access
  real-test --case ID --real-account --private-access
  authorize-model --endpoint HTTPS_URL --model NAME
  prune-evidence               按本机配置保留期清理脱敏证据

通用选项：--runtime PATH（默认 %LOCALAPPDATA%\\inbora），--headed（默认），--headless。
默认 test:e2e 只访问本地合成页面。真实网页需本次显式声明访问权限。
观察需已校准映射；私信审批/发送需 dm-reply 或 site-mapping，一级评论回复需 comment-reply 或 site-mapping。帮助和 status 不访问网页。
schema3请在客户端生成人工/AI草稿；旧draft与独立approve入口在调用模型前拒绝，send-once使用统一服务交互确认。
calibrate-client仅校准当前准确草稿的受控GUI试用资格，不批准外发；schema3旧评论重试禁用。`;

async function ask(message: string): Promise<string> {
  requireSafe(stdin.isTTY && stdout.isTTY, 'INTERACTIVE_TERMINAL_REQUIRED');
  const rl = createInterface({ input: stdin, output: stdout });
  try { return await rl.question(message); } finally { rl.close(); }
}
function print(value: unknown): void { stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function safeCode(error: unknown): string { return error instanceof Blocked ? error.code : 'OPERATION_FAILED_PRIVATE_DIAGNOSTICS'; }

async function replyCommand(command:string,id:string,store:EventStore,browser:BrowserProfileOwner,adapter:ReplyAdapter,root:string,headless:boolean):Promise<void>{
  const d=store.draft(id),e=store.event(d.eventId);
  if(command==='calibrate-client'){
    requireSafe(store.db.pragma('user_version',{simple:true})===3,'CLIENT_MIGRATION_REQUIRED');
    const port=BrowserService.adopt(root,browser,headless?'headless':'headed'),handle=await port.adapter(e.payload);
    try{
      const snapshot=await browser.actor.run(()=>handle.adapter.inspect(e.payload));
      const evidence=await recordEvidence(join(root,'evidence'),{caseId:e.payload.channel==='DIRECT_MESSAGE'?'D04':'C03',browserVersion:browser.version(),
        mode:headless?'headless':'headed',taskId:e.id,action:'OBSERVE',result:'UNVERIFIED',source:'AUTOMATED_REAL',
        diagnostics:['CONTROLLED_GUI_TRIAL_READY','ONLY_CURRENT_TARGET_DRAFT_VERSION','NO_SEND_NO_APPROVAL'],proofDigest:digest(snapshot)});
      new WorkbenchAuthority(store).calibrateTrial(d.id,snapshot,port.identity(e.payload.channel)!,evidence);
      print({calibrated:true,eventId:e.id,draftVersion:d.version,evidenceId:evidence,sendApproved:false,expiresInSeconds:3600});
    }finally{handle.dispose();}return;
  }
  if(store.db.pragma('user_version',{simple:true})===3&&command==='approve'){
    requireSafe(false,'CLIENT_SCHEMA_CONFIRM_IN_GUI_OR_SEND_ONCE');
  }
  if(store.db.pragma('user_version',{simple:true})===3&&command==='send-once'){
    const service=new ClientService(store,BrowserService.adopt(root,browser,headless?'headless':'headed'));
    const token=service.authority.issueSession();
    try {
      const ownership=service.authority.ownership(e),claimed=service.authority.claim(token,e.id,ownership.generation),selectionId=randomUUID();
      service.authority.select(token,e.id,selectionId);
      const params={eventId:e.id,generation:claimed.generation,draftId:d.id,draftVersion:d.version,text:d.text,
        contextVersion:service.authority.contextVersion(e),selectionId};
      const preview=await service.dispatch(token,{command:'previewSend',params}) as {commandId:string};
      print({original:e.payload,approvedText:d.text,version:d.version,target:targetKey(e.payload)});
      const challenge=`APPROVE ${digest([preview.commandId,params]).slice(0,12)}`;
      requireSafe(await ask(`客户端统一门禁已预检。核对本条目标/全文后输入 ${challenge}：`)===challenge,'CANCELLED');
      // In schema 3 the CLI confirmation and dispatch are one operation, never a stale portable approval.
      await service.dispatch(token,{command:'submitManualSend',commandId:preview.commandId,params,confirmed:true});
      await service.drain();print(await service.dispatch(token,{command:'getSendResult',commandId:preview.commandId}));
    }finally{service.authority.revoke(token);}return;
  }
  if(command==='retry-comment-once'){
    requireSafe(e.payload.channel==='COMMENT_NOTIFICATION'&&e.status==='UNCERTAIN','MANUAL_RETRY_REQUIRES_UNKNOWN_COMMENT');
    const snapshot=await browser.actor.run(()=>adapter.inspect(e.payload));
    requireSafe(stdin.isTTY&&stdout.isTTY,'INTERACTIVE_TERMINAL_REQUIRED');
    print({original:e.payload,retryText:d.text,version:d.version,previousResult:'UNCERTAIN',oldIntentRetained:true});
    const challenge=`RETRY ${digest([d.id,d.version,d.text,snapshot]).slice(0,12)}`;
    requireSafe(await ask(`只批准再提交一次，原未知结果及可能迟到回复仍保留。输入 ${challenge}：`)===challenge,'CANCELLED');
    const grantId=store.authorizeCommentRetry(d.id,snapshot,challenge);
    const result=await new ManualCommentRetry(store,browser.actor).send(grantId,adapter,true);
    const evidenceId=await recordEvidence(join(root,'evidence'),{caseId:'N06',browserVersion:browser.version(),mode:headless?'headless':'headed',
      taskId:e.id,action:'SEND',result:result==='CONFIRMED'?'PASS':'BLOCKED',source:'AUTOMATED_REAL',
      diagnostics:['EXPLICIT_MANUAL_RETRY',result,'ORIGINAL_UNKNOWN_RETAINED'],proofDigest:digest(store.stats().manualRetries)});
    print({result,grantId,evidenceId,originalStillFrozen:true});return;
  }
  if(command==='approve'){
    const snapshot=await browser.actor.run(()=>adapter.inspect(e.payload));
    requireSafe(stdin.isTTY&&stdout.isTTY,'INTERACTIVE_TERMINAL_REQUIRED');
    print({original:e.payload,approvedText:d.text,version:d.version,target:snapshot.targetKey});
    const challenge=`APPROVE ${digest([d.id,d.version,d.text,snapshot]).slice(0,12)}`;
    requireSafe(await ask(`逐条核对账号、目标和文本。输入 ${challenge}：`)===challenge,'CANCELLED');
    store.approve(d.id,snapshot,d.version,d.text);print({approved:true});return;
  }
  const result=await new SendCoordinator(store,browser.actor).send(d.id,adapter,true);
  const evidenceId=await recordEvidence(join(root,'evidence'),{caseId:e.payload.channel==='DIRECT_MESSAGE'?'D05':'N06',
    browserVersion:browser.version(),mode:headless?'headless':'headed',taskId:e.id,action:'SEND',
    result:result==='CONFIRMED'?'PASS':'BLOCKED',source:'AUTOMATED_REAL',diagnostics:[result],proofDigest:digest(store.receiptForEvent(e.id))});
  print({result,evidenceId});
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, runtime: { type: 'string' },
    headed: { type: 'boolean' }, headless: { type: 'boolean' },
    'real-account': { type: 'boolean' }, 'private-access': { type: 'boolean' },
    file: { type: 'string' }, 'real-model': { type: 'boolean' }, endpoint: { type: 'string' }, model: { type: 'string' },
    case: { type: 'string' },
  } });
  if (values.help || positionals.length === 0) { stdout.write(`${help}\n`); return; }
  requireSafe(!(values.headed && values.headless), 'CONFLICTING_BROWSER_MODE');
  const command = positionals[0]!; const id = positionals[1];
  const known = ['init','status','login','install-mapping','observe','draft','show','edit','approve','reject','send-once','calibrate-client','retry-comment-once','verify-comment',
    'pause','resume','review-uncertain','compare-modes','real-test','authorize-model','prune-evidence'];
  requireSafe(known.includes(command), 'UNKNOWN_COMMAND');
  const root = runtimeRoot(values.runtime);
  // Dedicated control path: never calls recover() while another worker may own an active intent.
  if (command === 'pause') {
    requireSafe(id,'ID_REQUIRED'); await loadRuntime(root);
    const control = await OwnerLock.acquire(join(root,'control')); let controlStore: EventStore | undefined;
    try {
      controlStore = new EventStore(join(root,'poc.sqlite'));
      controlStore.pause(targetKey(controlStore.event(id).payload),true);
      print({paused:true,inFlightIntentMayAlreadyBeCommitted:true}); return;
    } finally { try { controlStore?.close(); } finally { await control.close(); } }
  }
  const lock = await OwnerLock.acquire(root);
  let store: EventStore | undefined; let browser: BrowserProfileOwner | undefined;
  const realAccess = (): void => requireSafe(values['real-account'] && values['private-access'], 'EXPLICIT_PRIVATE_ACCESS_REQUIRED');
  try {
    if (command === 'init') {
      await initRuntime(root); store = new EventStore(join(root, 'poc.sqlite'), true); print({ initialized: true }); return;
    }
    const config = await loadRuntime(root); store = new EventStore(join(root, 'poc.sqlite')); store.recover();
    if (command === 'status') { print(store.stats()); return; }
    if (command === 'install-mapping') {
      realAccess(); requireSafe(values.file, 'FILE_REQUIRED');
      const raw = JSON.parse(await readFile(values.file,'utf8')) as unknown;
      if(raw&&typeof raw==='object'&&'purpose' in raw&&raw.purpose==='comment-reply'){
        const mapping=validateCommentReplyMapping(raw,true);
        requireSafe(await ask(`安装已校准一级评论回复映射，账号摘要 ${digest(mapping.observation.self.uid).slice(0,12)}。每条发送仍需独立审批。输入 INSTALL：`)==='INSTALL','CANCELLED');
        store.bindAccount(mapping.observation.self.uid);
        await writeFile(join(root,'comment-reply-mapping.json'),JSON.stringify(mapping,null,2),{mode:0o600});
        print({installed:true,purpose:'comment-reply',individualApprovalRequired:true});return;
      }
      if(raw&&typeof raw==='object'&&'purpose' in raw&&raw.purpose==='dm-reply'){
        const mapping=validateDmReplyMapping(raw,true);
        requireSafe(await ask(`安装已校准私信回复映射，账号摘要 ${digest(mapping.observation.self.uid).slice(0,12)}。每条发送仍需独立审批。输入 INSTALL：`)==='INSTALL','CANCELLED');
        store.bindAccount(mapping.observation.self.uid);
        await writeFile(join(root,'dm-reply-mapping.json'),JSON.stringify(mapping,null,2),{mode:0o600});
        print({installed:true,purpose:'dm-reply',individualApprovalRequired:true});return;
      }
      if (raw && typeof raw === 'object' && 'purpose' in raw && raw.purpose === 'observation') {
        const mapping = validateObservationMapping(raw,true);
        requireSafe(await ask(`安装已校准只读映射，账号摘要 ${digest(mapping.self.uid).slice(0,12)}。不会启用发送。输入 INSTALL：`) === 'INSTALL','CANCELLED');
        store.bindAccount(mapping.self.uid);
        await writeFile(join(root,'observation-mapping.json'),JSON.stringify(mapping,null,2),{mode:0o600});
        print({installed:true,purpose:'observation',sendsEnabled:false}); return;
      }
      const mapping = validateMapping(raw, true);
      requireSafe(await ask(`仅安装已实际观察的网页映射。账号标识摘要 ${digest(mapping.ownId).slice(0,12)}。输入 INSTALL：`) === 'INSTALL', 'CANCELLED');
      store.bindAccount(mapping.ownId);
      await writeFile(join(root, 'site-mapping.json'), JSON.stringify(mapping, null, 2), { mode: 0o600 }); print({ installed: true }); return;
    }
    if (command === 'authorize-model') {
      requireSafe(values.endpoint && values.model, 'MODEL_ENDPOINT_REQUIRED');
      const url = new URL(values.endpoint);
      requireSafe(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'INVALID_MODEL_ENDPOINT');
      requireSafe(await ask(`将有限消息上下文发送至 ${url.host}，模型 ${values.model}。硬上限50次，可能付费，不自动重试。输入 AUTHORIZE：`) === 'AUTHORIZE', 'CANCELLED');
      config.modelGrant = { endpoint: url.href, model: values.model, approvedAt: new Date().toISOString() };
      await writeFile(join(root, 'runtime.json'), JSON.stringify(config, null, 2), { mode: 0o600 }); print({ authorized: true }); return;
    }
    if (command === 'prune-evidence') { print({ deleted: await pruneEvidence(join(root, 'evidence'), config.evidenceRetentionDays) }); return; }
    if (command === 'review-uncertain') {
      print(store.uncertain().map(i => ({ intentId: i.id, eventId: i.event_id, targetDigest: digest(i.target_key), status: i.status }))); return;
    }
    if (['draft','edit','show','reject','pause','resume'].includes(command)) {
      requireSafe(id, 'ID_REQUIRED');
      if (command === 'draft') {
        const provider = values['real-model'] ? new HttpDraftProvider(config.modelGrant, process.env.INBORA_MODEL_KEY) : undefined;
        print({ draftId: await generateDraft(store, id, provider) });
      } else if (command === 'edit') {
        requireSafe(values.file, 'FILE_REQUIRED'); const d = store.draft(id);
        const text=await readFile(values.file,'utf8');
        if(store.db.pragma('user_version',{simple:true})===3){
          const authority=new WorkbenchAuthority(store),token=authority.issueSession();
          try{const generation=authority.claim(token,d.eventId,authority.ownership(store.event(d.eventId)).generation).generation;
            print({draftId:authority.save(token,d.eventId,generation,d.version,text).id});authority.release(token,d.eventId,generation);
          }finally{authority.revoke(token);}
        }else print({ draftId: store.saveDraft(d.eventId, text, 'manual').id });
      } else if (command === 'show') {
        requireSafe(stdin.isTTY && stdout.isTTY, 'INTERACTIVE_TERMINAL_REQUIRED');
        const e = store.event(id); const draft = store.db.prepare('SELECT id FROM reply_drafts WHERE event_id=?').get(id) as { id: string } | undefined;
        print({ event: e, draft: draft ? store.draft(draft.id) : null });
      } else if (command === 'reject') { store.reject(id); print({ rejected: true }); }
      else { store.pause(targetKey(store.event(id).payload), command === 'pause'); print({ paused: command === 'pause' }); }
      return;
    }
    realAccess();
    if (command === 'login') {
      requireSafe(!values.headless, 'LOGIN_REQUIRES_HEADED');
      browser = await BrowserProfileOwner.launch(join(root, 'profile'), false); await browser.open('https://www.douyin.com');
      await ask('请在可见浏览器扫码或处理验证码。完成后按回车关闭并保存专属 Profile（不代表身份核验通过）：');
      print({ profileSaved: true, identityVerified: false, browserVersion: browser.version() }); return;
    }
    if (command === 'observe' && ['dm','works'].includes(id ?? '')) {
      const observation = await loadObservationMapping(root);
      if (observation) {
        browser = await BrowserProfileOwner.launch(join(root,'profile'),values.headless ?? false);
        await browser.open(observation.entryUrl);
        const reader = new ObservedReader(id === 'dm' ? browser.dm : browser.notification,observation);
        const result = await browser.actor.run(async()=>{
          const tasks: string[] = []; let loaded = 0, unsupported = 0;
          const count = id === 'dm' ? observation.peers.length : observation.works.length;
          for (let index = 0; index < count; index++) {
            const batch = id === 'dm' ? await reader.dm(index) : await reader.comments(index);
            const evidenceId = await recordEvidence(join(root,'evidence'),{caseId:id === 'dm'?'D01':'N01',
              browserVersion:browser!.version(),mode:values.headless?'headless':'headed',taskId:null,action:'OBSERVE',
              result:'UNVERIFIED',source:'AUTOMATED_REAL',diagnostics:['READ_ONLY_CAPTURE_COMPLETE',
                id === 'dm'?'PERMITTED_CONVERSATION':'ALLOWED_WORK_FALLBACK','SEND_UNVERIFIED'],proofDigest:digest(batch)});
            const scope = id === 'dm' ? observation.peers[index]!.conversationId : `work:${observation.works[index]!.id}`;
            tasks.push(...store!.observe(id === 'dm'?'DIRECT_MESSAGE':'COMMENT_NOTIFICATION',scope,
              batch.events.map(e=>({...e,evidenceId})),observation.self.uid,evidenceId));
            loaded += batch.loaded; unsupported += batch.unsupported;
          }
          return {newEventIds:tasks,loaded,unsupported,sendsEnabled:false};
        });
        print(result); return;
      }
      requireSafe(id !== 'works','OBSERVATION_MAPPING_REQUIRED');
    }
    if(['approve','send-once','calibrate-client','retry-comment-once','verify-comment'].includes(command)){
      requireSafe(id,'DRAFT_ID_REQUIRED');
      const event=store.event(store.draft(id).eventId);
      if(command==='verify-comment'){
        requireSafe(event.payload.channel==='COMMENT_NOTIFICATION','COMMENT_REPLY_SCOPE_REQUIRED');
        const native=await loadCommentReplyMapping(root);requireSafe(native,'NATIVE_COMMENT_REPLY_MAPPING_REQUIRED');
        const retry=(store.stats().manualRetries as {retryId:string;eventId:string}[]).find(r=>r.eventId===event.id);
        const intent=store.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(event.id) as {id:string}|undefined;
        requireSafe(intent,'COMMENT_REPLY_INTENT_REQUIRED');
        const boundary=retry?store.commentRetryBoundary(retry.retryId):store.intentBoundary(intent.id);
        browser=await BrowserProfileOwner.launch(join(root,'profile'),values.headless??false);
        const adapter=new ObservedCommentReply(browser.notification,native);
        try{
          const proof=await browser.actor.run(()=>adapter.verifyExisting(event.payload,store!.draft(id).text,boundary));
          const evidenceId=await recordEvidence(join(root,'evidence'),{caseId:'C05',browserVersion:browser.version(),mode:values.headless?'headless':'headed',
            taskId:event.id,action:'OBSERVE',result:proof?'PASS':'BLOCKED',source:'AUTOMATED_REAL',
            diagnostics:['AUTOMATED_READ_ONLY_RECHECK',proof?'BOUND_PROOF':'NO_BOUND_PROOF','ORIGINAL_RECEIPTS_RETAINED'],proofDigest:proof?digest(proof):null});
          print({verified:!!proof,evidenceId,originalReceiptsRetained:true});
        }finally{adapter.dispose();}return;
      }
      if(command==='retry-comment-once')requireSafe(event.payload.channel==='COMMENT_NOTIFICATION','MANUAL_RETRY_REQUIRES_UNKNOWN_COMMENT');
      if(event.payload.channel==='DIRECT_MESSAGE'){
        const native=await loadDmReplyMapping(root);
        if(native){
          browser=await BrowserProfileOwner.launch(join(root,'profile'),values.headless??false);await browser.open(native.observation.entryUrl);
          await replyCommand(command,id,store,browser,new ObservedDmReply(browser.dm,native),root,values.headless??false);return;
        }
      }else{
        const native=await loadCommentReplyMapping(root);
        if(native){
          browser=await BrowserProfileOwner.launch(join(root,'profile'),values.headless??false);await browser.open(native.observation.entryUrl);
          await replyCommand(command,id,store,browser,new ObservedCommentReply(browser.notification,native),root,values.headless??false);return;
        }
      }
    }
    requireSafe(command!=='retry-comment-once','NATIVE_COMMENT_REPLY_MAPPING_REQUIRED');
    const mapping = await loadMapping(root);
    if (command === 'compare-modes') {
      const results: unknown[] = [];
      for (const headless of [false, true]) {
        const start = performance.now(); const cpu = process.cpuUsage();
        browser = await BrowserProfileOwner.launch(join(root, 'profile'), headless);
        try {
          await browser.open(mapping.origin);
          const notification = new DomAdapter(browser.notification, 'COMMENT_NOTIFICATION', mapping);
          const dm = new DomAdapter(browser.dm, 'DIRECT_MESSAGE', mapping);
          await browser.actor.run(async () => {
            await notification.observeNotifications();
            for (const conversation of await dm.conversations()) await dm.observeDm(conversation.id, conversation.peerId);
          });
          const evidenceId = await recordEvidence(join(root, 'evidence'), { caseId: 'H01', browserVersion: browser.version(),
            mode: headless ? 'headless' : 'headed', taskId: null, action: 'MODE_COMPARE', result: 'PASS', source: 'AUTOMATED_REAL',
            diagnostics: ['READ_ONLY_CHANNELS_PASSED_SEND_UNVERIFIED'], proofDigest: digest(mapping) });
          results.push({ headless, evidenceId, readOnly: 'PASS', sends: 'UNVERIFIED', elapsedMs: Math.round(performance.now()-start),
            nodeRssBytes: process.memoryUsage().rss, nodeCpuMicros: process.cpuUsage(cpu), browser:await browserMetrics() });
        } catch (error) {
          const evidenceId = await recordEvidence(join(root, 'evidence'), { caseId: 'H01', browserVersion: browser.version(),
            mode: headless ? 'headless' : 'headed', taskId: null, action: 'MODE_COMPARE', result: 'BLOCKED', source: 'AUTOMATED_REAL',
            diagnostics: [safeCode(error)], proofDigest: null }); results.push({ headless, evidenceId, result: 'BLOCKED' });
        } finally { await browser.close(); browser = undefined; }
      }
      print({ results, conclusion: 'SEND_COMPARISON_REQUIRES_INDIVIDUAL_APPROVAL' }); return;
    }
    browser = await BrowserProfileOwner.launch(join(root, 'profile'), values.headless ?? false); await browser.open(mapping.origin);
    const notification = new DomAdapter(browser.notification, 'COMMENT_NOTIFICATION', mapping);
    const dm = new DomAdapter(browser.dm, 'DIRECT_MESSAGE', mapping);
    if (command === 'observe') {
      const ids = await browser.actor.run(async () => {
        if (id === 'notifications') {
          const batch = await notification.observeNotifications();
          return store!.observe('COMMENT_NOTIFICATION', 'notifications', batch.events, mapping.ownId, batch.evidenceId);
        }
        requireSafe(id === 'dm', 'CHANNEL_REQUIRED'); const collected: string[] = [];
        for (const conversation of await dm.conversations()) {
          const batch = await dm.observeDm(conversation.id, conversation.peerId);
          collected.push(...store!.observe('DIRECT_MESSAGE', conversation.id, batch.events, mapping.ownId, batch.evidenceId));
        }
        return collected;
      }); print({ newEventIds: ids }); return;
    }
    if (command === 'real-test') {
      requireSafe(values.case && caseIds.includes(values.case as typeof caseIds[number]), 'VALID_CASE_REQUIRED');
      await browser.actor.run(async () => { await notification.guard(); await dm.guard(); });
      const answer = await ask(`按 tests/manual/real-account-checklist.md 执行 ${values.case}。输入 PASS / FAIL / BLOCKED；此记录为人工声明，不能替代自动收据：`);
      requireSafe(['PASS','FAIL','BLOCKED'].includes(answer), 'INVALID_RESULT');
      const evidenceId = await recordEvidence(join(root, 'evidence'), { caseId: values.case as typeof caseIds[number], browserVersion: browser.version(),
        mode: values.headless ? 'headless' : 'headed', taskId: null, action: 'MANUAL_CHECK', result: answer as 'PASS'|'FAIL'|'BLOCKED',
        source: 'MANUAL_ATTESTATION', diagnostics: ['CHECKLIST_MANUAL_ATTESTATION'], proofDigest: digest(mapping) });
      print({ evidenceId, source: 'MANUAL_ATTESTATION' }); return;
    }
    requireSafe(id && ['approve','send-once'].includes(command), 'DRAFT_ID_REQUIRED');
    const event=store.event(store.draft(id).eventId);
    await replyCommand(command,id,store,browser,event.payload.channel==='DIRECT_MESSAGE'?dm:notification,root,values.headless??false);
  } finally {
    try { if (browser) await browser.close(); }
    finally { try { if (store) store.close(); } finally { await lock.close(); } }
  }
}

main().catch(error => { diagnostic(safeCode(error)); process.exitCode = 1; });
