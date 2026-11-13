import {execFile,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';

const execute=promisify(execFile);
const positive=z.number().finite().positive();
const processSchema=z.object({
  pid:positive.int(),parentPid:z.number().int().nonnegative(),name:z.string().max(128),createdAt:positive,
  workingSetBytes:z.number().finite().nonnegative().nullable(),privateBytes:z.number().finite().nonnegative().nullable(),
  cpuSeconds:z.number().finite().nonnegative().nullable(),statCreatedAt:positive.nullable(),
});
const processListSchema=z.array(processSchema).max(16_384);
export type BrowserProcessRow=z.infer<typeof processSchema>;
export interface BrowserMetrics {browserProcesses:number;workingSetBytes:number;cpuSeconds:number}
export interface BrowserProcessSample extends BrowserMetrics {privateBytes:number;rootPid:number;rootCreatedAt:number}
export type BrowserProcessFailure='UNSUPPORTED_PLATFORM'|'PROCESS_UNAVAILABLE'|'PROCESS_AMBIGUOUS'|'ACCESS_DENIED'|'TIMEOUT'|'CANCELLED'|'INVALID_SAMPLE';
export type BrowserProcessResult={ok:true;value:BrowserProcessSample}|{ok:false;reason:BrowserProcessFailure};

/** Pure attribution, shared by the Windows sampler and PID-reuse regression tests. */
export function attributeBrowserProcesses(rows:readonly BrowserProcessRow[],sidecarPid:number,sidecarCreatedAt:number):BrowserProcessResult {
  const byPid=new Map(rows.map(row=>[row.pid,row]));
  if(byPid.size!==rows.length)return {ok:false,reason:'INVALID_SAMPLE'};
  const sidecar=byPid.get(sidecarPid);
  if(!sidecar||sidecar.createdAt!==sidecarCreatedAt)return {ok:false,reason:'PROCESS_UNAVAILABLE'};
  const descendants=new Set([sidecarPid]);
  let changed=true;
  while(changed){
    changed=false;
    for(const row of rows){
      const parent=byPid.get(row.parentPid);
      if(parent&&descendants.has(parent.pid)&&row.createdAt>=parent.createdAt&&!descendants.has(row.pid)){
        descendants.add(row.pid);changed=true;
      }
    }
  }
  const browsers=rows.filter(row=>descendants.has(row.pid)&&row.name.toLowerCase()==='msedge.exe');
  if(browsers.length===0)return {ok:false,reason:'PROCESS_UNAVAILABLE'};
  const hasBrowserAncestor=(row:BrowserProcessRow):boolean=>{
    const seen=new Set<number>();let parent=byPid.get(row.parentPid);
    while(parent&&parent.pid!==sidecarPid&&!seen.has(parent.pid)){
      if(parent.name.toLowerCase()==='msedge.exe')return true;
      seen.add(parent.pid);parent=byPid.get(parent.parentPid);
    }
    return false;
  };
  const roots=browsers.filter(row=>!hasBrowserAncestor(row));
  if(roots.length!==1)return {ok:false,reason:'PROCESS_AMBIGUOUS'};
  if(browsers.some(row=>row.workingSetBytes===null||row.privateBytes===null||row.cpuSeconds===null||row.statCreatedAt!==row.createdAt)){
    return {ok:false,reason:'PROCESS_UNAVAILABLE'};
  }
  const workingSetBytes=browsers.reduce((sum,row)=>sum+row.workingSetBytes!,0);
  const privateBytes=browsers.reduce((sum,row)=>sum+row.privateBytes!,0);
  const cpuSeconds=browsers.reduce((sum,row)=>sum+row.cpuSeconds!,0);
  if(!Number.isSafeInteger(workingSetBytes)||!Number.isSafeInteger(privateBytes)||workingSetBytes<=0||privateBytes<=0||!Number.isFinite(cpuSeconds)){
    return {ok:false,reason:'INVALID_SAMPLE'};
  }
  return {ok:true,value:{browserProcesses:browsers.length,workingSetBytes,privateBytes,cpuSeconds,rootPid:roots[0]!.pid,rootCreatedAt:roots[0]!.createdAt}};
}

// Only fixed metadata is selected. Neither command lines nor profile paths are requested.
// CreationDate prevents ParentProcessId reuse from attaching old children to a new parent.
const windowsScript=`$ErrorActionPreference='Stop'
try {
  $inboraRootPid=${process.pid}
  $inboraRows=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | ForEach-Object {
    if ($null -ne $_.CreationDate) {
      [pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=$_.Name;createdAt=([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()}
    }
  })
  $inboraByPid=@{};foreach($inboraRow in $inboraRows){$inboraByPid[$inboraRow.pid]=$inboraRow}
  $inboraTree=[System.Collections.Generic.HashSet[int]]::new()
  [void]$inboraTree.Add($inboraRootPid)
  do {
    $inboraChanged=$false
    foreach($inboraRow in $inboraRows) {
      $inboraParent=$inboraByPid[$inboraRow.parentPid]
      if($null -ne $inboraParent -and $inboraRow.createdAt -ge $inboraParent.createdAt -and $inboraTree.Contains($inboraRow.parentPid) -and $inboraTree.Add($inboraRow.pid)) {$inboraChanged=$true}
    }
  } while($inboraChanged)
  $inboraOutput=@(foreach($inboraRow in $inboraRows) {
    if(!$inboraTree.Contains($inboraRow.pid)){continue}
    $inboraWorking=$null;$inboraPrivate=$null;$inboraCpu=$null;$inboraCreated=$null
    if($inboraRow.name -eq 'msedge.exe') {
      $inboraProcess=Get-Process -Id $inboraRow.pid -ErrorAction SilentlyContinue
      if($null -ne $inboraProcess) {
        $inboraCreated=([DateTimeOffset]$inboraProcess.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
        $inboraWorking=$inboraProcess.WorkingSet64;$inboraPrivate=$inboraProcess.PrivateMemorySize64;$inboraCpu=$inboraProcess.CPU
      }
    }
    @{pid=$inboraRow.pid;parentPid=$inboraRow.parentPid;name=$inboraRow.name;createdAt=$inboraRow.createdAt;workingSetBytes=$inboraWorking;privateBytes=$inboraPrivate;cpuSeconds=$inboraCpu;statCreatedAt=$inboraCreated}
  })
  ConvertTo-Json -InputObject $inboraOutput -Compress
} catch [System.UnauthorizedAccessException] { '{"reason":"ACCESS_DENIED"}' }
catch { '{"reason":"PROCESS_UNAVAILABLE"}' }`;

export class BrowserProcessSampler {
  private sidecarCreatedAt:number|null=null;
  private child:ChildProcess|null=null;
  private childClosed:Promise<void>|null=null;
  async sample(signal:AbortSignal):Promise<BrowserProcessResult> {
    if(process.platform!=='win32')return {ok:false,reason:'UNSUPPORTED_PLATFORM'};
    if(signal.aborted)return {ok:false,reason:'CANCELLED'};
    if(this.child)return {ok:false,reason:'PROCESS_UNAVAILABLE'};
    try{
      const operation=execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',windowsScript],{
        timeout:5_000,signal,windowsHide:true,maxBuffer:1_048_576,
      });
      this.child=operation.child;
      const childClosed=new Promise<void>(resolveClosed=>operation.child.once('close',()=>{
        if(this.child===operation.child)this.child=null;resolveClosed();
      }));
      this.childClosed=childClosed;
      const {stdout}=await operation;
      const raw:unknown=JSON.parse(stdout);
      if(typeof raw==='object'&&raw!==null&&'reason' in raw){
        return {ok:false,reason:raw.reason==='ACCESS_DENIED'?'ACCESS_DENIED':'PROCESS_UNAVAILABLE'};
      }
      const parsed=processListSchema.safeParse(raw);
      if(!parsed.success)return {ok:false,reason:'INVALID_SAMPLE'};
      const root=parsed.data.find(row=>row.pid===process.pid);
      if(!root)return {ok:false,reason:'PROCESS_UNAVAILABLE'};
      this.sidecarCreatedAt??=root.createdAt;
      return attributeBrowserProcesses(parsed.data,process.pid,this.sidecarCreatedAt);
    }catch(error){
      if(signal.aborted)return {ok:false,reason:'CANCELLED'};
      const code=(error as NodeJS.ErrnoException).code;
      if((error as {killed?:boolean}).killed)return {ok:false,reason:'TIMEOUT'};
      return {ok:false,reason:code==='EACCES'||code==='EPERM'?'ACCESS_DENIED':'PROCESS_UNAVAILABLE'};
    }
  }
  async close():Promise<void> {
    if(this.child&&this.child.exitCode===null)this.child.kill();
    await this.childClosed;
  }
}

/** Kept for the source/built smoke probes; no monitor, timer or report is started. */
export async function browserMetrics():Promise<BrowserMetrics|null> {
  const result=await new BrowserProcessSampler().sample(new AbortController().signal);
  if(!result.ok)return null;
  const {browserProcesses,workingSetBytes,cpuSeconds}=result.value;
  return {browserProcesses,workingSetBytes,cpuSeconds};
}
