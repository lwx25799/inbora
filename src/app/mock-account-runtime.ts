import { dirname } from 'node:path';
import type { DeepSeekProvider } from '../ai/deepseek.js';
import { Blocked, requireSafe, type Channel } from '../core/contracts.js';
import { SendCoordinator } from '../core/send-coordinator.js';
import type { ReplyKnowledgeStore } from '../knowledge/store.js';
import type { MockPlatformConnector } from '../platform/mock-platform-connector.js';
import { AutomationStore } from '../storage/automation-store.js';
import { isEmergencyStopped } from '../storage/emergency-stop.js';
import { ModelProviderStore } from '../storage/model-provider-store.js';
import { EventStore } from '../storage/store.js';
import { WorkbenchAuthority } from './authority.js';
import type { ClientCommand, SendParams } from './contracts.js';
import { HumanFollowups } from './human-followup.js';
import { InboxSyncRunner } from './inbox-sync-runner.js';
import { ModelProviderController } from './model-provider-controller.js';
import { ModelRouteGuard } from './model-route-guard.js';
import { previewSendCommand, reconcileUncertainCommand, sendResultCommand, type DeliveryContext } from './service-delivery.js';
import { clientError, dismissSuggestion, isReadOnlySidecarCommand, updateModelGrant } from './service-guards.js';
import { handleReplyPipelineCommand, assertPolicyCommandOutboundSafe } from './reply-pipeline-commands.js';
import { handleAiRuntimeCommand, prepareSendMediaAttachment } from './ai-runtime-commands.js';
import type { SuggestionState } from './suggestion-eligibility.js';
import { generateSuggestion } from './suggestion-generation.js';
import { WorkbenchQueries } from './workbench-queries.js';

export interface SharedMockModels {
  models: ModelProviderController | null;
  provider: DeepSeekProvider;
  knowledge: ReplyKnowledgeStore;
  state: SuggestionState;
  signal: AbortSignal;
}

type ParentOperator = ReturnType<WorkbenchAuthority['operator']>;

/** Account-scoped Core for a registered synthetic connector in the shared SQLite database. */
export class MockAccountRuntime {
  private readonly store: EventStore;
  private readonly authority: WorkbenchAuthority;
  private readonly automation: AutomationStore;
  private readonly coordinator: SendCoordinator;
  private readonly queries: WorkbenchQueries;
  private readonly followups: HumanFollowups;
  private readonly sync: InboxSyncRunner;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly modelPending = new Set<string>();
  private modelAbort = new AbortController();
  private modelController?: { primary: ModelProviderController; scoped: ModelProviderController };
  private session?: { parentId: string; token: string; expiresAt: number };
  private closing = false;
  private inboxRevision = 0;
  private readonly runtimeRoot: string;

  constructor(file: string, private readonly browser: MockPlatformConnector, now: () => number,
    private readonly sharedModels: () => SharedMockModels, private readonly emit: (event: string) => void,
    private readonly readAudit: (store: EventStore, page: number) => unknown) {
    this.runtimeRoot = dirname(file);
    const store = this.store = new EventStore(file, false, undefined, browser.accountId);
    try {
      this.authority = new WorkbenchAuthority(store, now);
      this.authority.recover();
      browser.bindStore(store);
      this.automation = new AutomationStore(store, now);
      this.coordinator = new SendCoordinator(store, browser.actor);
      this.queries = new WorkbenchQueries(store, this.authority, browser);
      this.followups = new HumanFollowups(store, this.authority, browser, () => this.closing,
        () => this.updated('send_status_updated'), clientError);
      this.sync = new InboxSyncRunner({
        store, authority: this.authority, browser, getAutomation: () => this.automation, getCollector: () => null,
        isClosing: () => this.closing, emit: event => this.updated(event), track: task => this.track(task), errorCode: clientError,
      });
    } catch (error) {
      store.close();
      throw error;
    }
  }

  isIdle(): boolean { return this.pending.size === 0; }

  async close(): Promise<void> {
    this.closing = true;
    this.sync.stop();
    this.modelAbort.abort(new Blocked('CLIENT_CLOSING'));
    this.modelController?.scoped.close();
    await Promise.allSettled([...this.pending]);
    try {
      this.authority.expireOperators('ALL');
    } finally {
      try { await this.browser.close(); }
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
    return { ...shared.state, recovering: false, modelBusy: this.modelPending.size > 0,
      modelRoute: this.scopedModels(shared.models)?.guard ?? null };
  }

  private abortModel(): void {
    this.modelAbort.abort(new Blocked('MODEL_CANCELLED'));
    this.modelAbort = new AbortController();
  }

  private status(token: string) {
    const state = this.modelState();
    return this.queries.status(token, {
      ...state, modelUnavailable: state.modelUnavailable ?? null,
      keyStored: false, keyStorageError: null, automation: this.automation,
      collector: undefined, inboxRevision: this.inboxRevision, sync: this.sync.snapshot(),
    });
  }

  private async refreshCapability(channel: Channel) {
    const identity = await this.browser.refreshIdentity(channel);
    const { reason } = this.authority.capability(channel, identity);
    if (identity && ['CAPABILITY_UNVERIFIED', 'CAPABILITY_EXPIRED_OR_CHANGED'].includes(reason)) {
      // Synthetic connectors own the entire transport and have a bound readback channel.
      this.authority.attest(channel, 'SEND_AVAILABLE', identity, 'mock-platform');
    }
    return identity;
  }

  private deliveryContext(): DeliveryContext {
    return {
      store: this.store, authority: this.authority, browser: this.browser,
      getAutomation: () => this.automation, getVerification: () => null, isClosing: () => this.closing,
      suspendForVisible: () => { throw new Blocked('MOCK_OPERATION_UNSUPPORTED'); },
      resetOnlineAbort: () => { throw new Blocked('MOCK_OPERATION_UNSUPPORTED'); },
      resumeAfterLogin: () => {}, bumpInboxRevision: () => { this.inboxRevision++; },
      emit: this.emit, errorCode: clientError,
    };
  }

  private async handle(token: string, c: ClientCommand, checkOperator: () => void): Promise<unknown> {
    const { store, authority, browser } = this;
    authority.operator(token);
    switch (c.command) {
      case 'getStatus':
        for (const channel of browser.capabilities.channels) await this.refreshCapability(channel);
        return this.status(token);
      case 'observe':
        await this.sync.observe(token, c.source);
        return this.status(token);
      case 'syncInbox':
        authority.operator(token, 'CONTROL');
        this.sync.start(token);
        return this.status(token);
      case 'getInbox':
        return this.queries.inbox(c);
      case 'getThread':
        return { ...this.queries.thread(token, c.eventId, this.automation, c.timelineBefore, this.modelState()), workUrl: null };
      case 'selectTarget':
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
        updateModelGrant(token, c, { authority, automation: this.automation,
          models: this.scopedModels(this.sharedModels().models), abortModel: () => this.abortModel() });
        this.emit('status_updated');
        return this.status(token);
      case 'setMode':
        requireSafe(c.mode !== 'LIMITED_AUTO', 'ACCOUNT_COMMAND_NOT_SUPPORTED');
        authority.setMode(token, c.mode);
        this.emit('status_updated');
        return this.status(token);
      case 'previewSend':
        authority.operator(token, 'SEND');
        await this.refreshCapability(store.event(c.params.eventId).payload.channel);
        return previewSendCommand(this.deliveryContext(), token, c.params);
      case 'submitManualSend': {
        const identity = await browser.refreshIdentity(store.event(c.params.eventId).payload.channel);
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
      case 'replyPipeline':
        return handleReplyPipelineCommand({
          store, authority, automation: this.automation,
          knowledgeContext: (event, queryText) => {
            const shared = this.sharedModels();
            return shared.knowledge.available() ? shared.knowledge.context(event.accountId, event.channel, queryText) : null;
          },
          onConfigSaved: () => this.emit('status_updated'),
        }, token, c);
      case 'accountAiFeatures':
      case 'mediaAssets':
      case 'businessTools':
        return handleAiRuntimeCommand({
          store, authority, root: this.runtimeRoot, now: authority.now,
          onUpdated: () => this.emit('status_updated'),
        }, token, c);
      default:
        throw new Blocked('ACCOUNT_COMMAND_NOT_SUPPORTED');
    }
  }

  private async deliver(token: string, id: string, p: SendParams, checkOperator: () => void): Promise<void> {
    const { store, authority, browser } = this;
    const { payload } = store.event(p.eventId);
    const epoch = browser.ownerEpoch;
    let dispose: (() => void | Promise<void>) | undefined;
    try {
      const media = prepareSendMediaAttachment(store, this.runtimeRoot, p);
      const handle = await browser.adapter(payload, store);
      dispose = handle.dispose;
      const guard = authority.dispatchGuard(token, id, () => browser.identity(payload.channel));
      const active = () => {
        checkOperator();
        requireSafe(!this.closing, 'CLIENT_CLOSING');
        requireSafe(browser.ownerEpoch === epoch, 'BROWSER_CLOSED');
      };
      const outcome = await this.coordinator.send(p.draftId, handle.adapter, true, {
        ...guard, check: () => { active(); assertPolicyCommandOutboundSafe(store, id, store.event(p.eventId), p.text, authority.now); guard.check(); },
        beforeSubmit: intentId => { active(); guard.beforeSubmit(intentId); },
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
