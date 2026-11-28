import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { resolveWebProfileDir } from '../storage/account-store.js';
import { readAccountHolds } from './isolated-douyin-connector.js';
import { hasCalibratedWebReplyMapping } from '../config/web-platform-mapping.js';
import {
  XIAOHONGSHU_PLATFORM_ID,
  type AccountSummary,
  type WebBrowserPlatformId,
} from '../contracts/account.js';
import { Blocked, requireSafe, type Channel } from '../core/contracts.js';
import { SendCoordinator } from '../core/send-coordinator.js';
import { BilibiliPlatformConnector } from '../platform/bilibili/connector.js';
import type { PlatformConnector } from '../platform/platform-connector.js';
import { XiaohongshuPlatformConnector } from '../platform/xiaohongshu/connector.js';
import { AutomationStore } from '../storage/automation-store.js';
import { isEmergencyStopped } from '../storage/emergency-stop.js';
import { ModelProviderStore } from '../storage/model-provider-store.js';
import { EventStore } from '../storage/store.js';
import type { WorkerMode } from '../workers/worker-protocol.js';
import { handleAiRuntimeCommand, prepareSendMediaAttachment } from './ai-runtime-commands.js';
import { WorkbenchAuthority } from './authority.js';
import type { ClientCommand, SendParams } from './contracts.js';
import { HumanFollowups } from './human-followup.js';
import { HumanReplyWorkflow } from './human-reply-workflow.js';
import { markInboxRead } from './inbox-read-state.js';
import { InboxSyncRunner } from './inbox-sync-runner.js';
import type { SharedMockModels } from './mock-account-runtime.js';
import { ModelProviderController } from './model-provider-controller.js';
import { ModelRouteGuard } from './model-route-guard.js';
import type { ParentOperator } from './official-account-runtime.js';
import { assertPolicyCommandOutboundSafe, handleReplyPipelineCommand } from './reply-pipeline-commands.js';
import {
  previewSendCommand,
  reconcileUncertainCommand,
  sendResultCommand,
  type DeliveryContext,
} from './service-delivery.js';
import {
  clientError,
  closeOtherDialogs,
  dismissSuggestion,
  isReadOnlySidecarCommand,
  readAccountAvatarPreview,
  readAnalyticsSummary,
  updateModelGrant,
} from './service-guards.js';
import type { SuggestionState } from './suggestion-eligibility.js';
import { generateSuggestion } from './suggestion-generation.js';
import { WorkbenchQueries } from './workbench-queries.js';

export interface WebAccountRuntimeOptions {
  readonly file: string;
  readonly account: AccountSummary;
  readonly now: () => number;
  readonly sharedModels: () => SharedMockModels;
  readonly emit: (event: string) => void;
  readonly readAudit: (store: EventStore, page: number) => unknown;
  readonly workerMode?: WorkerMode | undefined;
  readonly allowFixture?: boolean | undefined;
  readonly entryScript?: string | undefined;
}

function accountStartBoundaryMs(account: AccountSummary, fallbackNow: () => number): number {
  const created = Date.parse(account.createdAt);
  if (Number.isSafeInteger(created) && created > 0) return created;
  return Math.max(1, Math.trunc(fallbackNow()));
}

function assertNoCaseInsensitiveDirCollision(parentDir: string, name: string): void {
  if (!existsSync(parentDir)) return;
  const lower = name.toLowerCase();
  const collision = readdirSync(parentDir).some(entry => entry.toLowerCase() === lower && entry !== name);
  requireSafe(!collision, 'ACCOUNT_PROFILE_CONFLICT');
}

/** Account-scoped Core runtime for isolated web browser connectors (小红书 / B 站). */
export class WebAccountRuntime {
  readonly connector: PlatformConnector;
  readonly profileDir: string;
  readonly accountRoot: string;
  readonly platformId: WebBrowserPlatformId;
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
  private stopAbort = new AbortController();
  private modelController?: { primary: ModelProviderController; scoped: ModelProviderController };
  private session?: { parentId: string; token: string; expiresAt: number };
  private closing = false;
  private inboxRevision = 0;
  private readonly runtimeRoot: string;
  private readonly allowFixture: boolean;

  constructor(options: WebAccountRuntimeOptions) {
    this.runtimeRoot = dirname(options.file);
    const resolvedProfile = resolveWebProfileDir(this.runtimeRoot, options.account.id, options.account.profileRef);
    assertNoCaseInsensitiveDirCollision(join(this.runtimeRoot, 'accounts'), options.account.id);
    assertNoCaseInsensitiveDirCollision(dirname(resolvedProfile), basename(resolvedProfile));
    this.accountRoot = join(this.runtimeRoot, 'accounts', options.account.id);
    this.profileDir = resolvedProfile;
    this.platformId = options.account.platform as WebBrowserPlatformId;
    this.allowFixture = options.allowFixture ?? false;
    const store = this.store = new EventStore(options.file, false, undefined, options.account.id);
    try {
      this.authority = new WorkbenchAuthority(store, options.now, options.account.id);
      this.authority.recover();
      const connectorOptions = {
        accountId: options.account.id,
        root: this.accountRoot,
        profileDir: this.profileDir,
        store,
        mode: options.workerMode ?? 'browser',
        allowFixture: this.allowFixture,
        firstRunAt: accountStartBoundaryMs(options.account, options.now),
        ...(options.entryScript ? { entryScript: options.entryScript } : {}),
      };
      this.connector = this.platformId === XIAOHONGSHU_PLATFORM_ID
        ? new XiaohongshuPlatformConnector(connectorOptions)
        : new BilibiliPlatformConnector(connectorOptions);
      this.connector.bindStore(store);
      this.automation = new AutomationStore(store, options.now);
      this.coordinator = new SendCoordinator(store, this.connector.actor);
      this.queries = new WorkbenchQueries(store, this.authority, this.connector);
      this.followups = new HumanFollowups(
        store,
        this.authority,
        this.connector,
        () => this.closing,
        () => this.updated('send_status_updated'),
        clientError,
      );
      this.followups.recover();
      this.humanReplies = new HumanReplyWorkflow(
        store,
        this.authority,
        this.connector,
        () => this.closing,
        (token, id, params) => this.deliver(token, id, params),
        event => this.updated(event),
        clientError,
      );
      this.sync = new InboxSyncRunner({
        store,
        authority: this.authority,
        browser: this.connector,
        getAutomation: () => this.automation,
        getCollector: () => null,
        isClosing: () => this.closing,
        emit: event => this.updated(event),
        track: task => this.track(task),
        errorCode: clientError,
      });
    } catch (error) {
      store.close();
      throw error;
    }
    this.sharedModels = options.sharedModels;
    this.emit = options.emit;
    this.readAudit = options.readAudit;
  }

  private readonly sharedModels: () => SharedMockModels;
  private readonly emit: (event: string) => void;
  private readonly readAudit: (store: EventStore, page: number) => unknown;

  isIdle(): boolean {
    return this.pending.size === 0 && this.connector.isIdle();
  }

  async isCalibrated(): Promise<boolean> {
    return hasCalibratedWebReplyMapping(
      this.accountRoot,
      this.platformId,
      { allowFixture: this.allowFixture },
    );
  }

  abortInFlight(reason = 'EMERGENCY_STOPPED'): void {
    if ('abortInFlight' in this.connector && typeof this.connector.abortInFlight === 'function') {
      this.connector.abortInFlight();
    }
    if (!this.stopAbort.signal.aborted) {
      this.stopAbort.abort(new Blocked(reason));
    }
    this.sync.stop();
    this.modelAbort.abort(new Blocked(reason));
  }

  recheckInFlight(): void {
    if ('recheckInFlight' in this.connector && typeof this.connector.recheckInFlight === 'function') {
      this.connector.recheckInFlight();
    }
  }

  onGlobalEmergencyResumed(): void {
    if (this.closing || isEmergencyStopped(this.store)) return;
    if (this.stopAbort.signal.aborted) this.stopAbort = new AbortController();
    if (this.modelAbort.signal.aborted) this.modelAbort = new AbortController();
  }

  async close(): Promise<void> {
    this.closing = true;
    this.abortInFlight('CLIENT_CLOSING');
    this.dialogs.clear();
    this.modelController?.scoped.close();
    await Promise.allSettled([...this.pending]);
    this.authority.expireOperators('ALL');
    await this.connector.close();
    this.store.close();
  }

  dispatch(
    parent: ParentOperator,
    command: ClientCommand,
    checkOperator: () => void,
    onGlobalRecover?: () => Promise<void>,
    checkControl?: () => void,
  ): Promise<unknown> {
    requireSafe(!this.closing, 'CLIENT_CLOSING');
    if (command.command === 'getAnalytics' || command.command === 'getAvatarPreview') {
      requireSafe(parent.expires_at > this.authority.now(), 'OPERATOR_EXPIRED');
      requireSafe(parent.permissions.includes('READ'), 'OPERATOR_PERMISSION_DENIED');
      checkOperator();
      return Promise.resolve(
        command.command === 'getAnalytics'
          ? readAnalyticsSummary(this.store, command.range, this.authority.now)
          : readAccountAvatarPreview(this.store, command.role, command.key),
      );
    }
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
    return this.track(this.handle(token, command, checkOperator, onGlobalRecover, checkControl));
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

  private updated(event: string): void {
    this.inboxRevision++;
    this.recheckInFlight();
    this.emit(event);
  }

  private scopedModels(primary: ModelProviderController | null) {
    if (this.modelController?.primary !== primary) {
      this.modelController?.scoped.close();
      const scoped = primary ? new ModelProviderController(
        new ModelRouteGuard(new ModelProviderStore(this.store.db, this.authority.now), this.automation),
        primary.credentials,
        primary.transport,
        () => this.emit('status_updated'),
      ) : null;
      if (primary && scoped) this.modelController = { primary, scoped };
      else delete this.modelController;
      this.authority.modelRoute = scoped?.guard ?? null;
    }
    return this.modelController?.scoped ?? null;
  }

  private modelState(shared = this.sharedModels()): SuggestionState {
    return {
      ...shared.state,
      recovering: false,
      modelBusy: this.modelPending.size > 0,
      modelRoute: this.scopedModels(shared.models)?.guard ?? null,
    };
  }

  private abortModel(): void {
    this.modelAbort.abort(new Blocked('MODEL_CANCELLED'));
    this.modelAbort = new AbortController();
  }

  private async status(token: string) {
    const state = this.modelState();
    return {
      ...this.queries.status(token, {
        ...state,
        modelUnavailable: state.modelUnavailable ?? null,
        keyStored: false,
        keyStorageError: null,
        automation: this.automation,
        collector: undefined,
        inboxRevision: this.inboxRevision,
        sync: this.sync.snapshot(),
      }),
      schema: 4,
      calibrated: await this.isCalibrated(),
      manualRecovery: this.connector.manualRecoveryStatus(),
      securityHolds: readAccountHolds(this.store),
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
      store: this.store,
      authority: this.authority,
      browser: this.connector,
      getAutomation: () => this.automation,
      getVerification: () => null,
      isClosing: () => this.closing,
      suspendForVisible: () => { throw new Blocked('WORKER_MANUAL_RECOVERY_UNAVAILABLE'); },
      resetOnlineAbort: () => {
        if (this.stopAbort.signal.aborted) this.stopAbort = new AbortController();
        return this.stopAbort.signal;
      },
      resumeAfterLogin: () => {},
      bumpInboxRevision: () => { this.inboxRevision++; },
      emit: this.emit,
      errorCode: clientError,
    };
  }

  private async handle(
    token: string,
    c: ClientCommand,
    checkOperator: () => void,
    onGlobalRecover?: () => Promise<void>,
    checkControl?: () => void,
  ): Promise<unknown> {
    const { store, authority, connector } = this;
    authority.operator(token);
    switch (c.command) {
      case 'getStatus':
        if (connector.resourceIdentity().open) {
          for (const channel of connector.capabilities.channels) await this.refreshCapability(channel);
        }
        return this.status(token);
      case 'browser': {
        authority.requireGuiControl(token);
        requireSafe(!('action' in c), 'WORKER_MANUAL_RECOVERY_UNAVAILABLE');
        if (c.open) {
          requireSafe(c.mode !== 'headed' && !c.loginRecovery, 'WORKER_MANUAL_RECOVERY_UNAVAILABLE');
          await connector.open('headless', this.stopAbort.signal);
          for (const channel of connector.capabilities.channels) await this.refreshCapability(channel);
        } else {
          await connector.close();
        }
        this.emit('status_updated');
        return this.status(token);
      }
      case 'securityRecovery': {
        const check = () => {
          authority.requireGuiControl(token, 'CONTROL', 'ASSISTANT_CANNOT_CONTROL_VERIFICATION');
          requireSafe(!this.closing, 'CLIENT_CLOSING');
        };
        check();
        const result = await connector.securityRecovery(c, token, check);
        this.emit('status_updated');
        return c.action === 'close' || c.action === 'finish' ? this.status(token) : result;
      }
      case 'observe':
        requireSafe(!isEmergencyStopped(store), 'EMERGENCY_STOPPED');
        await this.sync.observe(token, c.source, this.stopAbort.signal);
        return this.status(token);
      case 'syncInbox':
        requireSafe(!isEmergencyStopped(store), 'EMERGENCY_STOPPED');
        authority.operator(token, 'CONTROL');
        await connector.open('headless', this.stopAbort.signal);
        for (const channel of connector.capabilities.channels) await this.refreshCapability(channel);
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
        closeOtherDialogs(this.dialogs, authority, token, c.eventId);
        const event = store.event(c.eventId);
        if (
          c.editing !== false
          && (!store.db.prepare('SELECT id FROM send_intents WHERE event_id=?').get(c.eventId)
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
        await connector.open('headless', this.stopAbort.signal);
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
        await connector.open('headless', this.stopAbort.signal);
        await this.refreshCapability(store.event(c.input.eventId).payload.channel);
        checkOperator();
        const fresh = this.followups.queue(token, c.commandId, c.input);
        if (fresh) this.track(this.enqueueHuman(() => this.followups.prepare(token, c.commandId)));
        return this.followups.result(token, c.commandId);
      }
      case 'selectTarget':
        closeOtherDialogs(this.dialogs, authority, token, c.eventId);
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
          store,
          authority,
          automation: this.automation,
          models,
          provider: shared.provider,
          pending: this.modelPending,
          state: () => { checkOperator(); return this.modelState(); },
          signal: () => AbortSignal.any([shared.signal, shared.models?.signal ?? shared.signal, this.modelAbort.signal]),
          knowledgeContext: event => shared.knowledge.available()
            ? shared.knowledge.context(event.accountId, event.channel, event.text)
            : null,
          emit: this.emit,
          cancelMaintenance: () => {},
        }, token, c);
      }
      case 'dismissSuggestion': {
        const result = dismissSuggestion(store, authority, token, c.suggestionId);
        this.emit('suggestion_updated');
        return result;
      }
      case 'setModelGrant':
        updateModelGrant(token, c, {
          authority,
          automation: this.automation,
          models: this.scopedModels(this.sharedModels().models),
          abortModel: () => this.abortModel(),
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
        await connector.open('headless', this.stopAbort.signal);
        await this.refreshCapability(store.event(c.params.eventId).payload.channel);
        return previewSendCommand(this.deliveryContext(), token, c.params);
      case 'submitManualSend': {
        requireSafe(!isEmergencyStopped(store), 'EMERGENCY_STOPPED');
        await connector.open('headless', this.stopAbort.signal);
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
        if (c.command === 'resume') {
          if (c.eventId === null) {
            authority.operator(token, 'CONTROL');
            checkControl?.();
            if (isEmergencyStopped(store)) {
              requireSafe(onGlobalRecover, 'EMERGENCY_STOPPED');
              await onGlobalRecover();
            }
            requireSafe(!isEmergencyStopped(store), 'EMERGENCY_STOPPED');
            const signal = this.stopAbort.signal.aborted ? new AbortController().signal : this.stopAbort.signal;
            await connector.recoverSecurityHolds(true, signal, () => {
              requireSafe(!this.closing, 'CLIENT_CLOSING');
              checkControl?.();
              authority.operator(token, 'CONTROL');
            });
            checkControl?.();
          } else {
            requireSafe(!isEmergencyStopped(store), 'EMERGENCY_STOPPED');
          }
        }
        authority.pause(token, c.eventId, c.command === 'pause');
        if (c.command === 'resume' && c.eventId === null) {
          this.onGlobalEmergencyResumed();
        }
        if (c.command === 'pause' && c.eventId === null) this.abortModel();
        this.emit('takeover_updated');
        this.emit('send_status_updated');
        return this.status(token);
      case 'getAudit':
        return this.readAudit(store, c.page);
      case 'getAnalytics':
        return readAnalyticsSummary(store, c.range, authority.now);
      case 'getAvatarPreview':
        return readAccountAvatarPreview(store, c.role, c.key);
      case 'reconcileUncertain':
        store.event(c.eventId);
        return reconcileUncertainCommand(this.deliveryContext(), token, c.eventId);
      case 'replyPipeline':
        return handleReplyPipelineCommand({
          store,
          authority,
          automation: this.automation,
          knowledgeContext: (event, queryText) => {
            const shared = this.sharedModels();
            return shared.knowledge.available()
              ? shared.knowledge.context(event.accountId, event.channel, queryText)
              : null;
          },
          onConfigSaved: () => this.emit('status_updated'),
        }, token, c);
      case 'accountAiFeatures':
      case 'mediaAssets':
      case 'businessTools':
        return handleAiRuntimeCommand({
          store,
          authority,
          root: this.runtimeRoot,
          now: authority.now,
          onUpdated: () => this.emit('status_updated'),
        }, token, c);
      default:
        throw new Blocked('ACCOUNT_COMMAND_NOT_SUPPORTED');
    }
  }

  private async deliver(token: string, id: string, p: SendParams, checkOperator?: () => void): Promise<void> {
    const { store, authority, connector } = this;
    const { payload } = store.event(p.eventId);
    let dispose: (() => void | Promise<void>) | undefined;
    try {
      const media = prepareSendMediaAttachment(store, this.runtimeRoot, p);
      const handle = await connector.adapter(payload, store, this.stopAbort.signal);
      dispose = handle.dispose;
      const epoch = connector.ownerEpoch;
      const guard = authority.dispatchGuard(token, id, () => connector.identity(payload.channel));
      const active = () => {
        checkOperator?.();
        requireSafe(!this.closing, 'CLIENT_CLOSING');
        requireSafe(!isEmergencyStopped(store), 'EMERGENCY_STOPPED');
        requireSafe(connector.ownerEpoch === epoch, 'BROWSER_CLOSED');
      };
      const outcome = await this.coordinator.send(p.draftId, handle.adapter, true, {
        ...guard,
        check: () => {
          active();
          assertPolicyCommandOutboundSafe(store, id, store.event(p.eventId), p.text, authority.now);
          guard.check();
        },
        beforeSubmit: intentId => {
          active();
          guard.beforeSubmit(intentId);
        },
      }, media);
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
