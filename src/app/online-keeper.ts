import { digest } from "../core/contracts.js";
import { shouldStopGlobally } from "../core/emergency-stop.js";
import type { EventStore } from "../storage/store.js";
import type { AutomationStore } from "../storage/automation-store.js";
import type { WorkbenchAuthority } from "./authority.js";
import type { PlatformConnector } from "../platform/platform-connector.js";
import { BrowserDraftRecovery } from "./browser-draft-recovery.js";

export interface OnlineKeeperHost {
  store: EventStore;
  authority: WorkbenchAuthority;
  browser: PlatformConnector;
  getAutomation(): AutomationStore | null;
  isClosing(): boolean;
  onStopForGlobalFailure(code: string): void;
  onResumeAfterLogin(): void;
  onOwnerReady(): void;
  emit(event: string): void;
  track(task: Promise<unknown>): void;
  errorCode(error: unknown): string;
}

/** Keeps the bound single account connected in headless mode and checks login recovery completion. */
export class OnlineKeeper {
  private enabled = false;
  private task: Promise<void> | null = null;
  private retryAt = 0;
  private abortController = new AbortController();
  private recoveryDiagnosticPending = false;
  constructor(private readonly host: OnlineKeeperHost) {}
  get busy(): boolean {
    return !!this.task;
  }
  get signal(): AbortSignal {
    return this.abortController.signal;
  }
  setRecoveryDiagnosticPending(pending: boolean): void {
    this.recoveryDiagnosticPending = pending;
  }
  resetRetry(): void {
    this.retryAt = 0;
  }
  resetAbort(): AbortSignal {
    this.abortController.abort();
    this.abortController = new AbortController();
    return this.abortController.signal;
  }
  abort(): void {
    this.abortController.abort();
  }
  start(): void {
    this.enabled = true;
    this.keepOnline();
  }
  private inspectStartupRecovery(): void {
    if (!this.recoveryDiagnosticPending || !this.host.browser.status().state.startsWith("OPEN")) return;
    this.recoveryDiagnosticPending = false;
    const token = this.host.authority.issueSession(["READ"]);
    const task = new BrowserDraftRecovery(this.host.store, this.host.authority, this.host.browser)
      .available(token)
      .catch(() => {})
      .finally(() => this.host.authority.revoke(token));
    this.host.track(task);
  }
  keepOnline(): void {
    const automation = this.host.getAutomation();
    if (
      !this.enabled ||
      this.host.isClosing() ||
      this.task ||
      !automation ||
      automation.state().emergencyStopped ||
      this.host.authority.now() < this.retryAt
    ) {
      return;
    }
    const ownId = this.host.store.accountOwnId(this.host.browser.accountId);
    if (!ownId) return;
    if (this.host.browser.loginRecovery) {
      this.retryAt = this.host.authority.now() + 30_000;
      const task = this.host.browser
        .completeLoginIfVerified(ownId)
        .then((done) => {
          if (done) this.host.onResumeAfterLogin();
        })
        .catch(() => {})
        .finally(() => {
          this.task = null;
          if (!this.host.isClosing()) {
            this.host.emit("status_updated");
            this.host.onOwnerReady();
          }
        });
      this.task = task;
      this.host.track(task);
      return;
    }
    this.inspectStartupRecovery();
    if (!["CLOSED", "BROWSER_START_FAILED"].includes(this.host.browser.status().state)) return;
    if (this.abortController.signal.aborted) this.abortController = new AbortController();
    const task = this.host.browser
      .open("headless", this.abortController.signal)
      .catch((error) => {
        if (this.host.isClosing() || this.abortController.signal.aborted) return;
        const code = this.host.errorCode(error);
        this.retryAt = this.host.authority.now() + 30_000;
        if (shouldStopGlobally(code)) this.host.onStopForGlobalFailure(code);
        this.host.store.audit("SINGLE_ACCOUNT_CONNECTION_FAILED", digest(code), { stopped: shouldStopGlobally(code) });
      })
      .finally(() => {
        this.task = null;
        if (!this.host.isClosing()) {
          this.host.emit("status_updated");
          this.host.onOwnerReady();
        }
      });
    this.task = task;
    this.host.track(task);
  }
}
