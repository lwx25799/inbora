import {expect,test} from 'vitest';
import {readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {BrowserRecoveryLocations} from '../../src/app/browser-recovery-locations.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

test('a newly captured fault replaces old entry and fault positions while ordinary captures preserve the fault',async()=>{
  const root=privateTemp('recovery-location-fault-'),origin='https://www.douyin.com',entry=origin+'/user/self';
  const first=origin+'/video/10',second=origin+'/note/20';
  const config={...observedMapping(origin),entryUrl:entry,environment:'douyin',works:[{id:'10',url:first},{id:'20',url:second}]};
  try{
    await writeFile(join(root,'observation-mapping.json'),JSON.stringify(config));
    let notification=entry,dm=entry;
    // Only URL capture is under test: navigation or page evaluation must never be invoked here.
    const owner={notification:{url:()=>notification},dm:{url:()=>dm}} as unknown as BrowserProfileOwner;
    const locations=new BrowserRecoveryLocations(root),file=join(root,'browser-recovery-locations.json');
    const saved=async()=>JSON.parse(await readFile(file,'utf8')) as unknown;
    await locations.capture(owner,true);
    expect(await saved()).toEqual({version:1,ownId:'100',notification:entry,dm:entry});
    notification=first+'?from=synthetic#ignored';await locations.captureFault(owner);
    expect(await saved()).toEqual({version:1,ownId:'100',notification:first,dm:entry});
    notification=second;await locations.captureFault(owner);
    expect(await saved()).toEqual({version:1,ownId:'100',notification:second,dm:entry});
    notification=entry;dm=origin+'/';await locations.capture(owner,true);
    expect(await saved()).toEqual({version:1,ownId:'100',notification:second,dm:entry});
    notification=first;await locations.capture(owner);
    expect(await saved()).toEqual({version:1,ownId:'100',notification:second,dm:entry});
    await new BrowserRecoveryLocations(root).capture(owner,true);
    expect(await saved()).toEqual({version:1,ownId:'100',notification:second,dm:entry});
  }finally{await rm(root,{recursive:true});}
});
