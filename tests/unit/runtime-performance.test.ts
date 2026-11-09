import {expect, test} from 'vitest';
import {RuntimePerformance} from '../../src/observability/runtime-performance.js';

test('stage timers are monotonic, one-shot and report fixed numeric aggregates',()=>{
  let now=10;const metrics=new RuntimePerformance(()=>now),end=metrics.start('COLLECTION','DIRECT_MESSAGE');
  now=35;end();now=99;end('FAILED');
  expect(metrics.snapshot()).toEqual([{stage:'COLLECTION',channel:'DIRECT_MESSAGE',count:1,failures:0,cancelled:0,uncertain:0,lastMs:25,p50Ms:25,p95Ms:25,maxMs:25}]);
});

test('bounded samples retain recent percentiles while total counters remain useful',()=>{
  const metrics=new RuntimePerformance();
  for(let i=1;i<=1000;i++)metrics.record('PERSIST',i,'SHARED',i%2?'SUCCEEDED':'FAILED');
  expect(metrics.snapshot()).toEqual([{stage:'PERSIST',channel:'SHARED',count:1000,failures:500,cancelled:0,uncertain:0,lastMs:1000,p50Ms:936,p95Ms:994,maxMs:1000}]);
});

test('invalid untyped inputs cannot add private labels or nonfinite values',()=>{
  const metrics=new RuntimePerformance();
  metrics.record('PRIVATE_STAGE' as 'MODEL',1);metrics.record('MODEL',Infinity);metrics.record('MODEL',-1);
  metrics.record('MODEL',1,'PRIVATE_CHANNEL' as 'SHARED');metrics.record('MODEL',1,'SHARED','PRIVATE_ERROR' as 'FAILED');
  expect(metrics.snapshot()).toEqual([]);
  metrics.record('DELIVERY',20,'COMMENT_NOTIFICATION','CANCELLED');
  expect(metrics.snapshot()[0]).toMatchObject({cancelled:1,failures:0});
  expect(JSON.stringify(metrics.snapshot())).not.toMatch(/PRIVATE_|text|url|error|id/i);
});

test('object location, page waiting and content checking are distinct supported stages',()=>{
  const metrics=new RuntimePerformance();
  metrics.record('TARGET_LOCATION',12,'COMMENT_NOTIFICATION');
  metrics.record('PAGE_WAIT',34,'COMMENT_NOTIFICATION');
  metrics.record('CONTENT_CHECK',5,'COMMENT_NOTIFICATION','FAILED');
  expect(metrics.snapshot().map(row=>({stage:row.stage,lastMs:row.lastMs,failures:row.failures}))).toEqual([
    {stage:'TARGET_LOCATION',lastMs:12,failures:0},{stage:'PAGE_WAIT',lastMs:34,failures:0},{stage:'CONTENT_CHECK',lastMs:5,failures:1},
  ]);
});

test('an uncertain delivery is pending proof and never recorded as a failed send',()=>{
  const metrics=new RuntimePerformance();metrics.record('DELIVERY',50,'DIRECT_MESSAGE','UNCERTAIN');
  expect(metrics.snapshot()[0]).toMatchObject({count:1,failures:0,uncertain:1,cancelled:0});
});
