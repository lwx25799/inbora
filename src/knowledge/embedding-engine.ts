import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import type {LookupAddress} from 'node:dns';
import {lookup as dnsLookup} from 'node:dns/promises';
import {closeSync,constants as fsConstants,createReadStream,createWriteStream,fstatSync,lstatSync,openSync,readSync} from 'node:fs';
import {mkdir,rename,rm} from 'node:fs/promises';
import https from 'node:https';
import {isIP,type LookupFunction} from 'node:net';
import {homedir} from 'node:os';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {Readable} from 'node:stream';
import {isPublicModelAddress} from '../ai/model-transport.js';
import type {OnnxEmbeddingState,OnnxEmbeddingStatus,RetrievalEngineMode} from './contracts.js';

export type OnnxDnsLookup=(hostname:string,options:{all:true})=>Promise<LookupAddress[]>;

export interface OnnxModelSpec {
  modelId:string;
  fileName:string;
  dims:number;
  expectedSha256:string|null;
  minBytes:number;
  maxBytes:number;
  downloadUrl:string|null;
}

export interface EmbeddingRuntime {
  readonly modelId:string;
  readonly dims:number;
  embed(text:string):Float32Array|Promise<Float32Array>;
  embedSync?(text:string):Float32Array;
}

export interface OnnxEmbeddingManagerOptions {
  spec?:Partial<OnnxModelSpec>;
  configuredModelPath?:string|null;
  cacheRoot?:string;
  sharedSearchDirs?:string[];
  runtimeFactory?:(input:{modelPath:string;spec:OnnxModelSpec})=>EmbeddingRuntime|null;
  transport?:typeof fetch;
  lookup?:OnnxDnsLookup;
  now?:()=>number;
}

export interface OnnxEnsureReadyOptions {
  allowDownload?:boolean;
  signal?:AbortSignal;
  timeoutMs?:number;
}

export interface FileVerificationResult {
  ok:boolean;
  code:
    | 'OK'
    | 'NOT_FOUND'
    | 'NOT_REGULAR_FILE'
    | 'SYMLINK_REJECTED'
    | 'SIZE_OUT_OF_RANGE'
    | 'SHA256_MISMATCH'
    | 'EXPECTED_SHA256_UNCONFIGURED'
    | 'INVALID_EXPECTED_SHA256'
    | 'IO_ERROR';
  sizeBytes:number|null;
  actualSha256:string|null;
  mtimeMs:number|null;
}

const SHA256_HEX_RE=/^[a-f0-9]{64}$/u;
const SAFE_REASON_RE=/^[A-Z0-9_:-]{1,96}$/u;
const HASH_CHUNK_BYTES=65_536;
const nativeFetch=globalThis.fetch;

/**
 * Default local ONNX embedding model specification (quantized Chinese BGE small).
 * expectedSha256 stays null until an official binary digest is explicitly pinned, preventing
 * unverified model reuse or self-contradictory placeholder hashes.
 */
export const DEFAULT_ONNX_MODEL_SPEC:OnnxModelSpec={
  modelId:'bge-small-zh-v1.5-q8',
  fileName:'model_quantized.onnx',
  dims:512,
  expectedSha256:null,
  minBytes:1_048_576,
  maxBytes:512*1024*1024,
  downloadUrl:'https://huggingface.co/BAAI/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx',
};

export function defaultFallbackEmbeddingStatus(now:number,reason='ONNX_MANAGER_NOT_CONFIGURED'):OnnxEmbeddingStatus{
  return {
    state:'FALLBACK_FTS5',
    engineMode:'FTS5_ENHANCED',
    modelId:DEFAULT_ONNX_MODEL_SPEC.modelId,
    modelPath:null,
    expectedSha256:null,
    actualSha256:null,
    sizeBytes:null,
    dims:DEFAULT_ONNX_MODEL_SPEC.dims,
    checkedPaths:[],
    reason,
    checkedAt:now,
  };
}

/**
 * Strips absolute local filesystem paths and any non-enum reason strings before returning
 * ONNX status over IPC to the desktop UI.
 */
export function sanitizeEmbeddingStatus(status:OnnxEmbeddingStatus):OnnxEmbeddingStatus{
  const safeReason=SAFE_REASON_RE.test(status.reason)?status.reason:'ONNX_FALLBACK_FTS5';
  return {
    ...status,
    modelPath:null,
    checkedPaths:[],
    reason:safeReason,
  };
}

function isLocalOnlyHostname(hostname:string):boolean{
  const host=hostname.trim().toLowerCase().replace(/^\[|\]$/gu,'').replace(/\.$/u,'');
  return !host||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal');
}

/**
 * Restricts model downloads to public HTTPS endpoints on default port 443,
 * reusing the shared IPv4/IPv6 public address policy from src/ai/model-transport.ts.
 */
export function isSafePublicHttpsUrl(rawUrl:string|null|undefined):boolean{
  if(!rawUrl)return false;
  try{
    const parsed=new URL(rawUrl);
    if(parsed.protocol!=='https:')return false;
    if(parsed.username||parsed.password)return false;
    if(parsed.port!==''&&parsed.port!=='443')return false;
    const hostname=parsed.hostname.replace(/^\[|\]$/gu,'');
    if(isLocalOnlyHostname(hostname))return false;
    const family=isIP(hostname);
    if(family)return isPublicModelAddress(hostname);
    return true;
  }catch{
    return false;
  }
}

function sha256Equal(expectedHex:string,actualHex:string):boolean{
  if(!SHA256_HEX_RE.test(expectedHex)||!SHA256_HEX_RE.test(actualHex))return false;
  const expected=Buffer.from(expectedHex,'hex');
  const actual=Buffer.from(actualHex,'hex');
  return expected.length===actual.length&&timingSafeEqual(expected,actual);
}

/**
 * Verifies an ONNX model file synchronously using an open file descriptor (openSync + fstatSync)
 * with strict bounded reads and symlink rejection to avoid lstat->open TOCTOU races.
 */
export function verifyOnnxModelFileSync(filePath:string,spec:OnnxModelSpec):FileVerificationResult{
  if(spec.expectedSha256===null){
    // Still report NOT_FOUND vs unpinned hash accurately without trusting unverified files.
    try{
      lstatSync(filePath);
    }catch(error){
      const code=(error as NodeJS.ErrnoException|undefined)?.code;
      if(code==='ENOENT'||code==='ENOTDIR')return {ok:false,code:'NOT_FOUND',sizeBytes:null,actualSha256:null,mtimeMs:null};
    }
    return {ok:false,code:'EXPECTED_SHA256_UNCONFIGURED',sizeBytes:null,actualSha256:null,mtimeMs:null};
  }
  if(!SHA256_HEX_RE.test(spec.expectedSha256)){
    return {ok:false,code:'INVALID_EXPECTED_SHA256',sizeBytes:null,actualSha256:null,mtimeMs:null};
  }

  try{
    const linkStat=lstatSync(filePath);
    if(linkStat.isSymbolicLink()){
      return {ok:false,code:'SYMLINK_REJECTED',sizeBytes:linkStat.size,actualSha256:null,mtimeMs:linkStat.mtimeMs};
    }
  }catch(error){
    const code=(error as NodeJS.ErrnoException|undefined)?.code;
    if(code==='ENOENT'||code==='ENOTDIR')return {ok:false,code:'NOT_FOUND',sizeBytes:null,actualSha256:null,mtimeMs:null};
    return {ok:false,code:'IO_ERROR',sizeBytes:null,actualSha256:null,mtimeMs:null};
  }

  const openFlags=fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW??0);
  let fd:number|undefined;
  let sizeBytes:number|null=null;
  let mtimeMs:number|null=null;
  try{
    fd=openSync(filePath,openFlags);
    const stat=fstatSync(fd);
    sizeBytes=stat.size;
    mtimeMs=stat.mtimeMs;
    if(!stat.isFile())return {ok:false,code:'NOT_REGULAR_FILE',sizeBytes,actualSha256:null,mtimeMs};
    if(stat.size<spec.minBytes||stat.size>spec.maxBytes){
      return {ok:false,code:'SIZE_OUT_OF_RANGE',sizeBytes,actualSha256:null,mtimeMs};
    }
    const hash=createHash('sha256');
    const buffer=Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let totalRead=0;
    for(;;){
      const remaining=spec.maxBytes-totalRead;
      const toRead=Math.min(HASH_CHUNK_BYTES,remaining+1);
      const bytesRead=readSync(fd,buffer,0,toRead,null);
      if(bytesRead<=0)break;
      totalRead+=bytesRead;
      if(totalRead>spec.maxBytes){
        return {ok:false,code:'SIZE_OUT_OF_RANGE',sizeBytes:totalRead,actualSha256:null,mtimeMs};
      }
      hash.update(buffer.subarray(0,bytesRead));
    }
    if(totalRead<spec.minBytes||totalRead>spec.maxBytes){
      return {ok:false,code:'SIZE_OUT_OF_RANGE',sizeBytes:totalRead,actualSha256:null,mtimeMs};
    }
    const actualSha256=hash.digest('hex');
    if(!sha256Equal(spec.expectedSha256,actualSha256)){
      return {ok:false,code:'SHA256_MISMATCH',sizeBytes:totalRead,actualSha256,mtimeMs};
    }
    return {ok:true,code:'OK',sizeBytes:totalRead,actualSha256,mtimeMs};
  }catch(error){
    const code=(error as NodeJS.ErrnoException|undefined)?.code;
    if(code==='ENOENT'||code==='ENOTDIR')return {ok:false,code:'NOT_FOUND',sizeBytes:null,actualSha256:null,mtimeMs:null};
    if(code==='ELOOP')return {ok:false,code:'SYMLINK_REJECTED',sizeBytes:null,actualSha256:null,mtimeMs:null};
    return {ok:false,code:'IO_ERROR',sizeBytes,actualSha256:null,mtimeMs};
  }finally{
    if(fd!==undefined){try{closeSync(fd);}catch{/* ignore close error */}}
  }
}

export async function sha256FileAsync(filePath:string):Promise<string>{
  return await new Promise<string>((resolveHash,rejectHash)=>{
    const hash=createHash('sha256');
    const stream=createReadStream(filePath,{highWaterMark:HASH_CHUNK_BYTES});
    stream.on('data',chunk=>hash.update(chunk));
    stream.on('error',rejectHash);
    stream.on('end',()=>resolveHash(hash.digest('hex')));
  });
}

function defaultSharedSearchDirs():string[]{
  const dirs:string[]=[];
  const localAppData=process.env.LOCALAPPDATA?.trim();
  const home=homedir();
  if(localAppData)dirs.push(join(localAppData,'Inbora','models','onnx'));
  if(home){
    dirs.push(join(home,'.cache','inbora','onnx'));
    dirs.push(join(home,'.cache','onnx-models'));
  }
  return dirs;
}

function isValidVector(vector:Float32Array,dims:number):boolean{
  if(!(vector instanceof Float32Array)||vector.length!==dims||dims<=0)return false;
  for(let i=0;i<vector.length;i++)if(!Number.isFinite(vector[i]!))return false;
  return true;
}

async function resolvePublicAddresses(url:URL,lookup:OnnxDnsLookup):Promise<LookupAddress[]>{
  const hostname=url.hostname.replace(/^\[|\]$/gu,'');
  const family=isIP(hostname);
  const resolved=family?[{address:hostname,family}]:await lookup(hostname,{all:true});
  if(!resolved.length||resolved.some(({address,family:f})=>isIP(address)!==f||!isPublicModelAddress(address))){
    throw new Error('ONNX_DOWNLOAD_DNS_REJECTED');
  }
  return resolved.map(({address,family:f})=>({address,family:f}));
}

async function pinnedHttpsGet(url:URL,addresses:readonly LookupAddress[],signal:AbortSignal):Promise<Response>{
  const hostname=url.hostname.replace(/^\[|\]$/gu,'');
  const family=isIP(hostname);
  const pinnedLookup:LookupFunction=(_host,options,callback)=>{
    if(options.all)callback(null,[...addresses]);
    else callback(null,addresses[0]!.address,addresses[0]!.family);
  };
  return await new Promise<Response>((resolveResponse,reject)=>{
    const req=https.request(url,{
      method:'GET',
      port:443,
      headers:{'accept-encoding':'identity'},
      signal,
      agent:false,
      lookup:pinnedLookup,
      rejectUnauthorized:true,
      ...(family?{}:{servername:hostname.replace(/\.$/u,'')}),
    },incoming=>{
      const status=incoming.statusCode??500;
      if(status>=300&&status<400){
        incoming.destroy();
        reject(new Error('ONNX_DOWNLOAD_REDIRECT_REJECTED'));
        return;
      }
      if(status<200||status>=300){
        incoming.destroy();
        resolveResponse(new Response(null,{status}));
        return;
      }
      const stream=Readable.toWeb(incoming,{
        strategy:{highWaterMark:incoming.readableHighWaterMark,size:(chunk:Uint8Array)=>chunk.byteLength},
      });
      resolveResponse(new Response(stream as unknown as ReadableStream<Uint8Array>,{status}));
    });
    req.once('error',()=>reject(new Error(signal.aborted?'ONNX_DOWNLOAD_ABORTED':'ONNX_DOWNLOAD_NETWORK_ERROR')));
    req.end();
  });
}

function classifyDownloadError(error:unknown,signal:AbortSignal):string{
  if(signal.aborted)return 'ONNX_DOWNLOAD_ABORTED';
  if(error instanceof Error&&SAFE_REASON_RE.test(error.message))return error.message;
  return 'ONNX_DOWNLOAD_FAILED';
}

interface VerifiedCacheEntry {
  path:string;
  sizeBytes:number;
  mtimeMs:number;
  actualSha256:string;
  origin:'REUSED_LOCAL'|'DOWNLOAD_READY';
}

/**
 * Manages local ONNX embedding model detection, SHA-256 integrity validation, optional safe HTTPS download,
 * and automatic zero-blocking fallback to enhanced FTS5 when local vector inference is not ready.
 */
export class OnnxEmbeddingManager {
  readonly spec:OnnxModelSpec;
  private readonly configuredModelPath:string|null;
  private readonly cacheRoot:string|null;
  private readonly sharedSearchDirs:string[];
  private readonly runtimeFactory?:(input:{modelPath:string;spec:OnnxModelSpec})=>EmbeddingRuntime|null;
  private readonly transport?:typeof fetch;
  private readonly lookup:OnnxDnsLookup;
  private readonly hasCustomLookup:boolean;
  private readonly now:()=>number;
  private verifiedCache:VerifiedCacheEntry|null=null;
  private runtime:EmbeddingRuntime|null=null;
  private runtimeModelPath:string|null=null;
  private lastFallbackReason:string|null=null;

  constructor(options:OnnxEmbeddingManagerOptions={}){
    this.spec={...DEFAULT_ONNX_MODEL_SPEC,...options.spec};
    const envPath=options.configuredModelPath===undefined?process.env.INBORA_ONNX_MODEL_PATH?.trim()||null:options.configuredModelPath;
    this.configuredModelPath=envPath&&envPath.trim()?resolve(envPath.trim()):null;
    this.cacheRoot=options.cacheRoot?resolve(options.cacheRoot):null;
    this.sharedSearchDirs=(options.sharedSearchDirs??defaultSharedSearchDirs()).map(dir=>resolve(dir));
    if(options.runtimeFactory)this.runtimeFactory=options.runtimeFactory;
    if(options.transport)this.transport=options.transport;
    this.hasCustomLookup=Boolean(options.lookup);
    this.lookup=options.lookup??dnsLookup;
    this.now=options.now??Date.now;
  }

  candidateModelPaths():string[]{
    const paths:string[]=[];
    const pushUnique=(value:string)=>{
      const normalizedPath=resolve(value);
      if(!paths.includes(normalizedPath))paths.push(normalizedPath);
    };
    if(this.configuredModelPath&&isAbsolute(this.configuredModelPath))pushUnique(this.configuredModelPath);
    if(this.cacheRoot){
      pushUnique(join(this.cacheRoot,this.spec.modelId,this.spec.fileName));
      pushUnique(join(this.cacheRoot,this.spec.fileName));
    }
    for(const dir of this.sharedSearchDirs){
      pushUnique(join(dir,this.spec.modelId,this.spec.fileName));
      pushUnique(join(dir,this.spec.fileName));
    }
    return paths;
  }

  private activateRuntime(modelPath:string):{ready:boolean;reason:string}{
    if(!this.runtimeFactory){
      this.runtime=null;
      this.runtimeModelPath=null;
      return {ready:false,reason:'ONNX_RUNTIME_UNAVAILABLE_FALLBACK_FTS5'};
    }
    if(this.runtime&&this.runtimeModelPath===modelPath)return {ready:true,reason:'HYBRID_ONNX_ACTIVE'};
    try{
      const created=this.runtimeFactory({modelPath,spec:this.spec});
      if(!created||created.dims!==this.spec.dims){
        this.runtime=null;
        this.runtimeModelPath=null;
        return {ready:false,reason:'ONNX_RUNTIME_DIMS_MISMATCH_FALLBACK_FTS5'};
      }
      this.runtime=created;
      this.runtimeModelPath=modelPath;
      return {ready:true,reason:'HYBRID_ONNX_ACTIVE'};
    }catch{
      this.runtime=null;
      this.runtimeModelPath=null;
      return {ready:false,reason:'ONNX_RUNTIME_INIT_FAILED_FALLBACK_FTS5'};
    }
  }

  private checkCachedStillValid():boolean{
    if(!this.verifiedCache)return false;
    try{
      const stat=lstatSync(this.verifiedCache.path);
      return !stat.isSymbolicLink()&&stat.isFile()&&stat.size===this.verifiedCache.sizeBytes&&stat.mtimeMs===this.verifiedCache.mtimeMs;
    }catch{
      return false;
    }
  }

  private buildStatus(input:{
    state:OnnxEmbeddingState;engineMode:RetrievalEngineMode;modelPath:string|null;
    actualSha256:string|null;sizeBytes:number|null;checkedPaths:string[];reason:string;
  }):OnnxEmbeddingStatus{
    return {
      state:input.state,
      engineMode:input.engineMode,
      modelId:this.spec.modelId,
      modelPath:input.modelPath,
      expectedSha256:this.spec.expectedSha256,
      actualSha256:input.actualSha256,
      sizeBytes:input.sizeBytes,
      dims:this.spec.dims,
      checkedPaths:input.checkedPaths,
      reason:input.reason,
      checkedAt:this.now(),
    };
  }

  /**
   * Synchronously inspects configured and shared local paths with strict size + SHA-256 verification.
   * Never performs network I/O and never throws to callers.
   */
  inspectStatus():OnnxEmbeddingStatus{
    const checkedPaths=this.candidateModelPaths();
    if(this.verifiedCache&&this.checkCachedStillValid()){
      const runtimeState=this.activateRuntime(this.verifiedCache.path);
      return this.buildStatus({
        state:this.verifiedCache.origin,
        engineMode:runtimeState.ready?'HYBRID_ONNX':'FTS5_ENHANCED',
        modelPath:this.verifiedCache.path,
        actualSha256:this.verifiedCache.actualSha256,
        sizeBytes:this.verifiedCache.sizeBytes,
        checkedPaths,
        reason:runtimeState.ready
          ?(this.verifiedCache.origin==='DOWNLOAD_READY'?'DOWNLOADED_MODEL_VERIFIED':'LOCAL_MODEL_VERIFIED_AND_REUSED')
          :runtimeState.reason,
      });
    }
    this.verifiedCache=null;
    this.runtime=null;
    this.runtimeModelPath=null;

    let integrityFailure:{path:string;code:FileVerificationResult['code'];sizeBytes:number|null;actualSha256:string|null}|null=null;
    for(const candidate of checkedPaths){
      const verified=verifyOnnxModelFileSync(candidate,this.spec);
      if(verified.ok&&verified.actualSha256!==null&&verified.sizeBytes!==null&&verified.mtimeMs!==null){
        this.verifiedCache={
          path:candidate,sizeBytes:verified.sizeBytes,mtimeMs:verified.mtimeMs,
          actualSha256:verified.actualSha256,origin:'REUSED_LOCAL',
        };
        this.lastFallbackReason=null;
        const runtimeState=this.activateRuntime(candidate);
        return this.buildStatus({
          state:'REUSED_LOCAL',
          engineMode:runtimeState.ready?'HYBRID_ONNX':'FTS5_ENHANCED',
          modelPath:candidate,
          actualSha256:verified.actualSha256,
          sizeBytes:verified.sizeBytes,
          checkedPaths,
          reason:runtimeState.ready?'LOCAL_MODEL_VERIFIED_AND_REUSED':runtimeState.reason,
        });
      }
      if(verified.code!=='NOT_FOUND'&&!integrityFailure){
        integrityFailure={path:candidate,code:verified.code,sizeBytes:verified.sizeBytes,actualSha256:verified.actualSha256};
      }
    }

    if(integrityFailure){
      return this.buildStatus({
        state:'FALLBACK_FTS5',
        engineMode:'FTS5_ENHANCED',
        modelPath:integrityFailure.path,
        actualSha256:integrityFailure.actualSha256,
        sizeBytes:integrityFailure.sizeBytes,
        checkedPaths,
        reason:`LOCAL_MODEL_INTEGRITY_REJECTED:${integrityFailure.code}`,
      });
    }

    if(this.lastFallbackReason){
      return this.buildStatus({
        state:'FALLBACK_FTS5',engineMode:'FTS5_ENHANCED',modelPath:null,
        actualSha256:null,sizeBytes:null,checkedPaths,reason:this.lastFallbackReason,
      });
    }

    return this.buildStatus({
      state:'MISSING_NEEDS_DOWNLOAD',
      engineMode:'FTS5_ENHANCED',
      modelPath:null,
      actualSha256:null,
      sizeBytes:null,
      checkedPaths,
      reason:this.spec.expectedSha256===null?'ONNX_MODEL_SHA256_NOT_PINNED':'LOCAL_ONNX_MODEL_NOT_FOUND',
    });
  }

  /**
   * Checks local verified models first; if missing and allowDownload=true, performs a safe DNS-pinned
   * public HTTPS (port 443) download with streaming size cap + SHA-256 verification.
   * Any failure cleans up temporary files and degrades cleanly to FALLBACK_FTS5.
   */
  async ensureReady(options:OnnxEnsureReadyOptions={}):Promise<OnnxEmbeddingStatus>{
    const current=this.inspectStatus();
    if(current.state==='REUSED_LOCAL'||current.state==='DOWNLOAD_READY')return current;
    if(!options.allowDownload)return current;

    const checkedPaths=this.candidateModelPaths();
    const fail=(reason:string,actualSha256:string|null=null,sizeBytes:number|null=null)=>{
      this.lastFallbackReason=reason;
      return this.buildStatus({state:'FALLBACK_FTS5',engineMode:'FTS5_ENHANCED',modelPath:null,actualSha256,sizeBytes,checkedPaths,reason});
    };

    if(!this.cacheRoot)return fail('ONNX_CACHE_ROOT_NOT_CONFIGURED');
    if(!isSafePublicHttpsUrl(this.spec.downloadUrl))return fail('ONNX_DOWNLOAD_URL_UNSAFE');
    if(!this.spec.expectedSha256||!SHA256_HEX_RE.test(this.spec.expectedSha256))return fail('ONNX_EXPECTED_SHA256_UNCONFIGURED');

    const url=new URL(this.spec.downloadUrl!);
    const targetPath=join(this.cacheRoot,this.spec.modelId,this.spec.fileName);
    const tempPath=`${targetPath}.part-${randomUUID()}`;
    const timeoutMs=options.timeoutMs??60_000;
    const signal=options.signal
      ?AbortSignal.any([options.signal,AbortSignal.timeout(timeoutMs)])
      :AbortSignal.timeout(timeoutMs);

    try{
      const usePinnedHttps=!this.transport||this.transport===nativeFetch||this.transport===globalThis.fetch;
      let addresses:LookupAddress[]|null=null;
      if(usePinnedHttps||this.hasCustomLookup){
        addresses=await resolvePublicAddresses(url,this.lookup);
      }
      await mkdir(dirname(targetPath),{recursive:true});

      const response=usePinnedHttps
        ?await pinnedHttpsGet(url,addresses!,signal)
        :await this.transport!(url.toString(),{method:'GET',redirect:'error',signal});

      if(response.redirected||response.type==='opaqueredirect'||(response.status>=300&&response.status<400)){
        await response.body?.cancel().catch(()=>{/* ignore cancel */});
        return fail('ONNX_DOWNLOAD_REDIRECT_REJECTED');
      }
      if(!response.ok||!response.body){
        await response.body?.cancel().catch(()=>{/* ignore cancel */});
        return fail(`ONNX_DOWNLOAD_HTTP_${response.status}`);
      }

      const reader=response.body.getReader();
      const writer=createWriteStream(tempPath,{flags:'wx'});
      let writerError:Error|null=null;
      const writerClosed=new Promise<void>(resolveClose=>{writer.once('close',()=>resolveClose());});
      // Attach error handler immediately so open/write failures never escape as uncaught stream errors.
      writer.on('error',err=>{writerError=err;});

      const hash=createHash('sha256');
      let totalBytes=0;
      try{
        for(;;){
          if(writerError)throw new Error('ONNX_DOWNLOAD_WRITE_FAILED');
          const {done,value}=await reader.read();
          if(done)break;
          if(writerError)throw new Error('ONNX_DOWNLOAD_WRITE_FAILED');
          totalBytes+=value.byteLength;
          if(totalBytes>this.spec.maxBytes)throw new Error('ONNX_DOWNLOAD_TOO_LARGE');
          hash.update(value);
          if(!writer.write(value)){
            await new Promise<void>((resolveDrain,rejectDrain)=>{
              if(writerError){rejectDrain(new Error('ONNX_DOWNLOAD_WRITE_FAILED'));return;}
              const onDrain=()=>{writer.off('error',onErr);resolveDrain();};
              const onErr=()=>{writer.off('drain',onDrain);rejectDrain(new Error('ONNX_DOWNLOAD_WRITE_FAILED'));};
              writer.once('drain',onDrain);
              writer.once('error',onErr);
            });
          }
        }
        if(writerError)throw new Error('ONNX_DOWNLOAD_WRITE_FAILED');
        await new Promise<void>((resolveEnd,rejectEnd)=>{
          const onErr=()=>rejectEnd(new Error('ONNX_DOWNLOAD_WRITE_FAILED'));
          writer.once('error',onErr);
          writer.end(()=>{writer.off('error',onErr);resolveEnd();});
        });
        if(!writer.closed)await writerClosed;
      }catch(error){
        await reader.cancel().catch(()=>{/* ignore reader cancel */});
        writer.destroy();
        if(!writer.closed)await writerClosed;
        throw error;
      }finally{
        reader.releaseLock();
      }

      const actualSha256=hash.digest('hex');
      if(totalBytes<this.spec.minBytes||totalBytes>this.spec.maxBytes){
        await rm(tempPath,{force:true});
        return fail('ONNX_DOWNLOAD_SIZE_OUT_OF_RANGE',actualSha256,totalBytes);
      }
      if(!sha256Equal(this.spec.expectedSha256,actualSha256)){
        await rm(tempPath,{force:true});
        return fail('ONNX_DOWNLOAD_SHA256_MISMATCH',actualSha256,totalBytes);
      }

      await rename(tempPath,targetPath);
      const stat=lstatSync(targetPath);
      this.verifiedCache={
        path:targetPath,sizeBytes:stat.size,mtimeMs:stat.mtimeMs,actualSha256,origin:'DOWNLOAD_READY',
      };
      this.lastFallbackReason=null;
      const runtimeState=this.activateRuntime(targetPath);
      return this.buildStatus({
        state:'DOWNLOAD_READY',
        engineMode:runtimeState.ready?'HYBRID_ONNX':'FTS5_ENHANCED',
        modelPath:targetPath,
        actualSha256,
        sizeBytes:stat.size,
        checkedPaths:this.candidateModelPaths(),
        reason:runtimeState.ready?'DOWNLOADED_MODEL_VERIFIED':runtimeState.reason,
      });
    }catch(error){
      await rm(tempPath,{force:true}).catch(()=>{/* ignore cleanup error */});
      return fail(classifyDownloadError(error,signal));
    }
  }

  getRuntime():EmbeddingRuntime|null{
    const status=this.inspectStatus();
    if(status.engineMode!=='HYBRID_ONNX')return null;
    return this.runtime;
  }

  embedQuerySync(text:string):Float32Array|null{
    const runtime=this.getRuntime();
    if(!runtime?.embedSync)return null;
    try{
      const vector=runtime.embedSync(text);
      return isValidVector(vector,this.spec.dims)?vector:null;
    }catch{
      return null;
    }
  }

  async embedText(text:string):Promise<Float32Array|null>{
    const runtime=this.getRuntime();
    if(!runtime)return null;
    try{
      const vector=await runtime.embed(text);
      return isValidVector(vector,this.spec.dims)?vector:null;
    }catch{
      return null;
    }
  }
}
