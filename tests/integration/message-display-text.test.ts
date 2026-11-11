import {expect,test} from 'vitest';
import {join} from 'node:path';
import {readFileSync,utimesSync,writeFileSync} from 'node:fs';
import {MessagePreviewStore} from '../../src/storage/message-previews.js';
import {EventStore} from '../../src/storage/store.js';
import {InboxQueries} from '../../src/app/inbox-queries.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {digest,eventBinding,isStrong} from '../../src/core/contracts.js';
import {candidate,privateTemp} from '../helpers.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jntkAAAAASUVORK5CYII=','base64');
const media=()=>candidate({platformEventId:'77201',actorId:'200',conversationId:'conv-a',text:'[含媒体的消息，需人工查看]',
  contentType:'MIXED',observationIssue:'DM_CONTENT_UNVERIFIED'});

test('display text is optional in old preview manifests, bound to the original event, and preserved by image updates',()=>{
  const root=privateTemp('display-text-cache-'),cache=new MessagePreviewStore(root),event=media();
  cache.save(event,'100',[{label:'synthetic image',png}]);const before=cache.list(event,'100');
  expect(cache.displayText(event,'100')).toBeNull();
  const text=' exact\ttext [微笑]\r\n next line ';
  cache.saveDisplayText(event,'100',text);expect(cache.displayText(event,'100')).toBe(text);expect(cache.list(event,'100')).toEqual(before);
  for(const [changed,own] of [[{...event,text:'changed original'},'100'],[{...event,actorId:'201'},'100'],[event,'101']] as const)
    expect(cache.displayText(changed,own)).toBeNull();
  cache.save(event,'100',[{label:'synthetic image',reason:'MESSAGE_PREVIEW_OBSCURED'}]);
  expect(cache.displayText(event,'100')).toBe(text);expect(cache.list(event,'100')).toEqual(before);
  cache.saveDisplayText(event,'100',null);expect(cache.displayText(event,'100')).toBeNull();expect(cache.list(event,'100')).toEqual(before);
});

test('display text rejects unknown controls and excessive data without erasing a prior exact witness and expires with its manifest',()=>{
  const root=privateTemp('display-text-validation-'),cache=new MessagePreviewStore(root),event=media();cache.saveDisplayText(event,'100','exact retained text');
  for(const text of ['', ' \t\r\n', 'a\0b','a\u007fb','x'.repeat(10001)]){
    expect(()=>cache.saveDisplayText(event,'100',text)).toThrow('MESSAGE_PREVIEW_UNAVAILABLE');
    expect(cache.displayText(event,'100')).toBe('exact retained text');
  }
  const key=digest(['100',event.channel,event.platformEventId,event.conversationId,event.actorId,event.direction,eventBinding(event)]),file=join(root,'evidence/message-previews',key+'.json');
  const old=new Date(Date.now()-15*86_400_000);utimesSync(file,old,old);expect(cache.displayText(event,'100')).toBeNull();
  const invalid=JSON.parse(readFileSync(file,'utf8'));invalid.displayText='a\0b';writeFileSync(file,JSON.stringify(invalid));
  expect(cache.displayText(event,'100')).toBeNull();
});

test('display projection exposes exact text separately without changing event identity, quality, history, tasks, budgets or intents',async()=>{
  const root=privateTemp('display-text-projection-'),store=new EventStore(join(root,'poc.sqlite'),true);await migrateClient(store,join(root,'backup.sqlite'));
  try{
    const event=media();store.observe('DIRECT_MESSAGE','conv-a',[],'100','fixture','2026-11-04T00:00:00Z');
    store.observe('DIRECT_MESSAGE','conv-a',[event],'100','fixture','2026-11-04T02:00:00Z');const saved=store.events()[0]!;
    const tables=['inbound_events','reply_drafts','send_intents','delivery_receipts','budgets','source_collisions'];
    const snapshot=()=>tables.map(table=>[table,store.db.prepare('SELECT * FROM '+table).all()]);const before=snapshot(),history=store.history(saved.payload);
    const cache=new MessagePreviewStore(root),queries=new InboxQueries(store,root,()=>'WAITING');cache.saveDisplayText(event,'100','verified private display text [微笑]');
    const timeline=queries.timeline(saved),item=timeline.items[0]!;
    expect(item).toMatchObject({eventId:saved.id,text:event.text,displayText:'verified private display text [微笑]',contentType:'MIXED',observationIssue:'DM_CONTENT_UNVERIFIED'});
    expect(queries.inbox({command:'getInbox',channel:'DIRECT_MESSAGE',status:'PENDING',page:0})).toMatchObject({total:0,items:[]});
    const inbox=queries.inbox({command:'getInbox',channel:'DIRECT_MESSAGE',status:'MANUAL_ONLY',page:0});
    expect(inbox.items[0]).toMatchObject({preview:event.text,displayText:'verified private display text [微笑]',id:saved.id,messageCount:1});
    expect(store.event(saved.id)).toEqual(saved);expect(isStrong(store.event(saved.id).payload)).toBe(false);expect(store.history(saved.payload)).toEqual(history);expect(snapshot()).toEqual(before);
    cache.saveDisplayText(event,'100',null);expect(queries.timeline(saved).items[0]?.displayText).toBeUndefined();
  }finally{store.close();}
});
