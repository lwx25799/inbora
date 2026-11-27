import {afterEach,expect,test} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {EventStore} from '../../src/storage/store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateReplyKnowledge} from '../../src/knowledge/migration.js';
import {ReplyKnowledgeStore} from '../../src/knowledge/store.js';
import {
  DEFAULT_ONNX_MODEL_SPEC,
  isSafePublicHttpsUrl,
  OnnxEmbeddingManager,
  type EmbeddingRuntime,
} from '../../src/knowledge/embedding-engine.js';
import {countChunkVectors,hasVectorTable} from '../../src/knowledge/vector-store.js';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {dispatchTrustedServiceCommand,routeSidecarEnvelope} from '../../src/app/protocol-v2-router.js';
import {PROTOCOL_V2} from '../../src/contracts/protocol-v2.js';
import {DeepSeekProvider} from '../../src/ai/deepseek.js';
import {installFixtureKey} from '../model-provider-helpers.js';
import {candidate,pending,privateTemp} from '../helpers.js';
import type {OnnxEmbeddingStatus,RetrievalDebugResult} from '../../src/contracts/knowledge.js';

const account='account_001';
const cleanupDirs:string[]=[];
const services:ClientService[]=[];
const stores:EventStore[]=[];

afterEach(async()=>{
  for(const service of services.splice(0))await service.close();
  for(const store of stores.splice(0))store.close();
  for(const dir of cleanupDirs.splice(0))rmSync(dir,{recursive:true,force:true});
});

function sha256Of(data:Buffer):string{
  return createHash('sha256').update(data).digest('hex');
}

/** Deterministic offline toy embedder that maps semantic groups onto 4-dim unit vectors for testing RRF hybrid recall. */
function createSemanticTestRuntime(modelId:string):EmbeddingRuntime{
  const embed=(text:string):Float32Array=>{
    const value=text.toLowerCase();
    const vec=new Float32Array([0.05,0.05,0.05,0.05]);
    if(/优惠|折扣|便宜|满减|促销|降价/u.test(value))vec[0]=1;
    if(/快递|物流|发货|配送|顺丰/u.test(value))vec[1]=1;
    if(/退款|退货|售后|换货/u.test(value))vec[2]=1;
    if(/清洗|保养|水洗|干洗/u.test(value))vec[3]=1;
    return vec;
  };
  return {modelId,dims:4,embed,embedSync:embed};
}

test('ONNX local detection reuses verified local models, rejects tampered files, and supports verified offline download',async()=>{
  const root=privateTemp('onnx-manager-');
  cleanupDirs.push(root);
  const validPayload=Buffer.from('INBORA-SYNTHETIC-ONNX-MODEL-WEIGHTS-V1-0123456789ABCDEF');
  const validSha256=sha256Of(validPayload);
  const cacheRoot=join(root,'cache');
  const sharedDir=join(root,'shared');

  const spec={
    modelId:'test-zh-embed-v1',
    fileName:'embed.onnx',
    dims:4,
    expectedSha256:validSha256,
    minBytes:16,
    maxBytes:1024,
    downloadUrl:'https://models.example.invalid/onnx/embed.onnx',
  };

  // 1. Missing model reports MISSING_NEEDS_DOWNLOAD and falls back to FTS5_ENHANCED without network calls.
  let fetchCount=0;
  const missingManager=new OnnxEmbeddingManager({
    spec,
    configuredModelPath:null,
    cacheRoot,
    sharedSearchDirs:[sharedDir],
    transport:async()=>{fetchCount++;return new Response(validPayload,{status:200});},
  });
  const missingStatus=missingManager.inspectStatus();
  expect(missingStatus.state).toBe('MISSING_NEEDS_DOWNLOAD');
  expect(missingStatus.engineMode).toBe('FTS5_ENHANCED');
  expect(fetchCount).toBe(0);

  // 2. Tampered local file in shared directory is rejected (SHA256_MISMATCH) -> FALLBACK_FTS5.
  const sharedModelDir=join(sharedDir,spec.modelId);
  mkdirSync(sharedModelDir,{recursive:true});
  const sharedModelFile=join(sharedModelDir,spec.fileName);
  writeFileSync(sharedModelFile,Buffer.from('CORRUPTED-OR-TAMPERED-MODEL-BYTES-0123456789ABCDEF'));
  const tamperedStatus=missingManager.inspectStatus();
  expect(tamperedStatus.state).toBe('FALLBACK_FTS5');
  expect(tamperedStatus.engineMode).toBe('FTS5_ENHANCED');
  expect(tamperedStatus.reason).toContain('SHA256_MISMATCH');

  // 3. Valid local model in shared directory is verified and reused (REUSED_LOCAL + HYBRID_ONNX when runtime available).
  writeFileSync(sharedModelFile,validPayload);
  const reuseManager=new OnnxEmbeddingManager({
    spec,
    configuredModelPath:null,
    cacheRoot,
    sharedSearchDirs:[sharedDir],
    runtimeFactory:()=>createSemanticTestRuntime(spec.modelId),
  });
  const reusedStatus=reuseManager.inspectStatus();
  expect(reusedStatus.state).toBe('REUSED_LOCAL');
  expect(reusedStatus.engineMode).toBe('HYBRID_ONNX');
  expect(reusedStatus.modelPath).toBe(sharedModelFile);
  expect(reusedStatus.actualSha256).toBe(validSha256);

  // 4. Explicit safe download verifies SHA-256 and activates DOWNLOAD_READY.
  const dlCacheRoot=join(root,'dl-cache');
  const dlManager=new OnnxEmbeddingManager({
    spec,
    configuredModelPath:null,
    cacheRoot:dlCacheRoot,
    sharedSearchDirs:[],
    runtimeFactory:()=>createSemanticTestRuntime(spec.modelId),
    transport:async()=>new Response(validPayload,{status:200}),
  });
  const downloaded=await dlManager.ensureReady({allowDownload:true});
  expect(downloaded.state).toBe('DOWNLOAD_READY');
  expect(downloaded.engineMode).toBe('HYBRID_ONNX');
  expect(downloaded.actualSha256).toBe(validSha256);
  expect(downloaded.modelPath && existsSync(downloaded.modelPath)).toBe(true);

  // 5. Bad download hash degrades cleanly to FALLBACK_FTS5 and cleans up temporary .part files.
  const badCacheRoot=join(root,'bad-dl-cache');
  const badDlManager=new OnnxEmbeddingManager({
    spec,
    configuredModelPath:null,
    cacheRoot:badCacheRoot,
    sharedSearchDirs:[],
    transport:async()=>new Response(Buffer.from('WRONG-DOWNLOADED-PAYLOAD-1234567890'),{status:200}),
  });
  const badResult=await badDlManager.ensureReady({allowDownload:true});
  expect(badResult.state).toBe('FALLBACK_FTS5');
  expect(badResult.engineMode).toBe('FTS5_ENHANCED');
  expect(badResult.reason).toContain('SHA256_MISMATCH');
  const leftoverDir=join(badCacheRoot,spec.modelId);
  expect(existsSync(leftoverDir)?readdirSync(leftoverDir):[]).toEqual([]);

  // 6. SSRF guard rejects non-HTTPS, non-443 ports, IPv6 private/doc ranges, and DNS resolving to private IPs.
  expect(DEFAULT_ONNX_MODEL_SPEC.expectedSha256).toBeNull();
  expect(isSafePublicHttpsUrl('http://models.example.invalid/a.onnx')).toBe(false);
  expect(isSafePublicHttpsUrl('https://models.example.invalid:8443/a.onnx')).toBe(false);
  expect(isSafePublicHttpsUrl('https://localhost/a.onnx')).toBe(false);
  expect(isSafePublicHttpsUrl('https://127.0.0.1/a.onnx')).toBe(false);
  expect(isSafePublicHttpsUrl('https://192.168.1.10/a.onnx')).toBe(false);
  expect(isSafePublicHttpsUrl('https://[fc00::1]/a.onnx')).toBe(false);
  expect(isSafePublicHttpsUrl('https://[2001:db8::1]/a.onnx')).toBe(false);
  expect(isSafePublicHttpsUrl('https://huggingface.co/BAAI/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx')).toBe(true);

  const dnsBlockedManager=new OnnxEmbeddingManager({
    spec,
    configuredModelPath:null,
    cacheRoot:join(root,'dns-blocked-cache'),
    sharedSearchDirs:[],
    lookup:async()=>[{address:'10.0.0.8',family:4}],
    transport:async()=>new Response(validPayload,{status:200}),
  });
  const dnsBlocked=await dnsBlockedManager.ensureReady({allowDownload:true});
  expect(dnsBlocked.state).toBe('FALLBACK_FTS5');
  expect(dnsBlocked.reason).toBe('ONNX_DOWNLOAD_DNS_REJECTED');

  // 7. Oversize download cancels stream, removes temp file, and degrades cleanly.
  const oversizeCache=join(root,'oversize-cache');
  const oversizeManager=new OnnxEmbeddingManager({
    spec:{...spec,maxBytes:32},
    configuredModelPath:null,
    cacheRoot:oversizeCache,
    sharedSearchDirs:[],
    transport:async()=>new Response(Buffer.alloc(256,0x41),{status:200}),
  });
  const oversizeResult=await oversizeManager.ensureReady({allowDownload:true});
  expect(oversizeResult.state).toBe('FALLBACK_FTS5');
  expect(oversizeResult.reason).toBe('ONNX_DOWNLOAD_TOO_LARGE');
  const oversizeDir=join(oversizeCache,spec.modelId);
  expect(existsSync(oversizeDir)?readdirSync(oversizeDir):[]).toEqual([]);

  // 8. Unpinned default spec refuses unverified download safely.
  const unpinnedManager=new OnnxEmbeddingManager({
    configuredModelPath:null,
    cacheRoot:join(root,'unpinned-cache'),
    sharedSearchDirs:[],
  });
  const unpinnedResult=await unpinnedManager.ensureReady({allowDownload:true});
  expect(unpinnedResult.state).toBe('FALLBACK_FTS5');
  expect(unpinnedResult.reason).toBe('ONNX_EXPECTED_SHA256_UNCONFIGURED');
});

test('hybrid ONNX mode lazily initializes k_chunk_vectors, recalls synonym queries via RRF, and cleans vectors on source deletion',async()=>{
  const root=privateTemp('knowledge-hybrid-');
  cleanupDirs.push(root);
  const store=new EventStore(join(root,'owner.sqlite'),true);
  stores.push(store);
  pending(store);
  await migrateClient(store,join(root,'client-backup.sqlite'));
  await migrateReplyKnowledge(store,join(root,'knowledge-backup.sqlite'));

  // k_schema stays at version 3 and k_chunk_vectors is NOT created eagerly during migration.
  expect(store.db.prepare('SELECT version FROM k_schema').get()).toEqual({version:3});
  expect(hasVectorTable(store.db)).toBe(false);

  const modelFile=join(root,'local-model.onnx');
  const modelBytes=Buffer.from('INBORA-SYNTHETIC-ONNX-HYBRID-RUNTIME-PAYLOAD-9876543210');
  writeFileSync(modelFile,modelBytes);

  const embeddingManager=new OnnxEmbeddingManager({
    spec:{
      modelId:'hybrid-test-v1',
      fileName:'local-model.onnx',
      dims:4,
      expectedSha256:sha256Of(modelBytes),
      minBytes:16,
      maxBytes:1024,
      downloadUrl:null,
    },
    configuredModelPath:modelFile,
    sharedSearchDirs:[],
    runtimeFactory:()=>createSemanticTestRuntime('hybrid-test-v1'),
  });

  const data=new ReplyKnowledgeStore(store,{now:()=>1_800_000_000_000,embeddingManager});
  const promo=data.saveKnowledge(account,{
    title:'店铺促销活动',
    topic:'promotion',
    text:'满二百立减三十，会员享九折优惠。',
    aliases:['满减活动'],
  });
  data.setKnowledgeState(account,promo.id,'ACTIVE');
  expect(hasVectorTable(store.db)).toBe(true);
  expect(countChunkVectors(store.db,'hybrid-test-v1')).toBe(1);

  // Query "能便宜点吗" shares zero lexical terms with "店铺促销活动 / 满二百立减三十",
  // yet hybrid ONNX vector search recalls it via RRF!
  const debug=data.debugRetrieval(account,'DIRECT_MESSAGE','能便宜点吗');
  expect(debug.engineMode).toBe('HYBRID_ONNX');
  expect(debug.onnxStatus.state).toBe('REUSED_LOCAL');
  expect(debug.hits).toHaveLength(1);
  expect(debug.hits[0]!.id).toBe(promo.id);
  expect(debug.hits[0]!.vectorScore).toBeGreaterThan(0.9);
  expect(debug.hits[0]!.lexicalScore).toBe(0);

  // Exact literal title/alias match must always outrank a non-exact hybrid vector match.
  const exactCourier=data.saveKnowledge(account,{
    title:'包邮说明',
    topic:'postage-exact',
    text:'全场满99元包邮。',
    aliases:['能便宜点吗'],
  });
  data.setKnowledgeState(account,exactCourier.id,'ACTIVE');
  const exactVsVector=data.debugRetrieval(account,'DIRECT_MESSAGE','能便宜点吗');
  expect(exactVsVector.hits[0]?.id).toBe(exactCourier.id);
  expect(exactVsVector.hits[0]?.exactMatch).toBe(true);
  expect(exactVsVector.exactFaqHit?.id).toBe(exactCourier.id);
  data.deleteSource(account,exactCourier.sourceId);

  // Deleting the source cleans up its chunk vectors with no orphan rows left behind.
  data.deleteSource(account,promo.sourceId);
  expect(countChunkVectors(store.db,'hybrid-test-v1')).toBe(0);
});

test('debugRetrieval and embeddingStatus commands consume zero model budget and tryReply returns rich basis metadata',async()=>{
  const root=privateTemp('knowledge-debug-cmd-');
  cleanupDirs.push(root);
  const store=new EventStore(join(root,'test.sqlite'),true);
  stores.push(store);
  await migrateClient(store,join(root,'schema3.sqlite'));
  pending(store,candidate());

  const provider=new DeepSeekProvider(async()=>new Response(JSON.stringify({
    model:'deepseek-flash',
    choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'顺丰快递一般三个工作日发出。'}}],
    usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20},
  })));
  const service=new ClientService(store,new BrowserService(root),provider);
  services.push(service);
  await service.loadSettings();

  const controlToken=service.authority.issueSession();
  const readToken=service.authority.issueSession(['READ']);

  // Read-only operator cannot bypass CONTROL check.
  await expect(service.dispatch(readToken,{
    command:'replyKnowledge',action:'embeddingStatus',
  })).rejects.toThrow();

  // Save & activate one knowledge entry.
  const saved=await service.dispatch(controlToken,{
    command:'replyKnowledge',
    action:'saveKnowledge',
    input:{title:'顺丰配送说明',topic:'shipping',text:'普通订单三个工作日内发顺丰快递。',aliases:['快递','邮寄']},
  }) as {id:string;sourceId:string};
  await service.dispatch(controlToken,{
    command:'replyKnowledge',action:'setKnowledgeState',id:saved.id,state:'ACTIVE',
  });

  // Zero model authorization and zero budget consumed for embeddingStatus & debugRetrieval,
  // and IPC status must be sanitized (no local filesystem paths leaked).
  const status=await service.dispatch(controlToken,{
    command:'replyKnowledge',action:'embeddingStatus',
  }) as OnnxEmbeddingStatus;
  expect(['MISSING_NEEDS_DOWNLOAD','FALLBACK_FTS5','REUSED_LOCAL','DOWNLOAD_READY']).toContain(status.state);
  expect(status.modelPath).toBeNull();
  expect(status.checkedPaths).toEqual([]);

  const debug=await service.dispatch(controlToken,{
    command:'replyKnowledge',
    action:'debugRetrieval',
    channel:'DIRECT_MESSAGE',
    query:'你好请问快递多久发',
    sourceIds:[saved.sourceId],
  }) as RetrievalDebugResult;
  expect(debug.filteredStopTerms).toEqual(expect.arrayContaining(['你好','请问']));
  expect(debug.hits).toHaveLength(1);
  expect(debug.hits[0]).toMatchObject({id:saved.id,title:'顺丰配送说明'});
  expect(debug.hits[0]!.score).toBeGreaterThan(0.5);
  expect(debug.onnxStatus.modelPath).toBeNull();
  expect(debug.onnxStatus.checkedPaths).toEqual([]);
  expect(store.budget('MODEL').used).toBe(0);
  expect(store.db.prepare('SELECT count(*) n FROM model_calls').get()).toEqual({n:0});
  expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});

  // Protocol v2 routing + trusted dispatch classify debugRetrieval & embeddingStatus as read-only
  // (no commandId needed, zero protocol_v2_commands writes, zero operator_sessions renewal writes).
  const secret='a'.repeat(64);
  const sessionsBefore=store.db.prepare('SELECT * FROM operator_sessions ORDER BY rowid').all();
  const routeContext={
    accounts:service.accounts,
    lifecycleCommandIds:new Map<string,string>(),
    dispatch:async(body:Parameters<typeof dispatchTrustedServiceCommand>[2],scope?:Parameters<typeof dispatchTrustedServiceCommand>[3])=>
      dispatchTrustedServiceCommand(service,controlToken,body,scope),
  };
  const v2StatusRes=await routeSidecarEnvelope(
    {
      protocol:PROTOCOL_V2,
      requestId:randomUUID(),
      secret,
      scope:{kind:'ACCOUNT',accountRef:account},
      body:{command:'replyKnowledge',action:'embeddingStatus'},
    },
    routeContext,
  );
  expect(v2StatusRes.ok).toBe(true);
  const v2DebugRes=await routeSidecarEnvelope(
    {
      protocol:PROTOCOL_V2,
      requestId:randomUUID(),
      secret,
      scope:{kind:'ACCOUNT',accountRef:account},
      body:{command:'replyKnowledge',action:'debugRetrieval',channel:'DIRECT_MESSAGE',query:'快递'},
    },
    routeContext,
  );
  expect(v2DebugRes.ok).toBe(true);
  expect(store.db.prepare('SELECT * FROM operator_sessions ORDER BY rowid').all()).toEqual(sessionsBefore);
  expect(store.db.prepare('SELECT count(*) n FROM protocol_v2_commands').get()).toEqual({n:0});

  // Now authorize a fixture model key and verify tryReply returns enriched knowledge basis metadata.
  await installFixtureKey(service,controlToken,{key:'synthetic-only',grant:true});
  const trial=await service.dispatch(controlToken,{
    command:'replyKnowledge',
    action:'tryReply',
    channel:'DIRECT_MESSAGE',
    message:'快递',
    sourceIds:[saved.sourceId],
    personaVersionId:null,
    confirmed:true,
  }) as {
    current:{
      text:string;
      engineMode:string;
      exactFaqMatch:{id:string;matchType:string}|null;
      knowledge:{id:string;title:string;score:number;matchedTerms:string[];exactMatch:boolean;textPreview:string}[];
    };
  };
  expect(trial.current.text).toContain('三个工作日');
  expect(trial.current.engineMode).toBe('FTS5_ENHANCED');
  expect(trial.current.exactFaqMatch).toMatchObject({id:saved.id,matchType:'EXACT_ALIAS'});
  expect(trial.current.knowledge[0]).toMatchObject({
    id:saved.id,
    title:'顺丰配送说明',
    exactMatch:true,
  });
  expect(trial.current.knowledge[0]!.score).toBeGreaterThanOrEqual(0.95);
  expect(trial.current.knowledge[0]!.matchedTerms).toContain('快递');
  expect(trial.current.knowledge[0]!.textPreview).toContain('顺丰快递');
});
