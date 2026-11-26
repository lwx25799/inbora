import type Database from 'better-sqlite3';
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {evidenceUuid,type EvidenceProtection} from '../observability/evidence.js';

type Store={db:Database.Database};
const referenceKeys=new Set(['evidenceId','evidenceRef','evidence_ref','proofRef','proof_ref']);
const uuidInText=/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/giu;

export interface EvidenceReferenceOptions {retentionCutoffMs?:number}

/** A malformed/unknown reference fails closed. Only UUID metadata files are candidates for retention. */
export function collectEvidenceReferences(store:Store,root:string,options:EvidenceReferenceOptions={}):EvidenceProtection {
  const ids=new Set<string>();let unknownReferences=0;
  const reference=(value:unknown,protect=true):void=>{
    if(typeof value!=='string'||!value){unknownReferences++;return;}
    if(evidenceUuid.test(value.toLowerCase())){if(protect)ids.add(value.toLowerCase());return;}
    // These existing fields also store proof digests or fixed internal outcomes; neither names an evidence file.
    if(/^[a-f0-9]{64}$/u.test(value)||/^[A-Z][A-Z0-9_:]{0,299}$/u.test(value)||/^readonly-contract:[a-f0-9]{64}$/u.test(value))return;
    for(const match of value.matchAll(uuidInText))ids.add(match[0].toLowerCase());
    unknownReferences++;
  };
  const json=(raw:unknown,allUuids=false,requireReference=false):void=>{
    if(typeof raw!=='string'||raw.length>1_000_000){unknownReferences++;return;}
    let value:unknown;try{value=JSON.parse(raw);}catch{unknownReferences++;return;}
    let references=0;
    const visit=(item:unknown,depth=0):void=>{
      if(depth>32){unknownReferences++;return;}
      if(Array.isArray(item)){for(const child of item)visit(child,depth+1);return;}
      if(!item||typeof item!=='object'){
        if(allUuids&&typeof item==='string')for(const match of item.matchAll(uuidInText))ids.add(match[0].toLowerCase());
        return;
      }
      for(const [key,child] of Object.entries(item)){
        if(referenceKeys.has(key)){references++;reference(child);}else visit(child,depth+1);
      }
    };
    visit(value);if(requireReference&&references===0)unknownReferences++;
  };
  store.db.transaction(()=>{
    const observationsPresent=!!store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations'").get();
    if(!observationsPresent)unknownReferences++;
    else{
      try{
        const columns=new Set((store.db.prepare('PRAGMA table_info(observations)').all() as {name:string}[]).map(column=>column.name));
        if(options.retentionCutoffMs!==undefined&&Number.isFinite(options.retentionCutoffMs)&&columns.has('observed_at')){
          for(const row of store.db.prepare('SELECT DISTINCT evidence_ref AS value, observed_at AS observedAt FROM observations').iterate() as Iterable<{value:unknown;observedAt:unknown}>){
            const observedAt=typeof row.observedAt==='string'?Date.parse(row.observedAt):NaN;
            if(!Number.isFinite(observedAt)){unknownReferences++;reference(row.value,true);continue;}
            reference(row.value,observedAt>=options.retentionCutoffMs);
          }
        }else{
          for(const row of store.db.prepare('SELECT DISTINCT evidence_ref AS value FROM observations').iterate() as Iterable<{value:unknown}>)
            reference(row.value,true);
        }
      }catch{unknownReferences++;}
    }
    for(const [table,column,kind,required] of [
      ['inbound_events','payload','json',true],
      ['source_collisions','evidence_ref','reference',true],['source_collisions','payload','json',true],
      ['delivery_receipts','proof_ref','reference',true],['verification_results','evidence_ref','reference',false],
      ['channel_capabilities','evidence_ref','reference',false],['controlled_trials','evidence_ref','reference',false],
      ['chat_messages','payload','json',false],['audit_events','detail_redacted','audit',true],['audit_events','entity_id','uuid',true],
    ] as const){
      const present=!!store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if(!present){if(required)unknownReferences++;continue;}
      try{
        for(const row of store.db.prepare(`SELECT DISTINCT ${column} AS value FROM ${table}`).iterate() as Iterable<{value:unknown}>){
          if(kind==='reference')reference(row.value);
          else if(kind==='json'||kind==='audit')json(row.value,kind==='audit',kind==='json');
          else if(typeof row.value==='string'&&evidenceUuid.test(row.value.toLowerCase()))ids.add(row.value.toLowerCase());
        }
      }catch{unknownReferences++;}
    }
  })();
  for(const name of ['site-mapping.json','observation-mapping.json','dm-reply-mapping.json','comment-reply-mapping.json']){
    const file=join(root,name);
    if(!existsSync(file))continue;
    try{
      const stat=lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>1_000_000){unknownReferences++;continue;}
      json(readFileSync(file,'utf8'),false,true);
    }catch{unknownReferences++;}
  }
  return {ids,complete:unknownReferences===0,unknownReferences};
}
