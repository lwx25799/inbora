import {expect,test,vi} from 'vitest';
import {existsSync,readFileSync,readdirSync,utimesSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {digest} from '../../src/core/contracts.js';
import {MessagePreviewStore} from '../../src/storage/message-previews.js';
import {candidate,privateTemp} from '../helpers.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jntkAAAAASUVORK5CYII=','base64');

test('preview retention caps owned manifests at 500 and preserves current thumbnails and unrelated evidence',()=>{
  const root=privateTemp('preview-capacity-'),cache=new MessagePreviewStore(root);
  const event=candidate({contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'});
  cache.save(event,'own-1',[{label:null,png}]);const before=cache.list(event,'own-1')[0]!;
  const folder=join(root,'evidence','message-previews'),unrelated=join(folder,'unrelated-evidence.txt');writeFileSync(unrelated,'keep');
  for(let index=0;index<500;index++){
    const key=digest(['synthetic-owned-cache',index]),file=join(folder,key+'.json'),time=new Date(Date.now()-100_000+index);
    writeFileSync(file,JSON.stringify({version:1,key,attachments:[]}));utimesSync(file,time,time);
  }
  cache.save(event,'own-1',[{label:null,png}]);
  expect(readdirSync(folder).filter(name=>name.endsWith('.json'))).toHaveLength(500);
  expect(existsSync(join(folder,digest(['synthetic-owned-cache',0])+'.json'))).toBe(false);
  expect(existsSync(join(folder,digest(['synthetic-owned-cache',499])+'.json'))).toBe(true);
  expect(cache.list(event,'own-1')[0]!.previewId).toBe(before.previewId);
  expect(cache.read(event,'own-1',before.previewId!).dataUrl).toBe('data:image/png;base64,'+png.toString('base64'));
  expect(readFileSync(unrelated,'utf8')).toBe('keep');
});

test('a tampered thumbnail fails its opaque content binding and cannot return replacement bytes',()=>{
  const root=privateTemp('preview-tamper-'),cache=new MessagePreviewStore(root);
  const event=candidate({contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'});
  cache.save(event,'own-1',[{label:null,png}]);const id=cache.list(event,'own-1')[0]!.previewId!;
  writeFileSync(join(root,'evidence','message-previews',id+'.png'),Buffer.concat([png,Buffer.from('replacement')]));
  expect(()=>cache.read(event,'own-1',id)).toThrow('MESSAGE_PREVIEW_UNAVAILABLE');
});

test('save prunes once, removes orphan thumbnail PNGs, and caches runtime.json retention by mtimeMs',()=>{
  const root=privateTemp('preview-orphan-cache-'),runtimeFile=join(root,'runtime.json');
  writeFileSync(runtimeFile,JSON.stringify({version:1,modelGrant:null,evidenceRetentionDays:14}));
  const cache=new MessagePreviewStore(root),event=candidate({contentType:'IMAGE',observationIssue:'DM_CONTENT_UNVERIFIED'});
  cache.save(event,'own-1',[{label:null,png}]);
  const folder=join(root,'evidence','message-previews'),keptId=cache.list(event,'own-1')[0]!.previewId!;
  const orphanId=digest(['orphan-preview-png']),orphanFile=join(folder,orphanId+'.png'),unrelated=join(folder,'keep.txt');
  writeFileSync(orphanFile,png);writeFileSync(unrelated,'keep');
  const pruneSpy=vi.spyOn(cache as unknown as {prune:(directory:string)=>void},'prune');
  cache.save(event,'own-1',[{label:null,png}]);
  expect(pruneSpy).toHaveBeenCalledTimes(1);
  expect(existsSync(orphanFile)).toBe(false);
  expect(existsSync(join(folder,keptId+'.png'))).toBe(true);
  expect(readFileSync(unrelated,'utf8')).toBe('keep');
  // Update runtime.json retention to 1 day and backdate the manifest by 2 days to verify mtimeMs invalidation.
  const manifestFile=readdirSync(folder).find(name=>name.endsWith('.json'))!;
  const twoDaysAgo=new Date(Date.now()-2*86_400_000);
  utimesSync(join(folder,manifestFile),twoDaysAgo,twoDaysAgo);
  expect(cache.list(event,'own-1')).toHaveLength(1);
  writeFileSync(runtimeFile,JSON.stringify({version:1,modelGrant:null,evidenceRetentionDays:1}));
  const bumped=new Date(Date.now()+2000);utimesSync(runtimeFile,bumped,bumped);
  expect(cache.list(event,'own-1')).toEqual([]);
  pruneSpy.mockRestore();
});
