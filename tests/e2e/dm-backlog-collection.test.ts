import { expect, test, vi } from 'vitest';
import { join } from 'node:path';
import { BrowserProfileOwner } from '../../src/browser/profile-owner.js';
import { InboxCollector } from '../../src/app/inbox-collector.js';
import { ObservedReader } from '../../src/adapters/observed-reader.js';
import { Blocked } from '../../src/core/contracts.js';
import { AutomationStore } from '../../src/storage/automation-store.js';
import { EventStore } from '../../src/storage/store.js';
import { migrateClient } from '../../src/storage/client-migration.js';
import { migrateAutomation } from '../../src/storage/automation-migration.js';
import { fixtureServer } from '../fixtures/site.js';
import { mountObserved, observedMapping } from '../fixtures/observed-site.js';
import { privateTemp } from '../helpers.js';

// Synthetic normal-direction overflow list, not a claim about live Douyin layout.
// Fixed MIT DSH 7989640 chat-browser.mjs:386–393 detects message-list direction;
// :864–869 scrolls the contact list, while :1119–1142 does not page message history.
test.each([[false,false],[true,false],[false,true],[true,true]])('DM backlog survives changed viewport height (%s) and a restored old window (%s)', async (heightChanges,restoredOld) => {
  const server = await fixtureServer();
  const root = privateTemp('dm-backlog-');
  const owner = await BrowserProfileOwner.launch(join(root, 'profile'), true);
  const store = new EventStore(join(root, 'poc.sqlite'), true);
  const startedAt = Date.now() - 60_000;
  let collector: InboxCollector | undefined;
  try {
    await migrateClient(store, join(root, 'schema3.sqlite'));
    await migrateAutomation(store, join(root, 'automation.sqlite'));
    let data = new AutomationStore(store);
    data.initialize(startedAt);
    store.bindAccount('100');
    data.configureCollection({ ownId: '100', comments: false, inbox: true,
      commentIntervalMs: 30_000, dmIntervalMs: 15_000 });
    store.db.prepare("UPDATE client_state SET mode='DRAFT_ONLY'").run();
    await mountObserved(owner, server.origin);
    await owner.dm.evaluate(({ startedAt, restoredOld }) => {
      const chat = document.querySelector('#chat') as HTMLElement;
      for (const box of chat.querySelectorAll('.box')) box.remove();
      const list = document.createElement('div');
      list.id = 'backlog-messages';
      list.style.cssText = 'height:144px;overflow-y:auto;position:relative;width:360px';
      const space = document.createElement('div');
      space.id = 'backlog-space';
      space.style.height = '600px';
      const viewport = document.createElement('div');
      viewport.style.cssText = 'position:sticky;top:0;height:96px';
      space.append(viewport); list.append(space); chat.append(list);
      const state = window as unknown as { backlogOlderLoads: number; backlogScrollEvents: number };
      state.backlogOlderLoads = 0; state.backlogScrollEvents = 0;
      const latest = [
        { id: '104', text: 'latest native four', at: startedAt + 4000 },
        { id: '105', text: 'latest native five', at: startedAt + 5000 },
      ];
      const earlier = [
        { id: '101', text: 'old baseline history', at: startedAt - 10_000 },
        { id: '102', text: 'earlier native two', at: startedAt + (restoredOld ? -9000 : 2000) },
        { id: '103', text: 'earlier native three', at: startedAt + (restoredOld ? -8000 : 3000) },
      ];
      const mountWindow = (messages: typeof latest) => {
        viewport.replaceChildren(...messages.map(message => {
          const box = document.createElement('div'); box.className = 'box';
          box.style.height = '28px';
          const row = document.createElement('div'); row.className = 'message';
          const text = document.createElement('span'); text.className = 'text'; text.textContent = message.text;
          row.append(text); box.append(row);
          Object.defineProperty(row, '__reactProps$fixture', { value: { children: { props: { message: {
            serverId: message.id, conversationId: 'conv-a', sender: '200', createdAt: new Date(message.at),
            _parsedContent: { text: message.text },
          } } } } });
          return box;
        }));
      };
      const openConversation = () => {
        mountWindow(restoredOld ? earlier : latest);
        list.scrollTop = restoredOld ? 0 : list.scrollHeight - list.clientHeight;
      };
      list.addEventListener('scroll', () => {
        state.backlogScrollEvents++;
        // Only ordinary physical scrolling mounts the other native window.
        requestAnimationFrame(() => {
          const oldWindow = restoredOld ? list.scrollTop < list.scrollHeight - list.clientHeight - 1 : list.scrollTop <= list.clientHeight;
          if (oldWindow) {
            state.backlogOlderLoads++;
            mountWindow(earlier);
          } else mountWindow(latest);
        });
      });
      document.querySelector('#back')!.addEventListener('click', () => { chat.hidden = true; });
      document.querySelector('.conversation')!.addEventListener('click', () => {
        chat.hidden = false; openConversation();
      });
      openConversation();
    }, { startedAt, restoredOld });
    const mapping = observedMapping(server.origin), signal = new AbortController().signal;
    collector = new InboxCollector(owner, mapping, data, root, 'headless');
    const progress = () => {
      const cursor=JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as { cursor_json: string }).cursor_json) as {
        sweep?: {top:number;height:number;phase:string;anchor?:{top:number;height:number;ids:string[]}};
        parked?:{top:number;height:number;phase:string;anchor?:{top:number;height:number;ids:string[]};peer:{conversationId:string}}[];
      };
      // A yielded peer retains the same pending proof in its parked checkpoint.
      return {...cursor,sweep:cursor.sweep??cursor.parked?.find(item=>item.peer.conversationId==='conv-a')};
    };
    const lastRead = () => (store.db.prepare("SELECT last_read FROM discovered_conversations WHERE id='conv-a'").get() as { last_read: number }).last_read;
    let completed = false;
    for (let turn = 0; turn < 32; turn++) {
      await collector.collect('dm', signal);
      if (turn === 0) {
        expect(lastRead()).toBe(0);
        expect(progress().sweep).toBeDefined();
      }
      if (turn === 1) {
        expect(lastRead()).toBe(0);
        collector.dispose();
        // Reopening may restore the latest or a saved old native window, as a fresh page would.
        await owner.dm.evaluate(heightChanges => {
          if (heightChanges) (document.querySelector('#backlog-space') as HTMLElement).style.height = '1000px';
          (document.querySelector('.conversation') as HTMLElement).click();
        }, heightChanges);
        data = new AutomationStore(store);
        data.initialize(Date.now());
        collector = new InboxCollector(owner, mapping, data, root, 'headless');
      }
      if (turn === 2 && heightChanges) {
        const current = await owner.dm.evaluate(() => {
          const list = document.querySelector('#backlog-messages')!;
          return {height:list.scrollHeight,step:Math.floor(list.clientHeight*0.8)};
        });
        const checkpoint=progress().sweep!;
        expect(checkpoint).toMatchObject({phase:restoredOld?'PROBE_MIN':'MIN',height:current.height,anchor:{height:current.height}});
        expect(checkpoint.anchor!.ids.length).toBeGreaterThan(0);
        expect(checkpoint.top).toBe(restoredOld?0:Math.max(0,checkpoint.anchor!.top-current.step));
        expect(lastRead()).toBe(0);
      }
      if (lastRead() > 0) {
        expect(progress().sweep).toBeUndefined();
        completed = true;
        break;
      }
      expect(progress().sweep).toBeDefined();
      expect(lastRead()).toBe(0);
    }
    expect(completed).toBe(true);
    // Later routine rounds observe the same native IDs without making duplicate tasks.
    await collector.collect('dm', signal);
    await collector.collect('dm', signal);
    const events = store.events();
    expect(data.state().startedAt).toBe(startedAt);
    expect(events.some(event => event.payload.platformEventId === '104')).toBe(true);
    expect(store.db.prepare('SELECT kind,used FROM budgets ORDER BY kind').all())
      .toEqual([{ kind: 'MODEL', used: 0 }, { kind: 'SEND', used: 0 }]);
    expect(store.db.prepare('SELECT count(*) AS n FROM send_intents').get()).toEqual({ n: 0 });
    expect(store.db.prepare('SELECT count(*) AS n FROM model_calls').get()).toEqual({ n: 0 });
    const fresh = events.filter(event => event.status !== 'BASELINE');
    expect(fresh.map(event => event.payload.platformEventId).sort()).toEqual(restoredOld ? ['104', '105'] : ['102', '103', '104', '105']);
    expect(new Set(events.map(event => event.payload.platformEventId)).size).toBe(events.length);
    expect(events.find(event => event.payload.platformEventId === '101')?.status).toBe('BASELINE');
    if (restoredOld) for (const id of ['102','103']) expect(events.find(event => event.payload.platformEventId === id)?.status).toBe('BASELINE');
    expect(await owner.dm.evaluate(() => (window as unknown as { backlogOlderLoads: number }).backlogOlderLoads)).toBeGreaterThan(0);
  } finally {
    collector?.dispose(); store.close(); await owner.close(); await server.close();
  }
});

test('a deferred sweep uses a display name refreshed by ordinary discovery after cooldown and collector restart', async () => {
  const server = await fixtureServer(), root = privateTemp('dm-backlog-rename-');
  const owner = await BrowserProfileOwner.launch(join(root,'profile'),true);
  const store = new EventStore(join(root,'poc.sqlite'),true);
  let collector: InboxCollector | undefined, now = Date.now();
  try {
    await migrateClient(store,join(root,'client.sqlite'));await migrateAutomation(store,join(root,'automation.sqlite'));
    const data = new AutomationStore(store,() => now);data.initialize(now-60_000);store.bindAccount('100');
    data.configureCollection({ownId:'100',comments:false,inbox:true,commentIntervalMs:30_000,dmIntervalMs:15_000});
    await mountObserved(owner,server.origin);
    await owner.dm.evaluate(now => {
      const chat = document.querySelector('#chat') as HTMLElement;
      const list = document.createElement('div');list.style.cssText = 'height:144px;overflow-y:auto';
      const space = document.createElement('div');space.style.height = '600px';
      const viewport = document.createElement('div');viewport.style.cssText = 'position:sticky;top:0';
      for (const box of chat.querySelectorAll('.box')) {
        if (box.querySelector('.from-me,img')) { box.remove(); continue; }
        Object.getOwnPropertyDescriptor(box.querySelector('.message')!,'__reactProps$fixture')!.value.children.props.message.createdAt = new Date(now-1000);
        viewport.append(box);
      }
      space.append(viewport);list.append(space);chat.append(list);list.scrollTop = list.scrollHeight-list.clientHeight;
      document.querySelector('#back')!.addEventListener('click',() => { chat.hidden = true; });
      document.querySelector('.conversation')!.addEventListener('click',() => { chat.hidden = false; });
    },now);
    const mapping = observedMapping(server.origin), signal = new AbortController().signal;
    collector = new InboxCollector(owner,mapping,data,root,'headless');
    await collector.collect('dm',signal);
    const before = (store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as { cursor_json: string }).cursor_json;
    const failure = vi.spyOn(ObservedReader.prototype,'dmWindow').mockRejectedValueOnce(new Blocked('OBSERVATION_DOM_NOT_READY'));
    try { await expect(collector.collect('dm',signal)).rejects.toThrow('OBSERVATION_DOM_NOT_READY'); }
    finally { failure.mockRestore(); }
    expect(JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as { cursor_json: string }).cursor_json).sweep)
      .toEqual(JSON.parse(before).sweep);
    await owner.dm.evaluate(() => {
      document.querySelector('.title')!.textContent = 'Renamed native peer';
      document.querySelector('#chat-title')!.textContent = 'Renamed native peer';
    });
    await collector.collect('dm',signal); // The deferred peer is only refreshed by the normal LIST read.
    expect(store.db.prepare("SELECT title,last_read FROM discovered_conversations WHERE id='conv-a'").get())
      .toEqual({title:'Renamed native peer',last_read:0});
    now += 120_001;
    collector.dispose();collector = new InboxCollector(owner,mapping,new AutomationStore(store,() => now),root,'headless');
    await expect(collector.collect('dm',signal)).resolves.toBeUndefined();
    const after = JSON.parse((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as { cursor_json: string }).cursor_json);
    expect(after.sweep.peer).toMatchObject({conversationId:'conv-a',secUid:'peer-sec',uid:'200',title:'Renamed native peer'});
    expect(after.deferred).toEqual([]);
    expect(store.db.prepare("SELECT last_read FROM discovered_conversations WHERE id='conv-a'").get()).toEqual({last_read:0});
    expect(store.db.prepare('SELECT used FROM budgets ORDER BY kind').all()).toEqual([{used:0},{used:0}]);
    const current = store.db.prepare("SELECT own_id,uid,sec_uid,title,first_seen,last_seen,last_read FROM discovered_conversations WHERE id='conv-a'").get() as {
      own_id:string;uid:string;sec_uid:string;title:string;first_seen:number;last_seen:number;last_read:number;
    };
    const protectedCursor = JSON.stringify(after);
    for (const conflict of ['missing','own','uid','secure']) {
      if (conflict === 'missing') store.db.prepare("DELETE FROM discovered_conversations WHERE id='conv-a'").run();
      else store.db.prepare("UPDATE discovered_conversations SET own_id=?,uid=?,sec_uid=? WHERE id='conv-a'")
        .run(conflict === 'own' ? 'other-own' : current.own_id,conflict === 'uid' ? 'other-uid' : current.uid,conflict === 'secure' ? 'other-sec' : current.sec_uid);
      try {
        await expect(collector.collect('dm',signal)).rejects.toThrow('OBSERVATION_CONVERSATION_CHANGED');
        expect((store.db.prepare("SELECT cursor_json FROM collection_progress WHERE source='dm'").get() as {cursor_json:string}).cursor_json).toBe(protectedCursor);
      } finally {
        store.db.prepare("DELETE FROM discovered_conversations WHERE id='conv-a'").run();
        store.db.prepare('INSERT INTO discovered_conversations(id,own_id,uid,sec_uid,title,first_seen,last_seen,last_read) VALUES(?,?,?,?,?,?,?,?)')
          .run('conv-a',current.own_id,current.uid,current.sec_uid,current.title,current.first_seen,current.last_seen,current.last_read);
      }
    }
  } finally {collector?.dispose();store.close();await owner.close();await server.close();}
});
