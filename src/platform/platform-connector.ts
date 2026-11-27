import type { AccountId, PlatformTransport } from '../contracts/account.js';
import type { BrowserMode, BrowserResourceIdentity, BrowserStatus } from '../contracts/browser-resources.js';
import type { Channel, InboundEvent, ReplyAdapter, SendProof, TargetSnapshot } from '../contracts/events.js';
import type { ManualRecoveryCommand, ManualRecoveryResult, ManualRecoveryStatus } from '../contracts/manual-recovery.js';
import type { AutomationStore } from '../storage/automation-store.js';
import type { EventStore } from '../storage/store.js';

export interface PlatformCapabilities {
  readonly channels: readonly Channel[];
  readonly loginRecovery: boolean;
  readonly manualSecurityRecovery: boolean;
  readonly preview: boolean;
  readonly readback: boolean;
  readonly transport?: PlatformTransport | undefined;
}

export type PlatformStatus = BrowserStatus;

export interface BrowserTransportStatus {
  readonly transport: 'browser';
  readonly state: string;
  readonly mode: BrowserMode;
  readonly version: string | null;
  readonly loginRecovery?: boolean | undefined;
}

export type OfficialApiTransportState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'DEGRADED' | 'ERROR';
export type OfficialApiProtocol = 'wecom_ws' | 'wechat_kf_http';

export interface OfficialApiTransportStatus {
  readonly transport: 'official_api';
  readonly state: OfficialApiTransportState;
  readonly endpointDigest: string | null;
  readonly protocol: OfficialApiProtocol;
  readonly lastHeartbeatAt?: number | null | undefined;
  readonly lastSyncAt?: number | null | undefined;
  readonly errorCode?: string | null | undefined;
}

export interface DesktopUiaTransportStatus {
  readonly transport: 'desktop_uia';
  readonly state: string;
  readonly windowAvailable: boolean;
  readonly accessibilityVisible: boolean;
}

export interface CopilotWebviewTransportStatus {
  readonly transport: 'copilot_webview';
  readonly state: string;
  readonly targetUrlOrigin: string | null;
}

export type ConnectorTransportStatus =
  | BrowserTransportStatus
  | OfficialApiTransportStatus
  | DesktopUiaTransportStatus
  | CopilotWebviewTransportStatus;

export type CollectionSource = 'works' | 'dm';
export type ObservationSource = 'notifications' | CollectionSource;
export type ObservationResult = { newEventIds: string[] } |
  { newEventIds: string[]; loaded: number; unsupported: number; sendsEnabled: false };
export interface PreviewDisplayTarget { eventId: string; source: 'INBOUND' | 'CHAT'; purpose: 'DISPLAY' }

export interface CapabilityIdentity {
  identityDigest: string;
  mappingDigest: string;
  browserVersion: string;
  browserMode: BrowserMode;
}

export interface BrowserCapabilityIdentity extends CapabilityIdentity {
  readonly transport: 'browser';
}

export interface OfficialApiCapabilityIdentity {
  readonly transport: 'official_api';
  readonly identityDigest: string;
  readonly mappingDigest: string;
  readonly protocol: OfficialApiProtocol;
  readonly endpointDigest: string;
}

export interface DesktopUiaCapabilityIdentity {
  readonly transport: 'desktop_uia';
  readonly identityDigest: string;
  readonly mappingDigest: string;
  readonly windowDigest: string;
}

export interface CopilotWebviewCapabilityIdentity {
  readonly transport: 'copilot_webview';
  readonly identityDigest: string;
  readonly mappingDigest: string;
  readonly targetUrlOrigin: string;
}

export type ConnectorCapabilityIdentity =
  | BrowserCapabilityIdentity
  | OfficialApiCapabilityIdentity
  | DesktopUiaCapabilityIdentity
  | CopilotWebviewCapabilityIdentity;

export interface AccountSerialExecutor {
  run<T>(operation: () => Promise<T>, priority?: 'interactive' | 'background'): Promise<T>;
}

export interface PlatformReplyAdapter extends ReplyAdapter {
  clickOnce(notBefore?: string, check?: () => void, permitExpiresAt?: number): Promise<void>;
  verifyExisting?(event: InboundEvent, text: string, notBefore: string, contextDigest?: string): Promise<SendProof | null>;
  readSavedDraft?(event: InboundEvent): Promise<{ text: string; snapshot: TargetSnapshot }>;
  clearSavedDraft?(event: InboundEvent, text: string): Promise<void>;
  locateSavedDraft?(event: InboundEvent, signal: AbortSignal): Promise<void>;
}

export interface AdapterHandle {
  adapter: PlatformReplyAdapter;
  dispose(): void | Promise<void>;
}

export interface AdapterOptions { manualMedia?: boolean; readonlySignal?: AbortSignal; nativeCommentOnly?: boolean; nativeReplyOnly?: boolean }
export interface VerificationOptions { signal?: AbortSignal; background?: boolean; commentDraftId?: string }
export interface VerificationResult { verified: boolean; evidenceId: string; nativeIdDigest?: string }
export interface FollowupVerificationResult extends VerificationResult { proofDigest?: string }

/** One account's platform operations. The application retains authorization and the durable send ledger. */
export interface PlatformConnector {
  readonly root: string;
  readonly platformId: string;
  readonly accountId: AccountId;
  readonly capabilities: PlatformCapabilities;
  readonly ownerEpoch: number;
  readonly loginRecovery: boolean;
  status(): PlatformStatus;
  transportStatus?(): ConnectorTransportStatus;
  resourceIdentity(): BrowserResourceIdentity;
  isIdle(): boolean;
  open(mode?: BrowserMode, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  bindStore(store: EventStore): void;
  setRuntimeInstance(instanceId: string | null): void;

  identity(channel: Channel): CapabilityIdentity | null;
  refreshIdentity(channel: Channel): Promise<CapabilityIdentity | null>;
  verifyManualCheck(): Promise<{browserVersion:string;mode:BrowserMode;proofDigest:string}>;
  beginLoginRecovery(autoFinish?: boolean, signal?: AbortSignal, check?: () => void, useAccountHome?: boolean): Promise<void>;
  finishLoginRecovery(generation?: number): Promise<boolean>;
  completeLoginIfVerified(ownId: string): Promise<boolean>;
  verifyEmergencyRecovery(ownId: string, signal: AbortSignal, check: () => void, complete?: () => void): Promise<void>;
  openStoredMessage(store: EventStore, eventId: string, beforeOpen: () => Promise<AbortSignal>, permitted: () => void):
    Promise<{ opened: true; located: boolean }>;
  workUrl(event: InboundEvent, store?: EventStore): Promise<string | null>;

  readonly manualRecoveryActive: boolean;
  manualRecoveryStatus(): ManualRecoveryStatus | null;
  securityRecovery(command: ManualRecoveryCommand, token: string, check: () => void): Promise<ManualRecoveryResult>;
  closeManualRecovery(): Promise<void>;
  recoverSecurityHolds(explicit?: boolean, signal?: AbortSignal, check?: () => void): Promise<void>;
  onManualRecoveryClosed: () => void;

  observe(store: EventStore, source: ObservationSource, signal?: AbortSignal): Promise<ObservationResult>;
  collect(data: AutomationStore, source: CollectionSource, signal: AbortSignal): Promise<void>;
  prioritizePreview(data: AutomationStore, event: InboundEvent, eventId?: string): void;
  prioritizeDisplayPreview(data: AutomationStore, event: InboundEvent, target: PreviewDisplayTarget): boolean;

  /** This is the same queue used by collection, recovery, preparation, the send intent and readback. */
  readonly actor: AccountSerialExecutor;
  /** Preparation and submission are separate. Dispatch uses this handle through SendCoordinator. */
  adapter(event: InboundEvent, store?: EventStore, signal?: AbortSignal, options?: AdapterOptions): Promise<AdapterHandle>;
  verifyExisting(store: EventStore, eventId: string, options?: VerificationOptions): Promise<VerificationResult>;
  verifyExistingFollowup(store: EventStore, commandId: string, options?: VerificationOptions): Promise<FollowupVerificationResult>;
}
