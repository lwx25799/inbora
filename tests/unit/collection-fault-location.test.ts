import {afterEach,expect,test,vi} from 'vitest';
import {AccountActor} from '../../src/browser/account-actor.js';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {Blocked} from '../../src/core/contracts.js';
import type {AutomationStore} from '../../src/storage/automation-store.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {EventStore} from '../../src/storage/store.js';

const stores:EventStore[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();});

function fixture(){
  const store=new EventStore(':memory:',true);stores.push(store);
  const actor=new AccountActor();
  const page={on:vi.fn(),once:vi.fn(),off:vi.fn(),bringToFront:vi.fn(async()=>{})};
  const owner={actor,notification:page,dm:page} as unknown as BrowserProfileOwner;
  const data={store,state:()=>({emergencyStopped:false,collection:{ownId:'100',comments:true,inbox:true}}),
    requireAccount:vi.fn()} as unknown as AutomationStore;
  const collector=new InboxCollector(owner,observedMapping('https://fixture.invalid'),data,'unused','headless');
  const works=vi.spyOn(collector as unknown as {works(signal:AbortSignal):Promise<boolean>},'works');
  return {actor,collector,works,signal:new AbortController().signal};
}

test('a platform fault is captured inside the collection actor before queued navigation',async()=>{
  const {actor,collector,works,signal}=fixture(),failure=new Blocked('OBSERVATION_SECURITY_COMPONENT');
  let started!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  let location='fault-work';const order:string[]=[];
  works.mockImplementation(async()=>{started();await gate;throw failure;});
  const collection=collector.collect('works',signal,async()=>{
    order.push('captured:'+location);
    await Promise.resolve();
    expect(location).toBe('fault-work');
  });
  const result=expect(collection).rejects.toBe(failure);
  await entered;
  const queued=actor.run(async()=>{location='other-authorized-work';order.push('navigated');});
  release();await result;await queued;
  expect(order).toEqual(['captured:fault-work','navigated']);
  collector.dispose();
});

test.each([new Blocked('OBSERVATION_COMMENT_LIST_NOT_READY'),new Error('ordinary failure')])(
  'an ordinary collection error does not replace the saved platform fault (%s)',async failure=>{
    const {collector,works,signal}=fixture(),capture=vi.fn(async()=>{});
    works.mockRejectedValue(failure);
    await expect(collector.collect('works',signal,capture)).rejects.toBe(failure);
    expect(capture).not.toHaveBeenCalled();
    collector.dispose();
  },
);

test('a failed fault snapshot preserves the original platform stop',async()=>{
  const {collector,works,signal}=fixture(),failure=new Blocked('OBSERVATION_SECURITY_COMPONENT');
  const capture=vi.fn(async()=>{throw new Error('snapshot unavailable');});
  works.mockRejectedValue(failure);
  await expect(collector.collect('works',signal,capture)).rejects.toBe(failure);
  expect(capture).toHaveBeenCalledOnce();
  collector.dispose();
});
