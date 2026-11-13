import {expect,test} from 'vitest';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {database,privateTemp,pending} from '../helpers.js';
import {digest} from '../../src/core/contracts.js';

test('diagnostics is an authenticated read with no business mutation and no private message or target fields',async()=>{
  const root=privateTemp('diagnostic-service-'),store=database();
  const event=pending(store);await migrateClient(store,join(root,'client.sqlite'));
  const service=new ClientService(store,new BrowserService(root));await service.loadSettings();
  try{
    const token=service.authority.issueSession(['READ']),control=service.authority.issueSession(['CONTROL']);
    const before=()=>digest(['inbound_events','reply_drafts','send_intents','delivery_receipts','budgets','audit_events'].map(table=>store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    await expect(service.dispatch(control,{command:'getDiagnostics'})).rejects.toThrow('OPERATOR_PERMISSION_DENIED');
    // Permission denial is intentionally audited; an authorized read must add no further business writes.
    const inventory=before();
    const result=await service.dispatch(token,{command:'getDiagnostics'});
    expect(result).toMatchObject({version:1,timeRangeSupported:false,model:{total:{requests:0}},performance:expect.any(Array),evidence:{running:false},
      browserResources:{state:'WAITING',reason:'NO_OWNER',latest:null}});
    for(let n=0;n<3;n++)expect(await service.dispatch(token,{command:'getDiagnostics'})).toEqual(result);
    expect(existsSync(join(root,'reports','browser-resources.json'))).toBe(false);
    const text=JSON.stringify(result);expect(text).not.toContain(event);expect(text).not.toContain(store.event(event).payload.text);
    expect(text).not.toContain(store.event(event).payload.conversationId);expect(text).not.toMatch(/"(?:pid|rootPid|commandLine|url)":|"samples":\[/iu);
    expect(before()).toBe(inventory);
    await expect(service.dispatch(token,{command:'getDiagnostics',privatePath:'anything'})).rejects.toThrow();
  }finally{await service.close();store.close();}
});
