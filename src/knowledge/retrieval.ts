import {digest,type Channel} from '../core/contracts.js';
import type Database from 'better-sqlite3';
import {knowledgeLimits,type KnowledgeHit} from './contracts.js';

export function normalized(value:string):string{return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu,' ').trim();}
export function lexicalTerms(value:string,maximum=40):string[]{
  const terms=new Set<string>();
  for(const match of normalized(value).matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu)){
    const part=match[0];
    if(/\p{Script=Han}/u.test(part)){
      const chars=Array.from(part);
      for(let i=0;i<chars.length-1;i++)terms.add(chars.slice(i,i+2).join(''));
    }else if(part.length>1)terms.add(part);
  }
  return [...terms].slice(0,maximum);
}
export function chunkText(text:string):string[]{
  const chars=Array.from(text),chunks:string[]=[];
  for(let start=0;start<chars.length;){
    let end=Math.min(chars.length,start+knowledgeLimits.chunk);
    if(end<chars.length){
      for(let split=end;split>start+300;split--)if(/[。！？\n]/u.test(chars[split-1]!)){end=split;break;}
    }
    const part=chars.slice(start,end).join('').trim();if(part)chunks.push(part);
    if(end===chars.length)break;start=Math.max(start+1,end-knowledgeLimits.overlap);
  }
  return chunks;
}
interface SearchRow {id:string;source_id:string;title:string;topic:string;version:number;text:string;chunk_id:string;aliases_json:string}
export interface RetrievalOptions {now:number;ownId:string;sourceIds?:string[]}
export function retrieveKnowledge(db:Database.Database,accountId:string,channel:Channel,query:string,options:RetrievalOptions):
  {knowledge:KnowledgeHit[];conflicts:string[];relevant:string[]}{
  const terms=lexicalTerms(query),needle=normalized(query);
  if(!terms.length)return {knowledge:[],conflicts:[],relevant:[]};
  const sourceFilter=options.sourceIds?` AND k.source_id IN (${options.sourceIds.map(()=>'?').join(',')||'NULL'})`:'';
  const where=`k.account_id=? AND s.own_id=? AND k.state='ACTIVE' AND (k.effective_at IS NULL OR k.effective_at<=?)
    AND (k.expires_at IS NULL OR k.expires_at>?) AND EXISTS(SELECT 1 FROM json_each(k.channels_json) WHERE value=?)${sourceFilter}`;
  const args=[accountId,options.ownId,options.now,options.now,channel,...(options.sourceIds??[])];
  const expression=terms.map(term=>'"'+term.replaceAll('"','""')+'"').join(' OR ');
  const candidates=db.prepare(`SELECT k.id,k.source_id,k.title,k.topic,k.version,c.text,c.id AS chunk_id,k.aliases_json FROM k_terms
    JOIN k_chunks c ON c.id=k_terms.chunk_id JOIN k_knowledge k ON k.id=c.entry_id JOIN k_sources s ON s.id=k.source_id
    WHERE k_terms MATCH ? AND ${where} ORDER BY bm25(k_terms),k.id,c.ordinal LIMIT ?`)
    .all(expression,...args,knowledgeLimits.candidates) as SearchRow[];
  const ftsTerms=Array.from(needle).length>=3?Array.from(needle).map((_,i,a)=>a.slice(i,i+3).join(''))
    .filter(term=>Array.from(term).length===3&&/[\p{L}\p{N}]/u.test(term)).slice(0,12):[];
  if(ftsTerms.length){
    const expression=ftsTerms.map(term=>'"'+term.replaceAll('"','""')+'"').join(' OR ');
    const fts=db.prepare(`SELECT k.id,k.source_id,k.title,k.topic,k.version,c.text,c.id AS chunk_id,k.aliases_json FROM k_search
      JOIN k_chunks c ON c.id=k_search.chunk_id JOIN k_knowledge k ON k.id=c.entry_id JOIN k_sources s ON s.id=k.source_id
      WHERE k_search MATCH ? AND ${where} ORDER BY bm25(k_search),k.id,c.ordinal LIMIT ?`)
      .all(expression,...args,knowledgeLimits.candidates) as SearchRow[];
    const seen=new Set(candidates.map(row=>row.chunk_id));for(const row of fts)if(!seen.has(row.chunk_id)){candidates.push(row);seen.add(row.chunk_id);}
  }
  const rank=(row:SearchRow)=>{
    const aliases=JSON.parse(row.aliases_json) as string[],title=normalized(row.title),body=normalized(row.text);
    const exact=needle.length>1&&(title.includes(needle)||aliases.some(alias=>needle.includes(normalized(alias))||normalized(alias).includes(needle)));
    return (exact?20:0)+terms.reduce((sum,term)=>sum+(title.includes(term)?4:0)+(body.includes(term)?1:0)+
      (aliases.some(alias=>normalized(alias).includes(term))?3:0),0);
  };
  const ranked=candidates.sort((a,b)=>rank(b)-rank(a)||a.id.localeCompare(b.id)||a.chunk_id.localeCompare(b.chunk_id)).slice(0,knowledgeLimits.candidates);
  const entryIds=[...new Set(ranked.map(row=>row.id))],topics=[...new Set(ranked.map(row=>row.topic))],conflicts:string[]=[],relevant:string[]=[];
  // Scope conflict checks to active entries actually matched by this query so complementary entries under one broad topic do not block each other.
  const variants=entryIds.length?db.prepare(`SELECT k.id,k.text,k.version,k.topic FROM k_knowledge k JOIN k_sources s ON s.id=k.source_id
    WHERE ${where} AND k.id IN (${entryIds.map(()=>'?').join(',')}) ORDER BY k.id`).all(...args,...entryIds) as {id:string;text:string;version:number;topic:string}[]:[];
  relevant.push(...variants.map(row=>digest([row.id,row.version,row.text])));
  for(const topic of topics)if(new Set(variants.filter(row=>row.topic===topic).map(row=>normalized(row.text))).size>1)conflicts.push(topic);
  const knowledge:KnowledgeHit[]=[];let budget:number=knowledgeLimits.knowledgeCharacters;
  for(const row of ranked){
    if(conflicts.includes(row.topic)||knowledge.length===knowledgeLimits.knowledgeCount||budget===0)continue;
    const text=Array.from(row.text).slice(0,budget).join('');budget-=Array.from(text).length;
    knowledge.push({id:row.id,sourceId:row.source_id,title:row.title,topic:row.topic,text,version:row.version,chunkId:row.chunk_id});
  }
  return {knowledge,conflicts,relevant:relevant.sort()};
}
