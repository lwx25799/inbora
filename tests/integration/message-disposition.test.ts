import {expect,test} from 'vitest';
import {join} from 'node:path';
import {readdirSync,unlinkSync} from 'node:fs';
import {ClientService} from '../../src/app/service.js';
import {BrowserService} from '../../src/app/browser-service.js';
import {EventStore} from '../../src/storage/store.js';
import {migrateClient} from '../../src/storage/client-migration.js';
import {MessageShareStore} from '../../src/storage/message-shares.js';
import {MessagePreviewStore} from '../../src/storage/message-previews.js';
import {candidate,pending,privateTemp} from '../helpers.js';

async function fixture(){
  const root=privateTemp('message-disposition-'),store=new EventStore(join(root,'poc.sqlite'),true);
  await migrateClient(store,join(root,'schema3.sqlite'));
  const event=candidate({platformEventId:'883001',contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED',text:'[图片或表情消息，需人工查看]'});
  pending(store,event);const id=store.events().find(item=>item.payload.platformEventId===event.platformEventId)!.id;
  const service=new ClientService(store,new BrowserService(root));
  const marks=()=>store.db.prepare("SELECT detail_redacted FROM audit_events WHERE event_type='INBOUND_DISPLAY_CLASSIFIED'").all() as {detail_redacted:string}[];
  return {root,store,event,id,service,marks,close:async()=>{await service.close();store.close();}};
}

test.each(['video','note'] as const)('startup records the exact %s share independently of preview retention',async route=>{
  const f=await fixture();try{
    new MessageShareStore(f.root).save(f.event,'own-1',{kind:'DOUYIN_WORK',url:`https://www.douyin.com/${route}/123`,workId:'123'});
    const before=f.store.event(f.id);
    await f.service.loadSettings();expect(f.marks()).toHaveLength(1);
    expect(JSON.parse(f.marks()[0]!.detail_redacted)).toEqual({binding:before.binding,eventType:'DOUYIN_WORK_SHARE'});
    const directory=join(f.root,'evidence','message-shares');for(const name of readdirSync(directory))unlinkSync(join(directory,name));
    await f.service.loadSettings();expect(f.marks()).toHaveLength(1);
    expect(f.store.event(f.id)).toEqual(before);
    expect(f.store.db.prepare('SELECT count(*) n FROM send_intents').get()).toEqual({n:0});
  }finally{await f.close();}
});

test('a verified share shell is classified, but generic unavailable emoji and plain labels are not',async()=>{
  const f=await fixture();try{
    const preview=new MessagePreviewStore(f.root);
    preview.save(f.event,'own-1',[{label:null,reason:'MESSAGE_PREVIEW_SHARE_LINK_UNVERIFIED'}]);
    const ordinary=candidate({...f.event,platformEventId:'883002',text:'[图片或表情消息，需人工查看]'});
    pending(f.store,ordinary);preview.save(ordinary,'own-1',[{label:'分享视频',reason:'MESSAGE_PREVIEW_OBSCURED'}]);
    pending(f.store,candidate({platformEventId:'883003',text:'分享了一个视频'}));
    await f.service.loadSettings();expect(f.marks()).toHaveLength(1);
    expect(JSON.parse(f.marks()[0]!.detail_redacted).binding).toBe(f.store.event(f.id).binding);
  }finally{await f.close();}
});
