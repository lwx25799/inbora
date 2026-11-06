import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { EventStore } from "../../src/storage/store.js";
import { migrateClient } from "../../src/storage/client-migration.js";
import { ClientService } from "../../src/app/service.js";
import { BrowserService } from "../../src/app/browser-service.js";
import { pending, privateTemp } from "../helpers.js";

test.each(["before-intent", "after-intent"] as const)(
  "hard process exit %s preserves commands and never replays on restart",
  async (phase) => {
    const root = privateTemp("client-crash-"),
      file = join(root, "poc.sqlite"),
      store = new EventStore(file, true);
    const eventId = pending(store);
    await migrateClient(store, join(root, "backup.sqlite"));
    store.close();
    const source = `
import {EventStore} from './src/storage/store.ts';
import {ClientService} from './src/app/service.ts';
import {BrowserService} from './src/app/browser-service.ts';
import {AccountActor} from './src/browser/account-actor.ts';
import {snapshot} from './tests/helpers.ts';
import {digest} from './src/core/contracts.ts';
import {randomUUID} from 'node:crypto';
const [file,eventId,phase]=process.argv.slice(1);
const s=new EventStore(file);
class CrashBrowser extends BrowserService{
  queue=new AccountActor();get actor(){return this.queue;}
  identity(){return {identityDigest:digest('own-1'),mappingDigest:'crash-fixture',browserVersion:'fixture',browserMode:'headed'};}
  async refreshIdentity(){return this.identity();}
  async adapter(e){let count=0;return {adapter:{inspect:async()=>snapshot(e),prepare:async()=>{},baseline:async()=>[],
    verifyPrepared:async()=>{if(++count===2&&phase==='before-intent')process.exit(90);return snapshot(e);},
    clickOnce:async()=>{process.exit(91);},readback:async()=>null},dispose(){}};}
}
const b=new CrashBrowser('.local'),app=new ClientService(s,b),token=app.authority.issueSession();
app.authority.attest('DIRECT_MESSAGE','SEND_AVAILABLE',b.identity(),'synthetic-crash-evidence');app.authority.setMode(token,'MANUAL');
const generation=app.authority.claim(token,eventId,0).generation,d=app.authority.save(token,eventId,generation,0,'crash fixture reply'),selectionId=randomUUID();
app.authority.select(token,eventId,selectionId);
const params={eventId,generation,draftId:d.id,draftVersion:d.version,text:d.text,contextVersion:app.authority.contextVersion(s.event(eventId)),selectionId};
const review=await app.dispatch(token,{command:'previewSend',params});
await app.dispatch(token,{command:'submitManualSend',commandId:review.commandId,params,confirmed:true});await app.drain();process.exit(92);
`;
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        source,
        file,
        eventId,
        phase,
      ],
      {
        cwd: resolve("."),
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      },
    );
    expect(child.stderr).toBe("");
    expect(child.status).toBe(phase === "before-intent" ? 90 : 91);
    const restored = new EventStore(file),
      app = new ClientService(restored, new BrowserService(root));
    try {
      const command = restored.db
        .prepare("SELECT status,intent_id,reason FROM manual_send_commands")
        .get() as { status: string; intent_id: string | null; reason: string };
      expect(command.status).toBe(
        phase === "before-intent" ? "FAILED_BEFORE_CLICK" : "UNCERTAIN",
      );
      expect(command.reason).toBe("RESTART_NO_REPLAY");
      expect(restored.uncertain()).toHaveLength(
        phase === "before-intent" ? 0 : 1,
      );
      expect(
        restored.db
          .prepare("SELECT used FROM budgets WHERE kind=?")
          .get("SEND"),
      ).toEqual({ used: phase === "before-intent" ? 0 : 1 });
      const before = restored.stats();
      app.authority.recover();
      expect(restored.stats()).toEqual(before);
      expect(app.browser.status().state).toBe("CLOSED");
    } finally {
      await app.close();
      restored.close();
    }
  },
  30_000,
);
