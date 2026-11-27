import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {closeSync,createReadStream,createWriteStream,lstatSync,openSync,readSync} from 'node:fs';
import {mkdir,rename,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import type {OnnxEmbeddingState,OnnxEmbeddingStatus,RetrievalEngineMode} from './contracts.js';

export interface OnnxModelSpec {
  modelId:string;
  fileName:string;
  dims:number;
  expectedSha256:string;
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
  now?:()=>number;
}

export interface OnnxEnsureReadyOptions {
  allowDownload?:boolean;
  signal?:AbortSignal;
  timeoutMs?:number;
}

export interface FileVerificationResult {
  ok:boolean;
  code:'OK'|'NOT_FOUND'|'NOT_REGULAR_FILE'|'SYMLINK_REJECTED'|'SIZE_OUT_OF_RANGE'|'SHA256_MISMATCH'|'INVALID_EXPECTED_SHA256'|'IO_ERROR';
  sizeBytes:number|null;
  actualSha256:string|null;
  mtimeMs:number|null;
}

const SHA256_HEX_RE=/^[a-f0-9]{64}$/u;
const HASH_CHUNK_BYTES=65_536;

/**
 * Default local ONNX embedding model specification (quantized Chinese BGE small).
 * Integrity is always verified by file size bounds and SHA-256 before any reuse or activation.
 */
export const DEFAULT_ONNX_MODEL_SPEC:OnnxModelSpec={
  modelId:'bge-small-zh-v1.5-q8',
  fileName:'model_quantized.onnx',
  dims:512,
  expectedSha256:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
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

function isPrivateOrLoopbackHost(hostname:string):boolean{
  const host=hostname.trim().toLowerCase().replace(/^\[|\]$/gu,'');
  if(!host||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal'))return true;
  if(host==='::1'||host==='::'||host.startsWith('fc')||host.startsWith('fd')||host.startsWith('fe80')||host.startsWith('::ffff:'))return true;
  const ipv4=/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if(ipv4){
    const [a,b]=[Number(ipv4[1]),Number(ipv4[2])];
    if(a===0||a===10||a===127)return true;
    if(a===169&&b===254)return true;
    if(a===172&&b>=16&&b<=31)return true;
    if(a===192&&b===168)return true;
    if(a===100&&b>=64&&b<=127)return true;
  }
  return false;
}

/** Restricts model downloads to public HTTPS endpoints, preserving SSRF boundaries. */
export function isSafePublicHttpsUrl(rawUrl:string|null|undefined):boolean{
  if(!rawUrl)return false;
  try{
    const parsed=new URL(rawUrl);
    if(parsed.protocol!=='https:')return false;
    if(parsed.username||parsed.password)return false;
    return !isPrivateOrLoopbackHost(parsed.hostname);
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

/** Verifies an ONNX model file synchronously with bounded streaming reads (no full-file RAM spike). */
export function verifyOnnxModelFileSync(filePath:string,spec:OnnxModelSpec):FileVerificationResult{
  if(!SHA256_HEX_RE.test(spec.expectedSha256)){
    return {ok:false,code:'INVALID_EXPECTED_SHA256',sizeBytes:null,actualSha256:null,mtimeMs:null};
  }
  let stat;
  try{
    stat=lstatSync(filePath);
  }catch(error){
    const code=(error as NodeJS.ErrnoException|undefined)?.code;
    if(code==='ENOENT'||code==='ENOTDIR')return {ok:false,code:'NOT_FOUND',sizeBytes:null,actualSha256:null,mtimeMs:null};
    return {ok:false,code:'IO_ERROR',sizeBytes:null,actualSha256:null,mtimeMs:null};
  }
  if(stat.isSymbolicLink())return {ok:false,code:'SYMLINK_REJECTED',sizeBytes:stat.size,actualSha256:null,mtimeMs:stat.mtimeMs};
  if(!stat.isFile())return {ok:false,code:'NOT_REGULAR_FILE',sizeBytes:stat.size,actualSha256:null,mtimeMs:stat.mtimeMs};
  if(stat.size<spec.minBytes||stat.size>spec.maxBytes){
    return {ok:false,code:'SIZE_OUT_OF_RANGE',sizeBytes:stat.size,actualSha256:null,mtimeMs:stat.mtimeMs};
  }
  const hash=createHash('sha256');
  const buffer=Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let fd:number|undefined;
  try{
    fd=openSync(filePath,'r');
    for(;;){
      const bytesRead=readSync(fd,buffer,0,HASH_CHUNK_BYTES,null);
      if(bytesRead<=0)break;
      hash.update(buffer.subarray(0,bytesRead));
    }
  }catch{
    return {ok:false,code:'IO_ERROR',sizeBytes:stat.size,actualSha256:null,mtimeMs:stat.mtimeMs};
  }finally{
    if(fd!==undefined){try{closeSync(fd);}catch{/* ignore close error */}}
  }
  const actualSha256=hash.digest('hex');
  if(!sha256Equal(spec.expectedSha256,actualSha256)){
    return {ok:false,code:'SHA256_MISMATCH',sizeBytes:stat.size,actualSha256,mtimeMs:stat.mtimeMs};
  }
  return {ok:true,code:'OK',sizeBytes:stat.size,actualSha256,mtimeMs:stat.mtimeMs};
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
  private readonly transport:typeof fetch;
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
    this.transport=options.transport??fetch;
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

    let corruptionFailure:{path:string;code:FileVerificationResult['code'];sizeBytes:number|null;actualSha256:string|null}|null=null;
    for(const candidate of checkedPaths){
      const verified=verifyOnnxModelFileSync(candidate,this.spec);
      if(verified.ok&&verified.actualSha256!==null&&verified.sizeBytes!==null&&verified.mtimeMs!==null){
        this.verifiedCache={
          path:candidate,
          sizeBytes:verified.sizeBytes,
          mtimeMs:verified.mtimeMs,
          actualSha256:verified.actualSha256,
          origin:'REUSED_LOCAL',
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
      if(verified.code!=='NOT_FOUND'&&!corruptionFailure){
        corruptionFailure={path:candidate,code:verified.code,sizeBytes:verified.sizeBytes,actualSha256:verified.actualSha256};
      }
    }

    if(corruptionFailure){
      return this.buildStatus({
        state:'FALLBACK_FTS5',
        engineMode:'FTS5_ENHANCED',
        modelPath:corruptionFailure.path,
        actualSha256:corruptionFailure.actualSha256,
        sizeBytes:corruptionFailure.sizeBytes,
        checkedPaths,
        reason:`LOCAL_MODEL_INTEGRITY_REJECTED:${corruptionFailure.code}`,
      });
    }

    if(this.lastFallbackReason){
      return this.buildStatus({
        state:'FALLBACK_FTS5',
        engineMode:'FTS5_ENHANCED',
        modelPath:null,
        actualSha256:null,
        sizeBytes:null,
        checkedPaths,
        reason:this.lastFallbackReason,
      });
    }

    return this.buildStatus({
      state:'MISSING_NEEDS_DOWNLOAD',
      engineMode:'FTS5_ENHANCED',
      modelPath:null,
      actualSha256:null,
      sizeBytes:null,
      checkedPaths,
      reason:'LOCAL_ONNX_MODEL_NOT_FOUND',
    });
  }

  /**
   * Checks local verified models first; if missing and allowDownload=true, performs a safe HTTPS download
   * with streaming size cap + SHA-256 verification. Any error degrades cleanly to FALLBACK_FTS5.
   */
  async ensureReady(options:OnnxEnsureReadyOptions={}):Promise<OnnxEmbeddingStatus>{
    const current=this.inspectStatus();
    if(current.state==='REUSED_LOCAL'||current.state==='DOWNLOAD_READY')return current;
    if(!options.allowDownload)return current;

    const checkedPaths=this.candidateModelPaths();
    if(!this.cacheRoot){
      this.lastFallbackReason='ONNX_CACHE_ROOT_NOT_CONFIGURED';
      return this.buildStatus({state:'FALLBACK_FTS5',engineMode:'FTS5_ENHANCED',modelPath:null,actualSha256:null,sizeBytes:null,checkedPaths,reason:this.lastFallbackReason});
    }
    if(!isSafePublicHttpsUrl(this.spec.downloadUrl)){
      this.lastFallbackReason='ONNX_DOWNLOAD_URL_UNSAFE';
      return this.buildStatus({state:'FALLBACK_FTS5',engineMode:'FTS5_ENHANCED',modelPath:null,actualSha256:null,sizeBytes:null,checkedPaths,reason:this.lastFallbackReason});
    }
    if(!SHA256_HEX_RE.test(this.spec.expectedSha256)){
      this.lastFallbackReason='ONNX_EXPECTED_SHA256_INVALID';
      return this.buildStatus({state:'FALLBACK_FTS5',engineMode:'FTS5_ENHANCED',modelPath:null,actualSha256:null,sizeBytes:null,checkedPaths,reason:this.lastFallbackReason});
    }

    const targetPath=join(this.cacheRoot,this.spec.modelId,this.spec.fileName);
    const tempPath=`${targetPath}.part-${randomUUID()}`;
    const timeoutMs=options.timeoutMs??60_000;
    const signal=options.signal
      ?AbortSignal.any([options.signal,AbortSignal.timeout(timeoutMs)])
      :AbortSignal.timeout(timeoutMs);

    try{
      await mkdir(dirname(targetPath),{recursive:true});
      const response=await this.transport(this.spec.downloadUrl!,{method:'GET',redirect:'error',signal});
      if(!response.ok||!response.body){
        this.lastFallbackReason=`ONNX_DOWNLOAD_HTTP_${response.status}`;
        return this.buildStatus({state:'FALLBACK_FTS5',engineMode:'FTS5_ENHANCED',modelPath:null,actualSha256:null,sizeBytes:null,checkedPaths,reason:this.lastFallbackReason});
      }
      const reader=response.body.getReader();
      const writer=createWriteStream(tempPath,{flags:'wx'});
      const hash=createHash('sha256');
      let totalBytes=0;
      try{
        for(;;){
          const {done,value}=await reader.read();
          if(done)break;
          totalBytes+=value.byteLength;
          if(totalBytes>this.spec.maxBytes)throw new Error('ONNX_DOWNLOAD_TOO_LARGE');
          hash.update(value);
          if(!writer.write(value)){
            await new Promise<void>((resolveDrain,rejectDrain)=>{
              writer.once('drain',resolveDrain);
              writer.once('error',rejectDrain);
            });
          }
        }
        await new Promise<void>((resolveEnd,rejectEnd)=>{
          writer.once('error',rejectEnd);
          writer.end(()=>resolveEnd());
        });
      }catch(error){
        writer.destroy();
        throw error;
      }

      const actualSha256=hash.digest('hex');
      if(totalBytes<this.spec.minBytes||totalBytes>this.spec.maxBytes){
        await rm(tempPath,{force:true});
        this.lastFallbackReason='ONNX_DOWNLOAD_SIZE_OUT_OF_RANGE';
        return this.buildStatus({state:'FALLBACK_FTS5',engineMode:'FTS5_ENHANCED',modelPath:null,actualSha256,sizeBytes:totalBytes,checkedPaths,reason:this.lastFallbackReason});
      }
      if(!sha256Equal(this.spec.expectedSha256,actualSha256)){
        await rm(tempPath,{force:true});
        this.lastFallbackReason='ONNX_DOWNLOAD_SHA256_MISMATCH';
        return this.buildStatus({state:'FALLBACK_FTS5',engineMode:'FTS5_ENHANCED',modelPath:null,actualSha256,sizeBytes:totalBytes,checkedPaths,reason:this.lastFallbackReason});
      }

      await rename(tempPath,targetPath);
      const stat=lstatSync(targetPath);
      this.verifiedCache={
        path:targetPath,
        sizeBytes:stat.size,
        mtimeMs:stat.mtimeMs,
        actualSha256,
        origin:'DOWNLOAD_READY',
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
      const tag=error instanceof Error&&error.message?error.message:'ONNX_DOWNLOAD_FAILED';
      this.lastFallbackReason=`FALLBACK_AFTER_DOWNLOAD_ERROR:${tag}`;
      return this.buildStatus({
        state:'FALLBACK_FTS5',
        engineMode:'FTS5_ENHANCED',
        modelPath:null,
        actualSha256:null,
        sizeBytes:null,
        checkedPaths,
        reason:this.lastFallbackReason,
      });
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
