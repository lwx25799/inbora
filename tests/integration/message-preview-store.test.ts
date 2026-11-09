import {expect,test} from 'vitest';
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
