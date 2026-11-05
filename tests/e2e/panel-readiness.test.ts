import { expect, test } from 'vitest';
import { join } from 'node:path';
import { BrowserProfileOwner } from '../../src/browser/profile-owner.js';
import { DomAdapter } from '../../src/adapters/dom-adapter.js';
import { fixtureServer, mapping, rowData } from '../fixtures/site.js';
import { database, privateTemp } from '../helpers.js';
import { validateMapping } from '../../src/config/site-mapping.js';

test.each(['notifications', 'dm'] as const)('waits for asynchronously mounted %s panel before reading', async channel => {
  const server = await fixtureServer();
  const owner = await BrowserProfileOwner.launch(join(privateTemp(), 'profile'), true);
  try {
    await owner.open(server.origin);
    const page = channel === 'notifications' ? owner.notification : owner.dm;
    await page.evaluate(kind => {
      const entry = document.querySelector(kind === 'notifications' ? '#notification-entry' : '#dm-entry') as HTMLElement;
      entry.onclick = () => {
        setTimeout(() => {
          (document.querySelector(kind === 'notifications' ? '#notifications' : '#dm-list') as HTMLElement).hidden = false;
        }, 120);
      };
    }, channel);
    const adapter = new DomAdapter(page, channel === 'notifications' ? 'COMMENT_NOTIFICATION' : 'DIRECT_MESSAGE', mapping(server.origin));
    if (channel === 'notifications') {
      expect((await adapter.observeNotifications()).events).toEqual([]);
      expect(await page.locator('#notifications').isVisible()).toBe(true);
    } else {
      expect(await adapter.conversations()).toHaveLength(2);
      expect(await page.locator('#dm-list').isVisible()).toBe(true);
    }
  } finally {
    await owner.close();
    await server.close();
  }
});

test('an explicitly unavailable mapped timestamp is read as null and persisted for manual review', async () => {
  const server = await fixtureServer();
  const owner = await BrowserProfileOwner.launch(join(privateTemp(), 'profile'), true);
  const store = database();
  try {
    const config = mapping(server.origin);
    config.dm.fields = { ...config.dm.fields, occurredAt: null };
    const observed = validateMapping(config, false);
    await owner.open(server.origin);
    await owner.dm.evaluate(data => (window as unknown as {
      addDm: (id: string, data: Record<string, string>) => void;
    }).addDm('conversation-1', data), rowData('dm'));
    const adapter = new DomAdapter(owner.dm, 'DIRECT_MESSAGE', observed);
    const batch = await adapter.observeDm('conversation-1', 'peer-1');
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]!.occurredAt).toBeNull();
    expect(store.observe('DIRECT_MESSAGE', 'conversation-1', batch.events, 'own-1', batch.evidenceId)).toEqual([]);
    expect(store.events()[0]!.status).toBe('MANUAL_REVIEW');
    expect(await owner.dm.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(0);
  } finally {
    store.close(); await owner.close(); await server.close();
  }
});
