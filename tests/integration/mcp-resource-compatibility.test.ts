import {afterEach,expect,test} from 'vitest';
import {request} from 'node:http';
import {randomUUID} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {z} from 'zod';
import {privateTemp} from '../helpers.js';
import {AssistantBridgeClient} from '../../src/mcp/bridge-client.js';
import {startAssistantControl} from '../../src/mcp/control-server.js';
import {readAssistantDiscovery,type AssistantDiscovery} from '../../src/mcp/discovery.js';
import {assistantRoute,browserResourcesHeader,type AssistantToolRegistry} from '../../src/mcp/bridge-contracts.js';
import {assistantTools,diagnosticsSchema} from '../../src/mcp/tool-contracts.js';

const usage={requests:0,knownUsageRequests:0,unknownUsageRequests:0,inputTokens:0,outputTokens:0,elapsedSamples:0,averageElapsedMs:null,p95ElapsedMs:null};
const resources={state:'AVAILABLE',reason:null,intervalMs:60_000,sampledAt:1000,segmentStartedAt:500,
  latest:{workingSetBytes:2048,privateBytes:1024,browserProcesses:6,pageCount:2,elapsedMs:15},hour:null,run:null};
const diagnostics={version:1,timeRangeSupported:false,model:{total:usage,groups:[]},blockers:[],browserResources:resources,
  collection:{channels:[],works:{included:0,historical:0,review:0},conversations:{total:0,neverRead:0}}};
const oldDiagnosticsSchema=diagnosticsSchema.omit({browserResources:true}).strict();
const tools:AssistantToolRegistry={inbora_get_diagnostics:assistantTools.inbora_get_diagnostics,
  inbora_get_status:{description:'Synthetic status',inputSchema:z.object({}).strict(),
    outputSchema:z.object({connected:z.literal(true),browserResources:z.literal('OTHER_TOOL_FIELD')}).strict()}};
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{await Promise.all(cleanups.splice(0).map(cleanup=>cleanup()));});

async function fixture(value:unknown=diagnostics){
  const root=privateTemp('mcp-resource-compat-'),calls:string[]=[];
  const control=await startAssistantControl({root,tools,dispatch:async(_session,tool)=>{
    calls.push(tool);return tool==='inbora_get_diagnostics'?value:{connected:true,browserResources:'OTHER_TOOL_FIELD'};
  }});
  cleanups.push(async()=>{
    await control.close();const base=resolve('.local/tests');
    expect(root.startsWith(`${base}\\`)||root.startsWith(`${base}/`)).toBe(true);
    await rm(root,{recursive:true,force:true});
  });
  return {root,calls,descriptor:await readAssistantDiscovery(root),client:new AssistantBridgeClient(root,{tools})};
}
async function raw(descriptor:AssistantDiscovery,headers:Record<string,string|string[]>={},tool='inbora_get_diagnostics'){
  const body=JSON.stringify({protocol:1,runtime:descriptor.runtime,instanceId:descriptor.instanceId,
    sessionId:randomUUID(),tool,args:{}});
  return new Promise<{status:number;body:{ok:boolean;result?:unknown;error?:string}}>((resolveResult,reject)=>{
    const req=request({hostname:'127.0.0.1',port:descriptor.port,path:assistantRoute,method:'POST',
      headers:{Authorization:`Bearer ${descriptor.secret}`,'Content-Type':'application/json',...headers}},response=>{
      let value='';response.setEncoding('utf8');response.on('data',chunk=>{value+=chunk;});
      response.on('end',()=>resolveResult({status:response.statusCode!,body:JSON.parse(value)}));response.on('error',reject);
    });
    req.on('error',reject);req.end(body);
  });
}

test('new diagnostics bridge receives resources while a resident old bridge still passes its original strict schema',async()=>{
  const f=await fixture();
  expect(oldDiagnosticsSchema.safeParse(diagnostics).success).toBe(false);
  expect(await f.client.call('inbora_get_diagnostics',{})).toEqual(diagnostics);
  const old=await raw(f.descriptor);
  expect(old.status).toBe(200);expect(old.body.ok).toBe(true);
  const {browserResources:_resources,...legacy}=diagnostics;
  expect(oldDiagnosticsSchema.parse(old.body.result)).toEqual(legacy);
  expect((await raw(f.descriptor,{[browserResourcesHeader]:'1'})).body.result).toEqual(diagnostics);
  expect(diagnostics.browserResources).toEqual(resources);
  expect(f.calls).toEqual(['inbora_get_diagnostics','inbora_get_diagnostics','inbora_get_diagnostics']);
});

test('diagnostics compatibility does not project fields out of any other tool',async()=>{
  const f=await fixture(),status={connected:true,browserResources:'OTHER_TOOL_FIELD'};
  expect(await f.client.call('inbora_get_status',{})).toEqual(status);
  expect((await raw(f.descriptor,{},'inbora_get_status')).body.result).toEqual(status);
  expect((await raw(f.descriptor,{[browserResourcesHeader]:'1'},'inbora_get_status')).body.result).toEqual(status);
});

test('capability must be absent or exactly one header with value one and never replaces authentication',async()=>{
  const f=await fixture();
  for(const value of ['', '0','2','true','1, 1',['1','1']]){
    const result=await raw(f.descriptor,{[browserResourcesHeader]:value});
    expect(result.status).toBe(400);expect(result.body.error).toBe('ASSISTANT_INVALID_REQUEST');
  }
  const unauthorized=await raw(f.descriptor,{Authorization:'Bearer wrong',[browserResourcesHeader]:'2'});
  expect(unauthorized.status).toBe(401);expect(unauthorized.body.error).toBe('ASSISTANT_AUTHENTICATION_FAILED');
  expect(f.calls).toEqual([]);
});

test('strict output is validated before the legacy projection, so hidden private fields still reject the response',async()=>{
  const f=await fixture({...diagnostics,browserResources:{...resources,pid:'SYNTHETIC_PRIVATE'}});
  for(const headers of [{},{[browserResourcesHeader]:'1'}]){
    const response=await raw(f.descriptor,headers);
    expect(response.body.error).toBe('ASSISTANT_RESPONSE_INVALID');
    expect(JSON.stringify(response)).not.toContain('SYNTHETIC_PRIVATE');
  }
});
