import { afterAll, beforeAll, expect, test } from 'vitest';
import { join } from 'node:path';
import { BrowserProfileOwner } from '../../src/browser/profile-owner.js';
import { DomAdapter } from '../../src/adapters/dom-adapter.js';
import { SendCoordinator } from '../../src/core/send-coordinator.js';
import { fixtureServer, mapping, rowData } from '../fixtures/site.js';
import { database, privateTemp } from '../helpers.js';

let server: Awaited<ReturnType<typeof fixtureServer>>;
beforeAll(async () => { server = await fixtureServer(); });
afterAll(async () => { await server.close(); });

test.each([true, false])('both channels use real persistent Edge pages, complete approved receipt chain; headless=%s', async headless => {
  const owner = await BrowserProfileOwner.launch(join(privateTemp(), 'profile'), headless); const s = database();
  try {
    await owner.open(server.origin);
    expect(owner.notification).not.toBe(owner.dm); expect(owner.context.pages()).toHaveLength(2);
    const config = mapping(server.origin);
    const notification = new DomAdapter(owner.notification, 'COMMENT_NOTIFICATION', config);
    const dm = new DomAdapter(owner.dm, 'DIRECT_MESSAGE', config);
    await owner.actor.run(async () => {
      const comments = await notification.observeNotifications();
      s.observe('COMMENT_NOTIFICATION', 'notifications', comments.events, config.ownId, comments.evidenceId);
      const history = await dm.observeDm('conversation-1', 'peer-1');
      s.observe('DIRECT_MESSAGE', 'conversation-1', history.events, config.ownId, history.evidenceId);
      await owner.notification.evaluate(e => (window as unknown as { addNotification: (e: unknown) => void }).addNotification(e), rowData('comment'));
      await owner.dm.evaluate(e => (window as unknown as { addDm: (id: string, e: unknown) => void }).addDm('conversation-1', e), rowData('dm'));
      const freshComments = await notification.observeNotifications();
      s.observe('COMMENT_NOTIFICATION', 'notifications', freshComments.events, config.ownId, freshComments.evidenceId);
      const freshDm = await dm.observeDm('conversation-1', 'peer-1');
      s.observe('DIRECT_MESSAGE', 'conversation-1', freshDm.events, config.ownId, freshDm.evidenceId);
    });
    expect(s.events()).toHaveLength(2);
    for (const event of s.events()) {
      const a = event.payload.channel === 'DIRECT_MESSAGE' ? dm : notification;
      const d = s.saveDraft(event.id, `fixture reply for ${event.payload.channel}`, 'mock');
      const target = await owner.actor.run(() => a.inspect(event.payload)); s.approve(d.id, target, d.version, d.text);
      expect(await new SendCoordinator(s, owner.actor).send(d.id, a, false)).toBe('CONFIRMED');
      expect(s.event(event.id).status).toBe('CONFIRMED');
    }
    expect(await owner.notification.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(1);
    expect(await owner.dm.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(1);
    expect(owner.notification.url()).toBe(`${server.origin}/`);
  } finally { s.close(); await owner.close(); }
});

test('DOM/login/challenge/account failures block; identical nicknames never select another recipient', async () => {
  const owner = await BrowserProfileOwner.launch(join(privateTemp(), 'profile'), true);
  try {
    await owner.open(server.origin); const dm = new DomAdapter(owner.dm, 'DIRECT_MESSAGE', mapping(server.origin));
    expect(await dm.conversations()).toHaveLength(2);
    for (const [selector, error] of [['#login', 'LOGIN_REQUIRED'], ['#challenge', 'CHALLENGE_REQUIRED'], ['#stop', 'PLATFORM_STOP']]) {
      await owner.dm.locator(selector!).evaluate(el => (el as HTMLElement).hidden = false);
      await expect(dm.guard()).rejects.toThrow(error!);
      await owner.dm.locator(selector!).evaluate(el => (el as HTMLElement).hidden = true);
    }
    await owner.dm.locator('#account').evaluate(el => el.setAttribute('data-id', 'wrong'));
    await expect(dm.guard()).rejects.toThrow('ACCOUNT_NOT_VERIFIED');
    await owner.dm.locator('#account').evaluate(el => el.setAttribute('data-id', 'own-1'));
    await owner.dm.locator('#account').evaluate(el => el.remove());
    await expect(dm.guard()).rejects.toThrow('DOM_NOT_UNIQUE');
  } finally { await owner.close(); }
});

test('pending browser reply becomes uncertain and frozen; later incoming message invalidates approval', async () => {
  const owner = await BrowserProfileOwner.launch(join(privateTemp(), 'profile'), true); const s = database();
  try {
    await owner.open(server.origin); const config = mapping(server.origin);
    const dm = new DomAdapter(owner.dm, 'DIRECT_MESSAGE', config, 200);
    s.observe('DIRECT_MESSAGE', 'conversation-1', [], config.ownId, 'fixture');
    await owner.dm.evaluate(e => (window as unknown as { addDm: (id: string, e: unknown) => void }).addDm('conversation-1', e), rowData('dm'));
    const observed = await dm.observeDm('conversation-1', 'peer-1');
    const id = s.observe('DIRECT_MESSAGE', 'conversation-1', observed.events, config.ownId, observed.evidenceId)[0]!;
    const d = s.saveDraft(id, 'fixture pending reply', 'mock'); s.approve(d.id, await dm.inspect(s.event(id).payload), d.version, d.text);
    await owner.dm.evaluate(() => (window as unknown as { pending: boolean }).pending = true);
    expect(await new SendCoordinator(s, owner.actor).send(d.id, dm, false)).toBe('UNCERTAIN');
    await expect(new SendCoordinator(s, owner.actor).send(d.id, dm, false)).rejects.toThrow();
    expect(await owner.dm.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(1);
  } finally { s.close(); await owner.close(); }
});

test('new incoming message after approval invalidates approval before browser click', async () => {
  const owner = await BrowserProfileOwner.launch(join(privateTemp(), 'profile'), true); const s = database();
  try {
    await owner.open(server.origin); const dm = new DomAdapter(owner.dm, 'DIRECT_MESSAGE', mapping(server.origin));
    s.observe('DIRECT_MESSAGE', 'conversation-1', [], 'own-1', 'fixture');
    await owner.dm.evaluate(e => (window as unknown as { addDm: (id: string, e: unknown) => void }).addDm('conversation-1', e), rowData('dm'));
    const batch = await dm.observeDm('conversation-1', 'peer-1');
    const eventId = s.observe('DIRECT_MESSAGE', 'conversation-1', batch.events, 'own-1', batch.evidenceId)[0]!;
    const d = s.saveDraft(eventId, 'approved fixture reply', 'mock'); s.approve(d.id, await dm.inspect(s.event(eventId).payload), d.version, d.text);
    await owner.dm.evaluate(e => (window as unknown as { addDm: (id: string, e: unknown) => void }).addDm('conversation-1', e), rowData('dm', { event: 'next', text: 'new message' }));
    await expect(new SendCoordinator(s, owner.actor).send(d.id, dm, false)).rejects.toThrow('TARGET_CHANGED');
    expect(s.draft(d.id).approval).toBeNull(); expect(s.db.prepare('SELECT * FROM send_intents').all()).toHaveLength(0);
    expect(await owner.dm.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(0);
  } finally { s.close(); await owner.close(); }
});

test('closing actual browser page immediately after durable intent freezes task across SQLite restart', async () => {
  const owner = await BrowserProfileOwner.launch(join(privateTemp(), 'profile'), true); const s = database();
  try {
    await owner.open(server.origin); const dm = new DomAdapter(owner.dm, 'DIRECT_MESSAGE', mapping(server.origin));
    s.observe('DIRECT_MESSAGE', 'conversation-1', [], 'own-1', 'fixture');
    await owner.dm.evaluate(e => (window as unknown as { addDm: (id: string, e: unknown) => void }).addDm('conversation-1', e), rowData('dm'));
    const batch = await dm.observeDm('conversation-1', 'peer-1');
    const eventId = s.observe('DIRECT_MESSAGE', 'conversation-1', batch.events, 'own-1', batch.evidenceId)[0]!;
    const d = s.saveDraft(eventId, 'approved interruption test', 'mock'); s.approve(d.id, await dm.inspect(s.event(eventId).payload), d.version, d.text);
    const click = dm.clickOnce.bind(dm);
    dm.clickOnce = async () => {
      expect(s.db.prepare("SELECT status FROM send_intents WHERE event_id=?").get(eventId)).toEqual({ status: 'INTENT_RECORDED' });
      await owner.dm.close(); await click();
    };
    expect(await new SendCoordinator(s, owner.actor).send(d.id, dm, false)).toBe('UNCERTAIN');
    expect(s.uncertain()).toHaveLength(1);
    await expect(new SendCoordinator(s, owner.actor).send(d.id, dm, false)).rejects.toThrow();
  } finally { s.close(); await owner.close(); }
});

test('delayed A-to-B conversation switch verifies both pane and peer, not just an existing composer', async () => {
  const owner = await BrowserProfileOwner.launch(join(privateTemp(), 'profile'), true);
  try {
    await owner.open(server.origin); const dm = new DomAdapter(owner.dm, 'DIRECT_MESSAGE', mapping(server.origin));
    await owner.dm.evaluate(e => (window as unknown as { addDm: (id: string, e: unknown) => void }).addDm('conversation-2', e),
      rowData('dm', { event: 'b', actor: 'peer-2', conversation: 'conversation-2' }));
    await owner.dm.evaluate(() => (window as unknown as { switchDelay: number }).switchDelay = 250);
    const batch = await dm.observeDm('conversation-2', 'peer-2');
    expect(batch.events).toHaveLength(1); expect(batch.events[0]?.actorId).toBe('peer-2');
    await owner.dm.locator('#dm-pane').evaluate(el => el.setAttribute('data-peer', 'wrong-peer'));
    await owner.dm.evaluate(() => (window as unknown as { freezeSwitch: boolean }).freezeSwitch = true);
    await expect(dm.observeDm('conversation-2', 'peer-2')).rejects.toThrow('CONVERSATION_SWITCH_UNVERIFIED');
  } finally { await owner.close(); }
});

test('dedicated profile shares state across two pages and restores it after browser close',async()=>{
  const profile=join(privateTemp(),'profile');let owner=await BrowserProfileOwner.launch(profile,false);
  try{
    await owner.open(server.origin);
    await owner.notification.evaluate(()=>{document.cookie='inbora_fixture=shared; Max-Age=300; Path=/';});
    expect(await owner.dm.evaluate(()=>document.cookie)).toContain('inbora_fixture=shared');
    await owner.close();owner=await BrowserProfileOwner.launch(profile,true);await owner.open(server.origin);
    expect(await owner.notification.evaluate(()=>document.cookie)).toContain('inbora_fixture=shared');
    expect(await owner.dm.evaluate(()=>document.cookie)).toContain('inbora_fixture=shared');
  }finally{await owner.close();}
});
