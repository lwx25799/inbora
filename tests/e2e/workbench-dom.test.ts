import { test, expect } from "vitest";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserProfileOwner } from "../../src/browser/profile-owner.js";
import { BrowserService } from "../../src/app/browser-service.js";
import { ClientService } from "../../src/app/service.js";
import { DomAdapter } from "../../src/adapters/dom-adapter.js";
import { migrateClient } from "../../src/storage/client-migration.js";
import {
  digest,
  type Channel,
  type InboundEvent,
} from "../../src/core/contracts.js";
import { fixtureServer, mapping, rowData } from "../fixtures/site.js";
import { database, privateTemp } from "../helpers.js";

test.each([false, true])(
  "application service sends both synthetic DOM channels through the sole coordinator, reopen headless owner=%s",
  async (reopen) => {
    const server = await fixtureServer(),
      root = privateTemp("workbench-dom-"),
      store = database();
    let owner = await BrowserProfileOwner.launch(
      join(root, "profile"),
      true,
    );
    let service: ClientService | undefined;
    try {
      if(reopen){await owner.close();owner=await BrowserProfileOwner.launch(join(root,'profile'),true);}
      await owner.open(server.origin);
      await migrateClient(store, join(root, "backup.sqlite"));
      const config = mapping(server.origin),
        comment = new DomAdapter(
          owner.notification,
          "COMMENT_NOTIFICATION",
          config,
        ),
        dm = new DomAdapter(owner.dm, "DIRECT_MESSAGE", config);
      for (const [channel, scope, adapter] of [
        ["COMMENT_NOTIFICATION", "notifications", comment],
        ["DIRECT_MESSAGE", "conversation-1", dm],
      ] as const) {
        const initial =
          channel === "DIRECT_MESSAGE"
            ? await adapter.observeDm(scope, "peer-1")
            : await adapter.observeNotifications();
        store.observe(
          channel,
          scope,
          initial.events,
          config.ownId,
          initial.evidenceId,
        );
      }
      await owner.notification.evaluate(
        (e) =>
          (
            window as unknown as { addNotification: (e: unknown) => void }
          ).addNotification(e),
        rowData("comment"),
      );
      await owner.dm.evaluate(
        (e) =>
          (
            window as unknown as { addDm: (id: string, e: unknown) => void }
          ).addDm("conversation-1", e),
        rowData("dm"),
      );
      for (const [channel, scope, adapter] of [
        ["COMMENT_NOTIFICATION", "notifications", comment],
        ["DIRECT_MESSAGE", "conversation-1", dm],
      ] as const) {
        const batch =
          channel === "DIRECT_MESSAGE"
            ? await adapter.observeDm(scope, "peer-1")
            : await adapter.observeNotifications();
        store.observe(
          channel,
          scope,
          batch.events,
          config.ownId,
          batch.evidenceId,
        );
      }
      class DomBrowser extends BrowserService {
        override get actor() {
          return owner.actor;
        }
        override identity() {
          return {
            identityDigest: digest(config.ownId),
            mappingDigest: digest(config),
            browserVersion: owner.version(),
            browserMode: "headless" as const,
          };
        }
        override async refreshIdentity() {
          return this.identity();
        }
        override async close() {
          await owner.close();
        }
        override async adapter(e: InboundEvent) {
          const adapter = e.channel === "DIRECT_MESSAGE" ? dm : comment;
          return { adapter, dispose: () => {} };
        }
      }
      service = new ClientService(store, new DomBrowser(root));
      const token = service.authority.issueSession();
      for (const channel of [
        "COMMENT_NOTIFICATION",
        "DIRECT_MESSAGE",
      ] as Channel[])
        service.authority.attest(
          channel,
          "SEND_AVAILABLE",
          service.browser.identity(channel)!,
          "synthetic-dom-evidence",
        );
      service.authority.setMode(token, "MANUAL");
      for (const event of store.events()) {
        const generation = service.authority.claim(
          token,
          event.id,
          0,
        ).generation;
        const draft = service.authority.save(
            token,
            event.id,
            generation,
            0,
            "人工回复合成夹具。",
          ),
          selectionId = randomUUID();
        service.authority.select(token, event.id, selectionId);
        const params = {
          eventId: event.id,
          generation,
          draftId: draft.id,
          draftVersion: draft.version,
          text: draft.text,
          contextVersion: service.authority.contextVersion(event),
          selectionId,
        };
        const preview = (await service.dispatch(token, {
          command: "previewSend",
          params,
        })) as { commandId: string };
        await service.dispatch(token, {
          command: "submitManualSend",
          commandId: preview.commandId,
          params,
          confirmed: true,
        });
        await service.drain();
        expect(
          await service.dispatch(token, {
            command: "getSendResult",
            commandId: preview.commandId,
          }),
        ).toMatchObject({ status: "CONFIRMED" });
      }
      expect(
        await owner.dm.evaluate(
          () => (window as unknown as { clicks: number }).clicks,
        ),
      ).toBe(1);
      expect(
        await owner.notification.evaluate(
          () => (window as unknown as { clicks: number }).clicks,
        ),
      ).toBe(1);
      expect(
        store.db.prepare("SELECT count(*) AS n FROM model_calls").get(),
      ).toEqual({ n: 0 });
    } finally {
      await service?.close();
      await owner.close();
      store.close();
      await server.close();
    }
  },
  60_000,
);
