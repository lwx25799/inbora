import type Database from 'better-sqlite3';
import type {BrowserResourcesSnapshot} from '../observability/browser-resource-contracts.js';

type Store = {db:Database.Database};
export interface ModelUsageSummary {
  requests:number;knownUsageRequests:number;unknownUsageRequests:number;inputTokens:number;outputTokens:number;
  elapsedSamples:number;averageElapsedMs:number|null;p95ElapsedMs:number|null;
}
export interface ModelUsageGroup extends ModelUsageSummary {model:string;status:string}
export interface DiagnosticBlocker {source:string;code:string;count:number}
export interface DiagnosticsSnapshot {
  version:1;timeRangeSupported:false;
  browserResources?:BrowserResourcesSnapshot;
  model:{total:ModelUsageSummary;groups:ModelUsageGroup[]};
  blockers:DiagnosticBlocker[];
  collection:{channels:{source:string;nextAt:number;lastSuccess:number|null;lastError:string|null;failures:number;elapsedMs:number|null}[];
    works:{included:number;historical:number;review:number};conversations:{total:number;neverRead:number}};
}

const normalizedCalls=`SELECT
  CASE WHEN length(model) BETWEEN 1 AND 100 AND model NOT GLOB '*[^A-Za-z0-9._:-]*' THEN model ELSE 'UNKNOWN_MODEL' END AS model,
  CASE WHEN status IN ('STARTED','SUCCEEDED','FAILED') THEN status ELSE 'UNKNOWN' END AS status,
  CASE WHEN typeof(input_tokens)='integer' AND input_tokens>=0 THEN input_tokens END AS input_tokens,
  CASE WHEN typeof(output_tokens)='integer' AND output_tokens>=0 THEN output_tokens END AS output_tokens,
  CASE WHEN typeof(elapsed_ms)='integer' AND elapsed_ms>=0 THEN elapsed_ms END AS elapsed_ms FROM model_calls`;
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
function modelUsage(db:Database.Database):DiagnosticsSnapshot['model'] {
  const total=db.prepare(`WITH calls AS (${normalizedCalls}),latencies AS (
    SELECT elapsed_ms,row_number() OVER(ORDER BY elapsed_ms) AS ordinal,count(*) OVER() AS samples FROM calls WHERE elapsed_ms IS NOT NULL)
    SELECT ${aggregate},(SELECT elapsed_ms FROM latencies WHERE ordinal=(samples*95+99)/100) AS p95ElapsedMs FROM calls`)
    .get() as ModelUsageSummary;
  total.knownUsageRequests??=0;total.unknownUsageRequests??=0;
  // Adapted from douyin-cli lib/memory/llm-usage.js at 4073159 (MIT); retain unknown values as unknown.
  const groups=db.prepare(`WITH calls AS (${normalizedCalls}),latencies AS (
    SELECT model,status,elapsed_ms,row_number() OVER(PARTITION BY model,status ORDER BY elapsed_ms) AS ordinal,
      count(*) OVER(PARTITION BY model,status) AS samples FROM calls WHERE elapsed_ms IS NOT NULL)
    SELECT c.model,c.status,${aggregate},(SELECT elapsed_ms FROM latencies l
      WHERE l.model=c.model AND l.status=c.status AND ordinal=(samples*95+99)/100) AS p95ElapsedMs
    FROM calls c GROUP BY c.model,c.status ORDER BY requests DESC,c.model,c.status`).all() as ModelUsageGroup[];
  return {total,groups};
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
  return db.transaction(()=>{
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
    const result:DiagnosticsSnapshot={version:1,timeRangeSupported:false,model:modelUsage(db),blockers:blockers(db),collection:{channels,works,conversations}};
    return result;
  })();
}
