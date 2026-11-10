import {expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountObserved,observedMapping} from '../fixtures/observed-site.js';
import {database,privateTemp} from '../helpers.js';

test.each(['normal','preview'] as const)('a cancelled %s DM read stops its inner readiness polling before the local five-second deadline',async mode=>{
  const root=privateTemp('dm-reader-cancel-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true),store=database();
  const abort=new AbortController();let collector:InboxCollector|undefined,task:Promise<void>|undefined;
  try{
    await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
    const data=new AutomationStore(store);data.initialize(Date.now()-10_000);store.bindAccount('100');
    data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000});
    await mountObserved(owner,server.origin);await owner.dm.evaluate(()=>{
      const row=document.querySelector('.message')!;row.querySelector('.text')!.remove();
      Object.getOwnPropertyDescriptor(row,'__reactProps$fixture')!.value.children.props.message.type=77;
      for(const message of document.querySelectorAll('.message'))
        Object.getOwnPropertyDescriptor(message,'__reactProps$fixture')!.value.children.props.message.createdAt=new Date(Date.now()-1000);
      const chat=document.querySelector('#chat') as HTMLElement;
      document.querySelector('#back')!.addEventListener('click',()=>{chat.hidden=true;});
      document.querySelector('.conversation')!.addEventListener('click',()=>{chat.hidden=false;});
    });
    const original=owner.dm.evaluate.bind(owner.dm);let cancelledAt=0,capturesAfterCancel=0;
    vi.spyOn(owner.dm,'evaluate').mockImplementation((async(fn:unknown,arg:unknown)=>{
      const input=arg as {channel?:string};
      try{return await original(fn as never,arg as never);}
      finally{
        if(input?.channel==='dm'){
          if(abort.signal.aborted)capturesAfterCancel++;
          else {cancelledAt=performance.now();abort.abort();}
        }
      }
    }) as typeof owner.dm.evaluate);
    collector=new InboxCollector(owner,observedMapping(server.origin),data,root,'headless');
    if(mode==='preview'){
      store.db.prepare('INSERT INTO discovered_conversations VALUES(?,?,?,?,?,?,?,0)').run('conv-a','100','200','peer-sec','Fixture peer',Date.now(),Date.now());
      expect(collector.prioritize('100','conv-a')).toBe(true);
    }
    let settled=false,code='';
    task=collector.collect('dm',abort.signal).then(()=>{settled=true;},error=>{settled=true;code=error.code;});
    await expect.poll(()=>cancelledAt>0,{timeout:10_000}).toBe(true);
    await expect.poll(()=>settled,{timeout:1000}).toBe(true);
    expect(code).toBe('OBSERVATION_CANCELLED');expect(performance.now()-cancelledAt).toBeLessThan(1000);expect(capturesAfterCancel).toBe(0);
    expect(store.events()).toHaveLength(0);expect(store.budgets().map(b=>b.used)).toEqual([0,0]);
    expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{abort.abort();await task;vi.restoreAllMocks();collector?.dispose();store.close();await owner.close();await server.close();}
});
