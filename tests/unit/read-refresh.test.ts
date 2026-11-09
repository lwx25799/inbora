import {afterEach,expect,test,vi} from 'vitest';
import {ReadRefresh,refreshTargets} from '../../desktop/src/read-refresh.js';

afterEach(()=>vi.useRealTimers());

test('a burst of events is combined after 150ms without extending its deadline',async()=>{
  vi.useFakeTimers();const status=vi.fn(async()=>{}),refresh=new ReadRefresh({status});
  refresh.schedule(['status']);await vi.advanceTimersByTimeAsync(100);refresh.schedule(['status']);
  await vi.advanceTimersByTimeAsync(49);expect(status).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);expect(status).toHaveBeenCalledTimes(1);refresh.dispose();
});

test('each read type has one in-flight query and one combined trailing query',async()=>{
  vi.useFakeTimers();let release:()=>void=()=>{},active=0,maximum=0;
  const status=vi.fn(async()=>{maximum=Math.max(maximum,++active);if(status.mock.calls.length===1)await new Promise<void>(resolve=>{release=resolve;});active--;});
  const inbox=vi.fn(async()=>{}),refresh=new ReadRefresh({status,inbox});
  refresh.schedule(['status'],0);await vi.advanceTimersByTimeAsync(0);
  for(let n=0;n<50;n++)refresh.schedule(['status','inbox']);
  await vi.advanceTimersByTimeAsync(1000);expect(status).toHaveBeenCalledTimes(1);expect(inbox).toHaveBeenCalledTimes(1);
  release();await vi.advanceTimersByTimeAsync(149);expect(status).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);expect(status).toHaveBeenCalledTimes(2);expect(maximum).toBe(1);refresh.dispose();
});

test('read failures do not block another event, and disposal cancels pending and trailing reads',async()=>{
  vi.useFakeTimers();const failed=vi.fn(),status=vi.fn(async()=>{throw Error('synthetic');});
  const refresh=new ReadRefresh({status},failed);refresh.schedule(['status']);await vi.advanceTimersByTimeAsync(150);
  expect(failed).toHaveBeenCalledTimes(1);refresh.schedule(['status']);refresh.dispose();
  await vi.advanceTimersByTimeAsync(1000);expect(status).toHaveBeenCalledTimes(1);
});

test('same-view notifications preserve a running snapshot and disposal still makes it ineligible',async()=>{
  vi.useFakeTimers();let release:()=>void=()=>{},current:(()=>boolean)|undefined;
  const refresh=new ReadRefresh({inbox:async valid=>{current=valid;await new Promise<void>(resolve=>{release=resolve;});}});
  refresh.schedule(['inbox'],0);await vi.advanceTimersByTimeAsync(0);expect(current?.()).toBe(true);
  refresh.schedule(['inbox']);expect(current?.()).toBe(true);release();
  await vi.advanceTimersByTimeAsync(150);expect(current?.()).toBe(true);refresh.dispose();expect(current?.()).toBe(false);release();
});

test('continuous events cannot starve successful snapshots and the trailing read reaches the final revision',async()=>{
  vi.useFakeTimers();let revision=0;const visible:number[]=[];
  const refresh=new ReadRefresh({inbox:async current=>{
    const observed=revision;await new Promise(resolve=>setTimeout(resolve,100));if(current())visible.push(observed);
  }});
  refresh.schedule(['inbox'],0);
  const storm=setInterval(()=>{revision++;refresh.schedule(['inbox']);},25);
  await vi.advanceTimersByTimeAsync(850);expect(visible.length).toBeGreaterThanOrEqual(3);
  clearInterval(storm);await vi.advanceTimersByTimeAsync(400);expect(visible.at(-1)).toBe(revision);refresh.dispose();
});

test('all backend view events refresh the visible audit and their dependent reads',()=>{
  for(const event of ['inbox_updated','inbox_sync_updated','send_status_updated','draft_updated','takeover_updated','suggestion_updated','status_updated']){
    expect(refreshTargets(event)).toContain('audit');expect(refreshTargets(event)).toContain('thread');
  }
  expect(refreshTargets('inbox_updated')).toEqual(['status','inbox','thread','audit']);
  expect(refreshTargets('backend_restarted')).not.toContain('thread');
  expect(refreshTargets('sidecar_closed')).toContain('status');
  expect(refreshTargets('unrecognized_event')).toEqual(['status','inbox','thread','audit']);
});
