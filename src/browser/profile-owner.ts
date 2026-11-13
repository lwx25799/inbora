import { mkdir } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { AccountActor } from './account-actor.js';
import { OwnerLock } from './owner-lock.js';
import { requireSafe } from '../core/contracts.js';
import { installMediaPauseGuard } from './media-pause.js';

export class BrowserProfileOwner {
  readonly actor = new AccountActor();
  private closing:Promise<void>|undefined;
  private constructor(readonly context: BrowserContext, readonly notification: Page, readonly dm: Page,
    private readonly lock: OwnerLock,private readonly headless:boolean) {}
  static async launch(profile: string, headless: boolean): Promise<BrowserProfileOwner> {
    await mkdir(profile, { recursive: true });
    const lock = await OwnerLock.acquire(profile);
    let context: BrowserContext | undefined;
    try {
      context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless, locale: 'zh-CN', args: ['--mute-audio'] });
      context.setDefaultTimeout(5000); context.setDefaultNavigationTimeout(15_000);
      const notification = context.pages()[0] ?? await context.newPage();
      // Do not navigate or reuse the notification page as the DM page.
      const dm = await context.newPage();
      for (const extra of context.pages()) if (extra !== notification && extra !== dm) await extra.close();
      const owner=new BrowserProfileOwner(context, notification, dm, lock,headless);
      context.once('close',()=>{void owner.close().catch(()=>{});});
      return owner;
    } catch (error) {
      if (context) await context.close().catch(() => {});
      await lock.close(); throw error;
    }
  }
  async open(origin: string, signal?: AbortSignal): Promise<void> {
    await this.actor.run(async () => {
      requireSafe(!signal?.aborted,'COLLECTION_CANCELLED');
      for(const page of [this.notification,this.dm])await installMediaPauseGuard(page,origin,this.headless);
      requireSafe(!signal?.aborted,'COLLECTION_CANCELLED');
      await this.notification.goto(origin, { waitUntil: 'domcontentloaded' });
      requireSafe(!signal?.aborted,'COLLECTION_CANCELLED');
      await this.dm.goto(origin, { waitUntil: 'domcontentloaded' });
    });
  }
  version(): string { return this.context.browser()?.version() ?? 'unknown'; }
  async close(): Promise<void> {
    if(!this.closing)this.closing=(async()=>{try {await this.context.close();}finally{await this.lock.close();}})();
    return this.closing;
  }
}
