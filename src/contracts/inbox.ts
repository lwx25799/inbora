import type { InboundEvent, StoredEvent } from './events.js';

export type ReplyStatus='WAITING'|'REPLIED'|'NOT_REQUIRED'|'MANUAL_ONLY';

export interface MessagePreviewAttachment {
  previewId:string|null;kind:'IMAGE';label:string|null;state:'READY'|'UNAVAILABLE';reason?:string|undefined;width?:number|undefined;height?:number|undefined;
}
export interface MessagePreviewData {previewId:string;mime:'image/png';dataUrl:string;width:number;height:number}

export interface MessageShare {kind:'DOUYIN_WORK';url:string;workId:string}

export interface TimelineItem {
  id:string;
  eventId:string;
  direction:'INCOMING'|'OUTGOING';
  text:string;
  displayText?:string;
  occurredAt:string|null;
  historical:boolean;
  origin:'OBSERVED'|'CONFIRMED';
  contentType?:StoredEvent['payload']['contentType'];
  observationIssue?:StoredEvent['payload']['observationIssue'];
  attachments:MessagePreviewAttachment[];
  share?:MessageShare;
}

export interface CommentThreadItem {
  id:string;eventId:string;direction:'INCOMING'|'OUTGOING';text:string;occurredAt:string|null;historical:boolean;
  origin:'OBSERVED'|'CONFIRMED';isRoot:boolean;payload:InboundEvent;verifiedForModel:boolean;
}
export interface CommentThreadContext {
  group:string;root:CommentThreadItem|null;rootVerified:boolean;rootMissing:boolean;rootAmbiguous:boolean;
  items:CommentThreadItem[];projectionRevision:string;localRecordsOnly:true;observedOwnHistoryComplete:false;
}

export interface CommentThreadPage extends Omit<CommentThreadContext, 'group'> {
  pageSize: number;
  hasMore: boolean;
  before: string | null;
}
