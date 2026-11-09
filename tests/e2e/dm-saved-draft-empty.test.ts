import {expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {ObservedDmReply} from '../../src/adapters/observed-dm-reply.js';
import {fixtureServer} from '../fixtures/site.js';
import {mountDmReply,dmReplyMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

test('saved draft inspection reports an exact empty editor without navigating or enabling empty clear',async()=>{
  const server=await fixtureServer(),owner=await BrowserProfileOwner.launch(join(privateTemp('dm-saved-draft-empty-'),'profile'),true);
  const mapping=dmReplyMapping(server.origin),adapter=new ObservedDmReply(owner.dm,mapping,250);
  try{
    await mountDmReply(owner,server.origin);const event=(await new ObservedReader(owner.dm,mapping.observation).dm(0)).events[0]!;
    const before=await owner.dm.locator('#native-editor').innerHTML(),navigate=vi.spyOn(ObservedReader.prototype,'dm').mockRejectedValue(Error('UNEXPECTED_NAVIGATION'));
    expect(await owner.actor.run(()=>adapter.readSavedDraft(event))).toMatchObject({text:'',snapshot:{targetKey:'dm:conv-a'}});
    await expect(owner.actor.run(()=>adapter.clearSavedDraft(event,''))).rejects.toThrow('INVALID_TEXT');
    expect(navigate).not.toHaveBeenCalled();expect(await owner.dm.locator('#native-editor').innerHTML()).toBe(before);
    expect(await owner.dm.evaluate(()=>(window as unknown as {nativeClicks:number}).nativeClicks)).toBe(0);
  }finally{vi.restoreAllMocks();adapter.dispose();await owner.close();await server.close();}
});
