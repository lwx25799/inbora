import { MODEL_PRESET_IDS } from '../contracts/model-providers.js';
import type Database from 'better-sqlite3';
import type {DiagnosticsSnapshot, DiagnosticBlocker, ModelUsageSummary, ModelUsageGroup} from '../contracts/diagnostics.js';
import {inspectModelProviderSchema} from '../storage/model-provider-store.js';
export type {DiagnosticsSnapshot, DiagnosticBlocker, ModelUsageSummary, ModelUsageGroup} from '../contracts/diagnostics.js';

type Store = {db:Database.Database};
function normalizedCalls(routed:boolean):string {
  const model=routed?'coalesce(r.requested_model,c.model)':'c.model';
  const provider=routed?`CASE WHEN v.preset_id IN (${MODEL_PRESET_IDS.map(id=>"'"+id+"'").join(',')}) THEN v.preset_id ELSE 'UNKNOWN' END`:"'UNKNOWN'";
  const join=routed?`LEFT JOIN m_call_routes r ON r.call_id=c.id
    LEFT JOIN m_connection_revisions v ON v.connection_id=r.connection_id AND v.route_revision=r.route_revision`:'';
  return `SELECT ${provider} AS provider,
  CASE WHEN length(${model}) BETWEEN 1 AND 256 AND ${model} NOT GLOB '*[^!-~]*' THEN ${model} ELSE 'UNKNOWN_MODEL' END AS model,
  CASE WHEN status IN ('STARTED','SUCCEEDED','FAILED') THEN status ELSE 'UNKNOWN' END AS status,
  CASE WHEN typeof(input_tokens)='integer' AND input_tokens>=0 THEN input_tokens END AS input_tokens,
  CASE WHEN typeof(output_tokens)='integer' AND output_tokens>=0 THEN output_tokens END AS output_tokens,
  CASE WHEN typeof(elapsed_ms)='integer' AND elapsed_ms>=0 THEN elapsed_ms END AS elapsed_ms FROM model_calls c ${join}`;
}
const aggregate=`count(*) AS requests,
  sum(CASE WHEN input_tokens IS NOT NULL AND output_tokens IS NOT NULL THEN 1 ELSE 0 END) AS knownUsageRequests,
  sum(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) AS unknownUsageRequests,
  coalesce(sum(input_tokens),0) AS inputTokens,coalesce(sum(output_tokens),0) AS outputTokens,
  count(elapsed_ms) AS elapsedSamples,avg(elapsed_ms) AS averageElapsedMs`;
function exists(db:Database.Database,table:string):boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
}
function code(value:unknown):string|null {
  return value===null||value===undefined?null:typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,159}$/u.test(value)?value:'UNCLASSIFIED';
}
function modelExtensionReady(db:Database.Database):boolean {
  try{return inspectModelProviderSchema(db)==='READY';}
  catch{return false;}
}
const modelGroupLimit=100;
function modelUsage(db:Database.Database,routed:boolean):
  Pick<DiagnosticsSnapshot,'model'|'modelBreakdownTotal'|'modelBreakdownTruncated'> {
  const normalized=normalizedCalls(routed);
  const total=db.prepare(`WITH calls AS (${normalized}),latencies AS (
    SELECT elapsed_ms,row_number() OVER(ORDER BY elapsed_ms) AS ordinal,count(*) OVER() AS samples FROM calls WHERE elapsed_ms IS NOT NULL)
    SELECT ${aggregate},(SELECT elapsed_ms FROM latencies WHERE ordinal=(samples*95+99)/100) AS p95ElapsedMs FROM calls`)
    .get() as ModelUsageSummary;
  total.knownUsageRequests??=0;total.unknownUsageRequests??=0;
  // Adapted from douyin-cli lib/memory/llm-usage.js at 4073159 (MIT); retain unknown values as unknown.
  const rows=db.prepare(`WITH calls AS (${normalized}),groups AS (
    SELECT provider,model,status,${aggregate},count(*) OVER() AS groupCount
    FROM calls GROUP BY provider,model,status ORDER BY requests DESC,provider,model,status LIMIT ?),latencies AS (
    SELECT c.provider,c.model,c.status,c.elapsed_ms,row_number() OVER(model_group ORDER BY c.elapsed_ms) AS ordinal,
      count(*) OVER(model_group) AS samples FROM calls c JOIN groups USING(provider,model,status)
      WHERE c.elapsed_ms IS NOT NULL WINDOW model_group AS (PARTITION BY c.provider,c.model,c.status))
    SELECT g.*,l.elapsed_ms AS p95ElapsedMs FROM groups g LEFT JOIN latencies l
      ON l.provider=g.provider AND l.model=g.model AND l.status=g.status AND l.ordinal=(l.samples*95+99)/100
    ORDER BY g.requests DESC,g.provider,g.model,g.status`).all(modelGroupLimit) as (ModelUsageGroup & {groupCount:number})[];
  const groupCount=rows[0]?.groupCount??0,groups=rows.map(({groupCount:_count,...group})=>group);
  return {model:{total,groups},...(groupCount>groups.length?{modelBreakdownTotal:groupCount,modelBreakdownTruncated:true}:{})};
}
function blockers(db:Database.Database):DiagnosticBlocker[] {
  const counts=new Map<string,DiagnosticBlocker>();
  // Match the inbox's simple per-event result: newest persistent proof wins, then inbound status.
  // Historical commands and jobs remain append-only even after a later send or proof resolves the event.
  const hasProofs=exists(db,'verification_results');
  const outcomes=`WITH ${hasProofs?`latest_proofs AS (SELECT intent_id,max(rowid) AS ordinal FROM verification_results GROUP BY intent_id),`:''}
    event_outcomes AS (SELECT e.id,coalesce(${hasProofs?'v.verified':'NULL'},CASE WHEN e.status='CONFIRMED' THEN 1 ELSE 0 END) AS replied
      FROM inbound_events e ${hasProofs?`LEFT JOIN send_intents i ON i.event_id=e.id
      LEFT JOIN latest_proofs p ON p.intent_id=i.id LEFT JOIN verification_results v ON v.rowid=p.ordinal`:''})`;
  const add=(source:string,reason:unknown,count:number):void=>{
    const safe=code(reason);if(!safe)return;
    const key=source+':'+safe,item=counts.get(key)??{source,code:safe,count:0};item.count+=count;counts.set(key,item);
  };
  for(const [table,source,column,where,eventScoped] of [
    ['collection_progress','COLLECTION','last_error','1',false],['work_collection_progress','WORK','last_error','1',false],
    ['automation_jobs','AUTOMATION','reason',"state='REVIEW'",true],
    ['verification_jobs','VERIFICATION','last_error',"state IN ('PENDING','RUNNING','REVIEW','EXHAUSTED')",true],
    ['manual_send_commands','MANUAL_SEND','reason',`status IN ('FAILED_BEFORE_CLICK','UNCERTAIN')
      AND blocked.rowid IN (SELECT max(rowid) FROM manual_send_commands GROUP BY event_id)`,true],
  ] as const){
    if(!exists(db,table))continue;
    const unresolved=eventScoped?'AND NOT EXISTS(SELECT 1 FROM event_outcomes e WHERE e.id=blocked.event_id AND e.replied=1)':'';
    const rows=db.prepare(`${eventScoped?outcomes:''} SELECT blocked.${column} AS reason,count(*) AS count FROM ${table} blocked
      WHERE ${where} AND blocked.${column} IS NOT NULL ${unresolved} GROUP BY blocked.${column}`)
      .all() as {reason:unknown;count:number}[];
    for(const row of rows)add(source,row.reason,row.count);
  }
  return [...counts.values()].sort((a,b)=>b.count-a.count||a.source.localeCompare(b.source)||a.code.localeCompare(b.code)).slice(0,10);
}

/** Read-only cumulative diagnostics. No private message, target identifier, inferred date or price is returned. */
export function readDiagnostics(store:Store):DiagnosticsSnapshot {
  const db=store.db;
  return db.transaction(():DiagnosticsSnapshot=>{
    const channels=exists(db,'collection_progress')?(db.prepare(`SELECT source,next_at,last_success,last_error,failures,elapsed_ms
      FROM collection_progress ORDER BY source`).all() as {source:string;next_at:number;last_success:number|null;last_error:unknown;failures:number;elapsed_ms:number|null}[])
      .map(row=>({source:['dm','works'].includes(row.source)?row.source:'UNKNOWN',nextAt:row.next_at,lastSuccess:row.last_success,
        lastError:code(row.last_error),failures:row.failures,elapsedMs:row.elapsed_ms})):[];
    const works=exists(db,'discovered_works')?db.prepare(`SELECT
      coalesce(sum(CASE WHEN state='INCLUDED' THEN 1 ELSE 0 END),0) AS included,
      coalesce(sum(CASE WHEN state='HISTORICAL' THEN 1 ELSE 0 END),0) AS historical,
      coalesce(sum(CASE WHEN state='REVIEW' THEN 1 ELSE 0 END),0) AS review FROM discovered_works`).get() as DiagnosticsSnapshot['collection']['works']:
      {included:0,historical:0,review:0};
    const conversations=exists(db,'discovered_conversations')?db.prepare(`SELECT count(*) AS total,
      coalesce(sum(CASE WHEN last_read=0 THEN 1 ELSE 0 END),0) AS neverRead FROM discovered_conversations`).get() as DiagnosticsSnapshot['collection']['conversations']:
      {total:0,neverRead:0};
    const routed=modelExtensionReady(db);
    const warnings=blockers(db);
    if(!routed)warnings.unshift({source:'MODEL_PROVIDER',code:'MODEL_PROVIDER_SCHEMA_UNAVAILABLE',count:1});
    return {version:1,timeRangeSupported:false,...modelUsage(db,routed),blockers:warnings.slice(0,10),
      collection:{channels,works,conversations}};
  })();
}
