import {digest,eventBinding,eventSchema,isStrong,targetKey,requireSafe,type Channel} from '../core/contracts.js';
import type {EventStore} from '../storage/store.js';
import type {ReplySample,SampleInput,SampleSource} from './contracts.js';
import {knowledgeLimits} from './contracts.js';

export interface SampleRow {id:string;source_id:string;channel:Channel;prompt:string;response:string;origin:SampleSource;source_ref:string|null;
  group_key:string;accepted:number;excluded:number;holdout:number;reason:string|null;created_at:number}
export function sampleFromRow(row:SampleRow):ReplySample{return {id:row.id,sourceId:row.source_id,channel:row.channel,prompt:row.prompt,
  response:row.response,source:row.origin,sourceRef:row.source_ref,group:row.group_key,accepted:!!row.accepted,
  excluded:!!row.excluded,holdout:!!row.holdout,reason:row.reason,createdAt:row.created_at};}
export function redactSampleText(text:string):string{
  return text.replace(/https?:\/\/[^\s<>]+/giu,'[链接]').replace(/[\w.+-]+@[\w.-]+\.\w+/gu,'[邮箱]')
    .replace(/\b\d{11,19}\b/gu,'[个人号码]').replace(/@[\p{L}\p{N}_-]{2,40}/gu,'[称呼]');
}
export function sampleDigest(channel:Channel,prompt:string,response:string):string{
  return digest([channel,prompt.normalize('NFKC').replace(/\s+/gu,' ').trim(),response.normalize('NFKC').replace(/\s+/gu,' ').trim()]);
}
export function sampleBlock(source:SampleSource,prompt:string,response:string):string|null{
  if(source==='AUTO_POLICY')return 'AI_GENERATED';
  if(/投诉|隐私|退款|转账|验证码|密码|身份证|银行卡|complaint|password|verification|refund|payment/iu.test(prompt+'\n'+response))return 'SENSITIVE_SAMPLE';
  if(/忽略.{0,12}(?:规则|指令)|system\s*prompt|api[_ -]?key|泄露.{0,10}(?:密钥|提示词)/iu.test(prompt+'\n'+response))return 'UNTRUSTED_INSTRUCTION';
  return null;
}
/** A retrieved style example must not smuggle a biography, numerical policy or promise into another conversation. */
export function safeStyleExample(sample:Pick<ReplySample,'prompt'|'response'>):boolean{
  return !/[\d¥￥$€]|(?:零|一|二|三|四|五|六|七|八|九|十|百|千|万|两)+(?:元|块|天|年|岁|小时)|保证|承诺|包退|包赔|一定(?:能|会)|我(?:叫|住|来自|今年|从事|的(?:地址|电话|生日|职业))/u
    .test(sample.prompt+'\n'+sample.response);
}

export interface HoldoutBaseline {
  existingHoldoutGroups: Set<string>;
  existingTrainingGroups: Set<string>;
}

/** Snapshot active group assignments before modifying sample selection so existing groups never drift into holdout. */
export function snapshotHoldoutBaseline(store:EventStore,accountId:string,ownId:string):HoldoutBaseline{
  const rows=store.db.prepare(`SELECT m.group_key,MAX(m.holdout) AS held FROM k_samples m JOIN k_sources s ON s.id=m.source_id
    WHERE m.account_id=? AND s.own_id=? AND m.accepted=1 AND m.excluded=0 GROUP BY m.group_key`)
    .all(accountId,ownId) as {group_key:string;held:number}[];
  const existingHoldoutGroups=new Set<string>(),existingTrainingGroups=new Set<string>();
  for(const row of rows){
    if(row.held)existingHoldoutGroups.add(row.group_key);
    else existingTrainingGroups.add(row.group_key);
  }
  return {existingHoldoutGroups,existingTrainingGroups};
}

/** A stable incremental group split keeps whole conversations intact without shifting existing training groups or published personas into holdout. */
export function assignHoldout(store:EventStore,accountId:string,ownId:string,baseline?:HoldoutBaseline):void{
  store.db.prepare(`UPDATE k_samples SET holdout=0
    WHERE account_id=? AND (accepted=0 OR excluded=1)
      AND source_id IN (SELECT id FROM k_sources WHERE account_id=? AND own_id=?)`)
    .run(accountId,accountId,ownId);
  const rows=store.db.prepare(`SELECT m.id,m.group_key,m.holdout FROM k_samples m JOIN k_sources s ON s.id=m.source_id
    WHERE m.account_id=? AND s.own_id=? AND m.accepted=1 AND m.excluded=0 ORDER BY m.created_at,m.id`)
    .all(accountId,ownId) as {id:string;group_key:string;holdout:number}[];
  const activeGroups=[...new Set(rows.map(row=>row.group_key))];
  const update=store.db.prepare('UPDATE k_samples SET holdout=? WHERE id=?');
  if(activeGroups.length<=1){
    for(const row of rows)if(row.holdout!==0)update.run(0,row.id);
    return;
  }
  const referenced=store.db.prepare(`SELECT DISTINCT m.group_key FROM k_personas p,json_each(p.sample_ids_json) j
    JOIN k_samples m ON m.id=j.value JOIN k_sources s ON s.id=m.source_id
    WHERE p.account_id=? AND p.own_id=? AND p.state<>'INVALID' AND m.account_id=? AND s.own_id=?`)
    .all(accountId,ownId,accountId,ownId) as {group_key:string}[];
  const activeSet=new Set(activeGroups);
  const lockedTraining=new Set<string>();
  for(const row of referenced)if(activeSet.has(row.group_key))lockedTraining.add(row.group_key);
  const keptHoldout=new Set<string>();
  if(baseline){
    for(const group of baseline.existingTrainingGroups)if(activeSet.has(group))lockedTraining.add(group);
    for(const group of baseline.existingHoldoutGroups)if(activeSet.has(group)&&!lockedTraining.has(group))keptHoldout.add(group);
  }else{
    for(const row of rows)if(row.holdout&&!lockedTraining.has(row.group_key))keptHoldout.add(row.group_key);
  }
  if(keptHoldout.size>=activeGroups.length){
    const ordered=[...keptHoldout].sort((a,b)=>digest(a).localeCompare(digest(b)));
    keptHoldout.delete(ordered.at(-1)!);
  }
  const newGroups=activeGroups.filter(group=>!keptHoldout.has(group)&&!lockedTraining.has(group))
    .sort((a,b)=>digest(a).localeCompare(digest(b)));
  const target=Math.max(1,Math.round(activeGroups.length*.2));
  const needed=Math.max(0,target-keptHoldout.size);
  const maxSelectable=Math.max(0,activeGroups.length-keptHoldout.size-1);
  const withheld=new Set<string>([...keptHoldout,...newGroups.slice(0,Math.min(needed,newGroups.length,maxSelectable))]);
  for(const row of rows){
    const next=Number(withheld.has(row.group_key));
    if(row.holdout!==next)update.run(next,row.id);
  }
}
export function learningSelection(rows:ReplySample[],sampleIds?:string[]):{training:ReplySample[];evaluation:ReplySample[]}{
  let selected=rows.filter(row=>row.accepted&&!row.excluded);
  if(sampleIds){
    requireSafe(sampleIds.length>0&&sampleIds.length<=knowledgeLimits.learningPairs&&new Set(sampleIds).size===sampleIds.length,'PERSONA_SAMPLE_SELECTION_INVALID');
    const byId=new Map(selected.map(row=>[row.id,row]));
    requireSafe(sampleIds.every(id=>byId.has(id)&&!byId.get(id)!.holdout),'PERSONA_SAMPLE_SELECTION_INVALID');
    selected=selected.filter(row=>sampleIds.includes(row.id)||row.holdout);
  }
  const deduplicated=new Map<string,ReplySample>();
  for(const row of selected)deduplicated.set(sampleDigest(row.channel,row.prompt,row.response),row);
  const bounded=[...deduplicated.values()].sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id)).slice(0,knowledgeLimits.learningPairs);
  return {training:bounded.filter(row=>!row.holdout),evaluation:bounded.filter(row=>row.holdout)};
}

/** Recover candidate pairs from immutable confirmed sends, never from a display timeline or an unfinished intent. */
export function nativeCandidates(store:EventStore,accountId:string,ownId:string):{inputs:SampleInput[];refs:string[]}{
  const has=(name:string)=>!!store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if(!has('draft_revisions'))return {inputs:[],refs:[]};
  const proof=has('verification_results')?`COALESCE((SELECT v.verified FROM verification_results v WHERE v.intent_id=i.id ORDER BY v.rowid DESC LIMIT 1),
    CASE WHEN i.status='CONFIRMED' AND (SELECT r.result FROM delivery_receipts r WHERE r.send_intent_id=i.id ORDER BY r.rowid DESC LIMIT 1)='CONFIRMED' THEN 1 ELSE 0 END)=1`:
    `i.status='CONFIRMED' AND (SELECT r.result FROM delivery_receipts r WHERE r.send_intent_id=i.id ORDER BY r.rowid DESC LIMIT 1)='CONFIRMED'`;
  const rows=store.db.prepare(`SELECT i.id,i.target_key,i.text_digest,i.attempt_started_at,d.text,d.version,r.origin,e.payload,e.binding,e.id AS event_id
    FROM send_intents i JOIN reply_drafts d ON d.id=i.draft_id AND d.event_id=i.event_id JOIN inbound_events e ON e.id=i.event_id
    LEFT JOIN draft_revisions r ON r.draft_id=d.id AND r.version=d.version AND r.text=d.text
    WHERE e.account_id=? AND ${proof} AND NOT EXISTS(SELECT 1 FROM source_collisions c WHERE c.event_id=e.id)
    AND NOT EXISTS(SELECT 1 FROM k_candidate_progress p WHERE p.account_id=e.account_id AND p.own_id=? AND p.source_ref='intent:'||i.id)
    ORDER BY i.rowid LIMIT 500`).all(accountId,ownId) as {
      id:string;target_key:string;text_digest:string;attempt_started_at:string;text:string;origin:string|null;payload:string;binding:string;event_id:string}[];
  const output:SampleInput[]=[];
  for(const row of rows){
    let raw:unknown;try{raw=JSON.parse(row.payload);}catch{continue;}
    const parsed=eventSchema.safeParse(raw);if(!parsed.success)continue;const event=parsed.data;
    if(event.accountId!==accountId||!isStrong(event)||event.direction!=='INCOMING'||eventBinding(event)!==row.binding||digest(row.text)!==row.text_digest||targetKey(event)!==row.target_key)continue;
    const origins=['HUMAN_TYPED','AI_ASSISTED_APPROVED','MCP_ASSISTED','AUTO_POLICY'];
    output.push({channel:event.channel,prompt:event.text,response:row.text,source:origins.includes(row.origin??'')?row.origin as SampleSource:'LEGACY',
      sourceRef:'intent:'+row.id,group:digest([event.accountId,event.channel,event.conversationId??event.videoId]),occurredAt:Date.parse(row.attempt_started_at)});
  }
  // Follow-up turns reference their original anchor, not the question immediately preceding the later reply.
  // They remain available for human review in the inbox but cannot prove a training pair here.
  return {inputs:output,refs:rows.map(row=>'intent:'+row.id)};
}
