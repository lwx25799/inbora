import type Database from 'better-sqlite3';
import {
  type AccountId, type AccountSummary,
} from '../contracts/account.js';
import { Blocked, requireSafe, type Channel } from '../core/contracts.js';
import { SendCoordinator } from '../core/send-coordinator.js';
import type { PlatformConnector } from '../platform/platform-connector.js';
import type { WeChatKfCursorStore } from '../platform/wechat-kf/types.js';
import { AutomationStore } from '../storage/automation-store.js';
import { isEmergencyStopped } from '../storage/emergency-stop.js';
import { ModelProviderStore } from '../storage/model-provider-store.js';
import { EventStore } from '../storage/store.js';
import { WorkbenchAuthority } from './authority.js';
import type { ClientCommand, SendParams } from './contracts.js';
import { HumanFollowups } from './human-followup.js';
import { HumanReplyWorkflow } from './human-reply-workflow.js';
import { markInboxRead } from './inbox-read-state.js';
import { InboxSyncRunner } from './inbox-sync-runner.js';
import type { SharedMockModels } from './mock-account-runtime.js';
import { ModelProviderController } from './model-provider-controller.js';
import { ModelRouteGuard } from './model-route-guard.js';
import {
  previewSendCommand, reconcileUncertainCommand, sendResultCommand, type DeliveryContext,
} from './service-delivery.js';
import { clientError, dismissSuggestion, isReadOnlySidecarCommand, updateModelGrant } from './service-guards.js';
import type { SuggestionState } from './suggestion-eligibility.js';
import { generateSuggestion } from './suggestion-generation.js';
import { WorkbenchQueries } from './workbench-queries.js';

export type ParentOperator = ReturnType<WorkbenchAuthority['operator']>;

/** Schema4 account_cursors-backed durable cursor store for WeChat KF /kf/sync_msg pagination. */
export class SqliteWeChatKfCursorStore implements WeChatKfCursorStore {
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) {}

  load(accountId: AccountId, openKfId: string): string | null {
    const scope = `wechat-kf:${openKfId}`;
    const row = this.db.prepare(
      "SELECT cursor_data FROM account_cursors WHERE account_id=? AND channel='DIRECT_MESSAGE' AND scope=?",
    ).pluck().get(accountId, scope);
    return typeof row === 'string' && row.length > 0 ? row : null;
  }

  save(accountId: AccountId, openKfId: string, cursor: string): void {
    const scope = `wechat-kf:${openKfId}`;
    const updatedAt = new Date(this.now()).toISOString();
    this.db.prepare(`
      INSERT INTO account_cursors (account_id, channel, scope, cursor_data, updated_at)
      VALUES (?, 'DIRECT_MESSAGE', ?, ?, ?)
      ON CONFLICT(account_id, channel, scope)
      DO UPDATE SET cursor_data=excluded.cursor_data, updated_at=excluded.updated_at
    `).run(accountId, scope, cursor, updatedAt);
  }
}

/** Read-only local SQLite queries served even while an official channel is offline or emergency-stopped. */
export function dispatchOfflineOfficialRead(
  dbPath: string,
  account: AccountSummary,
  parent: ParentOperator,
  command: ClientCommand,
  now: () => number,
  sharedModels: () => SharedMockModels,
  readAudit: (store: EventStore, page: number) => unknown,
): unknown {
  const supported = command.command === 'getStatus'
    || command.command === 'getInbox'
    || command.command === 'getThread'
    || command.command === 'getAudit'
    || command.command === 'getSendResult';
  requireSafe(supported, 'OFFICIAL_CHANNEL_NOT_CONNECTED');

  const store = new EventStore(dbPath, false, undefined, account.id);
  try {
    const authority = new WorkbenchAuthority(store, now, account.id);
    const token = authority.issueSession(parent.permissions);
    try {
      const offlineBrowser = {
        accountId: account.id,
        platformId: account.platform,
        capabilities: account.capabilities,
        status: () => ({ state: 'CLOSED', mode: 'headless' as const, version: null }),
        identity: () => null,
      } as unknown as PlatformConnector;
      const queries = new WorkbenchQueries(store, authority, offlineBrowser);
      const automation = new AutomationStore(store, now);
      switch (command.command) {
        case 'getStatus': {
          const shared = sharedModels();
          return {
            ...queries.status(token, {
              settings: shared.state.settings,
              keyPresent: shared.state.keyPresent,
              modelAuthorized: shared.state.modelAuthorized,
              modelBusy: false,
              modelRoute: null,
              modelUnavailable: shared.state.modelUnavailable ?? null,
              keyStored: false,
              keyStorageError: null,
              automation,
              collector: undefined,
              inboxRevision: 0,
              sync: { runId: null, running: false, cancelled: false, source: null, results: [] },
            }),
            schema: 4,
          };
        }
        case 'getInbox':
          return queries.inbox(command);
        case 'getThread': {
          const shared = sharedModels();
          return {
            ...queries.thread(token, command.eventId, automation, command.timelineBefore, {
              ...shared.state, recovering: false, modelBusy: false, modelRoute: null,
            }),
            workUrl: null,
          };
        }
        case 'getAudit':
          return readAudit(store, command.page);
        case 'getSendResult': {
          const followups = new HumanFollowups(store, authority, offlineBrowser, () => false, () => {}, clientError);
          return sendResultCommand(store, authority, followups, token, command.commandId);
        }
      }
    } finally {
      authority.revoke(token);
    }
  } finally {
    store.close();
  }
}

/** Account-scoped Core runtime for an active official API channel (WeCom AI Bot / WeChat KF). */
export class OfficialAccountRuntime {
  private readonly store: EventStore;
  private readonly authority: WorkbenchAuthority;
  private readonly automation: AutomationStore;
  private readonly coordinator: SendCoordinator;
  private readonly queries: WorkbenchQueries;
  private readonly followups: HumanFollowups;
  private readonly humanReplies: HumanReplyWorkflow;
  private readonly sync: InboxSyncRunner;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly modelPending = new Set<string>();
  private readonly dialogs = new Map<string, { token: string; generation: number }>();
  private humanQueue: Promise<void> = Promise.resolve();
  private modelAbort = new AbortController();
  private readonly stopAbort = new AbortController();
  private modelController?: { primary: ModelProviderController; scoped: ModelProviderController };
  private session?: { parentId: string; token: string; expiresAt: number };
  private closing = false;
  private inboxRevision = 0;

  constructor(
    file: string,
    readonly connector: PlatformConnector,
    now: () => number,
    private readonly sharedModels: () => SharedMockModels,
    private readonly emit: (event: string) => void,
    private readonly readAudit: (store: EventStore, page: number) => unknown,
  ) {
    const store = this.store = new EventStore(file, false, undefined, connector.accountId);
    try {
      this.authority = new WorkbenchAuthority(store, now, connector.accountId);
      this.authority.recover();
      connector.bindStore(store);
      this.automation = new AutomationStore(store, now);
      this.coordinator = new SendCoordinator(store, connector.actor);
      this.queries = new WorkbenchQueries(store, this.authority, connector);
      this.followups = new HumanFollowups(
        store, this.authority, connector, () => this.closing,
        () => this.updated('send_status_updated'), clientError,
      );
      this.humanReplies = new HumanReplyWorkflow(
        store, this.authority, connector, () => this.closing,
        (token, id, params) => this.deliver(token, id, params),
        event => this.updated(event), clientError,
      );
      this.sync = new InboxSyncRunner({
        store, authority: this.authority, browser: connector,
        getAutomation: () => this.automation, getCollector: () => null,
        isClosing: () => this.closing, emit: event => this.updated(event),
        track: task => this.track(task), errorCode: clientError,
      });
    } catch (error) {
      store.close();
      throw error;
    }
  }

  isIdle(): boolean {
    return this.pending.size === 0 && this.connector.isIdle();
  }

  async openAndAttest(signal?: AbortSignal): Promise<void> {
    const combined = signal ? AbortSignal.any([signal, this.stopAbort.signal]) : this.stopAbort.signal;
    await this.connector.open('headless', combined);
    combined.throwIfAborted();
    for (const channel of this.connector.capabilities.channels) {
      await this.refreshCapability(channel);
    }
  }

  abortNow(reason = 'EMERGENCY_STOPPED'): void {
    if (!this.stopAbort.signal.aborted) {
      this.stopAbort.abort(new Blocked(reason));
    }
    this.sync.stop();
    this.modelAbort.abort(new Blocked(reason));
  }

  async close(): Promise<void> {
    this.closing = true;
    this.abortNow('CLIENT_CLOSING');
    this.dialogs.clear();
    this.modelController?.scoped.close();
    await Promise.allSettled([...this.pending]);
    try {
      this.authority.expireOperators('ALL');
    } finally {
      try { await this.connector.close(); }
      finally { this.store.close(); }
    }
  }

  dispatch(parent: ParentOperator, command: ClientCommand, checkOperator: () => void): Promise<unknown> {
    requireSafe(!this.closing, 'CLIENT_CLOSING');
    if (this.session?.parentId !== parent.id || this.session.expiresAt <= this.authority.now()) {
      if (this.session) this.authority.revoke(this.session.token);
      const token = this.authority.issueSession(parent.permissions);
      this.session = { parentId: parent.id, token, expiresAt: this.authority.operator(token).expires_at };
    }
    const { token } = this.session;
    if (!isReadOnlySidecarCommand(command) && parent.expires_at > this.session.expiresAt) {
      this.authority.renewTrustedSession(token);
      this.session.expiresAt = this.authority.operator(token).expires_at;
    }
    return this.track(this.handle(token, command, checkOperator));
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    const remove = () => this.pending.delete(task);
    void task.then(remove, remove);
    return task;
  }

  private enqueueHuman(operation: () => Promise<void>): Promise<void> {
    const task = this.humanQueue.then(operation);
    this.humanQueue = task.catch(() => {});
    return task;
  }

  private closeOtherDialogs(token: string, current: string | null): void {
    for (const [id, dialog] of this.dialogs) {
      if (id !== current && dialog.token === token) {
        try { this.authority.release(token, id, dialog.generation); } catch { /* lease may have expired */ }
        this.dialogs.delete(id);
      }
    }
  }

  private updated(event: string): void {
    this.inboxRevision++;
    this.emit(event);
  }

  private scopedModels(primary: ModelProviderController | null) {
    if (this.modelController?.primary !== primary) {
      this.modelController?.scoped.close();
      const scoped = primary ? new ModelProviderController(
        new ModelRouteGuard(new ModelProviderStore(this.store.db, this.authority.now), this.automation),
        primary.credentials, primary.transport, () => this.emit('status_updated'),
      ) : null;
      if (primary && scoped) this.modelController = { primary, scoped };
      else delete this.modelController;
      this.authority.modelRoute = scoped?.guard ?? null;
    }
    return this.modelController?.scoped ?? null;
  }

  private modelState(shared = this.sharedModels()): SuggestionState {
    return {
      ...shared.state, recovering: false, modelBusy: this.modelPending.size > 0,
      modelRoute: this.scopedModels(shared.models)?.guard ?? null,
    };
  }

  private abortModel(): void {
    this.modelAbort.abort(new Blocked('MODEL_CANCELLED'));
    this.modelAbort = new AbortController();
  }

  private status(token: string) {
    const state = this.modelState();
    return {
      ...this.queries.status(token, {
        ...state, modelUnavailable: state.modelUnavailable ?? null,
        keyStored: false, keyStorageError: null, automation: this.automation,
        collector: undefined, inboxRevision: this.inboxRevision, sync: this.sync.snapshot(),
      }),
      schema: 4,
    };
  }

  private thread(token: string, eventId: string, timelineBefore?: string) {
    return {
      ...this.queries.thread(token, eventId, this.automation, timelineBefore, this.modelState()),
      workUrl: null,
    };
  }

  private async refreshCapability(channel: Channel) {
    const identity = await this.connector.refreshIdentity(channel);
    const { reason } = this.authority.capability(channel, identity);
    if (identity && ['CAPABILITY_UNVERIFIED', 'CAPABILITY_EXPIRED_OR_CHANGED'].includes(reason)) {
      this.authority.attest(channel, 'SEND_AVAILABLE', identity, this.connector.platformId);
    }
    return identity;
  }

  private deliveryContext(): DeliveryContext {
    return {
      store: this.store, authority: this.authority, browser: this.connector,
      getAutomation: () => this.automation, getVerification: () => null, isClosing: () => this.closing,
      suspendForVisible: () => { throw new Blocked('OFFICIAL_CHANNEL_OPERATION_UNSUPPORTED'); },
      resetOnlineAbort: () => { throw new Blocked('OFFICIAL_CHANNEL_OPERATION_UNSUPPORTED'); },
      resumeAfterLogin: () => {}, bumpInboxRevision: () => { this.inboxRevision++; },
      emit: this.emit, errorCode: clientError,
    };
  }

  private async handle(token: string, c: ClientCommand, checkOperator: () => void): Promise<unknown> {
    const { store, authority, connector } = this;
    authority.operator(token);
    switch (c.command) {
      case 'getStatus':
        for (const channel of connector.capabilities.channels) await this.refreshCapability(channel);
        return this.status(token);
      case 'observe':
        requireSafe(!isEmergencyStopped(store), 'EMERGENCY_STOPPED');
        await this.sync.observe(token, c.source, this.stopAbort.signal);
        return this.status(token);
      case 'syncInbox':
        requireSafe(!isEmergencyStopped(store), 'EMERGENCY_STOPPED');
        authority.operator(token, 'CONTROL');
        this.sync.start(token);
        return this.status(token);
      case 'getInbox':
        return this.queries.inbox(c);
      case 'markInboxRead': {
        authority.operator(token, 'EDIT');
        const result = markInboxRead(store);
        this.updated('inbox_updated');
        return result;
      }
      case 'getThread':
        return this.thread(token, c.eventId, c.timelineBefore);
      case 'openHumanDialog': {
        authority.operator(token, 'EDIT');
        authority.select(token, c.eventId, c.selectionId);
        this.closeOtherDialogs(token, c.eventId);
        const event = store.event(c.eventId);
        if (
          c.editing !== false &&
          (!store.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(c.eventId)
            || this.followups.view(c.eventId)?.queueReady)
        ) {
          const current = authority.ownership(event);
          const owner = current.operator_id === authority.operator(token).id && current.lease_expires_at > authority.now()
            ? current
            : authority.claim(token, c.eventId, current.generation);
          this.dialogs.set(c.eventId, { token, generation: owner.generation });
        }
        this.emit('takeover_updated');
        return this.thread(token, c.eventId);
      }
      case 'closeHumanDialog':
        authority.release(token, c.eventId, c.generation);
        this.dialogs.delete(c.eventId);
        this.emit('takeover_updated');
        return this.thread(token, c.eventId);
      case 'sendHumanReply': {
        requireSafe(!isEmergencyStopped(store), 'EMERGENCY_STOPPED');
        await this.refreshCapability(store.event(c.input.eventId).payload.channel);
        checkOperator();
        const input = { ...c.input, text: c.input.text.replace(/\r\n?/gu, '\n') };
        const fresh = this.humanReplies.queue(token, c.commandId, input);
        if (fresh) this.track(this.enqueueHuman(() => this.humanReplies.prepare(token, c.commandId)));
        return sendResultCommand(store, authority, this.followups, token, c.commandId);
      }
      case 'saveHumanFollowupDraft':
        authority.requireGuiControl(token, 'EDIT');
        return this.followups.save(token, c.eventId, c.generation, c.expectedVersion, c.text, c.suggestionId);
      case 'sendHumanFollowup': {
        requireSafe(!isEmergencyStopped(store), 'EMERGENCY_STOPPED');
        authority.requireGuiControl(token, 'SEND');
        await this.refreshCapability(store.event(c.input.eventId).payload.channel);
        checkOperator();
        const fresh = this.followups.queue(token, c.commandId, c.input);
        if (fresh) this.track(this.enqueueHuman(() => this.followups.prepare(token, c.commandId)));
        return this.followups.result(token, c.commandId);
      }
      case 'selectTarget':
        this.closeOtherDialogs(token, c.eventId);
        authority.select(token, c.eventId, c.selectionId);
        return { selected: true };
      case 'claimHuman': {
        const owner = authority.claim(token, c.eventId, c.generation);
        this.emit('takeover_updated');
        return owner;
      }
      case 'renewHuman':
        return authority.renew(token, c.eventId, c.generation);
      case 'releaseHuman':
        authority.release(token, c.eventId, c.generation);
        this.dialogs.delete(c.eventId);
        this.emit('takeover_updated');
        return { released: true };
      case 'saveDraft': {
        const draft = authority.save(token, c.eventId, c.generation, c.expectedVersion, c.text, c.suggestionId);
        this.emit('draft_updated');
        return draft;
      }
      case 'generateSuggestion': {
        const shared = this.sharedModels();
        const models = this.scopedModels(shared.models);
        return generateSuggestion({
          store, authority, automation: this.automation, models, provider: shared.provider, pending: this.modelPending,
          state: () => { checkOperator(); return this.modelState(); },
          signal: () => AbortSignal.any([shared.signal, shared.models?.signal ?? shared.signal, this.modelAbort.signal]),
          knowledgeContext: event => shared.knowledge.available() ? shared.knowledge.context(event.accountId, event.channel, event.text) : null,
          emit: this.emit, cancelMaintenance: () => {},
        }, token, c);
      }
      case 'dismissSuggestion': {
        const result = dismissSuggestion(store, authority, token, c.suggestionId);
        this.emit('suggestion_updated');
        return result;
      }
      case 'setModelGrant':
        updateModelGrant(token, c, {
          authority, automation: this.automation,
          models: this.scopedModels(this.sharedModels().models), abortModel: () => this.abortModel(),
        });
        this.emit('status_updated');
        return this.status(token);
      case 'setMode':
        requireSafe(c.mode !== 'LIMITED_AUTO', 'ACCOUNT_COMMAND_NOT_SUPPORTED');
        authority.setMode(token, c.mode);
        this.emit('status_updated');
        return this.status(token);
      case 'previewSend':
        requireSafe(!isEmergencyStopped(store), 'EMERGENCY_STOPPED');
        authority.operator(token, 'SEND');
        await this.refreshCapability(store.event(c.params.eventId).payload.channel);
        return previewSendCommand(this.deliveryContext(), token, c.params);
      case 'submitManualSend': {
        requireSafe(!isEmergencyStopped(store), 'EMERGENCY_STOPPED');
        const identity = await this.refreshCapability(store.event(c.params.eventId).payload.channel);
        checkOperator();
        if (authority.queue(token, c.commandId, c.params, identity)) {
          this.track(this.deliver(token, c.commandId, c.params, checkOperator));
        }
        return sendResultCommand(store, authority, this.followups, token, c.commandId);
      }
      case 'getSendResult':
        return sendResultCommand(store, authority, this.followups, token, c.commandId);
      case 'pause':
      case 'resume':
        if (c.command === 'resume') requireSafe(!isEmergencyStopped(store), 'EMERGENCY_STOPPED');
        authority.pause(token, c.eventId, c.command === 'pause');
        if (c.command === 'pause' && c.eventId === null) this.abortModel();
        this.emit('takeover_updated');
        this.emit('send_status_updated');
        return this.status(token);
      case 'getAudit':
        return this.readAudit(store, c.page);
      case 'reconcileUncertain':
        store.event(c.eventId);
        return reconcileUncertainCommand(this.deliveryContext(), token, c.eventId);
      default:
        throw new Blocked('ACCOUNT_COMMAND_NOT_SUPPORTED');
    }
  }

  private async deliver(token: string, id: string, p: SendParams, checkOperator?: () => void): Promise<void> {
    const { store, authority, connector } = this;
    const { payload } = store.event(p.eventId);
    const epoch = connector.ownerEpoch;
    let dispose: (() => void | Promise<void>) | undefined;
    try {
      const handle = await connector.adapter(payload, store, this.stopAbort.signal);
      dispose = handle.dispose;
      const guard = authority.dispatchGuard(token, id, () => connector.identity(payload.channel));
      const active = () => {
        checkOperator?.();
        requireSafe(!this.closing, 'CLIENT_CLOSING');
        requireSafe(!isEmergencyStopped(store), 'EMERGENCY_STOPPED');
        requireSafe(connector.ownerEpoch === epoch, 'BROWSER_CLOSED');
      };
      const outcome = await this.coordinator.send(p.draftId, handle.adapter, true, {
        ...guard,
        check: () => { active(); guard.check(); },
        beforeSubmit: intentId => { active(); guard.beforeSubmit(intentId); },
      });
      const receipt = store.receiptForEvent(p.eventId) as { proof_ref: string } | undefined;
      authority.finish(id, outcome, outcome === 'UNCERTAIN' ? receipt?.proof_ref ?? null : null);
    } catch (error) {
      const intentId = authority.command(id).intent_id;
      const receipt = store.receiptForEvent(p.eventId) as { result: string } | undefined;
      authority.finish(id, intentId ? receipt?.result ?? 'UNCERTAIN' : 'FAILED_BEFORE_CLICK', clientError(error));
      if (!intentId && store.draft(p.draftId).status === 'APPROVED') store.invalidateApproval(p.draftId);
    } finally {
      await dispose?.();
      this.updated('send_status_updated');
    }
  }
}
