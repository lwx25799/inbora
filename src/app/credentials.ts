import { spawn } from "node:child_process";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { requireSafe } from "../core/contracts.js";

function dpapi(input:Buffer,operation:'Protect'|'Unprotect'):Promise<Buffer> {
  requireSafe(process.platform==='win32','DPAPI_WINDOWS_REQUIRED');
  // The secret travels on stdin, never argv, environment, a script file or a log.
  const script=`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd());
  try{$entropy=[Text.Encoding]::UTF8.GetBytes('inbora:model-key:v1');$result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser);
  [Console]::Out.Write([Convert]::ToBase64String($result));[Array]::Clear($result,0,$result.Length)}finally{[Array]::Clear($bytes,0,$bytes.Length)}`;
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='';const timer=setTimeout(()=>{child.kill();reject(Error('DPAPI_OPERATION_FAILED'));},10_000);
    child.stdout.on('data',(chunk:Buffer)=>{output+=chunk.toString('ascii');if(output.length>32_000)child.kill();});
    child.stderr.resume();child.on('error',()=>{clearTimeout(timer);reject(Error('DPAPI_OPERATION_FAILED'));});
    child.on('close',code=>{clearTimeout(timer);if(code!==0||!output||!/^[A-Za-z0-9+/=]+$/.test(output))reject(Error('DPAPI_OPERATION_FAILED'));else resolve(Buffer.from(output,'base64'));});
    child.stdin.on('error',()=>{});child.stdin.end(input.toString('base64'));
  });
}
export class CredentialStore {
  private static queues=new Map<string,Promise<unknown>>();
  private file:string;
  constructor(root:string){this.file=join(root,'model-key.dpapi');}
  private sequence<T>(operation:()=>Promise<T>):Promise<T>{
    const task=(CredentialStore.queues.get(this.file)??Promise.resolve()).catch(()=>{}).then(operation);
    CredentialStore.queues.set(this.file,task);
    void task.finally(()=>{if(CredentialStore.queues.get(this.file)===task)CredentialStore.queues.delete(this.file);}).catch(()=>{});
    return task;
  }
  load():Promise<string|null> {return this.sequence(()=>this.read());}
  private async read():Promise<string|null> {
    let encrypted:Buffer;
    try{encrypted=await readFile(this.file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
    requireSafe(encrypted.byteLength<=16_000,'DPAPI_FILE_INVALID');
    const key=await dpapi(encrypted,'Unprotect');
    try{const text=key.toString('utf8');requireSafe(text.length>0&&text.length<=4000&&!/[\r\n]/u.test(text),'INVALID_MODEL_KEY');return text;}finally{key.fill(0);}
  }
  save(key:string):Promise<void> {return this.sequence(()=>this.write(key));}
  private async write(key:string):Promise<void> {
    requireSafe(key.length>0&&key.length<=4000&&!/[\r\n]/u.test(key),'INVALID_MODEL_KEY');
    const plain=Buffer.from(key,'utf8');let encrypted:Buffer;
    try{encrypted=await dpapi(plain,'Protect');}finally{plain.fill(0);}
    const temporary=`${this.file}.${randomUUID()}.tmp`;
    try{await writeFile(temporary,encrypted,{flag:'wx',mode:0o600});await rename(temporary,this.file);}
    finally{await rm(temporary,{force:true});encrypted.fill(0);}
  }
  delete():Promise<void>{return this.sequence(async()=>{await rm(this.file,{force:true});});}
}
