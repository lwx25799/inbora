import { join } from "node:path";
import { BrowserProfileOwner } from "../browser/profile-owner.js";
import { ObservedReader } from "../adapters/observed-reader.js";
import { ObservedDmReply } from "../adapters/observed-dm-reply.js";
import { ObservedCommentReply } from "../adapters/observed-comment-reply.js";
import { DomAdapter } from "../adapters/dom-adapter.js";
import {
  loadObservationMapping,
  loadDmReplyMapping,
  loadCommentReplyMapping,
  loadMapping,
} from "../config/runtime.js";
import {
  digest,
  requireSafe,
  type Channel,
  type InboundEvent,
  type ReplyAdapter,
} from "../core/contracts.js";
import type { EventStore } from "../storage/store.js";
import { recordEvidence } from "../observability/evidence.js";
import type { CapabilityIdentity } from "./authority.js";

export interface AdapterHandle {
  adapter: ReplyAdapter;
  dispose(): void;
}
export class BrowserService {
  private owner: BrowserProfileOwner | undefined;
  private mode: "headed" | "headless" = "headed";
  private currentIdentity = new Map<Channel, CapabilityIdentity>();
  private state = "CLOSED";
  private opening: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    readonly root: string,
    private readonly launch = BrowserProfileOwner.launch,
  ) {}
  static adopt(
    root: string,
    owner: BrowserProfileOwner,
    mode: "headed" | "headless",
  ): BrowserService {
    const service = new BrowserService(root);
    service.owner = owner;
    service.mode = mode;
    service.state = "OPEN_IDENTITY_UNVERIFIED";
    return service;
  }
  get actor() {
    requireSafe(this.owner, "BROWSER_NOT_RUNNING");
    return this.owner.actor;
  }
  status() {
    return {
      state: this.state,
      mode: this.mode,
      version: this.owner?.version() ?? null,
    };
  }
  async workUrl(event: InboundEvent): Promise<string | null> {
    if (event.channel !== "COMMENT_NOTIFICATION") return null;
    const observation = await loadObservationMapping(this.root);
    return (
      observation?.works.find((work) => work.id === event.videoId)?.url ?? null
    );
  }
  identity(channel: Channel): CapabilityIdentity | null {
    return this.currentIdentity.get(channel) ?? null;
  }
  async open(mode: "headed" | "headless" = this.mode): Promise<void> {
    if (this.closing) await this.closing;
    if (this.opening) {
      await this.opening;
      requireSafe(this.mode === mode, "CLOSE_BROWSER_BEFORE_MODE_CHANGE");
      return;
    }
    requireSafe(
      !this.owner || this.mode === mode,
      "CLOSE_BROWSER_BEFORE_MODE_CHANGE",
    );
    if (this.owner) return;
    const opening = this.launchOwner(mode);
    this.opening = opening;
    try {
      await opening;
    } finally {
      if (this.opening === opening) this.opening = undefined;
    }
  }
  private async launchOwner(mode: "headed" | "headless"): Promise<void> {
    this.state = "STARTING";
    this.mode = mode;
    let created: BrowserProfileOwner | undefined;
    try {
      const observation = await loadObservationMapping(this.root);
      let origin = observation?.entryUrl;
      if (!origin) {
        try {
          origin = (await loadMapping(this.root)).origin;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          origin = "https://www.douyin.com/";
        }
      }
      const owner = await this.launch(
        join(this.root, "profile"),
        mode === "headless",
      );
      created = owner;
      this.owner = owner;
      owner.context.once("close", () => {
        if (this.owner === owner) {
          this.owner = undefined;
          this.state = "CLOSED";
          this.currentIdentity.clear();
          this.closing = owner.close().finally(() => {
            this.closing = undefined;
          });
        }
      });
      await owner.open(origin);
      for (const channel of ["COMMENT_NOTIFICATION", "DIRECT_MESSAGE"] as const)
        await this.refreshIdentity(channel);
      this.state = "OPEN_IDENTITY_UNVERIFIED";
    } catch (error) {
      if (this.owner === created) this.owner = undefined;
      this.state = "BROWSER_START_FAILED";
      this.currentIdentity.clear();
      await created?.close();
      throw error;
    }
  }
  async close(): Promise<void> {
    if (this.opening) await this.opening.catch(() => {});
    if (this.closing) return this.closing;
    const owner = this.owner;
    this.owner = undefined;
    this.currentIdentity.clear();
    this.state = "CLOSED";
    if (owner) {
      this.closing = owner.actor.run(() => owner.close());
      try {
        await this.closing;
      } finally {
        this.closing = undefined;
      }
    }
  }
  async adapter(e: InboundEvent): Promise<AdapterHandle> {
    await this.open();
    const owner = this.owner!;
    const native =
      e.channel === "DIRECT_MESSAGE"
        ? await loadDmReplyMapping(this.root)
        : await loadCommentReplyMapping(this.root);
    if (native) {
      this.currentIdentity.set(e.channel, {
        identityDigest: digest(native.observation.self.uid),
        mappingDigest: digest(native),
        browserVersion: owner.version(),
        browserMode: this.mode,
      });
      const adapter =
        e.channel === "DIRECT_MESSAGE"
          ? new ObservedDmReply(
              owner.dm,
              native as NonNullable<
                Awaited<ReturnType<typeof loadDmReplyMapping>>
              >,
            )
          : new ObservedCommentReply(
              owner.notification,
              native as NonNullable<
                Awaited<ReturnType<typeof loadCommentReplyMapping>>
              >,
            );
      return { adapter, dispose: () => adapter.dispose() };
    }
    const mapping = await loadMapping(this.root);
    this.currentIdentity.set(e.channel, {
      identityDigest: digest(mapping.ownId),
      mappingDigest: digest(mapping),
      browserVersion: owner.version(),
      browserMode: this.mode,
    });
    return {
      adapter: new DomAdapter(
        e.channel === "DIRECT_MESSAGE" ? owner.dm : owner.notification,
        e.channel,
        mapping,
      ),
      dispose: () => {},
    };
  }
  async refreshIdentity(channel: Channel): Promise<CapabilityIdentity | null> {
    if (!this.owner) return null;
    const native =
      channel === "DIRECT_MESSAGE"
        ? await loadDmReplyMapping(this.root)
        : await loadCommentReplyMapping(this.root);
    let mapping:
      NonNullable<typeof native> | Awaited<ReturnType<typeof loadMapping>>;
    if (native) mapping = native;
    else {
      try {
        mapping = await loadMapping(this.root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          this.currentIdentity.delete(channel);
          return null;
        }
        throw error;
      }
    }
    const own = native
      ? native.observation.self.uid
      : (mapping as Awaited<ReturnType<typeof loadMapping>>).ownId;
    const identity = {
      identityDigest: digest(own),
      mappingDigest: digest(mapping),
      browserVersion: this.owner.version(),
      browserMode: this.mode,
    };
    this.currentIdentity.set(channel, identity);
    return identity;
  }
  async observe(
    store: EventStore,
    source: "notifications" | "works" | "dm",
  ): Promise<void> {
    await this.open();
    const owner = this.owner!,
      observation = await loadObservationMapping(this.root);
    await owner.actor.run(async () => {
      if (source !== "notifications" && observation) {
        const reader = new ObservedReader(
          source === "dm" ? owner.dm : owner.notification,
          observation,
        );
        const count =
          source === "dm" ? observation.peers.length : observation.works.length;
        for (let i = 0; i < count; i++) {
          const batch =
            source === "dm" ? await reader.dm(i) : await reader.comments(i);
          const evidence = await recordEvidence(join(this.root, "evidence"), {
            caseId: source === "dm" ? "D01" : "N01",
            browserVersion: owner.version(),
            mode: this.mode,
            taskId: null,
            action: "OBSERVE",
            result: "UNVERIFIED",
            source: "AUTOMATED_REAL",
            diagnostics: [
              "CLIENT_READ_ONLY",
              source === "dm"
                ? "PERMITTED_CONVERSATION"
                : "ALLOWED_WORK_FALLBACK",
            ],
            proofDigest: digest(batch),
          });
          store.observe(
            source === "dm" ? "DIRECT_MESSAGE" : "COMMENT_NOTIFICATION",
            source === "dm"
              ? observation.peers[i]!.conversationId
              : `work:${observation.works[i]!.id}`,
            batch.events.map((e) => ({ ...e, evidenceId: evidence })),
            observation.self.uid,
            evidence,
          );
        }
      } else {
        requireSafe(source !== "works", "OBSERVATION_MAPPING_REQUIRED");
        const mapping = await loadMapping(this.root),
          channel = source === "dm" ? "DIRECT_MESSAGE" : "COMMENT_NOTIFICATION";
        const adapter = new DomAdapter(
          source === "dm" ? owner.dm : owner.notification,
          channel,
          mapping,
        );
        if (source === "notifications") {
          const batch = await adapter.observeNotifications();
          store.observe(
            channel,
            "notifications",
            batch.events,
            mapping.ownId,
            batch.evidenceId,
          );
        } else
          for (const conversation of await adapter.conversations()) {
            const batch = await adapter.observeDm(
              conversation.id,
              conversation.peerId,
            );
            store.observe(
              channel,
              conversation.id,
              batch.events,
              mapping.ownId,
              batch.evidenceId,
            );
          }
      }
      this.state = "OPEN_LAST_READ_VERIFIED";
      for (const channel of ["COMMENT_NOTIFICATION", "DIRECT_MESSAGE"] as const)
        await this.refreshIdentity(channel);
    });
  }
  async verifyExisting(
    store: EventStore,
    eventId: string,
  ): Promise<{ verified: boolean; evidenceId: string }> {
    const event = store.event(eventId),
      draft = store.db
        .prepare("SELECT id FROM reply_drafts WHERE event_id=?")
        .get(eventId) as { id: string } | undefined;
    const intent = store.db
      .prepare("SELECT id FROM send_intents WHERE event_id=?")
      .get(eventId) as { id: string } | undefined;
    requireSafe(draft && intent, "INTENT_REQUIRED");
    await this.open();
    const owner = this.owner!;
    const handle = await this.adapter(event.payload);
    try {
      const proof = await owner.actor.run(async () => {
        if (handle.adapter instanceof ObservedCommentReply)
          return handle.adapter.verifyExisting(
            event.payload,
            store.draft(draft.id).text,
            store.intentBoundary(intent.id),
          );
        // DM readback is read-only: refresh only the already bound empty editor, never prepare/click.
        await handle.adapter.inspect(event.payload);
        return handle.adapter.readback(
          event.payload,
          store.draft(draft.id).text,
          [],
          store.intentBoundary(intent.id),
        );
      });
      const evidenceId = await recordEvidence(join(this.root, "evidence"), {
        caseId: event.payload.channel === "DIRECT_MESSAGE" ? "D05" : "C05",
        browserVersion: owner.version(),
        mode: this.mode,
        taskId: eventId,
        action: "OBSERVE",
        result: proof ? "PASS" : "BLOCKED",
        source: "AUTOMATED_REAL",
        diagnostics: ["CLIENT_READ_ONLY_RECHECK", "ORIGINAL_RECEIPTS_RETAINED"],
        proofDigest: proof ? digest(proof) : null,
      });
      return { verified: !!proof, evidenceId };
    } finally {
      handle.dispose();
    }
  }
}
