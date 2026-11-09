import { expect,test } from 'vitest';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { randomBytes,randomUUID } from 'node:crypto';
import { readFile,writeFile,mkdir,symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateTemp } from '../helpers.js';

type Reply={protocol?:number;requestId?:string|null;ready?:boolean;ok?:boolean;error?:string;result?:Record<string,unknown>;event?:Record<string,unknown>};
interface Supervisor {start():Promise<void>;restart():Promise<void>;close():Promise<void>}
type SupervisorConstructor=new(options:{root:string;secret:string;input:PassThrough;output:PassThrough;entry?:string;watch?:boolean})=>Supervisor;
const implementation=pathToFileURL(resolve('scripts/dev-sidecar.mjs')).href;

// Serialized fixture runs in a real child and owns a real exclusive file until EOF cleanup completes.
async function fixture(paths:{trace:string;hold:string;release:string;owner:string;connectHold:string;connectRelease:string}){
  const {createInterface}=await import('node:readline');
  const {appendFileSync,existsSync,unlinkSync,writeFileSync}=await import('node:fs');
  const {resolve}=await import('node:path');
  const nonce=process.env.INBORA_PIPE_NONCE,loadedVersion='fixture-version-1';
  const note=(event:string,extra:Record<string,unknown>={})=>appendFileSync(paths.trace,JSON.stringify({event,pid:process.pid,...extra})+'\n');
  const output=(message:unknown)=>process.stdout.write(JSON.stringify(message)+'\n');
  let connected=false,runtime='',keyPresent=false,closing=false;
  const delayed:{requestId:string}[]=[];
  try{writeFileSync(paths.owner,String(process.pid),{flag:'wx'});}catch{note('owner.overlap');process.exit(9);}
  note('start',{loadedVersion});output({protocol:1,ready:true});
  const input=createInterface({input:process.stdin,crlfDelay:Infinity});
  input.on('line',async line=>{
    const envelope=JSON.parse(line),body=envelope.body;
    note('request',{command:body.command,...(body.command==='connect'?{runtime:body.runtime,initialize:body.initialize}:{}),...(body.command==='configureAi'?{hasKey:!!body.key}:{})});
    const reply=(result:Record<string,unknown>)=>output({protocol:1,requestId:envelope.requestId,ok:true,result});
    if(envelope.secret!==nonce){output({protocol:1,requestId:envelope.requestId,ok:false,error:'IPC_AUTHENTICATION_FAILED'});return;}
    if(body.command==='connect'){
      if(String(body.runtime).includes('reject-runtime')){output({protocol:1,requestId:envelope.requestId,ok:false,error:'FIXTURE_CONNECT_REJECTED'});return;}
      while(existsSync(paths.connectHold)&&!existsSync(paths.connectRelease))await new Promise(resolve=>setTimeout(resolve,5));
      connected=true;runtime=resolve(body.runtime);reply({connected:true,runtime});
    }else if(body.command==='disconnect'){
      if(body.fail){output({protocol:1,requestId:envelope.requestId,ok:false,error:'FIXTURE_DISCONNECT_REJECTED'});return;}
      connected=false;runtime='';reply({connected:false});
    }else if(body.command==='configureAi'){
      keyPresent=!!body.key;process.stderr.write('private child stderr '+nonce+' '+String(body.key)+'\n');reply({keyPresent});
    }else if(body.command==='send'){
      delayed.push({requestId:envelope.requestId});note('submitted');
    }else if(body.command==='fixtureExit'){
      note('crash');unlinkSync(paths.owner);process.exit(7);
    }else reply({connected,runtime,keyPresent,pid:process.pid,loadedVersion});
  });
  input.on('close',()=>{void(async()=>{
    if(closing)return;closing=true;note('stdin.eof');
    while(existsSync(paths.hold)&&!existsSync(paths.release))await new Promise(resolve=>setTimeout(resolve,5));
    for(const item of delayed)output({protocol:1,requestId:item.requestId,ok:true,result:{lateOldResponse:true}});
    output({protocol:1,event:{type:'FIXTURE_OLD_EVENT',pid:process.pid}});
    note('closed');unlinkSync(paths.owner);
  })();});
}

async function harness(watch=false,moduleUrl=implementation){
  const root=privateTemp('dev-sidecar-'),secret=randomBytes(32).toString('hex'),trace=join(root,'trace.jsonl');
  const hold=join(root,'hold-close'),release=join(root,'release-close'),entry=join(root,'src','app','sidecar.ts');
  await mkdir(join(root,'src','app'),{recursive:true});await mkdir(join(root,'desktop'),{recursive:true});
  await symlink(resolve('node_modules'),join(root,'node_modules'),'junction');
  // The isolated child has Node's native imports, not Vitest's in-process module loader.
  const fixtureSource=fixture.toString().replaceAll('__vite_ssr_dynamic_import__','import');
  const connectHold=join(root,'hold-connect'),connectRelease=join(root,'release-connect');
  const code='('+fixtureSource+')('+JSON.stringify({trace,hold,release,owner:join(root,'owner'),connectHold,connectRelease})+');';
  await writeFile(entry,code);await writeFile(join(root,'src','probe.ts'),'export const sourceProbe=0;\n');
  await writeFile(join(root,'desktop','probe.ts'),'export const desktopProbe=0;\n');
  const input=new PassThrough(),output=new PassThrough(),messages:Reply[]=[];let raw='';
  output.on('data',chunk=>{raw+=String(chunk);});const lines=createInterface({input:output});
  lines.on('line',line=>{messages.push(JSON.parse(line) as Reply);});
  const module=await import(moduleUrl) as {DevelopmentSidecar:SupervisorConstructor};
  const supervisor=new module.DevelopmentSidecar({root,secret,input,output,entry,watch});
  const records=async()=>existsSync(trace)?(await readFile(trace,'utf8')).trim().split(/\r?\n/u).filter(Boolean).map(line=>JSON.parse(line) as {event:string;pid:number;command?:string;runtime?:string;initialize?:boolean}):[];
  const request=(body:Record<string,unknown>,nonce=secret)=>{
    const id=randomUUID();input.write(JSON.stringify({protocol:1,requestId:id,secret:nonce,body})+'\n');
    return {id,reply:async()=>{await expect.poll(()=>messages.some(message=>message.requestId===id),{timeout:10_000}).toBe(true);return messages.find(message=>message.requestId===id)!;}};
  };
  return {root,entry,code,secret,input,output,supervisor,messages,records,request,hold,release,connectHold,connectRelease,raw:()=>raw,
    close:async()=>{await writeFile(release,'release fixture');await writeFile(connectRelease,'release fixture connect');await supervisor.close();input.end();lines.close();output.end();}};
}

test('development reload remembers only a successful canonical runtime, reconnects without initialization and never caches AI secrets',async()=>{
  const f=await harness();
  try{
    await f.supervisor.start();const requested=join(f.root,'alias')+'/../runtime',canonical=resolve(requested),key='synthetic-dev-key-must-not-be-replayed';
    expect(requested).not.toBe(canonical);
    expect(await f.request({command:'connect',runtime:requested,initialize:true,consent:true}).reply()).toMatchObject({ok:true,result:{runtime:canonical}});
    expect(await f.request({command:'configureAi',key,settings:{model:'synthetic'}}).reply()).toMatchObject({ok:true,result:{keyPresent:true}});
    await f.supervisor.restart();
    expect(await f.request({command:'getStatus'}).reply()).toMatchObject({ok:true,result:{connected:true,runtime:canonical,keyPresent:false}});
    const calls=(await f.records()).filter(record=>record.event==='request');
    expect(calls.filter(record=>record.command==='connect').map(record=>({runtime:record.runtime,initialize:record.initialize})))
      .toEqual([{runtime:requested,initialize:true},{runtime:canonical,initialize:false}]);
    expect(calls.filter(record=>record.command==='configureAi')).toHaveLength(1);
    expect(f.raw()).not.toContain(f.secret);expect(f.raw()).not.toContain(key);expect(f.raw()).not.toContain('private child stderr');
    expect(await f.request({command:'disconnect'}).reply()).toMatchObject({ok:true,result:{connected:false}});
    await f.supervisor.restart();
    expect(await f.request({command:'getStatus'}).reply()).toMatchObject({ok:true,result:{connected:false}});
    expect((await f.records()).filter(record=>record.command==='connect')).toHaveLength(2);
  }finally{await f.close();}
});

test('failed connect is not remembered and failed disconnect does not erase the last successful runtime',async()=>{
  const f=await harness();
  try{
    await f.supervisor.start();
    expect(await f.request({command:'connect',runtime:join(f.root,'reject-runtime'),initialize:true,consent:true}).reply()).toMatchObject({ok:false,error:'FIXTURE_CONNECT_REJECTED'});
    await f.supervisor.restart();
    expect((await f.records()).filter(record=>record.command==='connect')).toHaveLength(1);
    const runtime=join(f.root,'runtime');await f.request({command:'connect',runtime,initialize:true,consent:true}).reply();
    expect(await f.request({command:'disconnect',fail:true}).reply()).toMatchObject({ok:false,error:'FIXTURE_DISCONNECT_REJECTED'});
    await f.supervisor.restart();
    expect(await f.request({command:'getStatus'}).reply()).toMatchObject({ok:true,result:{connected:true,runtime}});
    expect((await f.records()).filter(record=>record.command==='connect')).toHaveLength(3);
  }finally{await f.close();}
});

test('reload waits for real EOF shutdown, coalesces concurrent reloads and rejects in-flight sends without replay or stale responses',async()=>{
  const f=await harness();
  try{
    await f.supervisor.start();await f.request({command:'connect',runtime:join(f.root,'runtime'),initialize:true,consent:true}).reply();
    await writeFile(f.hold,'delay old owner shutdown');const send=f.request({command:'send',text:'synthetic single submission'});
    await expect.poll(async()=>(await f.records()).filter(record=>record.event==='submitted').length).toBe(1);
    const restart=f.supervisor.restart(),duplicate=f.supervisor.restart();
    expect(await send.reply()).toMatchObject({ok:false,error:'DEV_BACKEND_RESTARTING_READ_STATUS'});
    await expect.poll(async()=>(await f.records()).some(record=>record.event==='stdin.eof')).toBe(true);
    expect(await f.request({command:'getStatus'}).reply()).toMatchObject({ok:false,error:'DEV_BACKEND_RESTARTING_READ_STATUS'});
    expect((await f.records()).filter(record=>record.event==='start')).toHaveLength(1);
    expect((await f.records()).some(record=>record.event==='owner.overlap')).toBe(false);
    await writeFile(f.release,'allow old owner close');await Promise.all([restart,duplicate]);
    const records=await f.records(),firstClosed=records.findIndex(record=>record.event==='closed'),starts=records.map((record,index)=>record.event==='start'?index:-1).filter(index=>index>=0);
    expect(starts).toHaveLength(2);expect(starts[1]!).toBeGreaterThan(firstClosed);
    expect(records.filter(record=>record.event==='submitted')).toHaveLength(1);
    expect(f.messages.filter(message=>message.requestId===send.id)).toHaveLength(1);
    expect(f.messages.some(message=>message.result?.lateOldResponse===true)).toBe(false);
    expect(f.messages.some(message=>message.event?.type==='FIXTURE_OLD_EVENT')).toBe(false);
    expect(await f.request({command:'getStatus'}).reply()).toMatchObject({ok:true,result:{connected:true}});
  }finally{await f.close();}
});

test('source watcher reloads actual src changes while desktop-only changes leave the backend generation intact',async()=>{
  const f=await harness(true);
  try{
    await f.supervisor.start();const initial=(await f.request({command:'getStatus'}).reply()).result?.pid;
    await writeFile(join(f.root,'desktop','probe.ts'),'export const desktopProbe=1;\n');await new Promise(resolve=>setTimeout(resolve,300));
    expect((await f.request({command:'getStatus'}).reply()).result?.pid).toBe(initial);
    await writeFile(join(f.root,'src','probe.ts'),'export const sourceProbe=1;\n');
    await expect.poll(async()=>(await f.records()).filter(record=>record.event==='start').length,{timeout:10_000}).toBe(2);
    await expect.poll(async()=>{const reply=await f.request({command:'getStatus'}).reply();return reply.ok===true&&reply.result?.pid!==initial;},{timeout:10_000}).toBe(true);
    expect((await f.records()).filter(record=>record.event==='start')).toHaveLength(2);
  }finally{await f.close();}
});

test('a second source save after the new child loads but before reconnect completes is loaded by a later generation',async()=>{
  const f=await harness(true);
  try{
    await f.supervisor.start();await f.request({command:'connect',runtime:join(f.root,'runtime'),initialize:true,consent:true}).reply();
    await writeFile(f.connectHold,'pause next generation reconnect');
    await writeFile(join(f.root,'src','probe.ts'),'export const sourceProbe=1;\n');
    await expect.poll(async()=>(await f.records()).filter(record=>record.event==='start').length).toBe(2);
    await expect.poll(async()=>(await f.records()).filter(record=>record.command==='connect').length).toBe(2);
    await writeFile(f.entry,f.code.replaceAll('fixture-version-1','fixture-version-2'));
    // Let the actual source watcher debounce while the second child remains gated in reconnect.
    await new Promise(resolve=>setTimeout(resolve,350));
    expect((await f.records()).filter(record=>record.event==='start')).toHaveLength(2);
    await writeFile(f.connectRelease,'resume reconnect');
    await expect.poll(async()=>(await f.records()).filter(record=>record.event==='start').length,{timeout:5000}).toBe(3);
    await expect.poll(async()=>{
      const reply=await f.request({command:'getStatus'}).reply();return reply.ok===true&&reply.result?.loadedVersion==='fixture-version-2';
    },{timeout:5000}).toBe(true);
    expect((await f.records()).some(record=>record.event==='owner.overlap')).toBe(false);
    expect((await f.records()).filter(record=>record.event==='start')).toHaveLength(3);
  }finally{await f.close();}
});

test('a terminal child exit is held unavailable until explicit restart rather than silently relaunching',async()=>{
  const f=await harness();
  try{
    await f.supervisor.start();const crash=f.request({command:'fixtureExit'});
    expect(await crash.reply()).toMatchObject({ok:false,error:'DEV_BACKEND_UNAVAILABLE_RESTART_REQUIRED'});
    await expect.poll(async()=>(await f.records()).some(record=>record.event==='crash')).toBe(true);
    expect(await f.request({command:'getStatus'}).reply()).toMatchObject({ok:false,error:'DEV_BACKEND_UNAVAILABLE_RESTART_REQUIRED'});
    await new Promise(resolve=>setTimeout(resolve,200));expect((await f.records()).filter(record=>record.event==='start')).toHaveLength(1);
    await f.supervisor.restart();expect(await f.request({command:'getStatus'}).reply()).toMatchObject({ok:true});
    expect((await f.records()).filter(record=>record.event==='start')).toHaveLength(2);
  }finally{await f.close();}
});

test('a syntax failure stays unavailable without leaking raw errors or looping and can be repaired by one explicit restart',async()=>{
  const f=await harness();
  try{
    await f.supervisor.start();const runtime=join(f.root,'runtime');
    await f.request({command:'connect',runtime,initialize:true,consent:true}).reply();
    await writeFile(f.entry,'const privateSyntaxCanary = ;\n');
    await expect(f.supervisor.restart()).rejects.toThrow('DEV_BACKEND_START_FAILED');
    expect(await f.request({command:'getStatus'}).reply()).toMatchObject({ok:false,error:'DEV_BACKEND_UNAVAILABLE_RESTART_REQUIRED'});
    const count=(await f.records()).filter(record=>record.event==='start').length;
    await new Promise(resolve=>setTimeout(resolve,200));expect((await f.records()).filter(record=>record.event==='start')).toHaveLength(count);
    expect(f.raw()).not.toContain('privateSyntaxCanary');expect(f.raw()).not.toContain(f.secret);
    await writeFile(f.entry,f.code);await f.supervisor.restart();
    expect(await f.request({command:'getStatus'}).reply()).toMatchObject({ok:true,result:{connected:true,runtime}});
  }finally{await f.close();}
});

test('a connected ready child that exits abnormally remains blocked from starting another runtime holder',async()=>{
  const f=await harness();
  try{
    await f.supervisor.start();await f.request({command:'connect',runtime:join(f.root,'runtime'),initialize:true,consent:true}).reply();
    const crash=f.request({command:'fixtureExit'});
    expect(await crash.reply()).toMatchObject({ok:false,error:'DEV_BACKEND_UNAVAILABLE_RESTART_REQUIRED'});
    await expect(f.supervisor.restart()).rejects.toThrow('DEV_BACKEND_START_FAILED');
    expect(await f.request({command:'getStatus'}).reply()).toMatchObject({ok:false,error:'DEV_BACKEND_UNAVAILABLE_RESTART_REQUIRED'});
    expect((await f.records()).filter(record=>record.event==='start')).toHaveLength(1);
    expect((await f.records()).some(record=>record.event==='owner.overlap')).toBe(false);
  }finally{await f.close();}
});
