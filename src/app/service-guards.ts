import { requireSafe } from "../core/contracts.js";
import type { EventStore } from "../storage/store.js";
import type { AutomationStore } from "../storage/automation-store.js";
import type { WorkbenchAuthority } from "./authority.js";
import type { BrowserService } from "./browser-service.js";
import { CredentialStore } from "./credentials.js";
import { grantConfiguredModel, saveAiSettings } from "./ai-configuration.js";
import { configureAssistantConnection } from "./local-assistant-connection.js";
import { recoverEmergency } from "./emergency-recovery.js";
import { handleBrowserCommand } from "./browser-command.js";
import type { AiSettings, ClientCommand } from "./contracts.js";
import type { ReplyPolicy } from "./automation-contracts.js";

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
  if (body.command === "replyKnowledge") return body.action === "overview";
  return false;
}

export interface AutoModeGateContext {
  authority: WorkbenchAuthority;
  automation: AutomationStore | null;
  settings: AiSettings;
  resetAutomaticAbort(): void;
}

/** Shared complete gate for enabling LIMITED_AUTO via either setAutomaticReply(true) or setMode('LIMITED_AUTO'). */
export function enableAutomaticReplyMode(token: string, ctx: AutoModeGateContext): void {
  requireSafe(ctx.automation, "AUTOMATION_NOT_READY");
  requireSafe(!ctx.automation.state().emergencyStopped, "EMERGENCY_STOPPED");
  const grant = ctx.automation.active("AUTO_REPLY");
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
  getKey(): string;
  setKey(key: string): void;
  getKeyStored(): boolean;
  setKeyStored(stored: boolean): void;
  setKeyStorageError(error: string | null): void;
  nextKeyGeneration(): number;
  currentKeyGeneration(): number;
  setModelAuthorized(authorized: boolean): void;
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
      ctx.authority.requireGuiControl(token);
      requireSafe(ctx.automation, "AUTOMATION_NOT_READY");
      ctx.setModelAuthorized(false);
      if (c.scope) ctx.automation.grant("MODEL", c.scope);
      else {
        ctx.automation.revoke("MODEL");
        ctx.abortModel();
      }
      ctx.emit("status_updated");
      return ctx.status(token);
    case "setReplyPolicy":
      ctx.authority.requireGuiControl(token);
      requireSafe(ctx.automation, "AUTOMATION_NOT_READY");
      if (c.policy) ctx.automation.grant("AUTO_REPLY", c.policy);
      else {
        ctx.automation.revoke("AUTO_REPLY");
        ctx.stopAutomaticReply();
      }
      ctx.emit("status_updated");
      return ctx.status(token);
    case "enableReplyPolicy":
      ctx.authority.requireGuiControl(token);
      requireSafe(ctx.automation, "AUTOMATION_NOT_READY");
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
          resetAutomaticAbort: () => ctx.resetAutomaticAbort(),
        });
      } else {
        ctx.authority.setMode(token, c.mode);
        ctx.stopAutomaticReply();
      }
      ctx.emit("status_updated");
      return ctx.status(token);
    case "clearModelKey": {
      ctx.authority.requireGuiControl(token);
      const generation = ctx.nextKeyGeneration();
      ctx.setKey("");
      ctx.abortModel();
      await new CredentialStore(ctx.root).delete();
      if (generation === ctx.currentKeyGeneration() && !ctx.isClosing()) {
        ctx.setKeyStored(false);
        ctx.setKeyStorageError(null);
      }
      ctx.store.audit("MODEL_KEY_CLEARED", "account_001");
      ctx.emit("status_updated");
      return ctx.status(token);
    }
    case "setKeyStorage": {
      ctx.authority.requireGuiControl(token);
      const credentials = new CredentialStore(ctx.root);
      const generation = ctx.nextKeyGeneration();
      if (c.storage === "DPAPI") {
        requireSafe(ctx.getKey(), "MODEL_KEY_REQUIRED");
        await credentials.save(ctx.getKey());
        if (generation === ctx.currentKeyGeneration() && !ctx.isClosing()) ctx.setKeyStored(true);
      } else {
        await credentials.delete();
        if (generation === ctx.currentKeyGeneration() && !ctx.isClosing()) {
          ctx.setKeyStored(false);
          if (c.storage === "DELETE") {
            ctx.setKey("");
            ctx.abortModel();
          }
        }
      }
      ctx.setKeyStorageError(null);
      ctx.store.audit("MODEL_KEY_STORAGE_CHANGED", "account_001", { stored: ctx.getKeyStored() });
      ctx.emit("status_updated");
      return ctx.status(token);
    }
    case "configureAi": {
      ctx.authority.requireGuiControl(token);
      requireSafe(!/[\r\n]/u.test(c.key), "INVALID_MODEL_KEY");
      const generation = c.key ? ctx.nextKeyGeneration() : ctx.currentKeyGeneration();
      await saveAiSettings(ctx.root, c.settings);
      const modelChanged = ctx.getSettings().model !== c.settings.model;
      ctx.setSettings(c.settings);
      if (c.key && generation === ctx.currentKeyGeneration() && !ctx.isClosing()) {
        if (ctx.getKeyStored()) await new CredentialStore(ctx.root).save(c.key);
        if (generation === ctx.currentKeyGeneration() && !ctx.isClosing()) ctx.setKey(c.key);
      }
      if (modelChanged) ctx.setModelAuthorized(false);
      if (c.key && generation === ctx.currentKeyGeneration() && ctx.automation) {
        grantConfiguredModel(ctx.store, ctx.automation, c.settings);
      }
      ctx.emit("status_updated");
      return ctx.status(token);
    }
    case "authorizeAi":
      ctx.authority.requireGuiControl(token);
      requireSafe(!ctx.automation, "USE_PERSISTENT_MODEL_GRANT");
      requireSafe(!c.authorized || ctx.getKey(), "MODEL_KEY_REQUIRED");
      ctx.setModelAuthorized(c.authorized);
      ctx.store.audit(c.authorized ? "DEEPSEEK_AUTHORIZED" : "DEEPSEEK_REVOKED", "account_001");
      ctx.emit("status_updated");
      return ctx.status(token);
  }
}

export interface LifecycleControlContext {
  store: EventStore;
  authority: WorkbenchAuthority;
  browser: BrowserService;
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
      if (c.action === "start") ctx.suspendForVisible();
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
        await ctx.browser.recoverSecurityHolds(true);
        ctx.automation?.stop(false);
        ctx.resetAutomaticAbortIfLimitedAuto();
        ctx.keepOnline();
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
