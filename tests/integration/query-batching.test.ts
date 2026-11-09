import {expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {database,privateTemp,candidate} from '../helpers.js';
import {eventBinding,targetKey} from '../../src/core/contracts.js';

test('events decode one ordered query and inbox SQL executions do not grow with message count',async()=>{
  const store=database(),root=privateTemp('query-batch-');
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
    let reads=0;const original=store.db.prepare.bind(store.db);
    store.db.prepare=((sql:string)=>{
      const statement=original(sql);
      return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key,target);
        if(typeof value!=='function')return value;
        return (...args:unknown[])=>{if(['all','get','iterate'].includes(String(key)))reads++;return value.apply(target,args);};
      }});
    }) as typeof store.db.prepare;
    const rows=store.events();expect(rows).toHaveLength(1000);expect(reads).toBe(1);
    expect(rows[0]!.payload.platformEventId).toBe('batch-0');expect(rows.at(-1)!.payload.platformEventId).toBe('batch-999');
    reads=0;
    const inbox=await service.dispatch(token,{command:'getInbox',channel:'ALL',status:'ALL',page:0}) as {total:number;items:unknown[]};
    expect(inbox).toMatchObject({total:100});expect(inbox.items).toHaveLength(20);expect(reads).toBeLessThanOrEqual(15);
    reads=0;await service.dispatch(token,{command:'getStatus'});expect(reads).toBeLessThan(40);
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
