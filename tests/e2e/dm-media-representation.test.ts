import {expect,test} from 'vitest';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {EventStore} from '../../src/storage/store.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {MessagePreviewStore} from '../../src/storage/message-previews.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {migrateAutomation} from '../../src/storage/automation-migration.js';
import {isStrong,type InboundEvent} from '../../src/core/contracts.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountObserved,observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

test('normal inline collection keeps the old weak carrier and intent while a new native ID becomes exact text',async()=>{
  const root=privateTemp('dm-media-carrier-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true),
    store=new EventStore(join(root,'poc.sqlite'),true),origin=Date.now()-10_000;
  await migrateClient(store,join(root,'client-backup.sqlite'));await migrateAutomation(store,join(root,'auto-backup.sqlite'));
  const data=new AutomationStore(store);data.initialize(origin);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000});
  await mountObserved(owner,server.origin);const mapping=observedMapping(server.origin),collector=new InboxCollector(owner,mapping,data,root,'headless');
  try{
    await owner.dm.route(server.origin+'/emoji.png',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jntkAAAAASUVORK5CYII=','base64')}));
    const weak:InboundEvent={accountId:'account_001',channel:'DIRECT_MESSAGE',platformEventId:'88901',actorId:'200',actorName:'Fixture peer',
      text:'[含媒体的消息，需人工查看]',occurredAt:new Date(origin+1000).toISOString(),videoId:null,commentId:null,conversationId:'conv-a',
      direction:'INCOMING',kind:'DM',evidenceId:'synthetic-old-media',contentType:'MIXED',observationIssue:'DM_CONTENT_UNVERIFIED'};
    store.observe('DIRECT_MESSAGE','conv-a',[],'100','fixture',new Date(origin).toISOString());
    store.observe('DIRECT_MESSAGE','conv-a',[weak],'100','fixture',new Date(origin+2000).toISOString());
    const old=store.events()[0]!,draftId=randomUUID(),intentId=randomUUID();
    store.db.prepare('INSERT INTO reply_drafts VALUES(?,?,?,?,?,?,?,?)').run(draftId,old.id,'existing approved text','mock',1,'APPROVED','existing approval','2026-11-09T12:00:00Z');
    store.db.prepare('INSERT INTO send_intents VALUES(?,?,?,?,?,?,?,?)').run(intentId,old.id,draftId,'dm:conv-a','existing target','existing text','UNKNOWN','2026-11-09T12:00:00Z');
    store.db.prepare("UPDATE inbound_events SET status='UNCERTAIN' WHERE id=?").run(old.id);
    const before=store.event(old.id),draft=store.db.prepare('SELECT * FROM reply_drafts WHERE id=?').get(draftId),intent=store.db.prepare('SELECT * FROM send_intents WHERE id=?').get(intentId);
    await owner.dm.evaluate(({origin,url})=>{
      const chat=document.querySelector<HTMLElement>('#chat')!;chat.querySelectorAll('.box').forEach(box=>box.remove());
      for(const [index,id] of ['88901','88902'].entries()){
        const box=document.createElement('div'),row=document.createElement('div');box.className='box';row.className='message';
        row.innerHTML='<span class="text">hello <img width="16" height="16" alt="[微笑]" src="'+url+'"> tail</span>';
        Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:id,conversationId:'conv-a',sender:'200',type:7,
          createdAt:new Date(origin+1000+index*2000),_parsedContent:{text:'hello [微笑] tail'}}}}}});box.append(row);chat.append(box);
      }
      document.querySelector('#back')!.addEventListener('click',()=>{chat.hidden=true;});
      document.querySelector('.conversation')!.addEventListener('click',()=>{chat.hidden=false;});
    },{origin,url:server.origin+'/emoji.png'});
    const signal=new AbortController().signal;await collector.collect('dm',signal);
    expect(store.db.prepare('SELECT count(*) n FROM source_collisions').get()).toEqual({n:0});
    expect(store.event(old.id)).toEqual(before);expect(store.db.prepare('SELECT * FROM reply_drafts WHERE id=?').get(draftId)).toEqual(draft);
    expect(store.db.prepare('SELECT * FROM send_intents WHERE id=?').get(intentId)).toEqual(intent);
    expect(new MessagePreviewStore(root).displayText(before.payload,'100')).toBe('hello [微笑] tail');
    const fresh=store.events().find(event=>event.payload.platformEventId==='88902')!;
    expect(fresh).toMatchObject({status:'AWAITING_DRAFT',payload:{text:'hello [微笑] tail'}});expect(isStrong(fresh.payload)).toBe(true);
    await collector.collect('dm',signal);expect(store.events()).toHaveLength(2);
    expect(store.db.prepare('SELECT count(*) n FROM source_collisions').get()).toEqual({n:0});expect(store.event(old.id)).toEqual(before);
    expect(store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:1});expect(store.db.prepare('SELECT sum(used) n FROM budgets').get()).toEqual({n:0});
  }finally{collector.dispose();store.close();await owner.close();await server.close();}
});
