import { expect, test } from 'vitest';
import { join } from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import { BrowserService } from '../../src/app/browser-service.js';
import { BrowserProfileOwner } from '../../src/browser/profile-owner.js';
import { DomAdapter } from '../../src/adapters/dom-adapter.js';
import { SendCoordinator } from '../../src/core/send-coordinator.js';
import { EventStore } from '../../src/storage/store.js';
import { fixtureServer, html, mapping, rowData } from '../fixtures/site.js';
import { privateTemp } from '../helpers.js';

async function closeFixture(root:string,browser?:{close():Promise<void>},server?:{close():Promise<void>},store?:EventStore){
  try{await browser?.close();}finally{
    try{await server?.close();}finally{
      try{store?.close();}finally{await rm(root,{recursive:true,force:true});}
    }
  }
}

test('legacy mapping refuses to overwrite a web draft added after approval', async () => {
  const origin = 'https://www.douyin.com';
  const root = privateTemp('phase1-legacy-draft-');
  let browser:BrowserService|undefined;
  let store:EventStore|undefined;
  try {
    store = new EventStore(join(root, 'fixture.sqlite'), true);
    const owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
    browser=BrowserService.adopt(root,owner,'headless');
    await owner.context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
    await owner.open(origin);
    const config = { ...mapping(origin), environment: 'douyin' };
    await writeFile(join(root, 'site-mapping.json'), JSON.stringify(config));
    const reader = new DomAdapter(owner.dm, 'DIRECT_MESSAGE', mapping(origin));
    await owner.dm.evaluate(e => (window as unknown as {addDm:(id:string,e:unknown)=>void}).addDm('conversation-1',e), rowData('dm'));
    const batch = await reader.observeDm('conversation-1', 'peer-1');
    expect(batch.events).toHaveLength(1);
    const prior = new Date(Date.parse(batch.events[0]!.occurredAt!) - 1000).toISOString();
    store.observe('DIRECT_MESSAGE', 'conversation-1', [], 'own-1', 'fixture', prior);
    const eventId = store.observe('DIRECT_MESSAGE', 'conversation-1', batch.events, 'own-1', batch.evidenceId)[0]!;
    const event = store.event(eventId).payload;
    const draft = store.saveDraft(eventId, 'approved fixture reply', 'mock');
    const handle = await browser.adapter(event, store);
    try {
      store.approve(draft.id, await handle.adapter.inspect(event), draft.version, draft.text);
      await owner.dm.locator('#dm-composer').fill('Unsubmitted web draft');
      await expect(new SendCoordinator(store, owner.actor).send(draft.id, handle.adapter, false)).rejects.toThrow('NATIVE_REPLY_EXISTING_DRAFT');
      expect(await owner.dm.locator('#dm-composer').inputValue()).toBe('Unsubmitted web draft');
      expect(await owner.dm.evaluate(() => (window as unknown as {clicks:number}).clicks)).toBe(0);
      expect(store.db.prepare('SELECT id FROM send_intents').all()).toEqual([]);
    } finally { await handle.dispose(); }
  } finally { await closeFixture(root,browser,undefined,store); }
});

test.each([false,true])('legacy comment navigation preserves the current composer (hidden: %s)', async hidden => {
  const root = privateTemp('phase1-legacy-switch-');
  let server:Awaited<ReturnType<typeof fixtureServer>>|undefined;
  let owner: BrowserProfileOwner | undefined;
  try {
    server = await fixtureServer();
    owner = await BrowserProfileOwner.launch(join(root, 'profile'), true);
    await owner.open(server.origin);
    const page = owner.notification, adapter = new DomAdapter(page, 'COMMENT_NOTIFICATION', mapping(server.origin));
    const first = rowData('comment');
    await page.evaluate(rows => {
      const host = window as unknown as { addNotification: (row: unknown) => void };
      rows.forEach(host.addNotification);
    }, [first, { ...first, event: 'second', comment: 'second' }]);
    const batch = await adapter.observeNotifications();
    expect(batch.events).toHaveLength(2);
    await adapter.inspect(batch.events[0]!);
    await page.locator('#comment-composer').fill('Current comment draft');
    if(hidden)await page.locator('#comment-composer').evaluate(element=>element.setAttribute('hidden',''));
    await expect(adapter.inspect(batch.events[1]!)).rejects.toThrow('BROWSER_HAS_HUMAN_INPUT');
    expect(await page.locator('#comment-composer').inputValue()).toBe('Current comment draft');
    expect(await page.locator('#comment-composer').getAttribute('data-target')).toBe(
      'comment:' + batch.events[0]!.videoId + ':' + batch.events[0]!.commentId,
    );
  } finally { await closeFixture(root,owner,server); }
});

test('review: initial DM list without right pane can select the unique conversation', async () => {
  const root=privateTemp('legacy-dm-list-');
  let server:Awaited<ReturnType<typeof fixtureServer>>|undefined;
  let owner:BrowserProfileOwner|undefined;
  try {
    server=await fixtureServer();
    owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
    await owner.open(server.origin);
    await owner.dm.evaluate(() => {
      document.querySelector('#dm-entry')!.replaceWith(document.querySelector('#dm-entry')!.cloneNode(true));
      document.querySelector('#dm-entry')!.addEventListener('click', () => { (document.querySelector('#dm-list') as HTMLElement).hidden = false; });
      for (const button of document.querySelectorAll('#dm-list button')) button.addEventListener('click', () => { (document.querySelector('#dm-pane') as HTMLElement).hidden = false; });
    });
    const dm = new DomAdapter(owner.dm,'DIRECT_MESSAGE',mapping(server.origin));
    expect(await dm.conversations()).toHaveLength(2);
    expect((await dm.observeDm('conversation-1','peer-1')).events).toEqual([]);
  } finally { await closeFixture(root,owner,server); }
});

test.each(['pointerover','pointerdown','document-click-capture'])('review: %s cannot change the approved submission destination', async stage => {
  const root=privateTemp('legacy-dm-submit-');
  let server:Awaited<ReturnType<typeof fixtureServer>>|undefined;
  let owner:BrowserProfileOwner|undefined;
  let s:EventStore|undefined;
  try {
    server=await fixtureServer();
    s=new EventStore(join(root,'poc.sqlite'),true,()=> '2026-11-03T00:00:00Z');
    owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
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
  } finally { await closeFixture(root,owner,server,s); }
});

test('review: manually sent outgoing reply after approval invalidates the old approval', async () => {
  const root=privateTemp('legacy-dm-history-');
  let server:Awaited<ReturnType<typeof fixtureServer>>|undefined;
  let owner:BrowserProfileOwner|undefined;
  let s:EventStore|undefined;
  try {
    server=await fixtureServer();
    s=new EventStore(join(root,'poc.sqlite'),true,()=> '2026-11-03T00:00:00Z');
    owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
    await owner.open(server.origin); const dm = new DomAdapter(owner.dm,'DIRECT_MESSAGE',mapping(server.origin));
    s.observe('DIRECT_MESSAGE','conversation-1',[],'own-1','fixture');
    await owner.dm.evaluate(e => (window as unknown as {addDm:(id:string,e:unknown)=>void}).addDm('conversation-1',e),rowData('dm'));
    const batch = await dm.observeDm('conversation-1','peer-1');
    const eventId = s.observe('DIRECT_MESSAGE','conversation-1',batch.events,'own-1',batch.evidenceId)[0]!;
    const d = s.saveDraft(eventId,'approved text','mock'); s.approve(d.id,await dm.inspect(s.event(eventId).payload),d.version,d.text);
    await owner.dm.locator('#dm-composer').fill(d.text); await owner.dm.locator('#dm-send').click();
    await expect(new SendCoordinator(s,owner.actor).send(d.id,dm,false)).rejects.toThrow('TARGET_CHANGED');
    expect(await owner.dm.evaluate(() => (window as unknown as {clicks:number}).clicks)).toBe(1);
  } finally { await closeFixture(root,owner,server,s); }
});

test('review: old identical reply revealed after rejected click cannot be accepted as a new receipt',async()=>{
  const root=privateTemp('legacy-dm-proof-');
  let server:Awaited<ReturnType<typeof fixtureServer>>|undefined;
  let owner:BrowserProfileOwner|undefined;
  let s:EventStore|undefined;
  try{
    server=await fixtureServer();
    s=new EventStore(join(root,'poc.sqlite'),true,()=> '2026-11-03T00:00:00Z');
    owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
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
  }finally{await closeFixture(root,owner,server,s);}
});

test('review: pointerdown cannot register a late click handler that changes approved destination',async()=>{
  const root=privateTemp('legacy-dm-proof-');
  let server:Awaited<ReturnType<typeof fixtureServer>>|undefined;
  let owner:BrowserProfileOwner|undefined;
  let s:EventStore|undefined;
  try{
    server=await fixtureServer();
    s=new EventStore(join(root,'poc.sqlite'),true,()=> '2026-11-03T00:00:00Z');
    owner=await BrowserProfileOwner.launch(join(root,'profile'),true);
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
  }finally{await closeFixture(root,owner,server,s);}
});

test.each(['br before arming','img after arming','replacement editor','multiline input','successful cleanup','cancelled preparation','edited preparation'] as const)(
  'legacy editor keeps the prepared node and structure (case: %s)',async scenario=>{
    const root=privateTemp('phase1-legacy-editor-');
    let server:Awaited<ReturnType<typeof fixtureServer>>|undefined;
    let owner:BrowserProfileOwner|undefined;
    try{
      server=await fixtureServer();
      owner=await BrowserProfileOwner.launch(join(root,'profile'),true);await owner.open(server.origin);
      const page=owner.dm,adapter=new DomAdapter(page,'DIRECT_MESSAGE',mapping(server.origin));
      await page.evaluate(e=>(window as unknown as {addDm:(id:string,event:unknown)=>void}).addDm('conversation-1',e),rowData('dm'));
      const event=(await adapter.observeDm('conversation-1','peer-1')).events[0]!;
      await page.evaluate(singleLine=>{
        const prior=document.querySelector('#dm-composer')!,editor=document.createElement(singleLine?'input':'div');
        editor.id=prior.id;editor.setAttribute('data-target',prior.getAttribute('data-target')!);
        if(!singleLine){editor.contentEditable='true';editor.append(document.createElement('br'));}
        prior.replaceWith(editor);
        const button=document.querySelector<HTMLButtonElement>('#dm-send')!;
        button.onclick=()=>{(window as unknown as {clicks:number}).clicks++;editor.textContent='';};
      },scenario==='multiline input');
      const counter=()=>page.evaluate(()=>(window as unknown as {clicks:number}).clicks);
      await adapter.inspect(event);
      if(scenario==='multiline input'){
        await expect(adapter.prepare(event,'first\nsecond')).rejects.toThrow();
        expect(await page.locator('#dm-composer').inputValue()).toBe('');
      }else{
        const text='Approved reply',editor=page.locator('#dm-composer');
        await adapter.prepare(event,text);
        if(scenario==='br before arming'){
          await editor.evaluate(el=>el.append(document.createElement('br')));
          await expect(adapter.verifyPrepared(event,text)).rejects.toThrow();
        }else{
          await adapter.verifyPrepared(event,text);
          if(scenario==='img after arming'){
            await editor.evaluate(el=>el.append(document.createElement('img')));
            await expect(adapter.clickOnce()).rejects.toThrow();
          }else if(scenario==='replacement editor'){
            await editor.evaluate(el=>el.replaceWith(el.cloneNode(true)));
            await expect(adapter.clickOnce()).rejects.toThrow();
          }else if(scenario==='cancelled preparation'||scenario==='edited preparation'){
            if(scenario==='edited preparation')await editor.evaluate(el=>el.dispatchEvent(new InputEvent('input',{bubbles:true})));
            await adapter.cancelPreparation(event,text);
            expect(await editor.innerHTML()).toBe(scenario==='edited preparation'?text:'<br>');
            expect(await counter()).toBe(0);
            await page.locator('#dm-send').click();expect(await counter()).toBe(1);
            return;
          }else{
            await adapter.clickOnce();expect(await counter()).toBe(1);
            await page.locator('#dm-send').click();expect(await counter()).toBe(2);
            return;
          }
        }
      }
      expect(await counter()).toBe(0);
    }finally{await closeFixture(root,owner,server);}
  });
