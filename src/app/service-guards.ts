import { Blocked, requireSafe } from "../core/contracts.js";
import type { EventStore } from "../storage/store.js";
import type { AutomationStore } from "../storage/automation-store.js";
import type { WorkbenchAuthority } from "./authority.js";
import type { PlatformConnector } from "../platform/platform-connector.js";
import { saveAiSettings } from "./ai-configuration.js";
import { CredentialStore } from "./credentials.js";
import { configureAssistantConnection } from "./local-assistant-connection.js";
import { recoverEmergency } from "./emergency-recovery.js";
import { handleBrowserCommand } from "./browser-command.js";
import type { AiSettings, ClientCommand } from "./contracts.js";
import type { ModelProviderController } from "./model-provider-controller.js";
import type { ReplyPolicy } from "./automation-contracts.js";

export function clientError(error: unknown): string {
  return error instanceof Blocked ? error.code : "OPERATION_FAILED_PRIVATE_DIAGNOSTICS";
}

/** Knowledge commands that persist state changes and justify a knowledge_updated broadcast. */
export const knowledgeMutatingActions = new Set<string>([
  "saveKnowledge",
  "setKnowledgeState",
  "deleteSource",
  "selectSamples",
  "collectCandidates",
  "savePersona",
  "publishPersona",
  "importCommit",
  "analyze",
]);

const readOnlyCommands = new Set<string>([
  "getStatus",
  "getInbox",
  "getThread",
  "getDiagnostics",
  "getAudit",
  "getSendResult",
]);

/** Pure read-only IPC calls should not trigger SQLite session renewal writes while comfortably valid. */
export function isReadOnlySidecarCommand(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || !("command" in raw)) return false;
  const body = raw as Record<string, unknown>;
  if (typeof body.command !== "string") return false;
  if (readOnlyCommands.has(body.command)) return true;
  if (body.command === "getMessagePreview") return body.refresh !== true;
  if (body.command === "replyKnowledge") {
    return body.action === "overview" || body.action === "debugRetrieval" || body.action === "embeddingStatus";
  }
  if (body.command === "modelProviders") return body.action === "list";
  if (body.command === "accounts") {
    return body.action === "listAccounts"
      || body.action === "getAccountStatus"
      || body.action === "getOfficialChannelConfig";
  }
  return false;
}

export interface AutoModeGateContext {
  authority: WorkbenchAuthority;
  automation: AutomationStore | null;
  settings: AiSettings;
  models: ModelProviderController | null;
  resetAutomaticAbort(): void;
}

/** Shared complete gate for enabling LIMITED_AUTO via either setAutomaticReply(true) or setMode('LIMITED_AUTO'). */
export function enableAutomaticReplyMode(token: string, ctx: AutoModeGateContext): void {
  requireSafe(ctx.automation, "AUTOMATION_NOT_READY");
  requireSafe(!ctx.automation.state().emergencyStopped, "EMERGENCY_STOPPED");
  const grant = ctx.models?.guard.eligibleGrant("AUTO_REPLY");
  requireSafe(grant, "AUTO_POLICY_REQUIRED");
  requireSafe(grant.scope.model === ctx.settings.model, "MODEL_OUTSIDE_GRANT");
  requireSafe(ctx.automation.allowance(grant.version, "SEND"), "SEND_GRANT_EXHAUSTED");
  requireSafe(ctx.automation.allowance(grant.version, "MODEL"), "MODEL_GRANT_EXHAUSTED");
  ctx.authority.setMode(token, "LIMITED_AUTO");
  ctx.authority.resumeIdleAutomation();
  ctx.resetAutomaticAbort();
}

export interface ConfigCommandContext {
  store: EventStore;
  authority: WorkbenchAuthority;
  automation: AutomationStore | null;
  root: string;
  isClosing(): boolean;
  getSettings(): AiSettings;
  setSettings(settings: AiSettings): void;
  models: ModelProviderController | null;
  abortModel(): void;
  stopAutomaticReply(reason?: string): void;
  resetAutomaticAbort(force?: boolean): void;
  cancelCollector(): void;
  emit(event: string): void;
  status(token: string): unknown;
}

export type ConfigWriteCommand = Extract<
  ClientCommand,
  {
    command:
      | "configureCollection"
      | "setModelGrant"
      | "setReplyPolicy"
      | "enableReplyPolicy"
      | "setAutomaticReply"
      | "clearModelKey"
      | "setKeyStorage"
      | "configureAi"
      | "authorizeAi"
      | "setMode";
  }
>;

export function updateModelGrant(token: string, c: Extract<ClientCommand, { command: "setModelGrant" }>,
  ctx: Pick<ConfigCommandContext, "authority" | "automation" | "models" | "abortModel">): void {
  ctx.authority.requireGuiControl(token);
  requireSafe(ctx.automation, "AUTOMATION_NOT_READY");
  if (c.scope) {
    requireSafe(ctx.models, "MODEL_PROVIDERS_NOT_INITIALIZED");
    ctx.automation.grant("MODEL", c.scope);
  } else {
    ctx.automation.revoke("MODEL", {
      ...(c.expectedVersion !== undefined ? { version: c.expectedVersion } : {}),
      ...(c.expectedOwnId !== undefined ? { ownId: c.expectedOwnId } : {}),
    });
    ctx.abortModel();
  }
}

export function dismissSuggestion(store: EventStore, authority: WorkbenchAuthority, token: string, suggestionId: string) {
  authority.operator(token, "EDIT");
  requireSafe(store.db.prepare(`UPDATE ai_suggestions SET dismissed=1 WHERE id IN (
    SELECT s.id FROM ai_suggestions s JOIN inbound_events e ON e.id=s.event_id WHERE s.id=? AND e.account_id=?)`)
    .run(suggestionId, store.accountId).changes === 1, "SUGGESTION_NOT_FOUND");
  return { dismissed: true };
}

/** Centralized GUI-only config/policy/key mutations and unified LIMITED_AUTO gating. */
export async function handleConfigWriteCommand(
  token: string,
  c: ConfigWriteCommand,
  ctx: ConfigCommandContext,
): Promise<unknown> {
  switch (c.command) {
    case "configureCollection":
      ctx.authority.requireGuiControl(token);
      requireSafe(ctx.automation, "AUTOMATION_NOT_READY");
      ctx.automation.configureCollection(c.settings);
      ctx.cancelCollector();
      ctx.emit("status_updated");
      return ctx.status(token);
    case "setModelGrant":
      updateModelGrant(token, c, ctx);
      ctx.emit("status_updated");
      return ctx.status(token);
    case "setReplyPolicy":
      ctx.authority.requireGuiControl(token);
      requireSafe(ctx.automation, "AUTOMATION_NOT_READY");
      if (c.policy) {
        requireSafe(ctx.models, "MODEL_PROVIDERS_NOT_INITIALIZED");
        ctx.automation.grant("AUTO_REPLY", c.policy);
      }
      else {
        ctx.automation.revoke("AUTO_REPLY", {
          ...(c.expectedVersion !== undefined ? { version: c.expectedVersion } : {}),
          ...(c.expectedOwnId !== undefined ? { ownId: c.expectedOwnId } : {}),
        });
        ctx.stopAutomaticReply();
      }
      ctx.emit("status_updated");
      return ctx.status(token);
    case "enableReplyPolicy":
      ctx.authority.requireGuiControl(token);
      requireSafe(ctx.automation, "AUTOMATION_NOT_READY");
      requireSafe(ctx.models, "MODEL_PROVIDERS_NOT_INITIALIZED");
      ctx.store.db
        .transaction(() => {
          requireSafe(!ctx.automation!.state().emergencyStopped, "EMERGENCY_STOPPED");
          ctx.automation!.grant("AUTO_REPLY", c.policy);
          ctx.authority.setMode(token, "LIMITED_AUTO");
          ctx.authority.pause(token, null, false);
          ctx.authority.resumeIdleAutomation();
        })
        .immediate();
      ctx.stopAutomaticReply();
      ctx.resetAutomaticAbort(true);
      ctx.emit("status_updated");
      return ctx.status(token);
    case "setAutomaticReply":
      ctx.authority.operator(token, "CONTROL");
      requireSafe(ctx.automation, "AUTOMATION_NOT_READY");
      if (ctx.authority.assistantVersion(token) !== null) {
        const scope = ctx.authority.assistant.require("editControl", ctx.authority.assistantVersion(token)!);
        const policy = ctx.automation.active("AUTO_REPLY");
        if (c.enabled && policy) ctx.authority.assistant.requirePolicy(scope.version, policy.scope as ReplyPolicy);
      }
      if (c.enabled) {
        enableAutomaticReplyMode(token, {
          authority: ctx.authority,
          automation: ctx.automation,
          settings: ctx.getSettings(),
          models: ctx.models,
          resetAutomaticAbort: () => ctx.resetAutomaticAbort(),
        });
      } else {
        ctx.store.db
          .transaction(() => {
            ctx.authority.setMode(token, "MANUAL");
            ctx.stopAutomaticReply();
          })
          .immediate();
      }
      ctx.emit("status_updated");
      return ctx.status(token);
    case "setMode":
      ctx.authority.requireGuiControl(token);
      if (c.mode === "LIMITED_AUTO") {
        enableAutomaticReplyMode(token, {
          authority: ctx.authority,
          automation: ctx.automation,
          settings: ctx.getSettings(),
          models: ctx.models,
          resetAutomaticAbort: () => ctx.resetAutomaticAbort(),
        });
      } else {
        ctx.authority.setMode(token, c.mode);
        ctx.stopAutomaticReply();
      }
      ctx.emit("status_updated");
      return ctx.status(token);
    case "clearModelKey":
    case "setKeyStorage": {
      ctx.authority.requireGuiControl(token);
      requireSafe(c.command === "clearModelKey" || c.storage === "DELETE", "USE_MODEL_PROVIDER_SETTINGS");
      requireSafe(ctx.models, "MODEL_PROVIDERS_NOT_INITIALIZED");
      const selection = ctx.models.models.getSelection();
      if (selection.connectionId) {
        const row = ctx.models.models.requireConnection(selection.connectionId);
        await ctx.models.clearKey(row.id, row.version);
      }
      await new CredentialStore(ctx.root).delete();
      return ctx.status(token);
    }
    case "configureAi": {
      ctx.authority.requireGuiControl(token);
      const { model, persona, business, rules } = c.settings;
      requireSafe(!c.key && (model === undefined || model === ctx.getSettings().model), "USE_MODEL_PROVIDER_SETTINGS");
      await saveAiSettings(ctx.root, { persona, business, rules }, !ctx.models);
      ctx.setSettings({ model: ctx.getSettings().model, persona, business, rules });
      ctx.emit("status_updated");
      return ctx.status(token);
    }
    case "authorizeAi":
      ctx.authority.requireGuiControl(token);
      requireSafe(false, "USE_PERSISTENT_MODEL_GRANT");
  }
}

export interface LifecycleControlContext {
  store: EventStore;
  authority: WorkbenchAuthority;
  browser: PlatformConnector;
  automation: AutomationStore | null;
  isClosing(): boolean;
  bumpInboxRevision(): void;
  clearDialogs(): void;
  cancelCollector(): void;
  cancelVerification(): void;
  stopSync(): void;
  abortOnline(): void;
  resetOnlineAbort(): AbortSignal;
  resetOnlineRetry(): void;
  keepOnline(): void;
  suspendForVisible(): void;
  resumeAfterLogin(): void;
  stopAutomaticReply(reason?: string): void;
  resetAutomaticAbortIfLimitedAuto(): void;
  abortModel(): void;
  ownerReady(): void;
  emit(event: string): void;
  status(token: string): unknown;
}

export type LifecycleControlCommand = Extract<
  ClientCommand,
  { command: "securityRecovery" | "setLocalAssistantGrant" | "pause" | "resume" | "emergencyStop" | "browser" }
>;

export async function handleLifecycleControlCommand(
  token: string,
  c: LifecycleControlCommand,
  ctx: LifecycleControlContext,
): Promise<unknown> {
  switch (c.command) {
    case "securityRecovery": {
      const check = () => {
        ctx.authority.requireGuiControl(token, "CONTROL", "ASSISTANT_CANNOT_CONTROL_VERIFICATION");
        requireSafe(!ctx.isClosing(), "CLIENT_CLOSING");
      };
      check();
      if (c.action === "start" && ctx.browser.capabilities.loginRecovery) ctx.suspendForVisible();
      try {
        const result = await ctx.browser.securityRecovery(c, token, check);
        return c.action === "close" || c.action === "finish" ? ctx.status(token) : result;
      } finally {
        if (!ctx.browser.manualRecoveryActive) ctx.resumeAfterLogin();
        ctx.emit("status_updated");
      }
    }
    case "setLocalAssistantGrant": {
      ctx.authority.requireGuiControl(token, "CONTROL", "ASSISTANT_CANNOT_GRANT");
      await configureAssistantConnection(
        ctx.authority.assistant,
        ctx.browser.root,
        c.enabled ? "ENABLE" : "DISABLE",
        () => requireSafe(!ctx.isClosing(), "CLIENT_CLOSING"),
      );
      ctx.emit("status_updated");
      return ctx.status(token);
    }
    case "pause":
    case "resume":
    case "emergencyStop": {
      requireSafe(c.command !== "resume" || !ctx.browser.manualRecoveryActive, "MANUAL_RECOVERY_IN_PROGRESS");
      if (c.command === "resume" && c.eventId === null && ctx.automation?.state().emergencyStopped) {
        ctx.authority.operator(token, "CONTROL");
        const signal = ctx.resetOnlineAbort();
        await recoverEmergency({
          store: ctx.store,
          data: ctx.automation,
          authority: ctx.authority,
          browser: ctx.browser,
          token,
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          closing: () => ctx.isClosing(),
        });
        ctx.resumeAfterLogin();
        ctx.keepOnline();
        ctx.emit("status_updated");
        return ctx.status(token);
      }
      ctx.authority.pause(token, c.command === "emergencyStop" ? null : c.eventId, c.command !== "resume");
      if (c.command === "emergencyStop") {
        ctx.bumpInboxRevision();
        ctx.automation?.stop(true, "MANUAL_EMERGENCY_STOP", "MANUAL");
        void ctx.browser.closeManualRecovery().catch(() => {});
        ctx.abortOnline();
        ctx.clearDialogs();
        ctx.cancelCollector();
        ctx.cancelVerification();
        ctx.stopSync();
        ctx.stopAutomaticReply("EMERGENCY_STOPPED");
        ctx.abortModel();
      }
      if (c.command === "resume" && c.eventId === null) {
        const signal = ctx.resetOnlineAbort();
        try {
          await ctx.browser.recoverSecurityHolds(true, signal, () => {
            requireSafe(!ctx.isClosing(), "CLIENT_CLOSING");
            ctx.authority.operator(token, "CONTROL");
          });
        } catch (error) {
          if (!signal.aborted || !ctx.automation?.state().emergencyStopped) throw error;
        }
        if (!ctx.automation?.state().emergencyStopped) {
          ctx.resetAutomaticAbortIfLimitedAuto();
          ctx.keepOnline();
        }
      }
      ctx.emit("takeover_updated");
      ctx.emit("send_status_updated");
      return ctx.status(token);
    }
    case "browser": {
      ctx.authority.requireGuiControl(token);
      requireSafe(!ctx.browser.manualRecoveryActive, "MANUAL_RECOVERY_IN_PROGRESS");
      const result = await handleBrowserCommand({
        command: c,
        token,
        store: ctx.store,
        authority: ctx.authority,
        browser: ctx.browser,
        suspend: () => ctx.suspendForVisible(),
        resume: () => ctx.resumeAfterLogin(),
        cancel: () => {
          ctx.stopSync();
          ctx.cancelCollector();
        },
        resetRetry: () => ctx.resetOnlineRetry(),
      });
      ctx.ownerReady();
      ctx.emit("status_updated");
      return result.status ? ctx.status(token) : result.value;
    }
  }
}
