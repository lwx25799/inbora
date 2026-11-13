import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,test} from 'vitest';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {mediaFixtureServer} from '../fixtures/media-site.js';
import {privateTemp} from '../helpers.js';

test('headless Owner installs media guards on both dedicated Pages before the first business document',async()=>{
  const root=privateTemp('media-owner-'),server=await mediaFixtureServer();
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
  try{
    await owner.open(server.origin);
    expect(owner.context.pages()).toHaveLength(2);
    for(const page of [owner.notification,owner.dm]){
      expect(await page.evaluate(()=>Reflect.has(document,Symbol.for('inbora.media-pause.v1')))).toBe(true);
      const result=await page.evaluate(async()=>{
        const canvas=document.createElement('canvas'),video=document.createElement('video');
        canvas.width=32;canvas.height=32;video.muted=true;video.srcObject=canvas.captureStream(10);
        document.body.append(video);canvas.getContext('2d')!.fillRect(0,0,32,32);
        try{await video.play();}catch(error){if((error as Error).name!=='AbortError')throw error;}
        return {paused:video.paused,draft:(document.querySelector('#human-draft') as HTMLTextAreaElement).value};
      });
      expect(result).toEqual({paused:true,draft:'unsaved human draft'});
    }
  }finally{await owner.close();await server.close();await rm(root,{recursive:true,force:true});}
});
