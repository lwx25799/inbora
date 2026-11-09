import {expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {database,privateTemp,candidate} from '../helpers.js';
import {eventBinding,targetKey} from '../../src/core/contracts.js';

test('events decode one ordered query and inbox SQL executions do not grow with message count',async()=>{
  const store=database(),root=privateTemp('query-batch-');
  let reads=0;const file=store.db.name;store.close();
  Object.defineProperty(store,'db',{value:new Database(file,{verbose:()=>{reads++;}})});
  store.db.pragma('foreign_keys = ON');
  await migrateClient(store,join(root,'client.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();
  const token=service.authority.issueSession();store.bindAccount('own-1');
  try{
    const insert=store.db.prepare('INSERT INTO inbound_events VALUES(?,?,?,?,?,?,?,?,?)');
    store.db.transaction(()=>{for(let i=0;i<1000;i++){
      const e=candidate({platformEventId:`batch-${i}`,conversationId:`batch-peer-${Math.floor(i/10)}`,
        occurredAt:new Date(Date.UTC(2026,10,1)+i*1000).toISOString()});
      insert.run(randomUUID(),e.accountId,e.channel,e.platformEventId,e.conversationId,targetKey(e),eventBinding(e),JSON.stringify(e),'AWAITING_DRAFT');
    }})();
    // Native trace includes actual cached statements and transaction control.
    reads=0;
    const rows=store.events();expect(rows).toHaveLength(1000);expect(reads).toBe(1);
    expect(rows[0]!.payload.platformEventId).toBe('batch-0');expect(rows.at(-1)!.payload.platformEventId).toBe('batch-999');
    reads=0;
    const inbox=await service.dispatch(token,{command:'getInbox',channel:'ALL',status:'ALL',page:0}) as {total:number;items:unknown[]};
    expect(inbox).toMatchObject({total:100});expect(inbox.items).toHaveLength(20);expect(reads).toBeLessThanOrEqual(15);
    reads=0;await service.dispatch(token,{command:'getStatus'});expect(reads).toBeLessThan(40);
    reads=0;service.authority.expireOperators();expect(reads).toBeLessThan(10);
  }finally{await service.close();store.close();}
});

test('target history never reads or decodes unrelated event payloads',()=>{
  const store=database();try{
    const e=candidate(),insert=store.db.prepare('INSERT INTO inbound_events VALUES(?,?,?,?,?,?,?,?,?)');
    const add=(id:string,payload:string,target:string)=>insert.run(id,e.accountId,e.channel,id,'scope',target,'binding',payload,'AWAITING_DRAFT');
    add(randomUUID(),JSON.stringify(e),targetKey(e));add(randomUUID(),'{invalid unrelated payload','dm:other');
    expect(()=>store.history(e)).not.toThrow();expect(store.history(e).map(item=>item.text)).toEqual([e.text]);
  }finally{store.close();}
});
