import {z} from 'zod';
import {channelSchema} from '../core/contracts.js';
import {browserResourceReasons} from '../observability/browser-resource-contracts.js';
import type {AssistantToolRegistry} from './bridge-contracts.js';

const id=z.uuid(), count=z.number().int().nonnegative(), hash=z.string().regex(/^[a-f0-9]{64}$/u);
const code=z.string().regex(/^[A-Z][A-Z0-9_]{0,159}$/u);
const text=z.string().max(10_000), time=z.string().max(100).nullable();
const empty=z.object({}).strict();
const replyStatus=z.enum(['WAITING','REPLIED','NOT_REQUIRED','MANUAL_ONLY']);
export const previewSchema=z.object({previewId:hash.nullable(),state:z.enum(['READY','UNAVAILABLE']),
  reason:code.nullable(),width:count.nullable(),height:count.nullable()}).strict();
const draftSchema=z.object({id,version:count,text:z.string().max(2000),source:code}).strict();
const eventSchema=z.object({id,channel:channelSchema,text,author:z.string().max(1000).nullable(),occurredAt:time,
  quality:z.enum(['TEXT','UNVERIFIED']),replyStatus}).strict();
const messageSchema=z.object({id:z.string().max(300),eventId:id,direction:z.enum(['INCOMING','OUTGOING']),
  text,occurredAt:time,historical:z.boolean(),origin:z.enum(['OBSERVED','CONFIRMED']),previews:z.array(previewSchema).max(4)}).strict();
const timelineSchema=z.object({items:z.array(messageSchema).max(30),pageSize:z.literal(30),hasMore:z.boolean(),before:z.string().max(1000).nullable()}).strict();
export const threadSchema=z.object({event:eventSchema,draft:draftSchema.nullable(),contextVersion:hash,
  ownership:z.object({generation:count,isMine:z.boolean(),busy:z.boolean(),expiresAt:count}).strict(),
  timeline:timelineSchema,commentContext:timelineSchema.extend({items:z.array(messageSchema).max(31)}).nullable(),frozen:z.boolean()}).strict();
export const replySchema=z.object({kind:z.literal('reply'),eventId:id,selectionId:id,generation:count,
  expectedVersion:count,contextVersion:hash,draft:draftSchema.nullable()}).strict();
const syncSchema=z.object({runId:id.nullable(),running:z.boolean(),cancelled:z.boolean(),source:z.enum(['works','dm']).nullable(),
  results:z.array(z.object({source:z.enum(['works','dm']),state:code,error:code.nullable()}).strict()).max(2)}).strict();
export const statusSchema=z.object({runtime:z.string().min(1).max(1000),instanceId:id,connected:z.literal(true),
  accountConnected:z.boolean(),browser:z.object({state:code,mode:z.enum(['headed','headless']).nullable()}).strict(),
  automaticReply:z.boolean(),emergencyStopped:z.boolean(),budgets:z.array(z.object({kind:z.enum(['MODEL','SEND']),
    used:count,maximum:count.nullable()}).strict()).max(2),
  assistant:z.object({enabled:z.boolean(),grantVersion:count.nullable(),expiresAt:count.nullable(),
    permissions:z.object({read:z.boolean(),editControl:z.boolean(),send:z.boolean()}).strict(),
    remaining:z.object({MODEL:count.nullable(),SEND:count.nullable()}).strict(),reason:code.nullable()}).strict(),sync:syncSchema}).strict();
const usage=z.object({requests:count,knownUsageRequests:count,unknownUsageRequests:count,inputTokens:count,outputTokens:count,
  elapsedSamples:count,averageElapsedMs:z.number().nonnegative().nullable(),p95ElapsedMs:z.number().nonnegative().nullable()}).strict();
const memoryWindow=z.object({samples:count.max(1440),
  workingSetBytes:z.object({p50:count,p95:count,max:count}).strict(),
  privateBytes:z.object({p50:count,p95:count,max:count}).strict()}).strict();
export const browserResourcesSchema=z.object({state:z.enum(['WAITING','AVAILABLE','UNAVAILABLE','STALE','CLOSED']),
  reason:z.enum(browserResourceReasons).nullable(),
  intervalMs:count,sampledAt:count.nullable(),segmentStartedAt:count.nullable(),
  latest:z.object({workingSetBytes:count,privateBytes:count,browserProcesses:count,pageCount:count,elapsedMs:z.number().nonnegative()}).strict().nullable(),
  hour:memoryWindow.nullable(),run:memoryWindow.nullable()}).strict();
export const diagnosticsSchema=z.object({version:z.literal(1),timeRangeSupported:z.literal(false),
  model:z.object({total:usage,groups:z.array(usage.extend({model:z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/u),status:code})).max(100)}).strict(),
  blockers:z.array(z.object({source:code,code,count}).strict()).max(10),
  collection:z.object({channels:z.array(z.object({source:z.enum(['dm','works','UNKNOWN']),nextAt:count,lastSuccess:count.nullable(),
    lastError:code.nullable(),failures:count,elapsedMs:count.nullable()}).strict()).max(2),
    works:z.object({included:count,historical:count,review:count}).strict(),
    conversations:z.object({total:count,neverRead:count}).strict()}).strict(),
  browserResources:browserResourcesSchema.optional()}).strict();
const resultSchema=z.discriminatedUnion('kind',[
  replySchema,
  z.object({kind:z.literal('saved'),eventId:id,draft:draftSchema}).strict(),
  z.object({kind:z.literal('suggestion'),eventId:id,id,text:z.string().max(2000),stale:z.boolean()}).strict(),
  z.object({kind:z.literal('send'),commandId:id,status:code,intentId:id.nullable(),reason:code.nullable()}).strict(),
  z.object({kind:z.literal('sync'),runId:id.nullable()}).strict(),
  z.object({kind:z.literal('read'),marked:count}).strict(),
  z.object({kind:z.literal('automatic'),enabled:z.boolean()}).strict(),
  z.object({kind:z.literal('preview'),scheduled:z.boolean()}).strict(),
  z.object({kind:z.literal('stop'),emergencyStopped:z.literal(true)}).strict(),
  z.object({kind:z.literal('closed'),eventId:id}).strict(),
]);
export const operationSchema=z.object({operationId:id,tool:z.string().regex(/^inbora_[a-z_]+$/u),
  state:z.enum(['RUNNING','SUCCEEDED','FAILED','UNKNOWN']),eventId:id.nullable(),result:resultSchema.nullable(),
  error:code.nullable(),createdAt:count,updatedAt:count}).strict();
const operation={operationId:id};
const bound={eventId:id,selectionId:id,generation:count,contextVersion:hash};
const edit={...operation,...bound,expectedVersion:count};
export const assistantTools={
  inbora_get_status:{description:'Read body-free status of the running inbora client, backend instance, permissions, budgets and sync progress.',inputSchema:empty,outputSchema:statusSchema},
  inbora_list_inbox:{description:'Read a bounded inbox page within the connected client\'s current account, channels and collection range. The client must allow the local assistant connection.',
    inputSchema:z.object({channel:z.enum(['ALL','COMMENT_NOTIFICATION','DIRECT_MESSAGE']).default('ALL'),
      status:z.enum(['ALL','UNREAD','PENDING','MANUAL_ONLY','REVIEW','UNCERTAIN','CONFIRMED']).default('ALL'),page:count.max(100000).default(0)}).strict(),
    outputSchema:z.object({page:count,pageSize:z.literal(20),hasMore:z.boolean(),items:z.array(z.object({eventId:id,channel:channelSchema,
      author:z.string().max(1000).nullable(),text,time,unread:z.boolean(),replyStatus,
      resumeEventId:id.nullable(),previews:z.array(previewSchema).max(4)}).strict()).max(20)}).strict()},
  inbora_get_thread:{description:'Read the exact authorized thread, draft, bounded timeline, context version and editing ownership.',
    inputSchema:z.object({eventId:id,timelineBefore:z.string().min(1).max(300).optional()}).strict(),outputSchema:threadSchema},
  inbora_get_diagnostics:{description:'Read cumulative diagnostics without message bodies, targets, URLs or credentials.',inputSchema:empty,outputSchema:diagnosticsSchema},
  inbora_inspect_preview:{description:'Inspect private preview availability, dimensions and reasons only. Never returns an image, file path or URL.',
    inputSchema:z.object({eventId:id}).strict(),outputSchema:z.object({eventId:id,previews:z.array(previewSchema).max(4)}).strict()},
  inbora_sync_inbox:{description:'Start or join the authorized inbox sync. Poll get_operation and get_status for progress; do not resubmit after timeout.',
    inputSchema:z.object(operation).strict(),outputSchema:operationSchema},
  inbora_mark_all_read:{description:'Mark the authorized inbox read without changing reply status, drafts or receipts. New arrivals become unread.',
    inputSchema:z.object(operation).strict(),outputSchema:operationSchema},
  inbora_set_automatic_reply:{description:'Switch the existing automatic reply policy on or off within assistant control scope. Cannot create or enlarge policy.',
    inputSchema:z.object({...operation,enabled:z.boolean()}).strict(),outputSchema:operationSchema},
  inbora_refresh_preview:{description:'Schedule bounded refresh for an exact authorized preview. No image is returned or sent to a model.',
    inputSchema:z.object({...operation,eventId:id}).strict(),outputSchema:operationSchema},
  inbora_emergency_stop:{description:'Persist the global emergency stop. Does not resume it or grant any permission.',
    inputSchema:z.object(operation).strict(),outputSchema:operationSchema},
  inbora_open_reply:{description:'Open an independent assistant editing session for an exact text event. Never takes over an active GUI editor. Poll get_operation for versions.',
    inputSchema:z.object({...operation,eventId:id}).strict(),outputSchema:operationSchema},
  inbora_save_draft:{description:'Save an MCP_ASSISTED draft with exact ownership, context and draft versions. Cannot qualify media for human-only sending.',
    inputSchema:z.object({...edit,text:z.string().max(2000)}).strict(),outputSchema:operationSchema},
  inbora_generate_suggestion:{description:'Generate one text suggestion using the existing model permission and remaining global budgets; preserves the draft.',
    inputSchema:z.object(edit).strict(),outputSchema:operationSchema},
  inbora_send_reply:{description:'Submit text once within the connected client\'s current account, collection range and global budgets. operationId is the durable command ID. After timeout/restart query it; never retry with a new ID.',
    inputSchema:z.object({...edit,text:z.string().min(1).max(2000)}).strict(),outputSchema:operationSchema},
  inbora_get_operation:{description:'Query a previously accepted operation, including across disconnect/restart, without replay. Revocation redacts stored private results.',
    inputSchema:z.object(operation).strict(),outputSchema:operationSchema},
  inbora_close_reply:{description:'Release only this assistant session\'s matching editing lease. Preserves saved drafts and existing intents.',
    inputSchema:z.object({...operation,eventId:id,generation:count}).strict(),outputSchema:operationSchema},
} satisfies AssistantToolRegistry;
export type AssistantTool=keyof typeof assistantTools;
