import {readFile,lstat,mkdir,rm,writeFile} from 'node:fs/promises';
import * as files from 'node:fs/promises';
import {join} from 'node:path';
import {afterEach,expect,test,vi} from 'vitest';
import {BrowserResources,type BrowserResourceIdentity} from '../../src/observability/browser-resources.js';
import {attributeBrowserProcesses,type BrowserProcessResult,type BrowserProcessRow} from '../../src/observability/browser-metrics.js';
import {privateTemp} from '../helpers.js';

vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs/promises')>();return {...actual,writeFile:vi.fn(actual.writeFile)};
});
const roots:string[]=[],monitors:BrowserResources[]=[];
function root():string {const path=privateTemp('browser-resources-');roots.push(path);return path;}
function successful(workingSetBytes=100,overrides:Partial<Extract<BrowserProcessResult,{ok:true}>['value']>={}):BrowserProcessResult {
  return {ok:true,value:{rootPid:42,rootCreatedAt:1000,browserProcesses:3,workingSetBytes,privateBytes:workingSetBytes*2,cpuSeconds:0,...overrides}};
}
const identity=():BrowserResourceIdentity=>({open:true,epoch:1,mode:'headless',pageCount:2});
function monitor(options:ConstructorParameters<typeof BrowserResources>[0]):BrowserResources {
  const resources=new BrowserResources(options);monitors.push(resources);return resources;
}
function row(pid:number,parentPid:number,name:string,createdAt:number,overrides:Partial<BrowserProcessRow>={}):BrowserProcessRow {
  return {pid,parentPid,name,createdAt,statCreatedAt:createdAt,workingSetBytes:100,privateBytes:200,cpuSeconds:1,...overrides};
}
afterEach(async()=>{
  await Promise.all(monitors.splice(0).map(resources=>resources.close()));vi.useRealTimers();vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));
});

test('only this Sidecar descendant Edge tree counts; ordinary Edge, Codex, WebView2 and other Sidecars do not',()=>{
  const rows=[row(1,0,'node.exe',100),row(2,1,'msedge.exe',200),row(3,2,'msedge.exe',300),
    row(4,1,'msedgewebview2.exe',400),row(5,0,'msedge.exe',500),row(6,0,'node.exe',600),
    row(7,6,'msedge.exe',700),row(8,0,'Codex.exe',800),row(9,8,'msedge.exe',900)];
  expect(attributeBrowserProcesses(rows,1,100)).toEqual({ok:true,value:{rootPid:2,rootCreatedAt:200,browserProcesses:2,
    workingSetBytes:200,privateBytes:400,cpuSeconds:2}});
});

test('creation times reject reused Sidecar/parent PIDs, while an exited process never becomes zero RAM',()=>{
  expect(attributeBrowserProcesses([row(1,0,'node.exe',200),row(2,1,'msedge.exe',300)],1,100))
    .toEqual({ok:false,reason:'PROCESS_UNAVAILABLE'});
  expect(attributeBrowserProcesses([row(1,0,'node.exe',100),row(2,1,'node.exe',400),row(3,2,'msedge.exe',300)],1,100))
    .toEqual({ok:false,reason:'PROCESS_UNAVAILABLE'});
  expect(attributeBrowserProcesses([row(1,0,'node.exe',100),row(2,1,'msedge.exe',200,{statCreatedAt:201})],1,100))
    .toEqual({ok:false,reason:'PROCESS_UNAVAILABLE'});
  expect(attributeBrowserProcesses([row(1,0,'node.exe',100),row(2,1,'msedge.exe',200,{workingSetBytes:null})],1,100))
    .toEqual({ok:false,reason:'PROCESS_UNAVAILABLE'});
});

test('multiple browser roots and malformed duplicate identities are unavailable',()=>{
  const owner=row(1,0,'node.exe',100),edge=row(2,1,'msedge.exe',200);
  expect(attributeBrowserProcesses([owner,edge,row(3,1,'msedge.exe',300)],1,100)).toEqual({ok:false,reason:'PROCESS_AMBIGUOUS'});
  expect(attributeBrowserProcesses([owner,edge,edge],1,100)).toEqual({ok:false,reason:'INVALID_SAMPLE'});
});

test('snapshot reads only cache and start waits for an owner; owner-ready sampling is immediate',async()=>{
  vi.useFakeTimers();let current={...identity(),open:false};const sample=vi.fn(async()=>successful());
  const updated=vi.fn(),resources=monitor({root:root(),identity:()=>current,sample,onUpdated:updated,now:()=>1000});
  resources.start();resources.start();
  for(let n=0;n<20;n++)expect(resources.snapshot().state).toBe('WAITING');
  expect(sample).not.toHaveBeenCalled();
  current={...current,open:true};await resources.sampleNow();
  expect(resources.snapshot()).toMatchObject({state:'AVAILABLE',sampledAt:1000,latest:{pageCount:2,browserProcesses:3}});
  expect(sample).toHaveBeenCalledTimes(1);expect(updated).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);await resources.sampleNow();
  expect(sample).toHaveBeenCalledTimes(2);
});

test('concurrent requests share one sample and a timeout aborts without queueing a replacement',async()=>{
  vi.useFakeTimers();let signal:AbortSignal|undefined;
  const sample=vi.fn((value:AbortSignal)=>{signal=value;return new Promise<BrowserProcessResult>(()=>{});});
  const resources=monitor({root:root(),identity,sample});
  const first=resources.sampleNow();expect(resources.sampleNow()).toBe(first);expect(sample).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000);await first;
  expect(signal?.aborted).toBe(true);expect(resources.snapshot()).toMatchObject({state:'UNAVAILABLE',reason:'TIMEOUT',latest:null});
  expect(sample).toHaveBeenCalledTimes(1);
});

test('an owner change during OS sampling discards results and starts a fresh segment later',async()=>{
  let current=identity(),finish:(value:BrowserProcessResult)=>void=()=>{};
  const sample=vi.fn(()=>new Promise<BrowserProcessResult>(resolveResult=>{finish=resolveResult;}));
  const resources=monitor({root:root(),identity:()=>current,sample,now:()=>1000});
  const first=resources.sampleNow();current={...current,epoch:2};finish(successful());await first;
  expect(resources.snapshot()).toMatchObject({state:'WAITING',reason:'OWNER_CHANGED',latest:null,run:null});
  const next=resources.sampleNow();finish(successful());await next;
  expect(resources.snapshot()).toMatchObject({state:'AVAILABLE',segmentStartedAt:1000,run:{samples:1}});
});

test('root PID creation time and owner epoch split histories, never combining browser instances',async()=>{
  let current=identity(),value=successful(),now=1000;
  const resources=monitor({root:root(),identity:()=>current,sample:async()=>value,now:()=>now});
  await resources.sampleNow();now++;value=successful(200);await resources.sampleNow();
  expect(resources.snapshot().run?.samples).toBe(2);
  now++;value=successful(400,{rootCreatedAt:2000});await resources.sampleNow();
  expect(resources.snapshot()).toMatchObject({segmentStartedAt:1002,run:{samples:1,workingSetBytes:{p50:400,p95:400,max:400}}});
  current={...current,epoch:2};now++;await resources.sampleNow();expect(resources.snapshot().run?.samples).toBe(1);
});

test('latest time is retained and marked stale; cached arrays are never returned or aliased',async()=>{
  let now=1000;const resources=monitor({root:root(),identity,sample:async()=>successful(),now:()=>now});
  await resources.sampleNow();const first=resources.snapshot();first.latest!.workingSetBytes=999;
  now+=150_001;
  expect(resources.snapshot()).toMatchObject({state:'STALE',reason:'SAMPLE_STALE',sampledAt:1000,latest:{workingSetBytes:100}});
  expect(Object.keys(resources.snapshot())).not.toContain('samples');
});

test('repeated login or open readiness checks sample each new Owner once, retaining the 60-second timer',async()=>{
  vi.useFakeTimers();let current={...identity(),open:false};const sample=vi.fn(async()=>successful());
  const resources=monitor({root:root(),identity:()=>current,sample,now:()=>1000});resources.start();
  current={...current,open:true};resources.ownerReady();await resources.sampleNow();expect(sample).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000);resources.ownerReady();expect(sample).toHaveBeenCalledTimes(1);
  current={...current,epoch:2};resources.ownerReady();await resources.sampleNow();expect(sample).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30_000);resources.ownerReady();expect(sample).toHaveBeenCalledTimes(3);
});

test('1441st sample evicts oldest and 24-hour expiry is applied to summaries and report',async()=>{
  let now=1000,value=1;
  const directory=root(),resources=monitor({root:directory,identity,sample:async()=>successful(value),now:()=>now});
  for(;value<=1441;value++){await resources.sampleNow();now++;}
  let report=JSON.parse(await readFile(join(directory,'reports','browser-resources.json'),'utf8'));
  expect(report.samples).toHaveLength(1440);expect(report.samples[0].workingSetBytes).toBe(2);
  expect(resources.snapshot().run).toMatchObject({samples:1440,workingSetBytes:{p50:721,p95:1369,max:1441}});
  now+=86_400_001;expect(resources.snapshot().run).toBeNull();
  await resources.sampleNow();report=JSON.parse(await readFile(join(directory,'reports','browser-resources.json'),'utf8'));
  expect(report.samples).toHaveLength(1);expect((await lstat(join(directory,'reports','browser-resources.json'))).size).toBeLessThan(2_097_152);
});

test('a damaged previous report is replaced; fixed report contains no private identity and has no temp sibling',async()=>{
  const directory=root();await mkdir(join(directory,'reports'));await writeFile(join(directory,'reports','browser-resources.json'),'damaged');
  const resources=monitor({root:directory,identity,sample:async()=>successful(),now:()=>1000});await resources.sampleNow();
  const body=await readFile(join(directory,'reports','browser-resources.json'),'utf8');
  expect(JSON.parse(body)).toMatchObject({version:1,state:'AVAILABLE',samples:[{pageCount:2}]});
  expect(body).not.toMatch(/pid|command|url|profile|body|cookie|token|epoch/iu);
  await expect(lstat(join(directory,'reports','browser-resources.json.tmp'))).rejects.toMatchObject({code:'ENOENT'});
});

test('report failure preserves valid values and cannot break collection or expose raw filesystem errors',async()=>{
  const directory=root();await writeFile(join(directory,'reports'),'blocked');
  const resources=monitor({root:directory,identity,sample:async()=>successful(),now:()=>1000});
  await expect(resources.sampleNow()).resolves.toBeUndefined();
  expect(resources.snapshot()).toMatchObject({state:'AVAILABLE',reason:'REPORT_WRITE_FAILED',latest:{workingSetBytes:100},run:{samples:1}});
});

test('close cancels the sampler and rejects late success, without emitting updates or writing a report',async()=>{
  let finish:(value:BrowserProcessResult)=>void=()=>{},signal:AbortSignal|undefined;
  const sample=(current:AbortSignal)=>{signal=current;return new Promise<BrowserProcessResult>(resolveResult=>{finish=resolveResult;});};
  const directory=root(),onUpdated=vi.fn(),resources=monitor({root:directory,identity,sample,onUpdated});
  const pending=resources.sampleNow();await resources.close();await pending;
  expect(signal?.aborted).toBe(true);finish(successful());await Promise.resolve();
  expect(resources.snapshot()).toMatchObject({state:'CLOSED',latest:null,run:null});expect(onUpdated).not.toHaveBeenCalled();
  await expect(lstat(join(directory,'reports'))).rejects.toMatchObject({code:'ENOENT'});
  await resources.sampleNow();expect(resources.snapshot().latest).toBeNull();
});

test('sampling failures preserve the last valid value, while invalid numeric samples never enter the report',async()=>{
  let value=successful();const resources=monitor({root:root(),identity,sample:async()=>value,now:()=>1000});
  await resources.sampleNow();value={ok:false,reason:'ACCESS_DENIED'};await resources.sampleNow();
  expect(resources.snapshot()).toMatchObject({state:'UNAVAILABLE',reason:'ACCESS_DENIED',latest:{workingSetBytes:100},run:{samples:1}});
  value=successful(Infinity);await resources.sampleNow();
  expect(resources.snapshot()).toMatchObject({state:'UNAVAILABLE',reason:'INVALID_SAMPLE',run:{samples:1}});
});

test('a changed or closed Owner immediately hides the old instance without starting an OS operation',async()=>{
  let current=identity();const sample=vi.fn(async()=>successful());
  const resources=monitor({root:root(),identity:()=>current,sample,now:()=>1000});await resources.sampleNow();
  current={...current,epoch:2};
  expect(resources.snapshot()).toMatchObject({state:'WAITING',reason:'OWNER_CHANGED',latest:null,run:null});
  current={...current,open:false};
  expect(resources.snapshot()).toMatchObject({state:'WAITING',reason:'NO_OWNER',latest:null,run:null});
  expect(sample).toHaveBeenCalledTimes(1);
});

test('identity and update subscriber exceptions cannot reject start, sampling or cached diagnostics',async()=>{
  let broken=true;const sample=vi.fn(async()=>successful());
  const resources=monitor({root:root(),identity:()=>{if(broken)throw new Error('private context failure');return identity();},
    onUpdated:()=>{throw new Error('private UI failure');},sample,now:()=>1000});
  expect(()=>resources.start()).not.toThrow();await expect(resources.sampleNow()).resolves.toBeUndefined();
  expect(resources.snapshot()).toMatchObject({state:'UNAVAILABLE',reason:'PROCESS_UNAVAILABLE',latest:null});
  broken=false;await expect(resources.sampleNow()).resolves.toBeUndefined();expect(resources.snapshot().state).toBe('AVAILABLE');
});

test('close waits for an already-started file write and skips its rename, then leaves no late files or updates',async()=>{
  let writing:()=>void=()=>{},release:()=>void=()=>{};
  const began=new Promise<void>(resolveBegan=>{writing=resolveBegan;}),gate=new Promise<void>(resolveGate=>{release=resolveGate;});
  const original=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(files.writeFile).mockImplementationOnce(async(...args)=>{writing();await gate;await original.writeFile(...args);});
  const directory=root(),onUpdated=vi.fn(),resources=monitor({root:directory,identity,sample:async()=>successful(),onUpdated});
  const sampling=resources.sampleNow();await began;let closed=false;
  const closing=resources.close().then(()=>{closed=true;});await Promise.resolve();expect(closed).toBe(false);
  release();await closing;await sampling;
  expect(closed).toBe(true);expect(onUpdated).not.toHaveBeenCalled();
  await expect(lstat(join(directory,'reports','browser-resources.json'))).rejects.toMatchObject({code:'ENOENT'});
  await expect(lstat(join(directory,'reports','browser-resources.json.tmp'))).rejects.toMatchObject({code:'ENOENT'});
});
