import {request} from 'node:http';
import {randomUUID} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {expect,test} from 'vitest';
import {AssistantBridgeClient} from '../../src/mcp/bridge-client.js';
import {startAssistantControl} from '../../src/mcp/control-server.js';
import {readAssistantDiscovery} from '../../src/mcp/discovery.js';
import {assistantRoute,securityStatusHeader} from '../../src/mcp/bridge-contracts.js';
import {statusSchema} from '../../src/mcp/tool-contracts.js';
import {securityRuntime} from '../../src/app/security-runtime.js';
import {privateTemp} from '../helpers.js';

test('new status metadata reaches capable bridges while existing strict bridges keep their previous shape',async()=>{
  const root=privateTemp('mcp-security-status-compat-');let calls=0;let instanceId:string=randomUUID();
  const value=()=>({runtime:root,instanceId,connected:true,accountConnected:false,browser:{state:'CLOSED',mode:'headless'},
    automaticReply:false,emergencyStopped:false,budgets:[],securityRuntime:securityRuntime(instanceId),securityHolds:[],
    assistant:{enabled:false,grantVersion:null,expiresAt:null,permissions:{read:false,editControl:false,send:false},
      remaining:{MODEL:0,SEND:0},reason:null},sync:{runId:null,running:false,cancelled:false,source:null,results:[]}});
  const control=await startAssistantControl({root,dispatch:async()=>{calls++;return value();}});instanceId=control.instanceId;
  try{
    const descriptor=await readAssistantDiscovery(root);
    const raw=async(header?:string)=>{
      const body=JSON.stringify({protocol:1,runtime:descriptor.runtime,instanceId,sessionId:randomUUID(),tool:'inbora_get_status',args:{}});
      return new Promise<{ok:boolean;result?:unknown;error?:string}>((resolve,reject)=>{
        const req=request({hostname:'127.0.0.1',port:descriptor.port,path:assistantRoute,method:'POST',
          headers:{Authorization:`Bearer ${descriptor.secret}`,'Content-Type':'application/json',
            ...(header===undefined?{}:{[securityStatusHeader]:header})}},response=>{
          let text='';response.setEncoding('utf8');response.on('data',chunk=>{text+=chunk;});
          response.on('end',()=>resolve(JSON.parse(text)));response.on('error',reject);
        });req.on('error',reject);req.end(body);
      });
    };
    const legacy=await raw();expect(legacy.ok).toBe(true);
    expect(statusSchema.omit({securityRuntime:true,securityHolds:true}).strict().parse(legacy.result)).toMatchObject({instanceId,connected:true});
    expect(legacy.result).not.toHaveProperty('securityRuntime');expect(legacy.result).not.toHaveProperty('securityHolds');
    const current=statusSchema.parse(await new AssistantBridgeClient(root).call('inbora_get_status',{}));
    expect(current.securityRuntime).toEqual(securityRuntime(instanceId));expect(current.securityHolds).toEqual([]);
    expect(await raw('unsupported')).toEqual({ok:false,error:'ASSISTANT_INVALID_REQUEST'});
    expect(calls).toBe(2);
  }finally{await control.close();await rm(root,{recursive:true,force:true});}
});
