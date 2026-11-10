import {expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {inspectMessageShare} from '../../src/adapters/message-share.js';
import {saveMessagePreviews} from '../../src/adapters/message-preview.js';
import {MessagePreviewStore} from '../../src/storage/message-previews.js';
import {MessageShareStore} from '../../src/storage/message-shares.js';
import {eventBinding} from '../../src/core/contracts.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountObserved,observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

test('an exact modern share with no proven route caches its share reason without inspecting or capturing an image',async()=>{
  const root=privateTemp('share-unavailable-preview-'),server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  try{
    await mountObserved(owner,server.origin);
    await owner.dm.evaluate(()=>{
      const chat=document.querySelector('#chat')!;chat.querySelectorAll('.box').forEach(box=>box.remove());
      const box=document.createElement('div'),row=document.createElement('div'),image=document.createElement('img');
      box.className='box';row.className='message';image.width=24;image.height=24;row.style.minHeight='32px';
      image.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jntkAAAAASUVORK5CYII=';
      row.append(image);box.append(row);chat.append(box);
      Object.defineProperty(row,'__reactProps$fixture',{value:{children:{props:{message:{serverId:'99701',conversationId:'conv-a',sender:'200',type:110,
        createdAt:new Date(Date.now()-1000),_parsedContent:{item_id:'123456',schema:'aweme://aweme/detail/123456?refer=PRIVATE',
          aweme_info:{item_id:'123456',aweme_id:'123456',aweme_type:999,type:999}}}}}}});
    });
    await owner.dm.locator('.message img').evaluate(image=>(image as HTMLImageElement).decode());
    const mapping=observedMapping(server.origin),peer=mapping.peers[0]!,batch=await new ObservedReader(owner.dm,mapping).dmWindow(peer),event=batch.events[0]!;
    expect(await owner.dm.evaluate(inspectMessageShare,{mapping,event,peer})).toMatchObject({detected:true,share:null});
    const before=structuredClone(event),binding=eventBinding(event),screenshot=vi.spyOn(owner.dm,'screenshot'),evaluate=vi.spyOn(owner.dm,'evaluate');
    await saveMessagePreviews(owner.dm,mapping,batch,root,new AbortController().signal,peer);
    const cache=new MessagePreviewStore(root);
    expect(cache.list(event,'100')).toEqual([{kind:'IMAGE',state:'UNAVAILABLE',previewId:null,label:null,reason:'MESSAGE_PREVIEW_SHARE_LINK_UNVERIFIED'}]);
    expect(new MessageShareStore(root).read(event,'100')).toBeNull();expect(event).toEqual(before);expect(eventBinding(event)).toBe(binding);
    expect(event).toMatchObject({observationIssue:'DM_CONTENT_UNVERIFIED'});expect(screenshot).not.toHaveBeenCalled();
    expect(evaluate.mock.calls.map(call=>(call[0] as Function).name)).toEqual(['inspectMessageShare']);
    const diagnostic=()=>JSON.parse(readFileSync(join(root,'evidence','message-preview-latest.json'),'utf8'));
    expect(diagnostic()).toMatchObject({shareDetectedNoLink:1,inspected:0,shareLinked:0});
    expect(JSON.stringify(diagnostic())).not.toMatch(/PRIVATE|123456|99701|conv-a|aweme:\/\//u);
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jntkAAAAASUVORK5CYII=','base64');
    cache.save(event,'100',[{label:null,png,width:1,height:1}]);const ready=cache.list(event,'100');
    await saveMessagePreviews(owner.dm,mapping,batch,root,new AbortController().signal,peer);expect(cache.list(event,'100')).toEqual(ready);
    const failed=vi.spyOn(MessagePreviewStore.prototype,'save').mockImplementation(()=>{throw Error('PRIVATE_RAW_EXCEPTION');});
    await saveMessagePreviews(owner.dm,mapping,batch,root,new AbortController().signal,peer);
    expect(diagnostic()).toMatchObject({caught:{CACHE_WRITE:1},inspected:0,shareDetectedNoLink:1});
    expect(JSON.stringify(diagnostic())).not.toContain('PRIVATE_RAW_EXCEPTION');failed.mockRestore();
  }finally{vi.restoreAllMocks();await owner.close();await server.close();}
});
