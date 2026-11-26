import {expect,test} from 'vitest';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {BrowserProfileOwner} from '../../src/browser/profile-owner.js';
import {ObservedReader} from '../../src/adapters/observed-reader.js';
import {observedMapping} from '../fixtures/observed-site.js';
import {privateTemp} from '../helpers.js';

async function fixture(){
  const root=privateTemp('comment-fresh-editor-gate-'),origin='https://www.douyin.com';
  const owner=await BrowserProfileOwner.launch(join(root,'profile'),true),mapping=observedMapping(origin);
  await owner.context.route('**/*',route=>route.fulfill({contentType:'text/html',body:
    '<!doctype html><title>Synthetic unopened comments</title><a id="self">Self</a>'+
    '<textarea id="synthetic-human-draft">unsent synthetic human draft</textarea>'+
    '<button id="comment-open" onclick="window.openCount++;document.querySelector(\'#synthetic-human-draft\').remove();'+
    'document.querySelector(\'#comment-list\').style.display=\'block\'">Open comments</button>'+
    '<section id="comment-list" style="display:none;width:400px;height:100px"><p id="empty-comments">No comments</p></section>'+
    '<script>window.openCount=0;Object.defineProperty(document.querySelector("#self"),"__reactFiber$fixture",'+
    '{value:{return:{memoizedProps:{uid:"100",secUid:"self-sec"}}}});</script>'}));
  await owner.notification.goto(mapping.works[0]!.url);
  return {root,owner,mapping,close:async()=>{await owner.close();await rm(root,{recursive:true});}};
}

test.each([
  {label:'fresh reuse',stay:false},
  {label:'already-open document',stay:true},
])('$label checks human input before opening a still-hidden comment panel',async({stay})=>{
  const f=await fixture();
  try{
    const page=f.owner.notification;
    expect(await page.locator(f.mapping.selectors.commentList).isVisible()).toBe(false);
    await expect(new ObservedReader(page,f.mapping).comments(0,true,0,
      {holdScroll:true,stay,freshWithinMs:30_000})).rejects.toThrow('OBSERVATION_EXISTING_HUMAN_INPUT');
    expect(await page.evaluate(()=>(window as unknown as {openCount:number}).openCount)).toBe(0);
    expect(await page.locator('#synthetic-human-draft').inputValue()).toBe('unsent synthetic human draft');
    expect(await page.locator(f.mapping.selectors.commentList).isVisible()).toBe(false);
    // The same entry is permitted when its input is empty; a guarded opening still reads the native empty state.
    await page.locator('#synthetic-human-draft').fill('');
    const batch=await new ObservedReader(page,f.mapping).comments(0,true,0,
      {holdScroll:true,stay:true,freshWithinMs:30_000});
    expect(batch.events).toEqual([]);
    expect(await page.evaluate(()=>(window as unknown as {openCount:number}).openCount)).toBe(1);
    expect(await page.locator(f.mapping.selectors.commentList).isVisible()).toBe(true);
  }finally{await f.close();}
},20_000);
