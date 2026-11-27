import {z} from 'zod';
import type {Channel} from './events.js';

export const knowledgeLimits={chunk:600,chunkMaximum:1000,overlap:100,candidates:20,knowledgeCount:4,knowledgeCharacters:2400,
  exampleCount:3,exampleCharacters:1200,personaCharacters:2000,learningPairs:200,pageSize:50} as const;
const channels=z.array(z.enum(['DIRECT_MESSAGE','COMMENT_NOTIFICATION'])).min(1).max(2);
const time=z.number().int().nonnegative().nullable().optional();
export const knowledgeInputSchema=z.object({id:z.uuid().optional(),sourceId:z.uuid().optional(),title:z.string().trim().min(1).max(200),
  topic:z.string().trim().min(1).max(100),text:z.string().trim().min(1).max(100_000),aliases:z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  channels:channels.default(['DIRECT_MESSAGE','COMMENT_NOTIFICATION']),effectiveAt:time,expiresAt:time,expectedVersion:z.number().int().positive().optional()})
  .strict().refine(value=>value.expiresAt==null||value.effectiveAt==null||value.expiresAt>value.effectiveAt,{message:'KNOWLEDGE_INVALID_DATES'});
export type KnowledgeInput=z.input<typeof knowledgeInputSchema>;
export type KnowledgeState='ACTIVE'|'DISABLED';
export interface KnowledgeEntry {id:string;sourceId:string;title:string;topic:string;text:string;aliases:string[];channels:Channel[];
  effectiveAt:number|null;expiresAt:number|null;state:KnowledgeState;version:number;updatedAt:number}
export const sampleSourceSchema=z.enum(['HUMAN_TYPED','HUMAN_FOLLOWUP','IMPORTED','OBSERVED_UNKNOWN','AI_ASSISTED_APPROVED','MCP_ASSISTED','AUTO_POLICY','LEGACY']);
export type SampleSource=z.infer<typeof sampleSourceSchema>;
export const sampleInputSchema=z.object({channel:z.enum(['DIRECT_MESSAGE','COMMENT_NOTIFICATION']),prompt:z.string().trim().min(1).max(4000),
  response:z.string().trim().min(1).max(2000),source:sampleSourceSchema.default('IMPORTED'),sourceId:z.uuid().optional(),
  sourceRef:z.string().max(300).optional(),group:z.string().min(1).max(300).optional(),occurredAt:time}).strict();
export type SampleInput=z.input<typeof sampleInputSchema>;
export interface ReplySample {id:string;sourceId:string;channel:Channel;prompt:string;response:string;source:SampleSource;sourceRef:string|null;
  group:string;accepted:boolean;excluded:boolean;holdout:boolean;reason:string|null;createdAt:number}
export interface PersonaVersion {id:string;text:string;sampleIds:string[];state:'DRAFT'|'PUBLISHED'|'ARCHIVED'|'INVALID';createdAt:number}
export interface KnowledgeSource {id:string;title:string;kind:'KNOWLEDGE'|'CHAT'|'MANUAL';createdAt:number}
export interface KnowledgeHit {
  id:string;sourceId:string;title:string;topic:string;text:string;version:number;chunkId:string;
  score?:number;lexicalScore?:number;vectorScore?:number;matchedTerms?:string[];exactMatch?:boolean;
}
export type RetrievalEngineMode='FTS5_ENHANCED'|'HYBRID_ONNX';
export type OnnxEmbeddingState='REUSED_LOCAL'|'DOWNLOAD_READY'|'MISSING_NEEDS_DOWNLOAD'|'FALLBACK_FTS5';
export interface OnnxEmbeddingStatus {
  state:OnnxEmbeddingState;engineMode:RetrievalEngineMode;modelId:string;modelPath:string|null;
  expectedSha256:string|null;actualSha256:string|null;sizeBytes:number|null;dims:number;
  checkedPaths:string[];reason:string;checkedAt:number;
}
export interface ExactFaqMatch {
  id:string;sourceId:string;title:string;topic:string;text:string;version:number;chunkId:string;
  matchType:'EXACT_TITLE'|'EXACT_ALIAS'|'HIGH_CONFIDENCE';score:number;
}
export interface RetrievalDebugHit {
  id:string;sourceId:string;title:string;topic:string;version:number;chunkId:string;textPreview:string;
  score:number;lexicalScore:number;vectorScore:number;matchedTerms:string[];exactMatch:boolean;
}
export interface RetrievalRejectedCandidate {id:string;title:string;score:number;reason:string}
export interface RetrievalDebugResult {
  engineMode:RetrievalEngineMode;query:string;channel:Channel;queryTerms:string[];wordTerms:string[];
  filteredStopTerms:string[];minScore:number;hits:RetrievalDebugHit[];
  rejectedBelowThreshold:RetrievalRejectedCandidate[];conflicts:string[];
  exactFaqHit:ExactFaqMatch|null;onnxStatus:OnnxEmbeddingStatus;
}
export interface StyleExample {id:string;prompt:string;response:string;channel:Channel}
export interface ReplyKnowledgeContext {accountId:string;channel:Channel;query:string;sourceIds?:string[];accountPersonaOnly?:boolean;personaPinned?:boolean;persona:string;personaId:string|null;
  examples:StyleExample[];knowledge:KnowledgeHit[];fingerprint:string;conflicts:string[];
  exactFaqMatch?:ExactFaqMatch|null;engineMode?:RetrievalEngineMode}
export interface KnowledgeOverview {available:boolean;sources:KnowledgeSource[];knowledge:KnowledgeEntry[];samples:ReplySample[];
  personas:PersonaVersion[];activePersonaId:string|null;activePersona:PersonaVersion|null;totals:{sources:number;knowledge:number;samples:number;accepted:number;holdout:number;personas:number};
  learningTasks:{id:string;state:string;personaId:string|null;completed:number}[];page:number;pageSize:number}
export interface SourceInput {kind:'KNOWLEDGE'|'CHAT'|'MANUAL';title:string;digest?:string}
