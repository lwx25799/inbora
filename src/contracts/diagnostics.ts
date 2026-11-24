import type { Channel } from './events.js';
import type { BrowserResourcesSnapshot } from './browser-resources.js';

export interface ModelUsageSummary {
  requests:number;knownUsageRequests:number;unknownUsageRequests:number;inputTokens:number;outputTokens:number;
  elapsedSamples:number;averageElapsedMs:number|null;p95ElapsedMs:number|null;
}
export interface ModelUsageGroup extends ModelUsageSummary {model:string;status:string}
export interface DiagnosticBlocker {source:string;code:string;count:number}
export interface DiagnosticsSnapshot {
  version:1;timeRangeSupported:false;
  browserResources?:BrowserResourcesSnapshot;
  model:{total:ModelUsageSummary;groups:ModelUsageGroup[]};
  blockers:DiagnosticBlocker[];
  collection:{channels:{source:string;nextAt:number;lastSuccess:number|null;lastError:string|null;failures:number;elapsedMs:number|null}[];
    works:{included:number;historical:number;review:number};conversations:{total:number;neverRead:number}};
}

export interface EvidenceCapacity {files:number;bytes:number}
export interface EvidenceRetentionReport {
  scope:'EVIDENCE_METADATA';retentionDays:number;referencesComplete:boolean;unknownReferences:number;cancelled:boolean;
  total:EvidenceCapacity;recognized:EvidenceCapacity;expired:EvidenceCapacity;protected:EvidenceCapacity;
  eligible:EvidenceCapacity;unknown:EvidenceCapacity;deleted:EvidenceCapacity;remainingEligible:EvidenceCapacity;
}

export interface EvidenceMaintenanceStatus {
  running: boolean;
  nextAt: number;
  error: string | null;
  report: EvidenceRetentionReport | null;
}

export const runtimeStages=['QUEUE_WAIT','COLLECTION','TARGET_LOCATION','PAGE_WAIT','CONTENT_CHECK','RESPONSE_READ','RESPONSE_PARSE','PERSIST','MODEL','DELIVERY'] as const;
export type RuntimeStage=typeof runtimeStages[number];
export type RuntimeOutcome='SUCCEEDED'|'FAILED'|'CANCELLED'|'UNCERTAIN';
export type RuntimeChannel=Channel|'SHARED';
export interface RuntimePerformanceSummary {
  stage:RuntimeStage;channel:RuntimeChannel;count:number;failures:number;cancelled:number;uncertain:number;
  lastMs:number;p50Ms:number;p95Ms:number;maxMs:number;
}

export interface SecurityRuntime {
  ruleVersion:string;
  fingerprint:string;
  instanceId:string|null;
}
