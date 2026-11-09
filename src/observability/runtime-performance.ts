import {performance} from 'node:perf_hooks';
import type {Channel} from '../core/contracts.js';

export const runtimeStages=['QUEUE_WAIT','COLLECTION','TARGET_LOCATION','PAGE_WAIT','CONTENT_CHECK','RESPONSE_READ','RESPONSE_PARSE','PERSIST','MODEL','DELIVERY'] as const;
export type RuntimeStage=typeof runtimeStages[number];
export type RuntimeOutcome='SUCCEEDED'|'FAILED'|'CANCELLED'|'UNCERTAIN';
export type RuntimeChannel=Channel|'SHARED';
export interface RuntimePerformanceSummary {
  stage:RuntimeStage;channel:RuntimeChannel;count:number;failures:number;cancelled:number;uncertain:number;
  lastMs:number;p50Ms:number;p95Ms:number;maxMs:number;
}
interface Bucket {stage:RuntimeStage;channel:RuntimeChannel;count:number;failures:number;cancelled:number;uncertain:number;samples:number[]}
const channels:readonly RuntimeChannel[]=['SHARED','COMMENT_NOTIFICATION','DIRECT_MESSAGE'];
const outcomes:readonly RuntimeOutcome[]=['SUCCEEDED','FAILED','CANCELLED','UNCERTAIN'];
const samplesPerBucket=128,maxDurationMs=86_400_000,maxCount=1_000_000_000;

/** Fixed labels and 128 recent durations per bucket. No target, body, URL or exception enters this buffer. */
export class RuntimePerformance {
  private readonly buckets=new Map<string,Bucket>();
  constructor(private readonly now:()=>number=()=>performance.now()) {}
  record(stage:RuntimeStage,durationMs:number,channel:RuntimeChannel='SHARED',outcome:RuntimeOutcome='SUCCEEDED'):void {
    if(!runtimeStages.includes(stage)||!channels.includes(channel)||!outcomes.includes(outcome)||
      !Number.isFinite(durationMs)||durationMs<0)return;
    const key=stage+':'+channel;
    const bucket=this.buckets.get(key)??{stage,channel,count:0,failures:0,cancelled:0,uncertain:0,samples:[]};
    bucket.count=Math.min(maxCount,bucket.count+1);
    if(outcome==='FAILED')bucket.failures=Math.min(maxCount,bucket.failures+1);
    if(outcome==='CANCELLED')bucket.cancelled=Math.min(maxCount,bucket.cancelled+1);
    if(outcome==='UNCERTAIN')bucket.uncertain=Math.min(maxCount,bucket.uncertain+1);
    bucket.samples.push(Math.min(maxDurationMs,Math.round(durationMs*100)/100));
    if(bucket.samples.length>samplesPerBucket)bucket.samples.shift();
    this.buckets.set(key,bucket);
  }
  start(stage:RuntimeStage,channel:RuntimeChannel='SHARED'):(outcome?:RuntimeOutcome)=>void {
    const started=this.now();let ended=false;
    return (outcome='SUCCEEDED')=>{
      if(ended)return;ended=true;this.record(stage,this.now()-started,channel,outcome);
    };
  }
  snapshot():RuntimePerformanceSummary[] {
    return [...this.buckets.values()].map(bucket=>{
      const ordered=[...bucket.samples].sort((a,b)=>a-b);
      const percentile=(fraction:number)=>ordered[Math.max(0,Math.ceil(ordered.length*fraction)-1)]!;
      return {stage:bucket.stage,channel:bucket.channel,count:bucket.count,failures:bucket.failures,cancelled:bucket.cancelled,uncertain:bucket.uncertain,
        lastMs:bucket.samples.at(-1)!,p50Ms:percentile(0.5),p95Ms:percentile(0.95),maxMs:ordered.at(-1)!};
    });
  }
}

export const runtimePerformance=new RuntimePerformance();
