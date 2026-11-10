import {expect,test} from 'vitest';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {AutomationStore} from '../../src/storage/automation-store.js';
import {MessagePreviewStore} from '../../src/storage/message-previews.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {candidate,database,privateTemp} from '../helpers.js';
import {readFile,readdir,symlink} from 'node:fs/promises';
import {InboxCollector} from '../../src/app/inbox-collector.js';
import {observedMapping} from '../fixtures/observed-site.js';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import type {ObservedReader} from '../../src/adapters/observed-reader.js';

test('only explicit selection requests a bounded preview hint, with enabled scope and missing cached image',async()=>{
  const store=database(),root=privateTemp('preview-selection-');await migrateClient(store,join(root,'client.sqlite'));
  const event=candidate({text:'[图片或表情消息，需人工查看]',contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'});
  store.observe(event.channel,event.conversationId!,[event],'own-1','synthetic-media');const eventId=store.events()[0]!.id;
  const browser=new BrowserService(root),service=new ClientService(store,browser);await service.loadSettings();
  const data=new AutomationStore(store),token=service.authority.issueSession(),hints:{ownId:string;conversationId:string;eventId:string|undefined;trigger:string|undefined}[]=[];
  Object.assign(browser,{collector:{prioritize:(ownId:string,conversationId:string,eventId?:string,trigger?:string)=>{hints.push({ownId,conversationId,eventId,trigger});return true;}}});
  data.configureCollection({ownId:'own-1',comments:false,inbox:true,commentIntervalMs:30000,dmIntervalMs:15000});
  store.db.prepare('INSERT INTO discovered_conversations VALUES(?,?,?,?,?,?,?,0)').run(event.conversationId,'own-1','peer-1','peer-sec','Fixture peer',Date.now(),Date.now());
  const select=()=>service.dispatch(token,{command:'selectTarget',eventId,selectionId:randomUUID()});
  try{
    await service.dispatch(token,{command:'getThread',eventId});await service.dispatch(token,{command:'getThread',eventId});
    expect(hints).toEqual([]);await select();expect(hints).toEqual([{ownId:'own-1',conversationId:event.conversationId,eventId,trigger:'SELECTION'}]);
    data.stop(true);await select();expect(hints).toHaveLength(1);data.stop(false);
    data.configureCollection({...data.state().collection!,inbox:false});await select();expect(hints).toHaveLength(1);
    data.configureCollection({...data.state().collection!,inbox:true});
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
    new MessagePreviewStore(root).save(event,'own-1',[{label:null,png}]);await select();expect(hints).toHaveLength(1);
    expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({n:0});
    expect(store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
  }finally{Object.assign(browser,{collector:undefined});await service.close();store.close();}
});

test.each([true,false])('fixed read diagnostic keeps its report inside a regular evidence directory (junction %s)',async junction=>{
  const store=database(),root=privateTemp('diagnostic-owned-root-'),other=privateTemp('diagnostic-outside-');
  await migrateClient(store,join(root,'client.sqlite'));const browser=new BrowserService(root),service=new ClientService(store,browser);await service.loadSettings();
  const data=new AutomationStore(store);store.bindAccount('100');
  data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30000,dmIntervalMs:15000});
  if(junction)await symlink(other,join(root,'evidence'),'junction');
  const mapping=observedMapping('http://127.0.0.1:12345'),owner={notification:new EventEmitter()} as unknown as BrowserProfileOwner;
  const collector=new InboxCollector(owner,mapping,data,root,'headless');
  const reader={diagnostic:async()=>({source:'dm',messageSamples:[]})} as unknown as ObservedReader;
  try{
    await (collector as unknown as {diagnose(reader:ObservedReader,source:'dm',code:string,signal:AbortSignal):Promise<void>})
      .diagnose(reader,'dm','OBSERVATION_METADATA_NOT_READY',new AbortController().signal);
    expect(await readdir(other)).toEqual([]);
    expect(store.db.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type='COLLECTION_READ_DIAGNOSTIC'").get()).toEqual({n:junction?0:1});
    if(!junction)expect(JSON.parse(await readFile(join(root,'evidence','collection-read-dm-latest.json'),'utf8'))).toMatchObject({
      code:'OBSERVATION_METADATA_NOT_READY',report:{source:'dm',messageSamples:[]},
    });
  }finally{collector.dispose();await service.close();store.close();}
});
