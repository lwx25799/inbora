import {digest,type Channel} from '../core/contracts.js';
import type Database from 'better-sqlite3';
import {
  knowledgeLimits,
  type ExactFaqMatch,
  type KnowledgeHit,
  type RetrievalDebugHit,
  type RetrievalDebugResult,
  type RetrievalEngineMode,
  type RetrievalRejectedCandidate,
} from './contracts.js';
import {defaultFallbackEmbeddingStatus,OnnxEmbeddingManager} from './embedding-engine.js';
import {fuseHybridRankings,searchChunkVectors,type VectorSearchRow} from './vector-store.js';

export const DEFAULT_MIN_SCORE=0.25;
export const DEFAULT_VECTOR_MIN_SIMILARITY=0.3;
export const EXACT_FAQ_MAX_CHARS=500;

const zhSegmenter=new Intl.Segmenter('zh-CN',{granularity:'word'});
const EDGE_PUNCT_RE=/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu;
const HAN_RE=/\p{Script=Han}/u;
const WORD_CHAR_RE=/[\p{L}\p{N}]/u;
const LATIN_HAN_SHORT_RE=/[a-z0-9]{1,6}\p{Script=Han}/gu;
const HAN_LATIN_SHORT_RE=/\p{Script=Han}[a-z0-9]{1,6}/gu;
const NEGATION_OR_REVERSAL_RE=/(?:不能|能不|不可|不行|行不|好不|可不|是不是|是不|有没有|有没|不要|不用|没法|无法|不是|没有|不给|不发|不退|不换|不包|不支持|未收到|没收到)/u;

/**
 * Chinese customer-service filler words and colloquial stop bigrams (inspired by ZeZhizhan/Fathom, MIT).
 * Negation, restriction and polarity-flipping phrases are intentionally excluded so queries like
 * "不能自提" never collapse into their affirmative opposite.
 */
const CHINESE_STOP_WORDS=new Set<string>([
  '在吗','在嘛','你好','您好','哈喽','嗨','请问','请问下','请问一下','请教','一下','一下子',
  '可以','可以吗','这个','那个','这些','那些','帮我','帮忙','麻烦','谢谢','感谢','好的','好哒',
  '嗯嗯','哦哦','啊啊','想问','想问下','想问一下','问下','问一下','咨询','咨询下','咨询一下',
  '看看','看下','看一下','了解','了解一下','怎么','怎样','如何','什么','啥','我想','我要',
  '我们','你们','咱们','他们','客服','亲','亲亲','宝子','老板','小二','就是','然后','因为',
  '所以','但是','如果','还是','或者','呢','吗','啊','呀','哦','吧','哈','啦','嘛','的','了','着','过','么',
]);

const CHINESE_STOP_BIGRAMS=new Set<string>([
  '在吗','在嘛','你好','您好','请问','一下','可以','以吗','这个','那个','这些','那些',
  '帮我','帮忙','麻烦','谢谢','感谢','好的','怎么','怎样','什么','我想','我要','我们','你们',
  '咨询','问下','问一','看下','看一','了解','吗请','好请','的吗','了吗','呢请','就是','还是',
  '或者','以及','客服','亲亲','老板',
]);

export interface QueryAnalysis {
  needle:string;
  cleanNeedle:string;
  queryTerms:string[];
  wordTerms:string[];
  bigramTerms:string[];
  filteredStopTerms:string[];
  usedStopwordFallback:boolean;
  hasNegationOrPolarityShift:boolean;
  singleCharQuery:string|null;
  singleAliasToken:string|null;
}

export interface RetrievalOptions {
  now:number;
  ownId:string;
  sourceIds?:string[];
  minScore?:number;
  embeddingManager?:OnnxEmbeddingManager|null;
  queryVector?:Float32Array|null;
  vectorMinSimilarity?:number;
}

interface SearchRow {
  id:string;source_id:string;title:string;topic:string;version:number;
  text:string;chunk_id:string;aliases_json:string;bm25_score?:number;
}
interface CandidateMeta {row:SearchRow;termsBm25:number|null;searchBm25:number|null;vectorScore:number}
interface ScoredCandidate {
  row:SearchRow;score:number;lexicalScore:number;vectorScore:number;matchedTerms:string[];
  exactMatch:boolean;exactTitleMatch:boolean;exactAliasMatch:boolean;
  queryCoverage:number;targetCoverage:number;rejectReason:string|null;
}
interface EntryFullMeta {id:string;fullText:string;version:number;topic:string;chunkCount:number}
interface RetrievalOutcome {
  knowledge:KnowledgeHit[];conflicts:string[];relevant:string[];
  exactFaqMatch:ExactFaqMatch|null;engineMode:RetrievalEngineMode;debug:RetrievalDebugResult;
}

export function normalized(value:string):string{
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu,' ').trim();
}

export function stripEdgePunctuation(value:string):string{
  return normalized(value).replace(EDGE_PUNCT_RE,'').trim();
}

export function singleCharAliasToken(value:string):string|null{
  const chars=Array.from(stripEdgePunctuation(value));
  if(chars.length!==1||!WORD_CHAR_RE.test(chars[0]!))return null;
  const codePoint=chars[0]!.codePointAt(0);
  return codePoint===undefined?null:`al1x${codePoint.toString(16)}`;
}

function addHanBigrams(value:string,target:Set<string>):void{
  for(const match of value.matchAll(/[\p{Script=Han}]+/gu)){
    const chars=Array.from(match[0]);
    for(let i=0;i<chars.length-1;i++)target.add(chars.slice(i,i+2).join(''));
  }
}

function addMixedShortTokens(clean:string,target:Set<string>):void{
  for(const match of clean.matchAll(LATIN_HAN_SHORT_RE))target.add(match[0]);
  for(const match of clean.matchAll(HAN_LATIN_SHORT_RE))target.add(match[0]);
}

function addSubBigrams(
  chars:readonly string[],
  filterStopwords:boolean,
  bigrams:Set<string>,
  filteredStopTerms:Set<string>,
):void{
  if(chars.length<=2)return;
  for(let i=0;i<chars.length-1;i++){
    const bg=chars[i]!+chars[i+1]!;
    if(filterStopwords&&(CHINESE_STOP_BIGRAMS.has(bg)||CHINESE_STOP_WORDS.has(bg))){
      filteredStopTerms.add(bg);
    }else{
      bigrams.add(bg);
    }
  }
}

/**
 * Segments Chinese/alphanumeric text using Node's native Intl.Segmenter('zh-CN') while
 * fusing contiguous single Han characters (e.g. ["发","货"] -> "发货"), preserving compact
 * mixed Latin/digit-Han tokens (e.g. "S码", "3C", "XL号"), and stripping stopwords before
 * forming 2-grams so cross-stopword garbage bigrams never form.
 */
function segmentTextStructured(
  text:string,
  filterStopwords:boolean,
):{words:string[];bigrams:string[];filteredStopTerms:string[]}{
  const clean=normalized(text);
  const words=new Set<string>();
  const bigrams=new Set<string>();
  const filteredStopTerms=new Set<string>();

  addMixedShortTokens(clean,words);

  const pieces:{text:string;wordLike:boolean;isSingleHan:boolean}[]=[];
  for(const part of zhSegmenter.segment(clean)){
    const seg=part.segment.trim();
    if(!part.isWordLike||!seg){
      pieces.push({text:'',wordLike:false,isSingleHan:false});
      continue;
    }
    const chars=Array.from(seg);
    pieces.push({text:seg,wordLike:true,isSingleHan:chars.length===1&&HAN_RE.test(chars[0]!)});
  }

  let hanRun:string[]=[];
  const flushHanRun=()=>{
    if(hanRun.length>=2){
      const merged=hanRun.join('');
      if(filterStopwords&&CHINESE_STOP_WORDS.has(merged)){
        filteredStopTerms.add(merged);
      }else{
        words.add(merged);
        addSubBigrams(hanRun,filterStopwords,bigrams,filteredStopTerms);
      }
    }
    hanRun=[];
  };

  for(let i=0;i<pieces.length;i++){
    const cur=pieces[i]!;
    if(!cur.wordLike){flushHanRun();continue;}
    if(cur.isSingleHan){
      const next=pieces[i+1];
      if(filterStopwords&&next?.wordLike&&next.isSingleHan&&CHINESE_STOP_WORDS.has(cur.text+next.text)){
        flushHanRun();
        filteredStopTerms.add(cur.text+next.text);
        i++;
        continue;
      }
      if(filterStopwords&&CHINESE_STOP_WORDS.has(cur.text)){
        flushHanRun();
        filteredStopTerms.add(cur.text);
        continue;
      }
      hanRun.push(cur.text);
      continue;
    }
    flushHanRun();
    const chars=Array.from(cur.text);
    if(chars.length<2||!WORD_CHAR_RE.test(cur.text))continue;
    if(filterStopwords&&CHINESE_STOP_WORDS.has(cur.text)){
      filteredStopTerms.add(cur.text);
      continue;
    }
    words.add(cur.text);
    if(HAN_RE.test(cur.text))addSubBigrams(chars,filterStopwords,bigrams,filteredStopTerms);
  }
  flushHanRun();

  return {words:[...words],bigrams:[...bigrams],filteredStopTerms:[...filteredStopTerms]};
}

/**
 * Analyzes a user query with Node native Intl.Segmenter('zh-CN') + 2-grams, applying
 * customer-service stopword filtering with bounded fallback when all tokens are filtered.
 */
export function analyzeQuery(value:string,maximum=40):QueryAnalysis{
  const needle=normalized(value);
  const cleanNeedle=stripEdgePunctuation(value);
  const hasNegationOrPolarityShift=NEGATION_OR_REVERSAL_RE.test(cleanNeedle);
  const cleanChars=Array.from(cleanNeedle);
  const singleCharQuery=cleanChars.length===1&&WORD_CHAR_RE.test(cleanChars[0]!)
    ?cleanChars[0]!
    :null;
  const singleAliasToken=singleCharQuery?singleCharAliasToken(singleCharQuery):null;

  if(singleCharQuery){
    return {
      needle,cleanNeedle,queryTerms:[],wordTerms:[],bigramTerms:[],
      filteredStopTerms:[],usedStopwordFallback:false,hasNegationOrPolarityShift,
      singleCharQuery,singleAliasToken,
    };
  }

  const filtered=segmentTextStructured(needle,true);
  let usedStopwordFallback=false;
  let finalWords=filtered.words;
  let finalBigrams=filtered.bigrams;
  let finalTerms=[...new Set([...filtered.words,...filtered.bigrams])];

  if(finalTerms.length===0){
    const raw=segmentTextStructured(needle,false);
    const rawBigrams=new Set<string>(raw.bigrams);
    addHanBigrams(needle,rawBigrams);
    const rawMerged=[...new Set([...raw.words,...rawBigrams])];
    if(rawMerged.length>0){
      usedStopwordFallback=true;
      finalWords=raw.words;
      finalBigrams=[...rawBigrams];
      finalTerms=rawMerged;
    }
  }

  return {
    needle,
    cleanNeedle,
    queryTerms:finalTerms.slice(0,maximum),
    wordTerms:finalWords.slice(0,maximum),
    bigramTerms:finalBigrams.slice(0,maximum),
    filteredStopTerms:filtered.filteredStopTerms,
    usedStopwordFallback,
    hasNegationOrPolarityShift,
    singleCharQuery:null,
    singleAliasToken:null,
  };
}

/** Query-side lexical terms (word-level + 2-gram, stopword-filtered with safe fallback). */
export function lexicalTerms(value:string,maximum=40):string[]{
  return analyzeQuery(value,maximum).queryTerms;
}

/**
 * Document-side index terms written into existing k_terms.terms (schema v3 unchanged).
 * Combines Intl.Segmenter word tokens, fused Han runs, compact mixed Latin/digit-Han tokens,
 * Han 2-grams, alphanumeric words (>=2 chars), and dedicated exact-alias tokens ONLY for
 * explicitly declared single-character aliases.
 */
export function indexKnowledgeTerms(
  title:string,
  aliases:readonly string[],
  text:string,
  maximum=2000,
):string[]{
  const terms=new Set<string>();
  for(const alias of aliases){
    const singleToken=singleCharAliasToken(alias);
    if(singleToken)terms.add(singleToken);
  }
  const combined=[title,...aliases,text].join(' ');
  const structured=segmentTextStructured(combined,false);
  for(const token of structured.words)terms.add(token);
  for(const token of structured.bigrams)terms.add(token);
  addHanBigrams(normalized(combined),terms);
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

const ftsQuote=(term:string)=>'"'+term.replaceAll('"','""')+'"';
const previewText=(text:string,maxChars=140):string=>{
  const chars=Array.from(text.trim());
  return chars.length<=maxChars?chars.join(''):chars.slice(0,maxChars).join('')+'…';
};

function parseAliases(rawJson:string):string[]{
  try{
    const parsed=JSON.parse(rawJson) as unknown;
    return Array.isArray(parsed)?parsed.filter((item):item is string=>typeof item==='string'):[];
  }catch{
    return [];
  }
}

function extractTargetTerms(text:string):string[]{
  const structured=segmentTextStructured(text,true);
  if(structured.words.length>0)return structured.words;
  if(structured.bigrams.length>0)return structured.bigrams;
  const raw=segmentTextStructured(text,false);
  return [...new Set([...raw.words,...raw.bigrams])];
}

function countOccurrences(haystack:string,needle:string):number{
  if(!needle)return 0;
  let count=0,pos=0;
  for(;;){
    const idx=haystack.indexOf(needle,pos);
    if(idx===-1)break;
    count++;
    pos=idx+needle.length;
    if(count>=8)break;
  }
  return count;
}

/**
 * Corpus-invariant local BM25-style TF saturation score computed strictly within the matched
 * chunk and its title/aliases. Avoids global FTS5 IDF drift across unrelated entries or accounts.
 */
function localBm25Saturation(
  matchedTerms:readonly string[],
  titleNorm:string,
  aliasesJoined:string,
  bodyNorm:string,
):number{
  if(!matchedTerms.length)return 0;
  const docLen=Math.max(1,Array.from(titleNorm).length+Array.from(aliasesJoined).length+Array.from(bodyNorm).length);
  const k1=1.2,b=0.75,avgLen=180;
  const denomBase=k1*(1-b+b*(docLen/avgLen));
  let sum=0;
  for(const term of matchedTerms){
    const tf=countOccurrences(titleNorm,term)*2.5
      +countOccurrences(aliasesJoined,term)*2
      +countOccurrences(bodyNorm,term);
    if(tf>0)sum+=(tf*(k1+1))/(tf+denomBase);
  }
  const avgSaturation=sum/matchedTerms.length;
  return Math.max(0,Math.min(1,avgSaturation/(k1+1)));
}

function scoreLexicalCandidate(meta:CandidateMeta,analysis:QueryAnalysis):ScoredCandidate{
  const {row}=meta;
  const aliasesRaw=parseAliases(row.aliases_json);
  const aliasesClean=aliasesRaw.map(stripEdgePunctuation).filter(Boolean);
  const titleClean=stripEdgePunctuation(row.title);
  const titleNorm=normalized(row.title);
  const bodyNorm=normalized(row.text);
  const aliasesNorm=aliasesRaw.map(normalized).filter(Boolean);

  if(analysis.singleCharQuery){
    const exactSingleAlias=aliasesClean.includes(analysis.singleCharQuery);
    return exactSingleAlias
      ?{
        row,score:0.96,lexicalScore:0.96,vectorScore:meta.vectorScore,
        matchedTerms:[analysis.singleCharQuery],exactMatch:true,exactTitleMatch:false,
        exactAliasMatch:true,queryCoverage:1,targetCoverage:1,rejectReason:null,
      }
      :{
        row,score:0,lexicalScore:0,vectorScore:meta.vectorScore,
        matchedTerms:[],exactMatch:false,exactTitleMatch:false,exactAliasMatch:false,
        queryCoverage:0,targetCoverage:0,rejectReason:'SINGLE_CHAR_WITHOUT_EXACT_ALIAS',
      };
  }

  const cleanNeedle=analysis.cleanNeedle;
  const exactTitleMatch=cleanNeedle.length>0&&titleClean===cleanNeedle;
  const exactAliasMatch=cleanNeedle.length>0&&aliasesClean.includes(cleanNeedle);
  const exactMatch=exactTitleMatch||exactAliasMatch;

  if(analysis.usedStopwordFallback&&!exactMatch){
    // Queries composed solely of greetings/fillers are rejected unless exact title/alias matches.
    return {
      row,score:0,lexicalScore:0,vectorScore:meta.vectorScore,matchedTerms:[],
      exactMatch:false,exactTitleMatch:false,exactAliasMatch:false,
      queryCoverage:0,targetCoverage:0,rejectReason:'STOPWORD_ONLY_WEAK_MATCH',
    };
  }

  const strongPhraseMatch=!exactMatch&&cleanNeedle.length>=2&&(
    titleClean.includes(cleanNeedle)
    ||aliasesClean.some(alias=>Array.from(alias).length>=2&&(cleanNeedle.includes(alias)||alias.includes(cleanNeedle)))
  );

  const wordSet=new Set(analysis.wordTerms);
  const matchedTerms:string[]=[];
  let totalWeight=0,matchedWeight=0,titleWeight=0,aliasWeight=0,bodyWeight=0;

  for(const term of analysis.queryTerms){
    const weight=wordSet.has(term)?1:0.55;
    totalWeight+=weight;
    const inTitle=titleNorm.includes(term);
    const inAlias=aliasesNorm.some(alias=>alias.includes(term));
    const inBody=bodyNorm.includes(term);
    if(inTitle||inAlias||inBody){
      matchedTerms.push(term);
      matchedWeight+=weight;
      if(inTitle)titleWeight+=weight;
      if(inAlias)aliasWeight+=weight;
      if(inBody)bodyWeight+=weight;
    }
  }

  const queryCoverage=totalWeight>0?matchedWeight/totalWeight:0;
  const titleRatio=totalWeight>0?titleWeight/totalWeight:0;
  const aliasRatio=totalWeight>0?aliasWeight/totalWeight:0;
  const bodyRatio=totalWeight>0?bodyWeight/totalWeight:0;

  // Target-side (reverse) coverage against title and aliases to reward focused intent matches.
  const titleTargetTerms=extractTargetTerms(row.title);
  const titleTargetCov=titleTargetTerms.length>0
    ?titleTargetTerms.filter(term=>cleanNeedle.includes(term)||matchedTerms.includes(term)).length/titleTargetTerms.length
    :0;
  let bestAliasTargetCov=0;
  for(const alias of aliasesClean){
    if(Array.from(alias).length<2)continue;
    const aliasTerms=extractTargetTerms(alias);
    const cov=aliasTerms.length>0
      ?aliasTerms.filter(term=>cleanNeedle.includes(term)||matchedTerms.includes(term)).length/aliasTerms.length
      :(cleanNeedle.includes(alias)?1:0);
    if(cov>bestAliasTargetCov)bestAliasTargetCov=cov;
  }
  const targetCoverage=exactMatch?1:Math.max(titleTargetCov,bestAliasTargetCov);

  const localTfNorm=localBm25Saturation(matchedTerms,titleNorm,aliasesNorm.join(' '),bodyNorm);
  const exactBoost=exactMatch?0.36:strongPhraseMatch?0.22:0;
  const fieldBonus=titleRatio*0.16+aliasRatio*0.12+bodyRatio*0.08;

  let lexicalScore=0.52*queryCoverage+0.18*targetCoverage+fieldBonus+exactBoost+0.16*localTfNorm;
  if(exactMatch)lexicalScore=Math.max(lexicalScore,0.95);
  lexicalScore=Number(Math.max(0,Math.min(1,lexicalScore)).toFixed(4));

  return {
    row,score:lexicalScore,lexicalScore,vectorScore:meta.vectorScore,matchedTerms,
    exactMatch,exactTitleMatch,exactAliasMatch,
    queryCoverage:Number(queryCoverage.toFixed(4)),
    targetCoverage:Number(targetCoverage.toFixed(4)),
    rejectReason:null,
  };
}

function compareCandidates(a:ScoredCandidate,b:ScoredCandidate):number{
  // Exact literal title/alias match always outranks non-exact hybrid candidates.
  return Number(b.exactMatch)-Number(a.exactMatch)
    ||b.score-a.score
    ||a.row.id.localeCompare(b.row.id)
    ||a.row.chunk_id.localeCompare(b.row.chunk_id);
}

function toExactFaqMatch(
  item:ScoredCandidate,
  fullText:string,
  matchType:ExactFaqMatch['matchType'],
):ExactFaqMatch{
  return {
    id:item.row.id,sourceId:item.row.source_id,title:item.row.title,topic:item.row.topic,
    text:fullText,version:item.row.version,chunkId:item.row.chunk_id,matchType,score:item.score,
  };
}

function detectExactFaqMatch(
  acceptedEntries:readonly ScoredCandidate[],
  conflicts:readonly string[],
  analysis:QueryAnalysis,
  entryMetaById:ReadonlyMap<string,EntryFullMeta>,
):ExactFaqMatch|null{
  const cleanEntries=acceptedEntries.filter(item=>!conflicts.includes(item.row.topic));
  if(!cleanEntries.length)return null;

  const top=cleanEntries[0]!;
  const second=cleanEntries[1];
  const meta=entryMetaById.get(top.row.id);
  // Direct FAQ output requires a single unchunked entry whose complete text passes validText (<= 500 chars).
  if(!meta||meta.chunkCount!==1)return null;
  const fullText=meta.fullText.trim().replace(/\r\n?/gu,'\n');
  const fullChars=Array.from(fullText).length;
  if(fullChars===0||fullChars>EXACT_FAQ_MAX_CHARS||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(fullText))return null;

  const exactEntries=cleanEntries.filter(item=>item.exactMatch);
  if(exactEntries.length===1&&exactEntries[0]!.row.id===top.row.id){
    return toExactFaqMatch(top,fullText,top.exactTitleMatch?'EXACT_TITLE':'EXACT_ALIAS');
  }
  if(exactEntries.length>1)return null;

  if(
    !analysis.usedStopwordFallback
    &&!analysis.hasNegationOrPolarityShift
    &&!analysis.singleCharQuery
    &&top.score>=0.85
    &&top.queryCoverage>=0.85
    &&top.targetCoverage>=0.8
    &&(!second||top.score-second.score>=0.2)
  ){
    return toExactFaqMatch(top,fullText,'HIGH_CONFIDENCE');
  }
  return null;
}

const BASE_SELECT='k.id,k.source_id,k.title,k.topic,k.version,c.text,c.id AS chunk_id,k.aliases_json';

function queryFtsTable(
  db:Database.Database,
  table:'k_terms'|'k_search',
  expression:string,
  where:string,
  args:readonly unknown[],
):SearchRow[]{
  return db.prepare(`SELECT ${BASE_SELECT},bm25(${table}) AS bm25_score
    FROM ${table}
    JOIN k_chunks c ON c.id=${table}.chunk_id
    JOIN k_knowledge k ON k.id=c.entry_id
    JOIN k_sources s ON s.id=k.source_id
    WHERE ${table} MATCH ? AND ${where}`).all(expression,...args) as SearchRow[];
}

function executeRetrieval(
  db:Database.Database,
  accountId:string,
  channel:Channel,
  query:string,
  options:RetrievalOptions,
):RetrievalOutcome{
  const minScore=options.minScore??DEFAULT_MIN_SCORE;
  const analysis=analyzeQuery(query);
  const onnxStatus=options.embeddingManager
    ?options.embeddingManager.inspectStatus()
    :defaultFallbackEmbeddingStatus(options.now);

  const queryVector=options.queryVector!==undefined
    ?options.queryVector
    :(onnxStatus.engineMode==='HYBRID_ONNX'&&options.embeddingManager
      ?options.embeddingManager.embedQuerySync(query)
      :null);
  const canUseVectors=Boolean(queryVector&&queryVector.length>0);

  if(!analysis.queryTerms.length&&!analysis.singleAliasToken&&!canUseVectors){
    return {
      knowledge:[],conflicts:[],relevant:[],exactFaqMatch:null,engineMode:'FTS5_ENHANCED',
      debug:{
        engineMode:'FTS5_ENHANCED',query,channel,queryTerms:analysis.queryTerms,
        wordTerms:analysis.wordTerms,filteredStopTerms:analysis.filteredStopTerms,
        minScore,hits:[],rejectedBelowThreshold:[],conflicts:[],exactFaqHit:null,onnxStatus,
      },
    };
  }

  const sourceFilter=options.sourceIds
    ?` AND k.source_id IN (${options.sourceIds.map(()=>'?').join(',')||'NULL'})`
    :'';
  const where=`k.account_id=? AND s.own_id=? AND k.state='ACTIVE' AND (k.effective_at IS NULL OR k.effective_at<=?)
    AND (k.expires_at IS NULL OR k.expires_at>?) AND EXISTS(SELECT 1 FROM json_each(k.channels_json) WHERE value=?)${sourceFilter}`;
  const args=[accountId,options.ownId,options.now,options.now,channel,...(options.sourceIds??[])];

  const candidateMap=new Map<string,CandidateMeta>();
  const registerRow=(row:SearchRow,source:'terms'|'search'|'vector',scoreVal?:number)=>{
    let meta=candidateMap.get(row.chunk_id);
    if(!meta){meta={row,termsBm25:null,searchBm25:null,vectorScore:0};candidateMap.set(row.chunk_id,meta);}
    if(source==='terms'&&typeof scoreVal==='number')meta.termsBm25=scoreVal;
    if(source==='search'&&typeof scoreVal==='number')meta.searchBm25=scoreVal;
    if(source==='vector'&&typeof scoreVal==='number')meta.vectorScore=scoreVal;
  };

  if(analysis.singleCharQuery&&analysis.singleAliasToken){
    // Single-character guard: match ONLY entries whose aliases explicitly declare this single character.
    for(const row of queryFtsTable(db,'k_terms',ftsQuote(analysis.singleAliasToken),where,args)){
      registerRow(row,'terms',row.bm25_score);
    }
    // Legacy compatibility: normalize aliases with stripEdgePunctuation so e.g. "（配）" matches "配".
    const legacyAliasedRows=db.prepare(`SELECT ${BASE_SELECT}
      FROM k_knowledge k
      JOIN k_sources s ON s.id=k.source_id
      JOIN k_chunks c ON c.entry_id=k.id
      WHERE ${where} AND k.aliases_json<>'[]'`).all(...args) as SearchRow[];
    for(const row of legacyAliasedRows){
      if(parseAliases(row.aliases_json).map(stripEdgePunctuation).includes(analysis.singleCharQuery)){
        registerRow(row,'terms');
      }
    }
  }else if(analysis.queryTerms.length){
    for(const row of queryFtsTable(db,'k_terms',analysis.queryTerms.map(ftsQuote).join(' OR '),where,args)){
      registerRow(row,'terms',row.bm25_score);
    }
    const needleChars=Array.from(analysis.cleanNeedle);
    const ftsTerms=needleChars.length>=3
      ?needleChars.map((_,i,arr)=>arr.slice(i,i+3).join(''))
        .filter(term=>Array.from(term).length===3&&WORD_CHAR_RE.test(term))
        .slice(0,12)
      :[];
    if(ftsTerms.length){
      for(const row of queryFtsTable(db,'k_search',ftsTerms.map(ftsQuote).join(' OR '),where,args)){
        registerRow(row,'search',row.bm25_score);
      }
    }
  }

  let vectorRows:VectorSearchRow[]=[];
  if(canUseVectors&&queryVector&&!analysis.singleCharQuery){
    vectorRows=searchChunkVectors(db,{
      accountId,ownId:options.ownId,channel,now:options.now,modelId:onnxStatus.modelId,queryVector,
      ...(options.sourceIds?{sourceIds:options.sourceIds}:{}),
      limit:knowledgeLimits.candidates,
      minSimilarity:options.vectorMinSimilarity??DEFAULT_VECTOR_MIN_SIMILARITY,
    });
    for(const vrow of vectorRows)registerRow(vrow,'vector',vrow.vectorScore);
  }

  const engineMode:RetrievalEngineMode=canUseVectors&&(vectorRows.length>0||onnxStatus.engineMode==='HYBRID_ONNX')
    ?'HYBRID_ONNX'
    :'FTS5_ENHANCED';

  const lexicalScored=[...candidateMap.values()].map(meta=>scoreLexicalCandidate(meta,analysis));

  if(vectorRows.length>0){
    const lexicalRanked=[...lexicalScored]
      .filter(item=>item.lexicalScore>0)
      .sort(compareCandidates)
      .map(item=>({chunkId:item.row.chunk_id,lexicalScore:item.lexicalScore,exactMatch:item.exactMatch}));
    const fused=fuseHybridRankings(lexicalRanked,vectorRows.map(row=>({chunkId:row.chunk_id,vectorScore:row.vectorScore})));
    const fusedByChunk=new Map(fused.map(item=>[item.chunkId,item]));
    for(const item of lexicalScored){
      const hybrid=fusedByChunk.get(item.row.chunk_id);
      if(hybrid){item.score=hybrid.score;item.vectorScore=hybrid.vectorScore;}
    }
  }

  // Deduplicate by entry_id (keeping best chunk per entry) BEFORE candidate cutoff and conflict checks
  // so a single multi-chunk long entry cannot crowd out a conflicting short entry under the same topic.
  const bestByEntry=new Map<string,ScoredCandidate>();
  for(const item of lexicalScored){
    const prev=bestByEntry.get(item.row.id);
    if(!prev||compareCandidates(item,prev)<0)bestByEntry.set(item.row.id,item);
  }
  const sortedEntries=[...bestByEntry.values()].sort(compareCandidates);

  const accepted:ScoredCandidate[]=[];
  const rejectedBelowThreshold:RetrievalRejectedCandidate[]=[];

  for(const item of sortedEntries){
    const reason=item.rejectReason
      ??(item.score<minScore?(analysis.usedStopwordFallback?'STOPWORD_ONLY_WEAK_MATCH':'BELOW_MIN_SCORE'):null);
    if(reason){
      rejectedBelowThreshold.push({id:item.row.id,title:item.row.title,score:item.score,reason});
      continue;
    }
    if(accepted.length<knowledgeLimits.candidates)accepted.push(item);
  }

  const entryIds=accepted.map(item=>item.row.id);
  const topics=[...new Set(accepted.map(item=>item.row.topic))];
  const conflicts:string[]=[];
  const relevant:string[]=[];

  // Scope conflict checks to active entries that actually passed retrieval threshold.
  const variants=entryIds.length
    ?db.prepare(`SELECT k.id,k.text,k.version,k.topic,(SELECT count(*) FROM k_chunks c2 WHERE c2.entry_id=k.id) AS chunk_count
      FROM k_knowledge k JOIN k_sources s ON s.id=k.source_id
      WHERE ${where} AND k.id IN (${entryIds.map(()=>'?').join(',')}) ORDER BY k.id`)
      .all(...args,...entryIds) as {id:string;text:string;version:number;topic:string;chunk_count:number}[]
    :[];
  const entryMetaById=new Map<string,EntryFullMeta>();
  for(const row of variants){
    entryMetaById.set(row.id,{id:row.id,fullText:row.text,version:row.version,topic:row.topic,chunkCount:row.chunk_count});
    relevant.push(digest([row.id,row.version,row.text]));
  }
  for(const topic of topics){
    if(new Set(variants.filter(row=>row.topic===topic).map(row=>normalized(row.text))).size>1){
      conflicts.push(topic);
    }
  }

  const knowledge:KnowledgeHit[]=[];
  const debugHits:RetrievalDebugHit[]=[];
  let budget:number=knowledgeLimits.knowledgeCharacters;

  for(const item of accepted){
    if(conflicts.includes(item.row.topic)||knowledge.length===knowledgeLimits.knowledgeCount||budget===0)continue;
    const text=Array.from(item.row.text).slice(0,budget).join('');
    budget-=Array.from(text).length;
    const common={
      id:item.row.id,sourceId:item.row.source_id,title:item.row.title,topic:item.row.topic,
      version:item.row.version,chunkId:item.row.chunk_id,score:item.score,
      lexicalScore:item.lexicalScore,vectorScore:item.vectorScore,
      matchedTerms:item.matchedTerms,exactMatch:item.exactMatch,
    };
    knowledge.push({...common,text});
    debugHits.push({...common,textPreview:previewText(text)});
  }

  const exactFaqMatch=detectExactFaqMatch(accepted,conflicts,analysis,entryMetaById);
  return {
    knowledge,conflicts,relevant:relevant.sort(),exactFaqMatch,engineMode,
    debug:{
      engineMode,query,channel,queryTerms:analysis.queryTerms,wordTerms:analysis.wordTerms,
      filteredStopTerms:analysis.filteredStopTerms,minScore,hits:debugHits,
      rejectedBelowThreshold,conflicts,exactFaqHit:exactFaqMatch,onnxStatus,
    },
  };
}

export function retrieveKnowledge(
  db:Database.Database,
  accountId:string,
  channel:Channel,
  query:string,
  options:RetrievalOptions,
):{
  knowledge:KnowledgeHit[];conflicts:string[];relevant:string[];
  exactFaqMatch:ExactFaqMatch|null;engineMode:RetrievalEngineMode;
}{
  const {knowledge,conflicts,relevant,exactFaqMatch,engineMode}=executeRetrieval(db,accountId,channel,query,options);
  return {knowledge,conflicts,relevant,exactFaqMatch,engineMode};
}

/** Exposes detailed zero-cost retrieval diagnostics for the Knowledge Retrieval Debugger UI and tests. */
export function debugRetrieveKnowledge(
  db:Database.Database,
  accountId:string,
  channel:Channel,
  query:string,
  options:RetrievalOptions,
):RetrievalDebugResult{
  return executeRetrieval(db,accountId,channel,query,options).debug;
}
