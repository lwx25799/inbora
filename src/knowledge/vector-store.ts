import type Database from 'better-sqlite3';
import {requireSafe,type Channel} from '../core/contracts.js';

export interface ChunkVectorInput {
  chunkId:string;
  modelId:string;
  vector:Float32Array;
  updatedAt?:number;
}

export interface VectorSearchParams {
  accountId:string;
  ownId:string;
  channel:Channel;
  now:number;
  modelId:string;
  queryVector:Float32Array;
  sourceIds?:string[];
  limit?:number;
  minSimilarity?:number;
}

export interface VectorSearchRow {
  id:string;
  source_id:string;
  title:string;
  topic:string;
  version:number;
  text:string;
  chunk_id:string;
  aliases_json:string;
  vectorScore:number;
}

export interface LexicalRankCandidate {
  chunkId:string;
  lexicalScore:number;
  exactMatch:boolean;
}

export interface VectorRankCandidate {
  chunkId:string;
  vectorScore:number;
}

export interface HybridFusedRank {
  chunkId:string;
  score:number;
  lexicalScore:number;
  vectorScore:number;
  rrfScore:number;
  lexicalRank:number|null;
  vectorRank:number|null;
}

interface RawVectorRow {
  id:string;
  source_id:string;
  title:string;
  topic:string;
  version:number;
  text:string;
  chunk_id:string;
  aliases_json:string;
  dims:number;
  vector:Buffer;
}

/** Checks whether the lazy k_chunk_vectors table has been initialized in this database. */
export function hasVectorTable(db:Database.Database):boolean{
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='k_chunk_vectors'").get();
}

/**
 * Lazily initializes k_chunk_vectors outside migrateReplyKnowledge so existing schema v3 migration
 * table inventory assertions remain 100% untouched until vector storage is actually used.
 */
export function ensureVectorTable(db:Database.Database):void{
  db.exec(`
    CREATE TABLE IF NOT EXISTS k_chunk_vectors (
      chunk_id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      dims INTEGER NOT NULL,
      vector BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS k_chunk_vectors_model ON k_chunk_vectors(model_id);
  `);
}

export function encodeFloat32Vector(vector:Float32Array):Buffer{
  requireSafe(vector instanceof Float32Array&&vector.length>0&&vector.length<=4096,'KNOWLEDGE_VECTOR_INVALID');
  const buffer=Buffer.allocUnsafe(vector.length*4);
  for(let i=0;i<vector.length;i++){
    const value=vector[i]!;
    requireSafe(Number.isFinite(value),'KNOWLEDGE_VECTOR_INVALID');
    buffer.writeFloatLE(value,i*4);
  }
  return buffer;
}

export function decodeFloat32Vector(blob:Buffer|Uint8Array,dims:number):Float32Array|null{
  if(!Number.isSafeInteger(dims)||dims<=0||dims>4096)return null;
  if(blob.byteLength!==dims*4)return null;
  const view=new DataView(blob.buffer,blob.byteOffset,blob.byteLength);
  const out=new Float32Array(dims);
  for(let i=0;i<dims;i++){
    const value=view.getFloat32(i*4,true);
    if(!Number.isFinite(value))return null;
    out[i]=value;
  }
  return out;
}

export function cosineSimilarity(a:Float32Array,b:Float32Array):number{
  if(a.length===0||a.length!==b.length)return 0;
  let dot=0,normA=0,normB=0;
  for(let i=0;i<a.length;i++){
    const av=a[i]!,bv=b[i]!;
    dot+=av*bv;
    normA+=av*av;
    normB+=bv*bv;
  }
  if(normA<=0||normB<=0)return 0;
  const raw=dot/(Math.sqrt(normA)*Math.sqrt(normB));
  if(!Number.isFinite(raw))return 0;
  return Math.max(-1,Math.min(1,raw));
}

export function upsertChunkVector(db:Database.Database,input:ChunkVectorInput):void{
  ensureVectorTable(db);
  const blob=encodeFloat32Vector(input.vector);
  db.prepare(`INSERT INTO k_chunk_vectors (chunk_id, model_id, dims, vector, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chunk_id) DO UPDATE SET
      model_id=excluded.model_id,
      dims=excluded.dims,
      vector=excluded.vector,
      updated_at=excluded.updated_at`)
    .run(input.chunkId,input.modelId,input.vector.length,blob,input.updatedAt??Date.now());
}

export function upsertChunkVectors(db:Database.Database,inputs:readonly ChunkVectorInput[]):void{
  if(!inputs.length)return;
  ensureVectorTable(db);
  const stmt=db.prepare(`INSERT INTO k_chunk_vectors (chunk_id, model_id, dims, vector, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chunk_id) DO UPDATE SET
      model_id=excluded.model_id,
      dims=excluded.dims,
      vector=excluded.vector,
      updated_at=excluded.updated_at`);
  const run=db.transaction((rows:readonly ChunkVectorInput[])=>{
    for(const item of rows){
      stmt.run(item.chunkId,item.modelId,item.vector.length,encodeFloat32Vector(item.vector),item.updatedAt??Date.now());
    }
  });
  run.immediate(inputs);
}

export function deleteChunkVectorsByEntry(db:Database.Database,entryId:string):void{
  if(!hasVectorTable(db))return;
  db.prepare('DELETE FROM k_chunk_vectors WHERE chunk_id IN (SELECT id FROM k_chunks WHERE entry_id=?)').run(entryId);
}

export function deleteChunkVectorsBySource(db:Database.Database,sourceId:string):void{
  if(!hasVectorTable(db))return;
  db.prepare(`DELETE FROM k_chunk_vectors WHERE chunk_id IN (
    SELECT c.id FROM k_chunks c JOIN k_knowledge k ON k.id=c.entry_id WHERE k.source_id=?
  )`).run(sourceId);
}

export function countChunkVectors(db:Database.Database,modelId?:string):number{
  if(!hasVectorTable(db))return 0;
  const row=modelId
    ?db.prepare('SELECT count(*) n FROM k_chunk_vectors WHERE model_id=?').get(modelId) as {n:number}
    :db.prepare('SELECT count(*) n FROM k_chunk_vectors').get() as {n:number};
  return row.n;
}

/**
 * Queries stored Float32Array chunk vectors strictly scoped by account, ownId, active state,
 * validity window, channel, optional sourceIds, and modelId. Returns [] if table does not exist yet.
 */
export function searchChunkVectors(db:Database.Database,params:VectorSearchParams):VectorSearchRow[]{
  if(!hasVectorTable(db)||params.queryVector.length===0)return [];
  const limit=Math.max(1,Math.min(100,params.limit??20));
  const minSimilarity=params.minSimilarity??0.25;
  const sourceFilter=params.sourceIds
    ?` AND k.source_id IN (${params.sourceIds.map(()=>'?').join(',')||'NULL'})`
    :'';
  const sql=`SELECT k.id,k.source_id,k.title,k.topic,k.version,c.text,c.id AS chunk_id,k.aliases_json,v.dims,v.vector
    FROM k_chunk_vectors v
    JOIN k_chunks c ON c.id=v.chunk_id
    JOIN k_knowledge k ON k.id=c.entry_id
    JOIN k_sources s ON s.id=k.source_id
    WHERE v.model_id=?
      AND v.dims=?
      AND k.account_id=?
      AND s.own_id=?
      AND k.state='ACTIVE'
      AND (k.effective_at IS NULL OR k.effective_at<=?)
      AND (k.expires_at IS NULL OR k.expires_at>?)
      AND EXISTS(SELECT 1 FROM json_each(k.channels_json) WHERE value=?)${sourceFilter}`;
  const args=[
    params.modelId,
    params.queryVector.length,
    params.accountId,
    params.ownId,
    params.now,
    params.now,
    params.channel,
    ...(params.sourceIds??[]),
  ];
  const rows=db.prepare(sql).all(...args) as RawVectorRow[];
  const scored:VectorSearchRow[]=[];
  for(const row of rows){
    const decoded=decodeFloat32Vector(row.vector,row.dims);
    if(!decoded)continue;
    const sim=Math.max(0,cosineSimilarity(params.queryVector,decoded));
    if(sim<minSimilarity)continue;
    scored.push({
      id:row.id,
      source_id:row.source_id,
      title:row.title,
      topic:row.topic,
      version:row.version,
      text:row.text,
      chunk_id:row.chunk_id,
      aliases_json:row.aliases_json,
      vectorScore:Number(sim.toFixed(4)),
    });
  }
  scored.sort((a,b)=>b.vectorScore-a.vectorScore||a.id.localeCompare(b.id)||a.chunk_id.localeCompare(b.chunk_id));
  return scored.slice(0,limit);
}

/**
 * Reciprocal Rank Fusion (RRF) combining lexical FTS5 rankings and dense vector rankings.
 * Preserves exact-match priority while boosting items agreed upon by both signals and allowing
 * high-similarity semantic hits to surface even when surface vocabulary differs.
 */
export function fuseHybridRankings(
  lexical:readonly LexicalRankCandidate[],
  vector:readonly VectorRankCandidate[],
  options:{k?:number;lexicalWeight?:number;vectorWeight?:number}={},
):HybridFusedRank[]{
  const k=options.k??60;
  const lexicalWeight=options.lexicalWeight??0.55;
  const vectorWeight=options.vectorWeight??0.45;
  const maxRrf=(lexicalWeight+vectorWeight)/(k+1);

  const byChunk=new Map<string,{
    lexicalScore:number;vectorScore:number;exactMatch:boolean;
    lexicalRank:number|null;vectorRank:number|null;
  }>();

  lexical.forEach((item,index)=>{
    byChunk.set(item.chunkId,{
      lexicalScore:item.lexicalScore,
      vectorScore:0,
      exactMatch:item.exactMatch,
      lexicalRank:index+1,
      vectorRank:null,
    });
  });

  vector.forEach((item,index)=>{
    const existing=byChunk.get(item.chunkId);
    if(existing){
      existing.vectorScore=item.vectorScore;
      existing.vectorRank=index+1;
    }else{
      byChunk.set(item.chunkId,{
        lexicalScore:0,
        vectorScore:item.vectorScore,
        exactMatch:false,
        lexicalRank:null,
        vectorRank:index+1,
      });
    }
  });

  const results:HybridFusedRank[]=[];
  for(const [chunkId,entry] of byChunk){
    const rrf=(entry.lexicalRank!==null?lexicalWeight/(k+entry.lexicalRank):0)
      +(entry.vectorRank!==null?vectorWeight/(k+entry.vectorRank):0);
    const rrfNorm=maxRrf>0?Math.min(1,rrf/maxRrf):0;
    let combined:number;
    if(entry.lexicalRank!==null&&entry.vectorRank!==null){
      // Both lexical and semantic agree: blend raw evidence with RRF agreement boost.
      combined=Math.min(1,0.5*entry.lexicalScore+0.35*entry.vectorScore+0.25*rrfNorm+(entry.exactMatch?0.12:0));
    }else if(entry.lexicalRank!==null){
      combined=Math.min(1,entry.exactMatch?Math.max(entry.lexicalScore,0.92):0.85*entry.lexicalScore+0.15*rrfNorm);
    }else{
      // Pure semantic vector recall without lexical overlap.
      combined=Math.min(1,0.78*entry.vectorScore+0.22*rrfNorm);
    }
    results.push({
      chunkId,
      score:Number(combined.toFixed(4)),
      lexicalScore:Number(entry.lexicalScore.toFixed(4)),
      vectorScore:Number(entry.vectorScore.toFixed(4)),
      rrfScore:Number(rrf.toFixed(6)),
      lexicalRank:entry.lexicalRank,
      vectorRank:entry.vectorRank,
    });
  }

  results.sort((a,b)=>b.score-a.score||b.rrfScore-a.rrfScore||a.chunkId.localeCompare(b.chunkId));
  return results;
}
