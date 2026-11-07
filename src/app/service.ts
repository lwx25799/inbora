import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  Blocked,
  isStrong,
  requireSafe,
  targetKey,
  type Channel,
} from "../core/contracts.js";
import { SendCoordinator } from "../core/send-coordinator.js";
import type { EventStore } from "../storage/store.js";
import {
  commandSchema,
  defaultSettings,
  settingsSchema,
  type AiSettings,
  type SendParams,
} from "./contracts.js";
import { WorkbenchAuthority } from "./authority.js";
import { BrowserService } from "./browser-service.js";
import { DeepSeekProvider } from "../ai/deepseek.js";

export function clientError(error: unknown): string {
  return error instanceof Blocked
    ? error.code
    : "OPERATION_FAILED_PRIVATE_DIAGNOSTICS";
}

/** Transport-neutral application service. Short controls never wait behind browser/model operations. */
export class ClientService {
  readonly events = new EventEmitter();
  readonly authority: WorkbenchAuthority;
  private settings: AiSettings = { ...defaultSettings };
  private key = "";
  private modelAuthorized = false;
  private modelAbort = new AbortController();
  private modelPending = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  private closing = false;
  constructor(
    readonly store: EventStore,
    readonly browser: BrowserService,
    private readonly provider = new DeepSeekProvider(),
    now: () => number = Date.now,
  ) {
    this.authority = new WorkbenchAuthority(store, now);
    this.authority.recover();
  }
  async loadSettings(): Promise<void> {
    try {
      this.settings = settingsSchema.parse(
        JSON.parse(
          await readFile(
            join(this.browser.root, "client-settings.json"),
            "utf8",
          ),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private emit(event: string): void {
    this.events.emit("update", { event });
  }
  private track(task: Promise<unknown>): void {
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
  }
  private thread(token: string, eventId: string) {
    const op = this.authority.operator(token),
      e = this.store.event(eventId),
      draft = this.authority.draftFor(eventId);
    const owner = this.authority.ownership(e),
      identity = this.browser.identity(e.payload.channel);
    const suggestions = this.store.db
      .prepare(
        "SELECT id,text,model,draft_version,context_version,created_at FROM ai_suggestions WHERE event_id=? AND dismissed=0 ORDER BY created_at DESC LIMIT 5",
      )
      .all(eventId);
    const intent =
      this.store.db
        .prepare("SELECT id,status FROM send_intents WHERE event_id=?")
        .get(eventId) ?? null;
    const paused = Boolean(
      (
        this.store.db
          .prepare("SELECT paused FROM pauses WHERE target_key=?")
          .get(targetKey(e.payload)) as { paused: number } | undefined
      )?.paused,
    );
    const frozen = !!this.store.db
      .prepare(
        "SELECT id FROM send_intents WHERE target_key=? AND status IN ('INTENT_RECORDED','UNCERTAIN')",
      )
      .get(targetKey(e.payload));
    return {
      event: e,
      draft,
      history: this.store.history(e.payload),
      ownership: { ...owner, isMine: owner.operator_id === op.id },
      contextVersion: this.authority.contextVersion(e),
      capability: this.authority.capability(e.payload.channel, identity),
      controlledTrial:
        !!draft &&
        this.authority.trialAvailable(
          e.id,
          draft.id,
          draft.version,
          draft.text,
          identity,
        ),
      strong: isStrong(e.payload),
      paused,
      frozen,
      intent,
      receipt: this.store.receiptForEvent(eventId) ?? null,
      suggestions,
    };
  }
  private status(token: string) {
    const op = this.authority.operator(token);
    const configuredMode=this.authority.mode();
    const anySendAvailable=(['COMMENT_NOTIFICATION','DIRECT_MESSAGE'] as Channel[]).some(channel=>
      this.authority.capability(channel,this.browser.identity(channel)).state==='SEND_AVAILABLE')||
      this.store.events().some(event=>{const draft=this.authority.draftFor(event.id);return draft&&this.authority.trialAvailable(event.id,draft.id,draft.version,draft.text,this.browser.identity(event.payload.channel));});
    const effectiveMode=['MANUAL','AI_ASSISTED'].includes(configuredMode)&&!anySendAvailable?'DRAFT_ONLY':configuredMode;
    const account = this.store.db
      .prepare("SELECT own_id FROM accounts WHERE id=?")
      .get("account_001") as { own_id: string } | undefined;
    return {
      runtime: this.browser.root,
      account: account ? { id: "account_001", identity: account.own_id } : null,
      operator: {
        id: op.id,
        permissions: op.permissions,
        expiresAt: op.expires_at,
      },
      mode: effectiveMode,
      paused: this.authority.paused(),
      browser: this.browser.status(),
      lastSync: this.store.db
        .prepare(
          "SELECT channel,MAX(observed_at) AS at FROM observations GROUP BY channel",
        )
        .all(),
      capabilities: (
        ["COMMENT_NOTIFICATION", "DIRECT_MESSAGE"] as Channel[]
      ).map((channel) => ({
        channel,
        ...this.authority.capability(channel, this.browser.identity(channel)),
      })),
      budgets: this.store.db.prepare("SELECT * FROM budgets").all(),
      usage: this.store.db
        .prepare(
          `SELECT count(*) AS requests,
        COALESCE(sum(input_tokens),0) AS inputTokens,COALESCE(sum(output_tokens),0) AS outputTokens,
        COALESCE(sum(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END),0) AS unresolved FROM model_calls`,
        )
        .get(),
      settings: this.settings,
      keyPresent: !!this.key,
      modelAuthorized: this.modelAuthorized,
      modelBusy: this.modelPending.size > 0,
      go: "UNVERIFIED",
      schema: 3,
    };
  }
  async dispatch(token: string, raw: unknown): Promise<unknown> {
    requireSafe(!this.closing, "CLIENT_CLOSING");
    const c = commandSchema.parse(raw);
    this.authority.operator(token);
    switch (c.command) {
      case "getStatus":
        for (const channel of [
          "COMMENT_NOTIFICATION",
          "DIRECT_MESSAGE",
        ] as const)
          await this.browser.refreshIdentity(channel);
        return this.status(token);
      case "getThread":
        return {
          ...this.thread(token, c.eventId),
          workUrl: await this.browser.workUrl(
            this.store.event(c.eventId).payload,
          ),
        };
      case "openTarget": {
        this.authority.operator(token, "CONTROL");
        const event = this.store.event(c.eventId),
          handle = await this.browser.adapter(event.payload);
        try {
          await this.browser.actor.run(() =>
            handle.adapter.inspect(event.payload),
          );
          return { opened: true };
        } finally {
          handle.dispose();
        }
      }
      case "getInbox": {
        const filter =
          c.status === "PENDING"
            ? ["AWAITING_DRAFT", "AWAITING_APPROVAL", "APPROVED"]
            : c.status === "REVIEW"
              ? ["MANUAL_REVIEW"]
              : c.status === "UNCERTAIN"
                ? ["UNCERTAIN", "INTENT_RECORDED"]
                : c.status === "CONFIRMED"
                  ? ["CONFIRMED"]
                  : null;
        const events = this.store
          .events()
          .filter(
            (e) =>
              e.status !== "BASELINE" &&
              (c.channel === "ALL" || e.payload.channel === c.channel) &&
              (!filter || filter.includes(e.status)),
          )
          .reverse();
        return {
          total: events.length,
          page: c.page,
          pageSize: 20,
          items: events.slice(c.page * 20, c.page * 20 + 20).map((e) => ({
            id: e.id,
            status: e.status,
            channel: e.payload.channel,
            author: e.payload.actorName,
            preview: e.payload.text,
            time: e.payload.occurredAt,
            source:
              e.payload.discovery ??
              (e.payload.channel === "DIRECT_MESSAGE"
                ? "DIRECT_MESSAGE"
                : "NOTIFICATION"),
          })),
        };
      }
      case "selectTarget":
        this.authority.select(token, c.eventId, c.selectionId);
        return { selected: true };
      case "claimHuman": {
        const o = this.authority.claim(token, c.eventId, c.generation);
        this.emit("takeover_updated");
        return o;
      }
      case "renewHuman":
        return this.authority.renew(token, c.eventId, c.generation);
      case "releaseHuman":
        this.authority.release(token, c.eventId, c.generation);
        this.emit("takeover_updated");
        return { released: true };
      case "saveDraft": {
        const draft = this.authority.save(
          token,
          c.eventId,
          c.generation,
          c.expectedVersion,
          c.text,
          c.suggestionId,
        );
        this.emit("draft_updated");
        return draft;
      }
      case "setMode":
        this.authority.setMode(token, c.mode);
        this.emit("status_updated");
        return this.status(token);
      case "pause":
      case "resume":
      case "emergencyStop": {
        this.authority.pause(
          token,
          c.command === "emergencyStop" ? null : c.eventId,
          c.command !== "resume",
        );
        if (c.command === "emergencyStop") {
          this.modelAbort.abort();
          this.modelAbort = new AbortController();
        }
        this.emit("takeover_updated");
        this.emit("send_status_updated");
        return this.status(token);
      }
      case "browser": {
        this.authority.operator(token, "CONTROL");
        if (c.open) await this.browser.open(c.mode);
        else await this.browser.close();
        this.emit("status_updated");
        return this.status(token);
      }
      case "observe": {
        this.authority.operator(token, "CONTROL");
        try {
          await this.browser.observe(this.store, c.source);
        } catch (error) {
          this.store.db
            .prepare("UPDATE channel_capabilities SET state='BLOCKED'")
            .run();
          throw error;
        }
        this.emit("inbox_updated");
        return this.status(token);
      }
      case "getAudit":
        return {
          items: this.store.db
            .prepare(
              "SELECT time,event_type,entity_id,detail_redacted FROM audit_events ORDER BY rowid DESC LIMIT 50 OFFSET ?",
            )
            .all(c.page * 50),
          page: c.page,
        };
      case "previewSend": {
        this.authority.operator(token, "SEND");
        const e = this.store.event(c.params.eventId);
        const handle = await this.browser.adapter(e.payload);
        try {
          const snapshot = await this.browser.actor.run(async () => {
            await this.browser.refreshIdentity(e.payload.channel);
            this.authority.assertCanSend(
              token,
              c.params,
              this.browser.identity(e.payload.channel),
            );
            return handle.adapter.inspect(e.payload);
          });
          return {
            ...this.authority.preview(
              token,
              c.params,
              snapshot,
              this.browser.identity(e.payload.channel),
            ),
            params: c.params,
            target: e.payload,
            account: snapshot.ownId,
          };
        } finally {
          handle.dispose();
        }
      }
      case "submitManualSend": {
        const e = this.store.event(c.params.eventId);
        await this.browser.refreshIdentity(e.payload.channel);
        const fresh = this.authority.queue(
          token,
          c.commandId,
          c.params,
          this.browser.identity(e.payload.channel),
        );
        if (fresh) this.track(this.deliver(token, c.commandId, c.params));
        return this.result(token, c.commandId);
      }
      case "getSendResult":
        return this.result(token, c.commandId);
      case "reconcileUncertain": {
        this.authority.operator(token, "CONTROL");
        return this.browser.verifyExisting(this.store, c.eventId);
      }
      case "configureAi": {
        this.authority.operator(token, "CONTROL");
        requireSafe(!/[\r\n]/u.test(c.key), "INVALID_MODEL_KEY");
        const file = join(this.browser.root, "client-settings.json"),
          temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(c.settings), {
          flag: "wx",
          mode: 0o600,
        });
        await rename(temporary, file);
        this.settings = c.settings;
        this.key = c.key;
        this.modelAuthorized = false;
        return this.status(token);
      }
      case "authorizeAi":
        this.authority.operator(token, "CONTROL");
        requireSafe(!c.authorized || this.key, "MODEL_KEY_REQUIRED");
        this.modelAuthorized = c.authorized;
        this.store.audit(
          c.authorized ? "DEEPSEEK_AUTHORIZED" : "DEEPSEEK_REVOKED",
          "account_001",
        );
        return this.status(token);
      case "generateSuggestion": {
        this.authority.operator(token, "EDIT");
        requireSafe(
          this.authority.mode() !== "OBSERVE" && !this.authority.paused(),
          "MODEL_PAUSED",
        );
        const e = this.store.event(c.eventId);
        requireSafe(
          [
            "AWAITING_DRAFT",
            "AWAITING_APPROVAL",
            "APPROVED",
            "MANUAL_REVIEW",
          ].includes(e.status),
          "EVENT_NOT_DRAFTABLE",
        );
        requireSafe(
          (this.authority.draftFor(e.id)?.version ?? 0) === c.draftVersion,
          "DRAFT_VERSION_CONFLICT",
        );
        requireSafe(!this.modelPending.has(e.id), "MODEL_ALREADY_PENDING");
        const context = this.authority.contextVersion(e);
        this.modelPending.add(e.id);
        try {
          const result = await this.provider.generate(
            this.store,
            e.payload,
            this.store.history(e.payload),
            this.settings,
            this.key,
            this.modelAuthorized,
            this.modelAbort.signal,
          );
          const id = randomUUID();
          this.store.db
            .prepare("INSERT INTO ai_suggestions VALUES(?,?,?,?,?,?,?,0)")
            .run(
              id,
              e.id,
              c.draftVersion,
              context,
              result.text,
              result.model,
              Date.now(),
            );
          // Candidate only: a human revision, new context, or new lease is never overwritten.
          this.emit("suggestion_updated");
          return {
            id,
            ...result,
            stale:
              (this.authority.draftFor(e.id)?.version ?? 0) !==
                c.draftVersion || this.authority.contextVersion(e) !== context,
          };
        } finally {
          this.modelPending.delete(e.id);
        }
      }
      case "dismissSuggestion":
        this.authority.operator(token, "EDIT");
        this.store.db
          .prepare("UPDATE ai_suggestions SET dismissed=1 WHERE id=?")
          .run(c.suggestionId);
        return { dismissed: true };
    }
  }
  private result(token: string, id: string) {
    const row = this.authority.command(id);
    this.authority.operator(token);
    return {
      commandId: id,
      status: row.status,
      intentId: row.intent_id,
      reason: row.reason,
    };
  }
  private async deliver(
    token: string,
    id: string,
    p: SendParams,
  ): Promise<void> {
    let dispose = () => {};
    try {
      const e = this.store.event(p.eventId),
        handle = await this.browser.adapter(e.payload);
      dispose = handle.dispose;
      await this.browser.refreshIdentity(e.payload.channel);
      const outcome = await new SendCoordinator(
        this.store,
        this.browser.actor,
      ).send(
        p.draftId,
        handle.adapter,
        true,
        this.authority.dispatchGuard(token, id, () =>
          this.browser.identity(e.payload.channel),
        ),
      );
      const receipt=this.store.receiptForEvent(e.id) as {proof_ref:string}|undefined;
      this.authority.finish(id, outcome, outcome==='UNCERTAIN'?receipt?.proof_ref??null:null);
      if (outcome === "CONFIRMED")
        this.authority.completeTrial(
          p.eventId,
          this.authority.command(id).intent_id!,
          this.browser.identity(e.payload.channel),
        );
    } catch (error) {
      const intent = this.store.db
        .prepare("SELECT id,status FROM send_intents WHERE event_id=?")
        .get(p.eventId) as { id: string; status: string } | undefined;
      if (intent && this.authority.command(id).intent_id === intent.id)
        this.authority.finish(
          id,
          intent.status === "CONFIRMED" ? "CONFIRMED" : "UNCERTAIN",
          clientError(error),
        );
      else {
        this.authority.finish(id, "FAILED_BEFORE_CLICK", clientError(error));
        const d = this.store.draft(p.draftId);
        if (d.status === "APPROVED") this.store.invalidateApproval(d.id);
      }
    } finally {
      dispose();
      this.emit("send_status_updated");
    }
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
  async close(): Promise<void> {
    this.closing = true;
    this.key = "";
    this.modelAuthorized = false;
    this.modelAbort.abort();
    this.store.db.prepare("UPDATE client_state SET paused=1 WHERE id=1").run();
    this.authority.expireOperators();
    await this.drain();
    await this.browser.close();
  }
}
