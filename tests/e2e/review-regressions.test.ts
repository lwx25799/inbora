import { expect, test } from 'vitest';
import { join } from 'node:path';
import { BrowserProfileOwner } from '../../src/browser/profile-owner.js';
import { DomAdapter } from '../../src/adapters/dom-adapter.js';
import { SendCoordinator } from '../../src/core/send-coordinator.js';
import { fixtureServer, mapping, rowData } from '../fixtures/site.js';
import { database, privateTemp } from '../helpers.js';

test('review: initial DM list without right pane can select the unique conversation', async () => {
  const server = await fixtureServer(); const owner = await BrowserProfileOwner.launch(join(privateTemp(),'profile'), true);
  try {
    await owner.open(server.origin);
    await owner.dm.evaluate(() => {
      document.querySelector('#dm-entry')!.replaceWith(document.querySelector('#dm-entry')!.cloneNode(true));
      document.querySelector('#dm-entry')!.addEventListener('click', () => { (document.querySelector('#dm-list') as HTMLElement).hidden = false; });
      for (const button of document.querySelectorAll('#dm-list button')) button.addEventListener('click', () => { (document.querySelector('#dm-pane') as HTMLElement).hidden = false; });
    });
    const dm = new DomAdapter(owner.dm,'DIRECT_MESSAGE',mapping(server.origin));
    expect(await dm.conversations()).toHaveLength(2);
    expect((await dm.observeDm('conversation-1','peer-1')).events).toEqual([]);
  } finally { await owner.close(); await server.close(); }
});

test.each(['pointerover','pointerdown','document-click-capture'])('review: %s cannot change the approved submission destination', async stage => {
  const server = await fixtureServer(); const owner = await BrowserProfileOwner.launch(join(privateTemp(),'profile'), true); const s = database();
  try {
    await owner.open(server.origin); const dm = new DomAdapter(owner.dm,'DIRECT_MESSAGE',mapping(server.origin),200);
    s.observe('DIRECT_MESSAGE','conversation-1',[],'own-1','fixture');
    await owner.dm.evaluate(e => (window as unknown as {addDm:(id:string,e:unknown)=>void}).addDm('conversation-1',e),rowData('dm'));
    const batch = await dm.observeDm('conversation-1','peer-1');
    const eventId = s.observe('DIRECT_MESSAGE','conversation-1',batch.events,'own-1',batch.evidenceId)[0]!;
    const d = s.saveDraft(eventId,'approved text','mock'); s.approve(d.id,await dm.inspect(s.event(eventId).payload),d.version,d.text);
    await owner.dm.locator('#dm-send').evaluate((button,stage) => {
      const change = () => {
      document.querySelector('#dm-pane')!.setAttribute('data-active','conversation-2');
      document.querySelector('#dm-pane')!.setAttribute('data-peer','peer-2');
      document.querySelector('#dm-composer')!.setAttribute('data-target','dm:conversation-2');
      (document.querySelector('#dm-composer') as HTMLTextAreaElement).value = 'UNAPPROVED TEXT';
      };
      if(stage==='document-click-capture') document.addEventListener('click',event=>{if(event.composedPath().includes(button))change();},{capture:true,once:true});
      else button.addEventListener(stage,change,{once:true});
    },stage);
    const result=await new SendCoordinator(s,owner.actor).send(d.id,dm,false);
    if(stage==='document-click-capture'){
      expect(result).toBe('UNCERTAIN');expect(await owner.dm.evaluate(() => (window as unknown as {clicks:number}).clicks)).toBe(0);expect(s.uncertain()).toHaveLength(1);
    }else{
      expect(result).toBe('CONFIRMED');expect(await owner.dm.evaluate(() => (window as unknown as {clicks:number}).clicks)).toBe(1);
      expect(await owner.dm.locator('.outgoing').getAttribute('data-target')).toBe('dm:conversation-1');
      expect(await owner.dm.locator('.outgoing').textContent()).toBe(d.text);
    }
  } finally { s.close(); await owner.close(); await server.close(); }
});

test('review: manually sent outgoing reply after approval invalidates the old approval', async () => {
  const server = await fixtureServer(); const owner = await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true); const s = database();
  try {
    await owner.open(server.origin); const dm = new DomAdapter(owner.dm,'DIRECT_MESSAGE',mapping(server.origin));
    s.observe('DIRECT_MESSAGE','conversation-1',[],'own-1','fixture');
    await owner.dm.evaluate(e => (window as unknown as {addDm:(id:string,e:unknown)=>void}).addDm('conversation-1',e),rowData('dm'));
    const batch = await dm.observeDm('conversation-1','peer-1');
    const eventId = s.observe('DIRECT_MESSAGE','conversation-1',batch.events,'own-1',batch.evidenceId)[0]!;
    const d = s.saveDraft(eventId,'approved text','mock'); s.approve(d.id,await dm.inspect(s.event(eventId).payload),d.version,d.text);
    await owner.dm.locator('#dm-composer').fill(d.text); await owner.dm.locator('#dm-send').click();
    await expect(new SendCoordinator(s,owner.actor).send(d.id,dm,false)).rejects.toThrow('TARGET_CHANGED');
    expect(await owner.dm.evaluate(() => (window as unknown as {clicks:number}).clicks)).toBe(1);
  } finally { s.close(); await owner.close(); await server.close(); }
});

test('review: old identical reply revealed after rejected click cannot be accepted as a new receipt',async()=>{
  const server=await fixtureServer();const owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);const s=database();
  try{
    await owner.open(server.origin);const dm=new DomAdapter(owner.dm,'DIRECT_MESSAGE',mapping(server.origin),200);
    s.observe('DIRECT_MESSAGE','conversation-1',[],'own-1','fixture');
    await owner.dm.evaluate(e=>(window as unknown as {addDm:(id:string,e:unknown)=>void}).addDm('conversation-1',e),rowData('dm'));
    const batch=await dm.observeDm('conversation-1','peer-1');const eventId=s.observe('DIRECT_MESSAGE','conversation-1',batch.events,'own-1',batch.evidenceId)[0]!;
    await owner.dm.evaluate(()=>{
      const old=document.createElement('div');old.className='outgoing';old.id='old-hidden';old.hidden=true;
      old.setAttribute('data-id','historical-reply');old.setAttribute('data-own','own-1');old.setAttribute('data-target','dm:conversation-1');
      old.setAttribute('data-status','confirmed');old.setAttribute('data-sent-at','2020-01-01T00:00:00Z');old.textContent='same approved text';
      document.querySelector('#dm-outgoing')!.append(old);
      (document.querySelector('#dm-send') as HTMLButtonElement).onclick=()=>{
        (window as unknown as {clicks:number}).clicks++;old.hidden=false;(document.querySelector('#dm-composer') as HTMLTextAreaElement).value='';
      };
    });
    const d=s.saveDraft(eventId,'same approved text','mock');s.approve(d.id,await dm.inspect(s.event(eventId).payload),d.version,d.text);
    expect(await new SendCoordinator(s,owner.actor).send(d.id,dm,false)).toBe('UNCERTAIN');
    expect(s.event(eventId).status).toBe('UNCERTAIN');
  }finally{s.close();await owner.close();await server.close();}
});

test('review: pointerdown cannot register a late click handler that changes approved destination',async()=>{
  const server=await fixtureServer();const owner=await BrowserProfileOwner.launch(join(privateTemp(),'profile'),true);const s=database();
  try{
    await owner.open(server.origin);const dm=new DomAdapter(owner.dm,'DIRECT_MESSAGE',mapping(server.origin),200);
    s.observe('DIRECT_MESSAGE','conversation-1',[],'own-1','fixture');
    await owner.dm.evaluate(e=>(window as unknown as {addDm:(id:string,e:unknown)=>void}).addDm('conversation-1',e),rowData('dm'));
    const batch=await dm.observeDm('conversation-1','peer-1');const eventId=s.observe('DIRECT_MESSAGE','conversation-1',batch.events,'own-1',batch.evidenceId)[0]!;
    const d=s.saveDraft(eventId,'approved text','mock');s.approve(d.id,await dm.inspect(s.event(eventId).payload),d.version,d.text);
    await owner.dm.locator('#dm-send').evaluate(button=>button.addEventListener('pointerdown',()=>button.addEventListener('click',()=>{
      document.querySelector('#dm-pane')!.setAttribute('data-active','conversation-2');document.querySelector('#dm-pane')!.setAttribute('data-peer','peer-2');
      document.querySelector('#dm-composer')!.setAttribute('data-target','dm:conversation-2');(document.querySelector('#dm-composer') as HTMLTextAreaElement).value='UNAPPROVED TEXT';
    },{capture:true,once:true}),{once:true}));
    await new SendCoordinator(s,owner.actor).send(d.id,dm,false);
    const outgoing=await owner.dm.locator('.outgoing').evaluateAll(rows=>rows.map(row=>({target:row.getAttribute('data-target'),text:row.textContent})));
    expect(outgoing.every(row=>row.target==='dm:conversation-1'&&row.text===d.text)).toBe(true);
    expect(outgoing).toHaveLength(1);
  }finally{s.close();await owner.close();await server.close();}
});
