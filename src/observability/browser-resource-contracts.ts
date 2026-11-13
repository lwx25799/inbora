export const browserResourceReasons=[
  'NO_OWNER','UNSUPPORTED_PLATFORM','PROCESS_UNAVAILABLE','PROCESS_AMBIGUOUS','ACCESS_DENIED','TIMEOUT',
  'CANCELLED','INVALID_SAMPLE','OWNER_CHANGED','REPORT_WRITE_FAILED','SAMPLE_STALE','CLOSED',
] as const;
export type BrowserResourceReason=typeof browserResourceReasons[number];
export type BrowserResourceState='WAITING'|'AVAILABLE'|'UNAVAILABLE'|'STALE'|'CLOSED';
export interface BrowserResourceLatest {
  workingSetBytes:number;privateBytes:number;browserProcesses:number;pageCount:number;elapsedMs:number;
}
export interface BrowserResourceDistribution {p50:number;p95:number;max:number}
export interface BrowserResourceWindow {
  samples:number;workingSetBytes:BrowserResourceDistribution;privateBytes:BrowserResourceDistribution;
}
export interface BrowserResourcesSnapshot {
  state:BrowserResourceState;reason:BrowserResourceReason|null;intervalMs:number;sampledAt:number|null;
  segmentStartedAt:number|null;latest:BrowserResourceLatest|null;hour:BrowserResourceWindow|null;run:BrowserResourceWindow|null;
}
