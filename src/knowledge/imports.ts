import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,appendFile,rm,readdir,lstat} from 'node:fs/promises';
import {join,extname} from 'node:path';
import {Worker} from 'node:worker_threads';
import {requireSafe} from '../core/contracts.js';
import type {ParsedDocument} from './import-parser.js';
import {mapChat,mapChatPreview,importMappingSchema} from './import-mapping.js';
import type {ReplyKnowledgeStore} from './store.js';
import type {z} from 'zod';

interface Upload {id:string;name:string;bytes:number;kind:'KNOWLEDGE'|'CHAT';file:string;received:number;index:number;
  digest:ReturnType<typeof createHash>;parsed?:ParsedDocument;mappingDigest?:string;busy:boolean}
export class KnowledgeImports {
  private uploads=new Map<string,Upload>();
  private active:Worker|null=null;
  private activeId:string|null=null;
  private closed=false;
  constructor(private readonly root:string){}
  private folder(){return join(this.root,'reply-imports');}
  async cleanup():Promise<void>{
    await mkdir(this.folder(),{recursive:true});
    for(const name of await readdir(this.folder()))if(/^[a-f0-9-]{36}\.upload$/u.test(name)){
      const file=join(this.folder(),name),info=await lstat(file);
      if(info.isFile()&&!info.isSymbolicLink()&&Date.now()-info.mtimeMs>86400_000)await rm(file,{force:true});
    }
  }
  async start(name:string,bytes:number,kind:'KNOWLEDGE'|'CHAT'){
    requireSafe(!this.closed,'CLIENT_CLOSING');
    requireSafe(bytes>0&&bytes<=20*1024*1024,'KNOWLEDGE_FILE_TOO_LARGE');
    const extensions=kind==='CHAT'?['.txt','.csv','.json','.jsonl']:['.txt','.md','.docx','.pdf','.csv','.xlsx'];
    requireSafe(extensions.includes(extname(name).toLowerCase()),'KNOWLEDGE_FORMAT_UNSUPPORTED');
    requireSafe([...this.uploads.values()].reduce((sum,row)=>sum+row.bytes,0)+bytes<=100*1024*1024,'KNOWLEDGE_BATCH_TOO_LARGE');
    requireSafe(this.uploads.size<20,'KNOWLEDGE_TOO_MANY_UPLOADS');
    const id=randomUUID(),file=join(this.folder(),`${id}.upload`);
    const row:Upload={id,name,bytes,kind,file,received:0,index:0,digest:createHash('sha256'),busy:true};
    this.uploads.set(id,row);
    try{await mkdir(this.folder(),{recursive:true});requireSafe(!this.closed,'CLIENT_CLOSING');
      await writeFile(file,Buffer.alloc(0),{flag:'wx',mode:0o600});requireSafe(!this.closed,'CLIENT_CLOSING');row.busy=false;return{id};
    }catch(error){this.uploads.delete(id);await rm(file,{force:true});throw error;}
  }
  private get(id:string){const upload=this.uploads.get(id);requireSafe(upload&&!this.closed,'KNOWLEDGE_UPLOAD_NOT_FOUND');return upload;}
  async chunk(id:string,index:number,data:string){
    const row=this.get(id);requireSafe(!row.busy&&!row.parsed&&index===row.index,'KNOWLEDGE_UPLOAD_ORDER');
    requireSafe(/^[A-Za-z0-9+/]*={0,2}$/u.test(data),'KNOWLEDGE_INVALID_CHUNK');
    const bytes=Buffer.from(data,'base64');requireSafe(bytes.length>0&&bytes.length<=48*1024&&bytes.toString('base64')===data,'KNOWLEDGE_INVALID_CHUNK');
    requireSafe(row.received+bytes.length<=row.bytes,'KNOWLEDGE_UPLOAD_SIZE');row.busy=true;
    try{await appendFile(row.file,bytes);row.received+=bytes.length;row.index++;row.digest.update(bytes);}
    finally{row.busy=false;}return {received:row.received};
  }
  async finish(id:string){
    const row=this.get(id);requireSafe(!row.busy&&!this.active,'KNOWLEDGE_IMPORT_BUSY');
    requireSafe(row.received===row.bytes,'KNOWLEDGE_UPLOAD_INCOMPLETE');
    if(!row.parsed){
      row.busy=true;
      try{row.parsed=await this.parse(row);}
      finally{row.busy=false;}
    }
    return {id,name:row.name,kind:row.kind,textPreview:row.parsed.text.slice(0,8000),columns:row.parsed.columns,
      rows:row.parsed.rows.slice(0,10),totalRows:row.parsed.rows.length,warnings:row.parsed.warnings};
  }
  private async parse(row:Upload):Promise<ParsedDocument>{
    const module=new URL(import.meta.url.endsWith('.ts')?'./import-worker.ts':'./import-worker.js',import.meta.url);
    const workerData={file:row.file,name:row.name,module:module.href,parent:import.meta.url};
    const worker=module.pathname.endsWith('.ts')?
      new Worker("const {workerData}=require('node:worker_threads');import('tsx/esm/api').then(m=>m.tsImport(workerData.module,workerData.parent));",
        {eval:true,workerData,execArgv:[],resourceLimits:{maxOldGenerationSizeMb:192}}):
      new Worker(module,{workerData,execArgv:[],resourceLimits:{maxOldGenerationSizeMb:192}});
    this.active=worker;this.activeId=row.id;
    try{return await new Promise<ParsedDocument>((resolve,reject)=>{
      const timer=setTimeout(()=>{void worker.terminate();reject(new Error('KNOWLEDGE_PARSE_TIMEOUT'));},30_000);
      worker.once('message',(value:{ok:boolean;result:ParsedDocument;error:string})=>{clearTimeout(timer);
        if(value.ok)resolve(value.result);else reject(new Error(value.error));});
      worker.once('error',()=>{clearTimeout(timer);reject(new Error('KNOWLEDGE_PARSE_FAILED'));});
      worker.once('exit',()=>{clearTimeout(timer);reject(new Error('KNOWLEDGE_PARSE_CANCELLED'));});
    });}catch(error){requireSafe(false,error instanceof Error&&/^KNOWLEDGE_[A-Z_]+$/u.test(error.message)?error.message:'KNOWLEDGE_PARSE_FAILED');}
    finally{await worker.terminate();this.active=null;this.activeId=null;}
  }
  previewMapping(id:string,mapping:z.infer<typeof importMappingSchema>){
    const row=this.get(id);requireSafe(row.parsed&&row.kind==='CHAT','KNOWLEDGE_IMPORT_PREVIEW_REQUIRED');
    const preview=mapChatPreview(row.parsed,mapping);row.mappingDigest=JSON.stringify(mapping);
    return {pairs:preview.pairs.slice(0,10),total:preview.pairs.length,warnings:preview.warnings};
  }
  async commit(id:string,store:ReplyKnowledgeStore,accountId:string,mapping?:z.infer<typeof importMappingSchema>){
    const row=this.get(id);requireSafe(row.parsed&&!row.busy,'KNOWLEDGE_IMPORT_PREVIEW_REQUIRED');
    const parsed=row.parsed;
    const samples=row.kind==='CHAT'?mapChat(parsed,importMappingSchema.parse(mapping)):null;
    if(samples)requireSafe(row.mappingDigest===JSON.stringify(mapping),'KNOWLEDGE_MAPPING_PREVIEW_REQUIRED');
    const source=store.store.db.transaction(()=>{
      const saved=store.saveSource(accountId,{kind:row.kind,title:row.name,digest:row.digest.copy().digest('hex')});
      if(samples)store.addSamples(accountId,samples.map(sample=>({...sample,sourceId:saved.id,group:`${saved.id}:${sample.group}`})));
      else{
      const text=parsed.text||parsed.rows.map(value=>Object.entries(value).map(([key,content])=>`${key}: ${content}`).join('；')).join('\n');
      // Each section remains an editable unpublished entry, with a single source for revocation.
      for(let offset=0;offset<text.length;offset+=90_000)store.saveKnowledge(accountId,{sourceId:saved.id,title:row.name.slice(0,200),
        topic:`${row.name.slice(0,70)}:${offset/90_000+1}`,text:text.slice(offset,offset+90_000)});
      }return saved;
    }).immediate();
    await this.cancel(id);return{sourceId:source.id,samples:samples?.length??0};
  }
  async cancel(id:string){const row=this.uploads.get(id);if(!row)return;
    if(row.busy&&this.activeId===id)await this.active?.terminate();else requireSafe(!row.busy,'KNOWLEDGE_IMPORT_BUSY');
    await rm(row.file,{force:true});this.uploads.delete(id);}
  async cancelActiveParse(){await this.active?.terminate();}
  async close(){this.closed=true;await this.cancelActiveParse();for(const row of this.uploads.values())await rm(row.file,{force:true});this.uploads.clear();}
}
