import {afterEach,expect,test} from 'vitest';
import {createElement,type ReactElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {join} from 'node:path';
import {rmSync} from 'node:fs';
import {EventStore} from '../../src/storage/store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateReplyKnowledge} from '../../src/knowledge/migration.js';
import {ReplyKnowledgeStore} from '../../src/knowledge/store.js';
import {
  analyzeQuery,
  DEFAULT_MIN_SCORE,
  indexKnowledgeTerms,
  singleCharAliasToken,
} from '../../src/knowledge/retrieval.js';
import {assertKnowledgePromptSafe,bindReplyKnowledge} from '../../src/knowledge/generation-context.js';
import {
  cosineSimilarity,
  decodeFloat32Vector,
  encodeFloat32Vector,
  fuseHybridRankings,
} from '../../src/knowledge/vector-store.js';
import {OnnxEmbeddingManager} from '../../src/knowledge/embedding-engine.js';
import {isMutatingClientCommand} from '../../src/contracts/protocol-v2.js';
import {isReadOnlySidecarCommand} from '../../src/app/service-guards.js';
import type {KnowledgeOverview,OnnxEmbeddingStatus} from '../../src/contracts/knowledge.js';
import type {Channel} from '../../src/contracts/events.js';
import {candidate,pending,privateTemp} from '../helpers.js';

const debuggerPath='../../desktop/src/KnowledgeRetrievalDebugger.tsx';
const trialPath='../../desktop/src/KnowledgeTrial.tsx';
const {KnowledgeRetrievalDebugger,describeEmbeddingBadge}=await import(debuggerPath) as {
  KnowledgeRetrievalDebugger:(props:{channel:Channel;sourceIds:string[];draftMessage:string;busy:boolean})=>ReactElement;
  describeEmbeddingBadge:(status:OnnxEmbeddingStatus)=>{label:string;tone:'success'|'muted'|'warning'};
};
const {KnowledgeTrial}=await import(trialPath) as {
  KnowledgeTrial:(props:{overview:KnowledgeOverview;busy:boolean;perform:()=>Promise<void>})=>ReactElement;
};

const account='account_001';
const cleanupDirs:string[]=[];
const openStores:EventStore[]=[];

afterEach(()=>{
  for(const store of openStores.splice(0))store.close();
  for(const dir of cleanupDirs.splice(0))rmSync(dir,{recursive:true,force:true});
});

async function createKnowledgeFixture(){
  const root=privateTemp('knowledge-retrieval-unit-');
  cleanupDirs.push(root);
  const store=new EventStore(join(root,'owner.sqlite'),true);
  openStores.push(store);
  pending(store);
  await migrateClient(store,join(root,'client-backup.sqlite'));
  await migrateReplyKnowledge(store,join(root,'knowledge-backup.sqlite'));
  const embeddingManager=new OnnxEmbeddingManager({
    configuredModelPath:null,
    cacheRoot:join(root,'onnx-cache'),
    sharedSearchDirs:[],
  });
  const data=new ReplyKnowledgeStore(store,{now:()=>1_800_000_000_000,embeddingManager});
  const enable=(title:string,text:string,topic=title,aliases:string[]=[])=>{
    const saved=data.saveKnowledge(account,{title,text,topic,aliases});
    return data.setKnowledgeState(account,saved.id,'ACTIVE');
  };
  return {root,store,data,enable};
}

test('Intl.Segmenter Chinese tokenization filters customer-service stopwords and preserves domain terms',()=>{
  const analysis=analyzeQuery('你好，请问一下普通订单的退换货流程怎么办理？');
  expect(analysis.filteredStopTerms).toEqual(expect.arrayContaining(['你好','请问','一下','怎么']));
  expect(analysis.wordTerms).toEqual(expect.arrayContaining(['普通','订单','流程','办理']));
  expect(analysis.queryTerms).toEqual(expect.arrayContaining(['退换','换货','流程']));
  expect(analysis.usedStopwordFallback).toBe(false);

  const stopOnly=analyzeQuery('你好，请问在吗？');
  expect(stopOnly.usedStopwordFallback).toBe(true);
  expect(stopOnly.filteredStopTerms.length).toBeGreaterThan(0);
  expect(stopOnly.queryTerms.length).toBeGreaterThan(0);

  const indexed=indexKnowledgeTerms('配送说明',['快递','退'],'普通订单三个工作日内发货');
  expect(indexed).toContain('配送');
  expect(indexed).toContain('快递');
  expect(indexed).toContain(singleCharAliasToken('退'));
  expect(indexed).not.toContain(singleCharAliasToken('配'));
});

test('single-character query blocks prefix noise unless an explicit single-character alias exists',async()=>{
  const f=await createKnowledgeFixture();
  f.enable('配送说明','普通订单三个工作日内发货。','delivery',['快递','邮寄']);

  expect(f.data.context(account,'DIRECT_MESSAGE','配').knowledge).toEqual([]);
  const noAliasDebug=f.data.debugRetrieval(account,'DIRECT_MESSAGE','配');
  expect(noAliasDebug.hits).toEqual([]);
  expect(noAliasDebug.exactFaqHit).toBeNull();

  const refund=f.enable('退货指引','七天无理由支持原包装退货。','refund',['退']);
  const aliasCtx=f.data.context(account,'DIRECT_MESSAGE','退');
  expect(aliasCtx.knowledge).toHaveLength(1);
  expect(aliasCtx.knowledge[0]?.id).toBe(refund.id);
  expect(aliasCtx.knowledge[0]?.exactMatch).toBe(true);
  expect(aliasCtx.exactFaqMatch).toMatchObject({id:refund.id,matchType:'EXACT_ALIAS'});

  // Ambiguous single-char alias across two entries must disable exactFaqMatch direct output.
  f.enable('退款说明','原路退回账户。','refund-money',['退']);
  const ambiguous=f.data.debugRetrieval(account,'DIRECT_MESSAGE','退');
  expect(ambiguous.hits).toHaveLength(2);
  expect(ambiguous.exactFaqHit).toBeNull();
});

test('anti-hallucination minScore rejects weak incidental overlaps while keeping valid hits and exact FAQs',async()=>{
  const f=await createKnowledgeFixture();
  const shipping=f.enable('发货时效说明','工作日每日下午五点截单发顺丰快递，节假日顺延。','shipping',['发货时间','快递']);
  f.enable('欢迎打招呼','你好，欢迎咨询店铺客服，有什么可以帮您？','greeting',['你好']);

  // Incidental overlap on only "五点" inside a long unrelated question must be rejected below threshold.
  const noisy=f.data.debugRetrieval(
    account,
    'DIRECT_MESSAGE',
    '你们线下体验门店周末五点关门吗，可以现场试穿挑选尺码办理会员卡吗？',
  );
  expect(noisy.minScore).toBe(DEFAULT_MIN_SCORE);
  expect(noisy.hits).toEqual([]);
  expect(noisy.rejectedBelowThreshold.some(item=>item.id===shipping.id&&item.reason==='BELOW_MIN_SCORE')).toBe(true);
  expect(noisy.exactFaqHit).toBeNull();

  // Exact alias match on stopword greeting hits the dedicated greeting FAQ cleanly without leaking shipping.
  const greeting=f.data.debugRetrieval(account,'DIRECT_MESSAGE','你好');
  expect(greeting.hits).toHaveLength(1);
  expect(greeting.exactFaqHit).toMatchObject({title:'欢迎打招呼',matchType:'EXACT_ALIAS'});

  // Stopword-only query must not accidentally recall an unrelated entry whose body merely starts with "你好".
  const bodyOnlyHello=f.enable('售后邮费','你好，运费由运费险承保。','postage');
  const greetingAgain=f.data.debugRetrieval(account,'DIRECT_MESSAGE','你好');
  expect(greetingAgain.hits.some(hit=>hit.id===bodyOnlyHello.id)).toBe(false);
  expect(greetingAgain.rejectedBelowThreshold.some(
    item=>item.id===bodyOnlyHello.id&&item.reason==='STOPWORD_ONLY_WEAK_MATCH',
  )).toBe(true);

  // Exact title match produces EXACT_TITLE faq hit; conflicting topic suppresses both hits and exactFaqHit.
  const exactTitle=f.data.debugRetrieval(account,'DIRECT_MESSAGE','发货时效说明');
  expect(exactTitle.exactFaqHit).toMatchObject({id:shipping.id,matchType:'EXACT_TITLE'});
  f.enable('发货时效说明','所有订单十个工作日后发出。','shipping');
  const conflicted=f.data.debugRetrieval(account,'DIRECT_MESSAGE','发货时效说明');
  expect(conflicted.conflicts).toEqual(['shipping']);
  expect(conflicted.hits).toEqual([]);
  expect(conflicted.exactFaqHit).toBeNull();
});

test('vector encoding, cosine similarity and RRF hybrid ranking fuse lexical and semantic signals accurately',()=>{
  const vecA=new Float32Array([1,0,0,0]);
  const vecB=new Float32Array([0.8,0.6,0,0]);
  const vecC=new Float32Array([0,1,0,0]);

  const encoded=encodeFloat32Vector(vecB);
  const decoded=decodeFloat32Vector(encoded,4);
  expect(decoded).not.toBeNull();
  expect(cosineSimilarity(vecB,decoded!)).toBeCloseTo(1,5);
  expect(cosineSimilarity(vecA,vecB)).toBeCloseTo(0.8,5);
  expect(cosineSimilarity(vecA,vecC)).toBeCloseTo(0,5);
  expect(decodeFloat32Vector(encoded,5)).toBeNull();

  const fused=fuseHybridRankings(
    [
      {chunkId:'lex-only',lexicalScore:0.62,exactMatch:false},
      {chunkId:'both-hit',lexicalScore:0.6,exactMatch:false},
    ],
    [
      {chunkId:'both-hit',vectorScore:0.9},
      {chunkId:'vec-only',vectorScore:0.86},
    ],
  );
  // Item confirmed by both lexical FTS5 and semantic vector ranks first.
  expect(fused[0]?.chunkId).toBe('both-hit');
  expect(fused[0]!.score).toBeGreaterThan(fused.find(item=>item.chunkId==='lex-only')!.score);
  // High-similarity semantic-only item surfaces cleanly above default minScore.
  const vecOnly=fused.find(item=>item.chunkId==='vec-only')!;
  expect(vecOnly.vectorScore).toBe(0.86);
  expect(vecOnly.score).toBeGreaterThan(DEFAULT_MIN_SCORE);
});

test('debugger and trial UI follow plain business language without raw engineering jargon or send actions',()=>{
  const overview:KnowledgeOverview={
    available:true,sources:[],knowledge:[],samples:[],personas:[],activePersonaId:null,activePersona:null,
    totals:{sources:0,knowledge:0,samples:0,accepted:0,holdout:0,personas:0},learningTasks:[],page:0,pageSize:50,
  };
  const debuggerHtml=renderToStaticMarkup(createElement(KnowledgeRetrievalDebugger,{
    channel:'DIRECT_MESSAGE',sourceIds:[],draftMessage:'快递多久发？',busy:false,
  }));
  expect(debuggerHtml).toContain('知识召回调试台');
  expect(debuggerHtml).toContain('不消耗模型额度');
  expect(debuggerHtml).toContain('预检命中知识');
  expect(debuggerHtml).not.toContain('FTS5');
  expect(debuggerHtml).not.toContain('ONNX');
  expect(debuggerHtml).not.toContain('>发送<');
  expect(debuggerHtml).not.toContain('openTarget');

  const trialHtml=renderToStaticMarkup(createElement(KnowledgeTrial,{
    overview,busy:false,perform:async()=>{},
  }));
  expect(trialHtml).toContain('知识召回调试台');
  expect(trialHtml).toMatch(/<button class="primary" type="submit" disabled="">生成试聊回复<\/button>/u);
  expect(trialHtml).not.toContain('>发送<');

  expect(describeEmbeddingBadge({
    state:'REUSED_LOCAL',engineMode:'HYBRID_ONNX',modelId:'m',modelPath:'/tmp/m.onnx',
    expectedSha256:null,actualSha256:null,sizeBytes:100,dims:4,checkedPaths:[],reason:'OK',checkedAt:0,
  }).tone).toBe('success');
  expect(describeEmbeddingBadge({
    state:'FALLBACK_FTS5',engineMode:'FTS5_ENHANCED',modelId:'m',modelPath:null,
    expectedSha256:null,actualSha256:null,sizeBytes:null,dims:4,checkedPaths:[],reason:'ERR',checkedAt:0,
  }).tone).toBe('warning');
});

test('negation phrases never flip affirmative FAQs into HIGH_CONFIDENCE and pure greetings score zero on non-exact entries',async()=>{
  const f=await createKnowledgeFixture();
  f.enable('自提说明','本店提供门店自提服务，下单后可到店取货。','pickup',['自提']);
  f.enable('你好流程','这是普通客服接待流程说明文档。','sop');

  const negAnalysis=analyzeQuery('不能自提');
  expect(negAnalysis.filteredStopTerms).not.toContain('不能');
  expect(negAnalysis.hasNegationOrPolarityShift).toBe(true);
  const negDebug=f.data.debugRetrieval(account,'DIRECT_MESSAGE','不能自提');
  expect(negDebug.exactFaqHit).toBeNull();

  // "你好" on non-exact title "你好流程" must score 0 and be blocked.
  const helloDebug=f.data.debugRetrieval(account,'DIRECT_MESSAGE','你好');
  expect(helloDebug.hits).toEqual([]);
  expect(helloDebug.rejectedBelowThreshold.some(
    item=>item.title==='你好流程'&&item.score===0&&item.reason==='STOPWORD_ONLY_WEAK_MATCH',
  )).toBe(true);
});

test('multi-chunk entries never emit exactFaqMatch, never crowd out conflicting short entries, and preserve mixed tokens & legacy punctuated single aliases',async()=>{
  const f=await createKnowledgeFixture();
  // Create a 22-chunk long entry (>11,000 chars) and a short conflicting entry under the same topic.
  const longText=('快递发货规则说明：普通订单需按批次安排。').repeat(620);
  const longEntry=f.enable('发货政策长文',longText,'shipping-long',['发货政策']);
  // Single-entry multi-chunk exact title match must NOT emit exactFaqMatch.
  const longExact=f.data.debugRetrieval(account,'DIRECT_MESSAGE','发货政策长文');
  expect(longExact.hits[0]?.id).toBe(longEntry.id);
  expect(longExact.exactFaqHit).toBeNull();

  // Adding a short conflicting entry under the same topic must trigger conflict even though the long entry has >20 chunks.
  f.enable('发货政策简版','所有订单统一十天后发货。','shipping-long');
  const conflicted=f.data.debugRetrieval(account,'DIRECT_MESSAGE','发货政策');
  expect(conflicted.conflicts).toEqual(['shipping-long']);
  expect(conflicted.hits).toEqual([]);
  expect(conflicted.exactFaqHit).toBeNull();

  // Compact mixed Latin/digit-Han tokens ("S码", "3C", "XL号") must be tokenized and recalled.
  const sizeEntry=f.enable('尺码与认证说明','本款提供S码与XL号，已通过3C认证。','specs');
  expect(f.data.context(account,'DIRECT_MESSAGE','S码').knowledge[0]?.id).toBe(sizeEntry.id);
  expect(f.data.context(account,'DIRECT_MESSAGE','3C').knowledge[0]?.id).toBe(sizeEntry.id);
  expect(f.data.context(account,'DIRECT_MESSAGE','XL号').knowledge[0]?.id).toBe(sizeEntry.id);

  // Legacy entry with punctuated single-char alias ("（配）") must match single-char "配" even if k_terms lacks al1x token.
  const legacy=f.enable('旧版配送','旧版配送正文。','legacy-delivery',['（配）']);
  f.store.db.prepare('DELETE FROM k_terms WHERE chunk_id IN (SELECT id FROM k_chunks WHERE entry_id=?)').run(legacy.id);
  const legacyHit=f.data.context(account,'DIRECT_MESSAGE','配');
  expect(legacyHit.knowledge).toHaveLength(1);
  expect(legacyHit.knowledge[0]?.id).toBe(legacy.id);
  expect(legacyHit.exactFaqMatch).toMatchObject({id:legacy.id,matchType:'EXACT_ALIAS'});
});

test('context witness preserves minScore, resists unrelated corpus inserts, binds body-free snapshots, and validates expectedQuery',async()=>{
  const f=await createKnowledgeFixture();
  const faq=f.enable('退货规则','七天无理由支持原包装退货。','refund',['退货']);
  const strictCtx=f.data.context(account,'DIRECT_MESSAGE','退货规则',{minScore:0.9});
  expect(strictCtx.minScore).toBe(0.9);
  expect(strictCtx.exactFaqMatch?.text).toBe('七天无理由支持原包装退货。');
  expect(f.data.isCurrent(strictCtx)).toBe(true);

  // Adding many unrelated entries must not perturb scores or break isCurrent().
  for(let i=0;i<25;i++){
    f.enable(`无关商品说明${i}`,`这是第${i}条关于颜色尺码与材质的无关说明。`,`unrelated-${i}`);
  }
  expect(f.data.isCurrent(strictCtx)).toBe(true);

  // bindReplyKnowledge must never persist exactFaqMatch or entry text in k_generation_contexts.
  bindReplyKnowledge(f.store,'DRAFT','draft-body-free',1,strictCtx);
  const rawRow=f.store.db.prepare(
    "SELECT snapshot_json FROM k_generation_contexts WHERE kind='DRAFT' AND entity_id='draft-body-free'",
  ).get() as {snapshot_json:string};
  expect(rawRow.snapshot_json).not.toContain('七天无理由');
  expect(rawRow.snapshot_json).not.toContain('exactFaqMatch');
  expect(JSON.parse(rawRow.snapshot_json)).toMatchObject({minScore:0.9,fingerprint:strictCtx.fingerprint});

  // assertKnowledgePromptSafe supports optional aggregated expectedQuery while preserving event.text default.
  const event=candidate({text:'末条短句'});
  const mergedCtx=f.data.context(account,'DIRECT_MESSAGE','退货规则 末条短句');
  expect(()=>assertKnowledgePromptSafe(mergedCtx,event)).toThrow('KNOWLEDGE_CONTEXT_MISMATCH');
  expect(()=>assertKnowledgePromptSafe(mergedCtx,event,'退货规则 末条短句')).not.toThrow();

  // Read-only classification covers debugRetrieval & embeddingStatus in both protocol-v2 and sidecar guards.
  const debugCmd={command:'replyKnowledge',action:'debugRetrieval',channel:'DIRECT_MESSAGE',query:'退货'} as const;
  const statusCmd={command:'replyKnowledge',action:'embeddingStatus'} as const;
  expect(isMutatingClientCommand(debugCmd)).toBe(false);
  expect(isMutatingClientCommand(statusCmd)).toBe(false);
  expect(isReadOnlySidecarCommand(debugCmd)).toBe(true);
  expect(isReadOnlySidecarCommand(statusCmd)).toBe(true);
  f.data.deleteSource(account,faq.sourceId);
  expect(f.data.isCurrent(strictCtx)).toBe(false);
});
