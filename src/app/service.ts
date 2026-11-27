import { EventEmitter } from "node:events";
import { ReplyKnowledgeService } from "../knowledge/service.js";
import { Blocked, requireSafe } from "../core/contracts.js";
import type { EventStore } from "../storage/store.js";
import { commandSchema, defaultSettings, type AiSettings, type SendParams } from "./contracts.js";
import { HumanReplyWorkflow } from "./human-reply-workflow.js";
import { HumanFollowups } from "./human-followup.js";
import { WorkbenchQueries } from "./workbench-queries.js";
import { readOrRefreshPreview } from "./media-preview-request.js";
import { WorkbenchAuthority } from "./authority.js";
import type { BrowserService } from "./browser-service.js";
import { DouyinPlatformConnector } from "../platform/douyin-platform-connector.js";
import type { PlatformConnector } from "../platform/platform-connector.js";
import { DeepSeekProvider } from "../ai/deepseek.js";
import type { AutomationStore } from "../storage/automation-store.js";
import type { CollectionScheduler } from "./collection-scheduler.js";
import type { VerificationScheduler } from "./verification-scheduler.js";
import type { ModelProviderController } from "./model-provider-controller.js";
import { handleModelProviderCommand } from "./model-provider-commands.js";
import { runServiceAutomaticReply } from "./automatic-reply.js";
import type { ReplyPipelineConfig } from "./reply-pipeline/types.js";
import { readDiagnostics } from "./diagnostics.js";
import { handleReplyPipelineCommand } from "./reply-pipeline-commands.js";
import { EvidenceMaintenance } from "./evidence-maintenance.js";
import { runtimePerformance } from "../observability/runtime-performance.js";
import { BrowserResources } from "../observability/browser-resources.js";
import { generateSuggestion } from "./suggestion-generation.js";
import { configureAssistantConnection } from "./local-assistant-connection.js";
import { readSecurityHold } from "../storage/security-holds.js";
import { securityRuntime } from "./security-runtime.js";
import {
  clientError, closeOtherDialogs, dismissSuggestion,
  handleConfigWriteCommand,
  handleLifecycleControlCommand,
  knowledgeMutatingActions,
  markInboxReadCommand,
  type ConfigWriteCommand,
  type LifecycleControlCommand,
} from "./service-guards.js";
import { InboxSyncRunner } from "./inbox-sync-runner.js";
import { OnlineKeeper } from "./online-keeper.js";
import {
  deliverCommand,
  openTargetCommand,
  previewSendCommand,
  reconcileUncertainCommand,
  sendResultCommand,
  type DeliveryContext,
} from "./service-delivery.js";
import { bootstrapAutomationRuntime, bootstrapModelProviders, loadClientSettings } from "./service-bootstrap.js";
import { AccountController, auditPage, isAccountWrite } from "./account-controller.js";
import { handleAiRuntimeCommand } from "./ai-runtime-commands.js";
import { CredentialStore } from "./credentials.js";
import type { AccountsCommand } from "../contracts/account.js";

export { clientError } from "./service-guards.js";

/** Transport-neutral application service. Short controls never wait behind browser/model operations. */
export class ClientService {
  readonly browser: PlatformConnector;
  readonly accountId: PlatformConnector["accountId"];
  private readonly knowledge: ReplyKnowledgeService;
  private readonly followups: HumanFollowups;
  private readonly queries: WorkbenchQueries;
  private readonly syncRunner: InboxSyncRunner;
  private readonly onlineKeeper: OnlineKeeper;
  readonly events = new EventEmitter();
  readonly authority: WorkbenchAuthority;
  readonly accounts: AccountController;
  private readonly humanReplies: HumanReplyWorkflow;
  private settings: AiSettings = { ...defaultSettings };
  private models: ModelProviderController | null = null;
  private modelUnavailable: string | null = "MODEL_PROVIDERS_NOT_INITIALIZED";
  private modelAbort = new AbortController();
  private automaticAbort = new AbortController();
  private modelPending = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  private closing = false;
  private automation: AutomationStore | null = null;
  private collector: CollectionScheduler | null = null;
  private inboxRevision = 0;
  private readonly startedAt: number;
  private dialogs = new Map<string, { token: string; generation: number }>();
  private leaseTimer: ReturnType<typeof setInterval> | undefined;
  private verification: VerificationScheduler | null = null;
  private autoTimer: ReturnType<typeof setInterval> | undefined;
  private autoTask: Promise<void> | null = null;
  private humanQueue: Promise<void> = Promise.resolve();
  private readonly maintenance: EvidenceMaintenance;
  private readonly browserResources: BrowserResources;
  private assistantConnection = {
    ready: false,
    instanceId: null as string | null,
    transport: "stdio" as const,
    tools: 16 as const,
  };
  constructor(
    readonly store: EventStore,
    connection: BrowserService | PlatformConnector,
    private readonly provider = new DeepSeekProvider(),
    now: () => number = Date.now,
    startedAt = now(),
    private pipelineConfig?: ReplyPipelineConfig,
  ) {
    const browser = this.browser = "platformId" in connection ? connection : new DouyinPlatformConnector(connection);
    this.accountId = browser.accountId;
    store.assertAccount(this.accountId);
    this.startedAt = startedAt;
    browser.bindStore(store);
    browser.onManualRecoveryClosed = () => {
      this.resumeAfterLogin();
      this.emit("status_updated");
    };
    this.maintenance = new EvidenceMaintenance(store, browser.root);
    this.browserResources = new BrowserResources({
      root: browser.root,
      identity: () => browser.resourceIdentity(),
      onUpdated: () => {
        if (!this.closing) this.emit("diagnostics_updated");
      },
    });
    this.authority = new WorkbenchAuthority(store, now, this.accountId);
    this.accounts = new AccountController(store, browser, now, this.authority, () => ({
      models: this.models, provider: this.provider, knowledge: this.knowledge.data,
      state: this.suggestionState(), signal: this.modelAbort.signal,
    }));
    this.authority.recover();
    this.knowledge = new ReplyKnowledgeService(store, this.authority, browser.root, () => ({
      settings: this.projectedSettings(),
      models: this.models,
      modelUnavailable: this.modelUnavailable,
      automation: this.automation,
      signal: this.modelAbort.signal,
      closing: this.closing,
    }));
    this.followups = new HumanFollowups(
      store,
      this.authority,
      browser,
      () => this.closing,
      () => this.emit("send_status_updated"),
      clientError,
    );
    this.humanReplies = new HumanReplyWorkflow(
      store,
      this.authority,
      browser,
      () => this.closing,
      (token, id, params) => this.deliver(token, id, params),
      (event) => this.emit(event),
      clientError,
    );
    this.queries = new WorkbenchQueries(store, this.authority, browser);
    this.syncRunner = new InboxSyncRunner({
      store,
      authority: this.authority,
      browser,
      getAutomation: () => this.automation,
      getCollector: () => this.collector,
      isClosing: () => this.closing,
      emit: (event) => this.emit(event),
      track: (task) => this.track(task),
      errorCode: clientError,
    });
    this.onlineKeeper = new OnlineKeeper({
      store,
      authority: this.authority,
      browser,
      getAutomation: () => this.automation,
      isClosing: () => this.closing,
      onStopForGlobalFailure: (code) => {
        this.accounts.abortWorkerSends();
        this.automation!.stop(true, code, "CONNECTION");
        this.collector?.cancel();
        this.stopAutomaticReply("EMERGENCY_STOPPED");
        this.abortModel();
      },
      onResumeAfterLogin: () => this.resumeAfterLogin(),
      onOwnerReady: () => this.browserResources.ownerReady(),
      emit: (event) => this.emit(event),
      track: (task) => this.track(task),
      errorCode: clientError,
    });
  }
  async loadSettings(): Promise<void> {
    if (!this.automation) {
      const runtime = await bootstrapAutomationRuntime({
        store: this.store,
        authority: this.authority,
        browser: this.browser,
        knowledge: this.knowledge,
        followups: this.followups,
        startedAt: this.startedAt,
        isSyncBusy: () => this.syncRunner.busy,
        cancelMaintenance: () => this.maintenance.cancel(),
        onInboxUpdated: () => {
          this.inboxRevision++;
          this.emit("inbox_updated");
        },
        onSendStatusUpdated: () => {
          this.inboxRevision++;
          this.emit("send_status_updated");
        },
      });
      this.automation = runtime.automation;
      const models = await bootstrapModelProviders(runtime.automation, this.browser.root, this.provider.transport,
        () => this.emit("status_updated"));
      this.accounts.initialize();
      this.models = models.controller;
      this.modelUnavailable = models.reason;
      this.authority.modelRoute = this.models?.guard ?? null;
      this.collector = runtime.collector;
      this.verification = runtime.verification;
      this.onlineKeeper.setRecoveryDiagnosticPending(runtime.hasStartupRecoveryCandidate);
    }
    try {
      const loaded = await loadClientSettings(this.browser.root);
      if (loaded) this.settings = loaded;
    } catch {
      this.disableModels("INVALID_LEGACY_MODEL_SETTINGS");
    }
    this.collector?.start();
    this.verification?.start();
    if (!this.autoTimer) {
      this.autoTimer = setInterval(() => this.automaticTick(), 1000);
      this.autoTimer.unref();
    }
    if (!this.leaseTimer) {
      this.leaseTimer = setInterval(() => {
        for (const [id, dialog] of this.dialogs) {
          try {
            this.authority.renew(dialog.token, id, dialog.generation);
          } catch {
            this.dialogs.delete(id);
          }
        }
      }, 30_000);
      this.leaseTimer.unref();
    }
  }
  private abortModel(): void {
    this.modelAbort.abort(new Blocked("MODEL_CANCELLED"));
    this.modelAbort = new AbortController();
  }
  private disableModels(reason: string): void {
    this.models?.close();
    this.models = null;
    this.authority.modelRoute = null;
    this.modelUnavailable = reason;
  }
  private projectedSettings(selection = this.models?.models.getSelection()): AiSettings {
    return { ...this.settings, model: selection?.modelId ?? defaultSettings.model };
  }
  private selectedModelState() {
    const modelProviders = this.models?.state();
    const applied = modelProviders?.connections.find(c => c.id === modelProviders.selection.connectionId)?.applied;
    return { modelProviders, applied };
  }
  startOnline(): void {
    this.browserResources.start();
    this.onlineKeeper.start();
  }
  setAssistantConnection(instanceId: string | null): void {
    this.browser.setRuntimeInstance(instanceId);
    this.assistantConnection = { ready: instanceId !== null, instanceId, transport: "stdio", tools: 16 };
    this.emit("status_updated");
  }
  async assistantConnected(): Promise<void> {
    const check = () => requireSafe(!this.closing, "CLIENT_CLOSING");
    check();
    if (await configureAssistantConnection(this.authority.assistant, this.browser.root, "IF_NEW", check)) {
      this.emit("status_updated");
    }
  }
  private maintainEvidence(): void {
    if (!this.closing) {
      try {
        this.knowledge.collectIfDue();
      } catch {
        this.store.audit("KNOWLEDGE_COLLECTION_DEFERRED", this.accountId);
      }
    }
    const idle =
      !this.closing &&
      !this.autoTask &&
      !this.onlineKeeper.busy &&
      !this.syncRunner.busy &&
      !this.modelPending.size &&
      !this.pending.size &&
      !this.collector?.status().running &&
      this.browser.isIdle();
    void this.maintenance
      .runIfDue(idle)
      .then((report) => {
        if (report) this.emit("diagnostics_updated");
      })
      .catch(() => this.emit("diagnostics_updated"));
  }
  private automaticTick(): void {
    this.onlineKeeper.keepOnline();
    if (this.autoTask) {
      this.maintenance.cancel();
      return;
    }
    const task = this.runAutomaticReply()
      .catch(() => {})
      .finally(() => {
        this.autoTask = null;
      });
    this.autoTask = task;
    this.track(task);
    void task.then(() => this.maintainEvidence());
  }
  private resumeAfterLogin(): void {
    if (this.browser.loginRecovery || this.closing) return;
    this.collector?.suspend(false);
    this.verification?.suspend(false);
    this.modelAbort = new AbortController();
    this.automaticAbort = new AbortController();
    this.onlineKeeper.resetRetry();
  }
  private stopAutomaticReply(reason = "AUTO_REPLY_DISABLED"): void {
    this.automaticAbort.abort(new Blocked("MODEL_CANCELLED"));
    if (this.automation) {
      this.store.db
        .prepare(
          `UPDATE manual_send_commands SET status='FAILED_BEFORE_CLICK',reason=?
           WHERE command_id IN (SELECT command_id FROM policy_commands) AND intent_id IS NULL
           AND status IN ('PREPARING','QUEUED','PREFLIGHT','PREVIEW')
           AND NOT EXISTS (SELECT 1 FROM send_intents i WHERE i.event_id=manual_send_commands.event_id)`,
        )
        .run(reason);
    }
  }
  private suspendForVisible(stopUnsubmitted = true): void {
    this.syncRunner.stop();
    this.collector?.suspend(true);
    this.verification?.suspend(true, stopUnsubmitted);
    this.onlineKeeper.abort();
    this.modelAbort.abort();
    if (stopUnsubmitted) this.stopAutomaticReply();
    else this.automaticAbort.abort();
  }
  private emit(event: string): void {
    this.accounts.recheckWorkerSend();
    this.events.emit("update", { event });
  }
  private track(task: Promise<unknown>): void {
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
  }
  private thread(token: string, eventId: string) {
    return this.queries.thread(
      token,
      eventId,
      this.automation,
      undefined,
      this.suggestionState(),
      this.verification?.activeEventId(),
    );
  }
  private suggestionState() {
    const { modelProviders, applied } = this.selectedModelState();
    return {
      settings: this.projectedSettings(modelProviders?.selection),
      keyPresent: !!applied?.keyPresent,
      modelAuthorized: false,
      modelRoute: this.models?.guard ?? null,
      modelUnavailable: this.modelUnavailable,
      modelBusy: this.modelPending.size > 0,
      recovering: this.browser.loginRecovery,
    };
  }
  private status(token: string) {
    const { modelProviders, applied } = this.selectedModelState();
    const grantStatus = this.models?.guard.statusProjection();
    return {
      modelProviders,
      modelProvidersSupported: true as const,
      modelProvidersAvailable: !!modelProviders,
      modelProvidersError: this.modelUnavailable,
      modelProvidersUnavailableReason: this.modelUnavailable,
      modelGrantError: grantStatus?.corrupt.length ? "GRANT_CORRUPT" as const : null,
      corruptModelGrantKinds: grantStatus?.corrupt ?? [],
      ...this.queries.status(token, {
        settings: this.projectedSettings(modelProviders?.selection),
        keyPresent: !!applied?.keyPresent,
        keyStored: !!applied?.keyStored,
        keyStorageError: this.models?.cleanupError ?? (
          this.models?.credentials.cacheInvalidationUnconfirmed || CredentialStore.cacheInvalidationUnconfirmed(this.browser.root)
            ? "MODEL_CREDENTIAL_CLEANUP_FAILED" :
          applied?.unavailableReason === "DPAPI_RESTORE_FAILED" || applied?.unavailableReason === "LEGACY_MODEL_KEY_RECONFIGURE_REQUIRED"
            ? applied.unavailableReason : null
        ),
        modelAuthorized: false,
        modelRoute: grantStatus?.route ?? null,
        modelUnavailable: this.modelUnavailable,
        modelBusy: this.modelPending.size > 0,
        automation: this.automation,
        collector: this.collector?.status(),
        inboxRevision: this.inboxRevision,
        sync: this.syncRunner.snapshot(),
      }),
      schema: this.accounts.schemaVersion,
      manualRecovery: this.browser.manualRecoveryStatus(),
      localAssistant: this.authority.assistant.state(),
      localAssistantConnection: { ...this.assistantConnection },
      securityRuntime: securityRuntime(this.assistantConnection.instanceId),
      securityHolds: (["COMMENT_NOTIFICATION", "DIRECT_MESSAGE"] as const).flatMap((channel) => {
        const hold = readSecurityHold(this.store, channel);
        return hold ? [hold] : [];
      }),
    };
  }
  private deliveryContext(): DeliveryContext {
    return {
      store: this.store,
      authority: this.authority,
      browser: this.browser,
      getAutomation: () => this.automation,
      getVerification: () => this.verification,
      isClosing: () => this.closing,
      suspendForVisible: (stopUnsubmitted) => this.suspendForVisible(stopUnsubmitted),
      resetOnlineAbort: () => this.onlineKeeper.resetAbort(),
      resumeAfterLogin: () => this.resumeAfterLogin(),
      bumpInboxRevision: () => {
        this.inboxRevision++;
      },
      emit: (event) => this.emit(event),
      errorCode: clientError,
    };
  }
  private configContext() {
    return {
      store: this.store,
      authority: this.authority,
      automation: this.automation,
      root: this.browser.root,
      isClosing: () => this.closing,
      getSettings: () => this.projectedSettings(),
      setSettings: (settings: AiSettings) => {
        this.settings = settings;
      },
      models: this.models,
      abortModel: () => this.abortModel(),
      stopAutomaticReply: (reason?: string) => this.stopAutomaticReply(reason),
      resetAutomaticAbort: (force = false) => {
        if (force || this.automaticAbort.signal.aborted) this.automaticAbort = new AbortController();
      },
      cancelCollector: () => {
        this.collector?.cancel();
      },
      emit: (event: string) => this.emit(event),
      status: (token: string) => this.status(token),
    };
  }
  private handleAccounts(token: string, command: AccountsCommand): Promise<unknown> {
    if (isAccountWrite(command)) this.authority.requireGuiControl(token, "CONTROL");
    else this.authority.operator(token, "READ");
    const task = this.accounts.dispatch(command);
    this.track(task);
    return task;
  }
  async dispatch(token: string, raw: unknown, accountRef = this.accountId): Promise<unknown> {
    requireSafe(!this.closing, "CLIENT_CLOSING");
    const c = commandSchema.parse(raw);
    if (c.command !== "accounts") this.authority.operator(token);
    if (accountRef !== this.accountId) return this.accounts.dispatchMock(accountRef, token, c);
    if (c.command === "emergencyStop") {
      this.authority.operator(token, "CONTROL");
      this.accounts.abortWorkerSends();
    }
    if (c.command === "modelProviders") {
      const task = handleModelProviderCommand(this.authority, token, this.models, this.modelUnavailable, () => this.closing, c);
      this.track(task);
      return task;
    }
    if (
      !["getStatus", "getInbox", "getThread", "getDiagnostics", "getAudit", "getSendResult", "getMessagePreview", "accounts"].includes(
        c.command,
      )
    ) {
      this.maintenance.cancel();
    }
    switch (c.command) {
      case "accounts":
        return this.handleAccounts(token, c);
      case "replyKnowledge": {
        const task = this.knowledge.dispatch(token, c);
        const tracked = knowledgeMutatingActions.has(c.action)
          ? task.then((value) => {
              this.emit("knowledge_updated");
              return value;
            })
          : task;
        this.track(tracked);
        return tracked;
      }
      case "replyPipeline":
        return handleReplyPipelineCommand({
          store: this.store, authority: this.authority, automation: this.automation,
          knowledgeContext: (event, queryText) =>
            this.knowledge.data.available() ? this.knowledge.data.context(event.accountId, event.channel, queryText) : null,
          onConfigSaved: () => this.emit("status_updated"),
        }, token, c);
      case "securityRecovery":
      case "setLocalAssistantGrant":
      case "pause":
      case "resume":
      case "emergencyStop":
      case "browser":
        return handleLifecycleControlCommand(token, c as LifecycleControlCommand, {
          store: this.store,
          authority: this.authority,
          browser: this.browser,
          automation: this.automation,
          isClosing: () => this.closing,
          bumpInboxRevision: () => {
            this.inboxRevision++;
          },
          clearDialogs: () => this.dialogs.clear(),
          cancelCollector: () => this.collector?.cancel(),
          cancelVerification: () => this.verification?.cancel(),
          stopSync: () => this.syncRunner.stop(),
          abortOnline: () => this.onlineKeeper.abort(),
          resetOnlineAbort: () => this.onlineKeeper.resetAbort(),
          resetOnlineRetry: () => this.onlineKeeper.resetRetry(),
          keepOnline: () => this.onlineKeeper.keepOnline(),
          suspendForVisible: () => this.suspendForVisible(),
          resumeAfterLogin: () => this.resumeAfterLogin(),
          stopAutomaticReply: (reason) => this.stopAutomaticReply(reason),
          resetAutomaticAbortIfLimitedAuto: () => {
            if (this.automaticAbort.signal.aborted && this.authority.mode() === "LIMITED_AUTO") {
              this.automaticAbort = new AbortController();
            }
          },
          abortModel: () => this.abortModel(),
          ownerReady: () => this.browserResources.ownerReady(),
          emit: (event) => this.emit(event),
          status: (t) => this.status(t),
        });
      case "openHumanDialog": {
        this.authority.operator(token, "EDIT");
        this.authority.select(token, c.eventId, c.selectionId);
        closeOtherDialogs(this.dialogs, this.authority, token, c.eventId);
        const event = this.store.event(c.eventId);
        if (
          c.editing !== false &&
          (!this.store.db.prepare("SELECT id FROM send_intents WHERE event_id=?").get(c.eventId) ||
            this.followups.view(c.eventId)?.queueReady)
        ) {
          const current = this.authority.ownership(event);
          const owner =
            current.operator_id === this.authority.operator(token).id && current.lease_expires_at > this.authority.now()
              ? current
              : this.authority.claim(token, c.eventId, current.generation);
          if (this.authority.assistantVersion(token) === null) {
            this.dialogs.set(c.eventId, { token, generation: owner.generation });
          }
        }
        this.emit("takeover_updated");
        return this.thread(token, c.eventId);
      }
      case "closeHumanDialog":
        this.authority.release(token, c.eventId, c.generation);
        this.dialogs.delete(c.eventId);
        this.emit("takeover_updated");
        return this.thread(token, c.eventId);
      case "sendHumanReply": {
        requireSafe(!this.browser.loginRecovery, "LOGIN_RECOVERY_IN_PROGRESS");
        requireSafe(this.automation, "AUTOMATION_NOT_READY");
        const input = { ...c.input, text: c.input.text.replace(/\r\n?/gu, "\n") };
        const fresh = this.humanReplies.queue(token, c.commandId, input);
        if (fresh) this.track(this.enqueueHuman(() => this.humanReplies.prepare(token, c.commandId)));
        return this.result(token, c.commandId);
      }
      case "saveHumanFollowupDraft":
        this.authority.requireGuiControl(token, "EDIT");
        return this.followups.save(token, c.eventId, c.generation, c.expectedVersion, c.text, c.suggestionId);
      case "sendHumanFollowup": {
        this.authority.requireGuiControl(token, "SEND");
        const fresh = this.followups.queue(token, c.commandId, c.input);
        if (fresh) this.track(this.enqueueHuman(() => this.followups.prepare(token, c.commandId)));
        return this.followups.result(token, c.commandId);
      }
      case "configureCollection":
      case "setModelGrant":
      case "setReplyPolicy":
      case "enableReplyPolicy":
      case "setAutomaticReply":
      case "setMode":
      case "clearModelKey":
      case "setKeyStorage":
      case "configureAi":
      case "authorizeAi":
        return handleConfigWriteCommand(token, c as ConfigWriteCommand, this.configContext());
      case "resumeAutomation":
        this.authority.resumeAutomation(token, c.eventId);
        this.emit("takeover_updated");
        return this.thread(token, c.eventId);
      case "getStatus":
        for (const channel of ["COMMENT_NOTIFICATION", "DIRECT_MESSAGE"] as const) {
          await this.browser.refreshIdentity(channel);
        }
        return this.status(token);
      case "getDiagnostics":
        this.authority.operator(token, "READ");
        return {
          ...readDiagnostics(this.store),
          performance: runtimePerformance.snapshot(),
          evidence: this.maintenance.status(),
          browserResources: this.browserResources.snapshot(),
        };
      case "getThread":
        return {
          ...this.queries.thread(
            token,
            c.eventId,
            this.automation,
            c.timelineBefore,
            this.suggestionState(),
            this.verification?.activeEventId(),
          ),
          workUrl: await this.browser.workUrl(this.store.event(c.eventId).payload, this.store),
        };
      case "getMessagePreview":
        return readOrRefreshPreview(
          this.store,
          this.browser,
          this.automation,
          () => {
            this.authority.operator(token, "CONTROL");
          },
          c,
        );
      case "openTarget":
        return openTargetCommand(this.deliveryContext(), token, c.eventId, c.visible);
      case "getInbox":
        return this.queries.inbox(c);
      case "markInboxRead": {
        const result = markInboxReadCommand(this.store, this.authority, token);
        this.inboxRevision++;
        this.emit("inbox_updated");
        return result;
      }
      case "selectTarget":
        closeOtherDialogs(this.dialogs, this.authority, token, c.eventId);
        this.authority.select(token, c.eventId, c.selectionId);
        if (c.eventId && this.automation) {
          this.browser.prioritizePreview(this.automation, this.store.event(c.eventId).payload, c.eventId);
        }
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
        const draft = this.authority.save(token, c.eventId, c.generation, c.expectedVersion, c.text, c.suggestionId);
        this.emit("draft_updated");
        return draft;
      }
      case "observe":
        await this.syncRunner.observe(token, c.source);
        return this.status(token);
      case "syncInbox":
        this.authority.operator(token, "CONTROL");
        this.syncRunner.start(token);
        return this.status(token);
      case "getAudit":
        return auditPage(this.store, c.page);
      case "previewSend":
        return previewSendCommand(this.deliveryContext(), token, c.params);
      case "submitManualSend": {
        const e = this.store.event(c.params.eventId);
        await this.browser.refreshIdentity(e.payload.channel);
        const fresh = this.authority.queue(token, c.commandId, c.params, this.browser.identity(e.payload.channel));
        if (fresh) this.track(this.deliver(token, c.commandId, c.params));
        return this.result(token, c.commandId);
      }
      case "getSendResult":
        return this.result(token, c.commandId);
      case "reconcileUncertain":
        return reconcileUncertainCommand(this.deliveryContext(), token, c.eventId);
      case "generateSuggestion":
        return generateSuggestion(
          {
            store: this.store,
            authority: this.authority,
            automation: this.automation,
            provider: this.provider,
            knowledgeContext: (event) =>
              this.authority.assistantVersion(token) === null && this.knowledge.data.available()
                ? this.knowledge.data.context(event.accountId, event.channel, event.text)
                : null,
            state: () => this.suggestionState(),
            models: this.models,
            signal: () => this.modelAbort.signal,
            pending: this.modelPending,
            emit: (event) => this.emit(event),
            cancelMaintenance: () => this.maintenance.cancel(),
          },
          token,
          c,
        );
      case "dismissSuggestion": {
        const result = dismissSuggestion(this.store, this.authority, token, c.suggestionId);
        this.emit("suggestion_updated");
        return result;
      }
      case "accountAiFeatures":
      case "mediaAssets":
      case "businessTools":
        return handleAiRuntimeCommand({ store: this.store, authority: this.authority, root: this.browser.root, onUpdated: () => this.emit("status_updated") }, token, c);
    }
  }
  private result(token: string, id: string) {
    return sendResultCommand(this.store, this.authority, this.followups, token, id);
  }
  get sync() {
    return this.syncRunner.snapshot();
  }
  private enqueueHuman(operation: () => Promise<void>): Promise<void> {
    const task = this.humanQueue.then(operation);
    this.humanQueue = task.catch(() => {});
    return task;
  }
  setPipelineConfig(config: ReplyPipelineConfig | undefined): void {
    this.pipelineConfig = config;
  }
  async runAutomaticReply(overridePipelineConfig?: ReplyPipelineConfig): Promise<void> {
    const pipelineConfig = overridePipelineConfig ?? this.pipelineConfig;
    await runServiceAutomaticReply({
      store: this.store, authority: this.authority, automation: this.automation, browser: this.browser,
      models: this.models, provider: this.provider, humanReplies: this.humanReplies,
      modelPending: this.modelPending, automaticSignal: this.automaticAbort.signal, modelSignal: this.modelAbort.signal,
      isClosing: () => this.closing, keyPresent: Boolean(this.selectedModelState().applied?.keyPresent),
      settings: () => this.projectedSettings(),
      knowledgeContext: (event, queryText) =>
        this.knowledge.data.available() ? this.knowledge.data.context(event.accountId, event.channel, queryText ?? event.text) : null,
      ...(pipelineConfig ? { pipelineConfig } : {}),
      updated: () => { this.inboxRevision++; this.emit("inbox_updated"); },
      errorCode: clientError, beforeWork: () => this.maintenance.cancel(),
      statusUpdated: () => this.emit("status_updated"),
      stop: (code: string) => {
        this.accounts.abortWorkerSends();
        this.automation!.stop(true, code, "AUTOMATIC_REPLY");
        this.collector?.cancel();
        this.stopAutomaticReply("EMERGENCY_STOPPED");
        this.abortModel();
      },
    });
  }
  private deliver(token: string, id: string, p: SendParams): Promise<void> {
    const automatic=this.automation&&this.store.db.prepare('SELECT command_id FROM policy_commands WHERE command_id=?').get(id);
    return deliverCommand(this.deliveryContext(),token,id,p,automatic?this.automaticAbort.signal:undefined);
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
  async close(): Promise<void> {
    this.closing = true;
    this.accounts.abortWorkerSends();
    this.onlineKeeper.abort();
    await this.knowledge.cancelActiveParse();
    await this.browser.closeManualRecovery();
    const resourcesClosed = this.browserResources.close();
    this.syncRunner.stop();
    this.stopAutomaticReply("CLIENT_CLOSING");
    this.models?.close();
    this.modelAbort.abort();
    clearInterval(this.leaseTimer);
    this.dialogs.clear();
    clearInterval(this.autoTimer);
    this.authority.expireOperators("ALL");
    await this.collector?.close();
    await this.verification?.close();
    await this.maintenance.close();
    await resourcesClosed;
    if (!this.automation) this.store.db.prepare("UPDATE client_state SET paused=1 WHERE id=1").run();
    await this.drain();
    await this.knowledge.close().finally(() => Promise.all([this.accounts.close(), this.browser.close()]));
  }
}
