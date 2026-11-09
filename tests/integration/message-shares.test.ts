import {expect,test} from 'vitest';
import {join} from 'node:path';
import {MessageShareStore} from '../../src/storage/message-shares.js';
import {candidate,database,privateTemp} from '../helpers.js';
import {eventBinding} from '../../src/core/contracts.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';

test('canonical shared work is display metadata bound to native identity, preserving old image event and budgets',async()=>{
  const root=privateTemp('shared-work-'),store=database(),event=candidate({text:'[图片或表情消息，需人工查看]',contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'});
  store.observe(event.channel,event.conversationId!,[event],'own-1','synthetic-old-image');const saved=store.events()[0]!;
  await migrateClient(store,join(root,'client.sqlite'));const service=new ClientService(store,new BrowserService(root));await service.loadSettings();
  try{
    const aux=new MessageShareStore(root),share={kind:'DOUYIN_WORK' as const,url:'https://www.douyin.com/video/1234567890123456789',workId:'1234567890123456789'};
    aux.save(event,'own-1',share);expect(aux.read(event,'own-1')).toEqual(share);
    expect(aux.read({...event,text:'new fixed display placeholder',contentType:'VIDEO'},'own-1')).toEqual(share);
    expect(aux.read({...event,conversationId:'another-native-conversation'},'own-1')).toBeNull();
    expect(aux.read({...event,platformEventId:'another-native-message'},'own-1')).toBeNull();
    expect(aux.read(event,'other-own')).toBeNull();expect(store.event(saved.id)).toEqual(saved);expect(eventBinding(event)).toBe(saved.binding);
    const token=service.authority.issueSession(),thread=await service.dispatch(token,{command:'getThread',eventId:saved.id}) as {timeline:{items:{share?:unknown;attachments:unknown[]}[]}};
    expect(thread.timeline.items[0]).toMatchObject({share,attachments:[]});
    expect(await service.dispatch(token,{command:'getInbox',channel:'DIRECT_MESSAGE',status:'ALL',page:0})).toMatchObject({items:[{share,attachments:[]}]});
    expect(()=>store.assertModelObservation(event)).toThrow('DM_CONTENT_UNVERIFIED');
    expect(store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
    expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
  }finally{await service.close();store.close();}
});

test.each(['http://www.douyin.com/video/123','https://evil.test/video/123','https://www.douyin.com.evil.test/video/123',
  'https://www.douyin.com/video/123?private=value','https://user:pass@www.douyin.com/video/123','https://www.douyin.com/user/123',
  'javascript:alert(1)','https://www.douyin.com/video/124'])('share store rejects noncanonical or mismatched work link %s',url=>{
  const aux=new MessageShareStore(privateTemp('invalid-shared-work-'));
  expect(()=>aux.save(candidate({observationIssue:'DM_CONTENT_UNVERIFIED',contentType:'IMAGE'}),'own-1',{kind:'DOUYIN_WORK',url,workId:'123'})).toThrow('MESSAGE_SHARE_UNAVAILABLE');
});
