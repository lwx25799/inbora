import { expect, test } from 'vitest';
import { join } from 'node:path';
import { BrowserProfileOwner } from '../../src/browser/profile-owner.js';
import { DomAdapter } from '../../src/adapters/dom-adapter.js';
import { fixtureServer, mapping } from '../fixtures/site.js';
import { privateTemp } from '../helpers.js';

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
