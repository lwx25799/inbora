#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { runtimeRoot, initRuntime, loadRuntime } from './config/runtime.js';
import { validateMapping, validateObservationMapping, validateDmReplyMapping,validateCommentReplyMapping } from './config/site-mapping.js';
import { OwnerLock } from './browser/owner-lock.js';
import { EventStore } from './storage/store.js';
import { assertSecurityChannelClear } from './storage/security-holds.js';
import { HttpDraftProvider, generateDraft } from './ai/draft-service.js';
import { Blocked, digest, requireSafe, targetKey } from './core/contracts.js';
import { SendCoordinator } from './core/send-coordinator.js';
import { ManualCommentRetry } from './core/manual-comment-retry.js';
import { diagnostic } from './observability/audit.js';
import { caseIds, recordEvidence } from './observability/evidence.js';
import {readDiagnostics} from './app/diagnostics.js';
import {EvidenceMaintenance} from './app/evidence-maintenance.js';
import { ClientService } from './app/service.js';
import { BrowserService } from './app/browser-service.js';
import { DouyinPlatformConnector } from './platform/douyin-platform-connector.js';
import type { PlatformConnector } from './platform/platform-connector.js';
import { randomUUID } from 'node:crypto';
import { WorkbenchAuthority } from './app/authority.js';

const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')) as {version:string};
const help = `inbora ${manifest.version} · 单账号双通道内核 / 自动化客户端

pnpm inbora <command> [id] [options]
  init                         初始化私有运行目录（只执行一次）
  status                       脱敏任务状态、预算和未知态统计
  diagnostics                  只读累计模型用量、耗时及当前阻塞统计
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
  compare-modes                历史模式比较已停用，保留既有证据
  real-test --case ID --real-account --private-access
  authorize-model --endpoint HTTPS_URL --model NAME
  prune-evidence [--dry-run]    保护持久引用，报告或分批清理过期证据元数据

通用选项：--runtime PATH（默认 %LOCALAPPDATA%\\inbora），普通操作默认 --headless；--headed 仅供 login 登录或验证码恢复。
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

async function replyCommand(command:string,id:string,store:EventStore,port:PlatformConnector):Promise<void>{
  const d=store.draft(id),e=store.event(d.eventId),root=port.root;
  if(command==='calibrate-client'){
    requireSafe(store.db.pragma('user_version',{simple:true})===3,'CLIENT_MIGRATION_REQUIRED');
    const handle=await port.adapter(e.payload,store,undefined,{nativeReplyOnly:true});
    try{
      const snapshot=await port.actor.run(()=>handle.adapter.inspect(e.payload));
      const evidence=await recordEvidence(join(root,'evidence'),{caseId:e.payload.channel==='DIRECT_MESSAGE'?'D04':'C03',browserVersion:port.status().version!,
        mode:port.status().mode,taskId:e.id,action:'OBSERVE',result:'UNVERIFIED',source:'AUTOMATED_REAL',
        diagnostics:['CONTROLLED_GUI_TRIAL_READY','ONLY_CURRENT_TARGET_DRAFT_VERSION','NO_SEND_NO_APPROVAL'],proofDigest:digest(snapshot)});
      new WorkbenchAuthority(store).calibrateTrial(d.id,snapshot,port.identity(e.payload.channel)!,evidence);
      print({calibrated:true,eventId:e.id,draftVersion:d.version,evidenceId:evidence,sendApproved:false,expiresInSeconds:3600});
    }finally{await handle.dispose();}return;
  }
  if(store.db.pragma('user_version',{simple:true})===3&&command==='approve'){
    requireSafe(false,'CLIENT_SCHEMA_CONFIRM_IN_GUI_OR_SEND_ONCE');
  }
  if(store.db.pragma('user_version',{simple:true})===3&&command==='send-once'){
    const service=new ClientService(store,port);
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
  const retry=command==='retry-comment-once';
  if(retry)requireSafe(e.payload.channel==='COMMENT_NOTIFICATION'&&e.status==='UNCERTAIN','MANUAL_RETRY_REQUIRES_UNKNOWN_COMMENT');
  const handle=await port.adapter(e.payload,store,undefined,{nativeCommentOnly:retry});
  const {adapter}=handle;
  try{
  const {mode,version}=port.status();requireSafe(version,'BROWSER_NOT_RUNNING');
  if(retry){
    const snapshot=await port.actor.run(()=>adapter.inspect(e.payload));
    requireSafe(stdin.isTTY&&stdout.isTTY,'INTERACTIVE_TERMINAL_REQUIRED');
    print({original:e.payload,retryText:d.text,version:d.version,previousResult:'UNCERTAIN',oldIntentRetained:true});
    const challenge=`RETRY ${digest([d.id,d.version,d.text,snapshot]).slice(0,12)}`;
    requireSafe(await ask(`只批准再提交一次，原未知结果及可能迟到回复仍保留。输入 ${challenge}：`)===challenge,'CANCELLED');
    const grantId=store.authorizeCommentRetry(d.id,snapshot,challenge);
    const result=await new ManualCommentRetry(store,port.actor).send(grantId,adapter,true);
    const evidenceId=await recordEvidence(join(root,'evidence'),{caseId:'N06',browserVersion:version,mode,
      taskId:e.id,action:'SEND',result:result==='CONFIRMED'?'PASS':'BLOCKED',source:'AUTOMATED_REAL',
      diagnostics:['EXPLICIT_MANUAL_RETRY',result,'ORIGINAL_UNKNOWN_RETAINED'],proofDigest:digest(store.stats().manualRetries)});
    print({result,grantId,evidenceId,originalStillFrozen:true});return;
  }
  if(command==='approve'){
    const snapshot=await port.actor.run(()=>adapter.inspect(e.payload));
    requireSafe(stdin.isTTY&&stdout.isTTY,'INTERACTIVE_TERMINAL_REQUIRED');
    print({original:e.payload,approvedText:d.text,version:d.version,target:snapshot.targetKey});
    const challenge=`APPROVE ${digest([d.id,d.version,d.text,snapshot]).slice(0,12)}`;
    requireSafe(await ask(`逐条核对账号、目标和文本。输入 ${challenge}：`)===challenge,'CANCELLED');
    store.approve(d.id,snapshot,d.version,d.text);print({approved:true});return;
  }
  const result=await new SendCoordinator(store,port.actor,store.accountId).send(d.id,adapter,true);
  const evidenceId=await recordEvidence(join(root,'evidence'),{caseId:e.payload.channel==='DIRECT_MESSAGE'?'D05':'N06',
    browserVersion:version,mode,taskId:e.id,action:'SEND',
    result:result==='CONFIRMED'?'PASS':'BLOCKED',source:'AUTOMATED_REAL',diagnostics:[result],proofDigest:digest(store.receiptForEvent(e.id))});
  print({result,evidenceId});
  }finally{await handle.dispose();}
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, runtime: { type: 'string' },
    headed: { type: 'boolean' }, headless: { type: 'boolean' },
    'real-account': { type: 'boolean' }, 'private-access': { type: 'boolean' },
    file: { type: 'string' }, 'real-model': { type: 'boolean' }, endpoint: { type: 'string' }, model: { type: 'string' },
    case: { type: 'string' },'dry-run':{type:'boolean'},
  } });
  if (values.help || positionals.length === 0) { stdout.write(`${help}\n`); return; }
  requireSafe(!(values.headed && values.headless), 'CONFLICTING_BROWSER_MODE');
  const command = positionals[0]!; const id = positionals[1];
  const known = ['init','status','login','install-mapping','observe','draft','show','edit','approve','reject','send-once','calibrate-client','retry-comment-once','verify-comment',
    'pause','resume','review-uncertain','compare-modes','real-test','authorize-model','prune-evidence','diagnostics'];
  requireSafe(known.includes(command), 'UNKNOWN_COMMAND');
  requireSafe(!values.headed||command==='login','HEADED_ONLY_FOR_LOGIN');
  requireSafe(command!=='compare-modes','BROWSER_MODE_COMPARISON_DISABLED');
  requireSafe(command!=='login'||!values.headless,'LOGIN_REQUIRES_HEADED');
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
  let store: EventStore | undefined;
  let connector: PlatformConnector | undefined;
  const realAccess = (): void => requireSafe(values['real-account'] && values['private-access'], 'EXPLICIT_PRIVATE_ACCESS_REQUIRED');
  try {
    if (command === 'init') {
      await initRuntime(root); store = new EventStore(join(root, 'poc.sqlite'), true); print({ initialized: true }); return;
    }
    const config = await loadRuntime(root); store = new EventStore(join(root, 'poc.sqlite'));
    if(!['diagnostics','prune-evidence','verify-comment','observe'].includes(command))store.recover();
    if (command === 'status') { print(store.stats()); return; }
    if(command==='diagnostics'){print(readDiagnostics(store));return;}
    if (command === 'install-mapping') {
      realAccess(); requireSafe(values.file, 'FILE_REQUIRED');
      const raw = JSON.parse(await readFile(values.file,'utf8')) as unknown;
      if(raw&&typeof raw==='object'&&'purpose' in raw&&raw.purpose==='comment-reply'){
        const mapping=validateCommentReplyMapping(raw,true);
        requireSafe(await ask(`安装已校准一级评论回复映射，账号摘要 ${digest(mapping.observation.self.uid).slice(0,12)}。每条发送仍需独立审批。输入 INSTALL：`)==='INSTALL','CANCELLED');
        store.bindAccount(store.accountId,mapping.observation.self.uid);
        await writeFile(join(root,'comment-reply-mapping.json'),JSON.stringify(mapping,null,2),{mode:0o600});
        print({installed:true,purpose:'comment-reply',individualApprovalRequired:true});return;
      }
      if(raw&&typeof raw==='object'&&'purpose' in raw&&raw.purpose==='dm-reply'){
        const mapping=validateDmReplyMapping(raw,true);
        requireSafe(await ask(`安装已校准私信回复映射，账号摘要 ${digest(mapping.observation.self.uid).slice(0,12)}。每条发送仍需独立审批。输入 INSTALL：`)==='INSTALL','CANCELLED');
        store.bindAccount(store.accountId,mapping.observation.self.uid);
        await writeFile(join(root,'dm-reply-mapping.json'),JSON.stringify(mapping,null,2),{mode:0o600});
        print({installed:true,purpose:'dm-reply',individualApprovalRequired:true});return;
      }
      if (raw && typeof raw === 'object' && 'purpose' in raw && raw.purpose === 'observation') {
        const mapping = validateObservationMapping(raw,true);
        requireSafe(await ask(`安装已校准只读映射，账号摘要 ${digest(mapping.self.uid).slice(0,12)}。不会启用发送。输入 INSTALL：`) === 'INSTALL','CANCELLED');
        store.bindAccount(store.accountId,mapping.self.uid);
        await writeFile(join(root,'observation-mapping.json'),JSON.stringify(mapping,null,2),{mode:0o600});
        print({installed:true,purpose:'observation',sendsEnabled:false}); return;
      }
      const mapping = validateMapping(raw, true);
      requireSafe(await ask(`仅安装已实际观察的网页映射。账号标识摘要 ${digest(mapping.ownId).slice(0,12)}。输入 INSTALL：`) === 'INSTALL', 'CANCELLED');
      store.bindAccount(store.accountId,mapping.ownId);
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
    if(command==='prune-evidence'){
      const maintenance=new EvidenceMaintenance(store,root);
      try{print(await (values['dry-run']?maintenance.report():maintenance.prune()));}finally{await maintenance.close();}
      return;
    }
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
      connector=new DouyinPlatformConnector(new BrowserService(root,undefined,store.accountId));
      connector.bindStore(store);
      await connector.beginLoginRecovery(false,undefined,undefined,true);
      await ask('请在可见浏览器扫码或处理验证码。完成后按回车关闭并保存专属 Profile（不代表身份核验通过）：');
      print({ profileSaved: true, identityVerified: false, browserVersion: connector.status().version }); return;
    }
    if (command === 'observe' || command === 'verify-comment') {
      connector = new DouyinPlatformConnector(new BrowserService(root, undefined, store.accountId));
      connector.bindStore(store);
      if (command === 'observe') {
        requireSafe(id === 'notifications' || id === 'dm' || id === 'works','CHANNEL_REQUIRED');
        print(await connector.observe(store, id));
      } else {
        requireSafe(id,'DRAFT_ID_REQUIRED');
        const { verified, evidenceId } = await connector.verifyExisting(store, store.draft(id).eventId, { commentDraftId: id });
        print({ verified, evidenceId, originalReceiptsRetained: true });
      }
      return;
    }
    if(['approve','send-once','calibrate-client','retry-comment-once'].includes(command)){
      requireSafe(id,'DRAFT_ID_REQUIRED');
      const event=store.event(store.draft(id).eventId);
      assertSecurityChannelClear(store,event.payload.channel);
      connector=new DouyinPlatformConnector(new BrowserService(root,undefined,store.accountId));
      connector.bindStore(store);
      await replyCommand(command,id,store,connector);return;
    }
    requireSafe(command==='real-test','UNKNOWN_COMMAND');
    const caseId=values.case as typeof caseIds[number];
    requireSafe(caseIds.includes(caseId),'VALID_CASE_REQUIRED');
    connector=new DouyinPlatformConnector(new BrowserService(root,undefined,store.accountId));
    connector.bindStore(store);
    const checked=await connector.verifyManualCheck();
    const answer = await ask(`按 tests/manual/real-account-checklist.md 执行 ${caseId}。输入 PASS / FAIL / BLOCKED；此记录为人工声明，不能替代自动收据：`);
    requireSafe(['PASS','FAIL','BLOCKED'].includes(answer), 'INVALID_RESULT');
    const evidenceId = await recordEvidence(join(root, 'evidence'), { caseId, ...checked,
      taskId: null, action: 'MANUAL_CHECK', result: answer as 'PASS'|'FAIL'|'BLOCKED',
      source: 'MANUAL_ATTESTATION', diagnostics: ['CHECKLIST_MANUAL_ATTESTATION'] });
    print({ evidenceId, source: 'MANUAL_ATTESTATION' });
  } finally {
    try { await connector?.close(); }
    finally { try { if (store) store.close(); } finally { await lock.close(); } }
  }
}

if (import.meta.main) main().catch(error => { diagnostic(safeCode(error)); process.exitCode = 1; });
