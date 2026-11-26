import type { BrowserService } from '../app/browser-service.js';
import type { PlatformCapabilities, PlatformConnector } from './platform-connector.js';

export const DOUYIN_PLATFORM_ID = 'douyin';
export const douyinCapabilities: PlatformCapabilities = Object.freeze({
  channels: Object.freeze(['COMMENT_NOTIFICATION', 'DIRECT_MESSAGE'] as const),
  loginRecovery: true,
  manualSecurityRecovery: true,
  preview: true,
  readback: true,
});

/** Keeps the browser owner, its safety state and its actor in the original service. */
export class DouyinPlatformConnector implements PlatformConnector {
  readonly platformId = DOUYIN_PLATFORM_ID;
  readonly capabilities = douyinCapabilities;

  constructor(private readonly browser: BrowserService) {}

  get root() { return this.browser.root; }
  get accountId() { return this.browser.accountId; }
  get ownerEpoch() { return this.browser.ownerEpoch; }
  get loginRecovery() { return this.browser.loginRecovery; }
  get actor() { return this.browser.actor; }
  status() { return this.browser.status(); }
  resourceIdentity() { return this.browser.resourceIdentity(); }
  isIdle() { return this.browser.isIdle(); }
  open(...args: Parameters<PlatformConnector['open']>) { return this.browser.open(...args); }
  close() { return this.browser.close(); }
  bindStore(...args: Parameters<PlatformConnector['bindStore']>) { return this.browser.bindStore(...args); }
  setRuntimeInstance(...args: Parameters<PlatformConnector['setRuntimeInstance']>) { return this.browser.setRuntimeInstance(...args); }

  identity(...args: Parameters<PlatformConnector['identity']>) { return this.browser.identity(...args); }
  refreshIdentity(...args: Parameters<PlatformConnector['refreshIdentity']>) { return this.browser.refreshIdentity(...args); }
  verifyManualCheck() { return this.browser.verifyManualCheck(); }
  beginLoginRecovery(...args: Parameters<PlatformConnector['beginLoginRecovery']>) { return this.browser.beginLoginRecovery(...args); }
  finishLoginRecovery(...args: Parameters<PlatformConnector['finishLoginRecovery']>) { return this.browser.finishLoginRecovery(...args); }
  completeLoginIfVerified(...args: Parameters<PlatformConnector['completeLoginIfVerified']>) { return this.browser.completeLoginIfVerified(...args); }
  verifyEmergencyRecovery(...args: Parameters<PlatformConnector['verifyEmergencyRecovery']>) { return this.browser.verifyEmergencyRecovery(...args); }
  openStoredMessage(...args: Parameters<PlatformConnector['openStoredMessage']>) { return this.browser.openStoredMessage(...args); }
  workUrl(...args: Parameters<PlatformConnector['workUrl']>) { return this.browser.workUrl(...args); }

  get manualRecoveryActive() { return this.browser.manualRecoveryActive; }
  get onManualRecoveryClosed() { return this.browser.onManualRecoveryClosed; }
  set onManualRecoveryClosed(callback: () => void) { this.browser.onManualRecoveryClosed = callback; }
  manualRecoveryStatus() { return this.browser.manualRecoveryStatus(); }
  securityRecovery(...args: Parameters<PlatformConnector['securityRecovery']>) { return this.browser.securityRecovery(...args); }
  closeManualRecovery() { return this.browser.closeManualRecovery(); }
  recoverSecurityHolds(...args: Parameters<PlatformConnector['recoverSecurityHolds']>) { return this.browser.recoverSecurityHolds(...args); }

  observe(...args: Parameters<PlatformConnector['observe']>) { return this.browser.observe(...args); }
  collect(...args: Parameters<PlatformConnector['collect']>) { return this.browser.collect(...args); }
  prioritizePreview(...args: Parameters<PlatformConnector['prioritizePreview']>) { return this.browser.prioritizePreview(...args); }
  prioritizeDisplayPreview(...args: Parameters<PlatformConnector['prioritizeDisplayPreview']>) { return this.browser.prioritizeDisplayPreview(...args); }

  adapter(...args: Parameters<PlatformConnector['adapter']>) { return this.browser.adapter(...args); }
  verifyExisting(...args: Parameters<PlatformConnector['verifyExisting']>) { return this.browser.verifyExisting(...args); }
  verifyExistingFollowup(...args: Parameters<PlatformConnector['verifyExistingFollowup']>) { return this.browser.verifyExistingFollowup(...args); }
}
