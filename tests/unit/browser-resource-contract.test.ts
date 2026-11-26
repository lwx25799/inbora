import {expect,test} from 'vitest';
import {browserResourcesSchema,diagnosticsSchema,assistantTools} from '../../src/mcp/tool-contracts.js';
import type {BrowserResourcesSnapshot} from '../../src/observability/browser-resource-contracts.js';

const summary={samples:2,workingSetBytes:{p50:100,p95:200,max:200},privateBytes:{p50:80,p95:160,max:160}};
const resources:BrowserResourcesSnapshot={state:'AVAILABLE',reason:null,intervalMs:60_000,sampledAt:1000,segmentStartedAt:500,
  latest:{workingSetBytes:200,privateBytes:160,browserProcesses:6,pageCount:2,elapsedMs:10.25},hour:summary,run:summary};
const usage={requests:0,knownUsageRequests:0,unknownUsageRequests:0,inputTokens:0,outputTokens:0,elapsedSamples:0,averageElapsedMs:null,p95ElapsedMs:null};
const diagnostic={version:1,timeRangeSupported:false,model:{total:usage,groups:[]},blockers:[],
  collection:{channels:[],works:{included:0,historical:0,review:0},conversations:{total:0,neverRead:0}}};

test('diagnostics version one accepts the optional bounded resource snapshot and old kernels',()=>{
  expect(diagnosticsSchema.parse(diagnostic)).toEqual(diagnostic);
  expect(diagnosticsSchema.parse({...diagnostic,browserResources:resources}).browserResources).toEqual(resources);
  expect(browserResourcesSchema.parse({...resources,state:'STALE',reason:'SAMPLE_STALE'})).toMatchObject({sampledAt:1000});
  expect(browserResourcesSchema.parse({...resources,state:'WAITING',reason:'NO_OWNER',sampledAt:null,segmentStartedAt:null,latest:null,hour:null,run:null})).toMatchObject({latest:null});
  expect(assistantTools.inbora_get_diagnostics.inputSchema.parse({})).toEqual({});
  expect(assistantTools.inbora_get_diagnostics.inputSchema.safeParse({sampleNow:true}).success).toBe(false);
});

test('resource wire schema rejects private or unbounded fields and invalid metrics',()=>{
  for(const field of ['pid','rootPid','commandLine','url','samples']){
    expect(browserResourcesSchema.safeParse({...resources,[field]:'PRIVATE'}).success).toBe(false);
    expect(browserResourcesSchema.safeParse({...resources,latest:{...resources.latest,[field]:'PRIVATE'}}).success).toBe(false);
  }
  for(const reason of ['PRIVATE_FAILURE_BODY','https://private.fixture',''])
    expect(browserResourcesSchema.safeParse({...resources,reason}).success).toBe(false);
  for(const latest of [{...resources.latest,workingSetBytes:-1},{...resources.latest,privateBytes:NaN},
    {...resources.latest,browserProcesses:1.5},{...resources.latest,elapsedMs:Infinity}])
    expect(browserResourcesSchema.safeParse({...resources,latest}).success).toBe(false);
  expect(browserResourcesSchema.safeParse({...resources,run:{...summary,samples:1441}}).success).toBe(false);
});
