import {expect,test} from 'vitest';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {ClientService} from '../../src/app/service.js';
import {EventStore} from '../../src/storage/store.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {observedMapping,dmReplyMapping,commentReplyMapping,mountObserved} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

test('healthy account recovery still refuses a blocked comment title or reply-only blockers on either owned page',async()=>{
  const root=privateTemp('emergency-recovery-pages-'),origin='https://www.douyin.com';
  const observation={...observedMapping(origin),environment:'douyin' as const},dm=dmReplyMapping(origin),comment=commentReplyMapping(origin);
  dm.observation=observation;comment.observation=observation;dm.blockers='#dm-reply-only-blocker';comment.blockers='#comment-reply-only-blocker';
  await Promise.all([
    writeFile(join(root,'observation-mapping.json'),JSON.stringify(observation)),
    writeFile(join(root,'dm-reply-mapping.json'),JSON.stringify(dm)),
    writeFile(join(root,'comment-reply-mapping.json'),JSON.stringify(comment)),
  ]);
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  // Both pages use entirely synthetic DOM. Every network request is fulfilled locally.
  await owner.context.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>synthetic recovery fixture</title>'}));
  const browser=BrowserService.adopt(root,owner,'headless'),store=new EventStore(join(root,'poc.sqlite'),true);
  await migrateClient(store,join(root,'backup.sqlite'));store.bindAccount('100');
  const service=new ClientService(store,browser);await service.loadSettings();const token=service.authority.issueSession(),data=new AutomationStore(store);
  try{
    await mountObserved(owner,origin);await mountObserved({dm:owner.notification} as BrowserProfileOwner,origin);
    for(const variant of ['title','comment-reply','dm-reply'] as const){
      await service.dispatch(token,{command:'emergencyStop'});
      const page=variant==='dm-reply'?owner.dm:owner.notification;
      if(variant==='title')await page.evaluate(()=>{document.title='访问受限';});
      else await page.evaluate(id=>{const element=document.createElement('div');element.id=id;element.textContent='synthetic validation blocker';document.body.append(element);},
        variant==='dm-reply'?'dm-reply-only-blocker':'comment-reply-only-blocker');
      const before=['budgets','send_intents','delivery_receipts','inbound_events','collection_progress']
        .map(table=>store.db.prepare('SELECT * FROM '+table).all());
      await expect(service.dispatch(token,{command:'resume',eventId:null}))
        .rejects.toThrow(variant==='title'?'OBSERVATION_SECURITY_TITLE':'OBSERVATION_SECURITY_COMPONENT');
      expect(data.state().emergencyStopped).toBe(true);expect(service.authority.paused()).toBe(true);
      expect(['budgets','send_intents','delivery_receipts','inbound_events','collection_progress']
        .map(table=>store.db.prepare('SELECT * FROM '+table).all())).toEqual(before);
      await page.evaluate(()=>{document.title='synthetic recovery fixture';document.querySelector('#dm-reply-only-blocker,#comment-reply-only-blocker')?.remove();});
    }
    expect(await service.dispatch(token,{command:'resume',eventId:null})).toMatchObject({paused:false,automation:{emergencyStopped:false}});
    expect(store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({n:0});
    expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
  }finally{await service.close();store.close();}
},30_000);
