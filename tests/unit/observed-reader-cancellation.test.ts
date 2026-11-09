import {expect,test,vi} from 'vitest';
import type {Page} from 'playwright';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {observedMapping} from '../fixtures/observed-site.js';

function setup(behavior:'never'|'resolve'|'metadata'){
  const controller=new AbortController(),locator=vi.fn(),waitForFunction=vi.fn(async()=>{});
  const evaluate=vi.fn(async()=>{
    if(behavior==='never')throw Error('UNEXPECTED_PAGE_EVALUATE');
    controller.abort();if(behavior==='metadata')throw Error('OBSERVATION_DM_METADATA_NOT_READY');
    return {events:[],loaded:0,unsupported:0,evidenceId:'synthetic-cancelled'};
  });
  const page={evaluate,locator,waitForFunction} as unknown as Page;
  return {controller,evaluate,locator,waitForFunction,reader:new ObservedReader(page,observedMapping('http://127.0.0.1:1'),undefined,controller.signal)};
}

test('a cancelled inspection never evaluates or selects a late conversation',async()=>{
  const f=setup('never');f.controller.abort();await expect(f.reader.dm(0)).rejects.toThrow('OBSERVATION_CANCELLED');
  expect(f.evaluate).not.toHaveBeenCalled();expect(f.locator).not.toHaveBeenCalled();expect(f.waitForFunction).not.toHaveBeenCalled();
});

test.each(['resolve','metadata'] as const)('cancellation during page capture ends before any locator or readiness retry: %s',async behavior=>{
  const f=setup(behavior);await expect(f.reader.dm(0)).rejects.toThrow('OBSERVATION_CANCELLED');
  expect(f.evaluate).toHaveBeenCalledTimes(1);expect(f.locator).not.toHaveBeenCalled();
});
