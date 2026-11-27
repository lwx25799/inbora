import type {
  KnowledgeInput,
  KnowledgeOverview,
  OnnxEmbeddingStatus,
  RetrievalDebugResult,
} from '../../src/contracts/knowledge.js';
import type {Channel} from '../../src/contracts/events.js';
import {request,desktopInfo} from './api.js';
import {explainSafe} from './error-messages.js';

export type {OnnxEmbeddingStatus,RetrievalDebugResult};

export interface ChatImportMapping {
  speakerColumn:string;
  textColumn:string;
  conversationColumn?:string;
  timeColumn?:string;
  selfName:string;
  channel:Channel;
}
export interface ImportPreview {
  id:string;name:string;kind:'KNOWLEDGE'|'CHAT';textPreview:string;
  columns:string[];rows:Record<string,string>[];totalRows:number;warnings:string[];
}
export type KnowledgeAction=
  | {action:'overview';page?:number}
  | {action:'saveKnowledge';input:KnowledgeInput&{aliases:string[];channels:Channel[]}}
  | {action:'setKnowledgeState';id:string;state:'ACTIVE'|'DISABLED'}
  | {action:'deleteSource';sourceId:string}
  | {action:'selectSamples';ids:string[];accepted:boolean}
  | {action:'collectCandidates'}
  | {action:'savePersona';text:string;sampleIds:string[]}
  | {action:'publishPersona';id:string}
  | {action:'analyze';sampleIds:string[];taskId?:string;confirmed:true}
  | {action:'tryReply';channel:Channel;message:string;sourceIds:string[];personaVersionId:string|null;
      comparePersonaVersionId?:string|null;confirmed:true}
  | {action:'debugRetrieval';channel:Channel;query:string;sourceIds?:string[];minScore?:number}
  | {action:'embeddingStatus'}
  | {action:'importStart';name:string;bytes:number;kind:'KNOWLEDGE'|'CHAT'}
  | {action:'importChunk';id:string;index:number;data:string}
  | {action:'importFinish';id:string}
  | {action:'importPreviewMapping';id:string;mapping:ChatImportMapping}
  | {action:'importCommit';id:string;mapping?:ChatImportMapping}
  | {action:'importCancel';id:string};

export async function knowledgeRequest<T>(body:KnowledgeAction):Promise<T> {
  if(body.action==='overview'&&(await desktopInfo()).features?.replyKnowledge!==true)
    throw new Error('KNOWLEDGE_NATIVE_UPDATE_REQUIRED');
  return request<T>({command:'replyKnowledge',...body});
}
export type PerformKnowledge=<T>(label:string,action:KnowledgeAction|(()=>Promise<T>),onSuccess?:(result:T)=>void,refresh?:boolean)=>Promise<void>;
export interface KnowledgePanelProps {overview:KnowledgeOverview;busy:boolean;perform:PerformKnowledge}
export const channelName=(channel:string)=>channel==='DIRECT_MESSAGE'?'私信':'评论';
export const sourceNames:Record<string,string>={HUMAN_TYPED:'本人输入',HUMAN_FOLLOWUP:'本人后续回复',IMPORTED:'外部导入',
  OBSERVED_UNKNOWN:'网页回复，来源待确认',AI_ASSISTED_APPROVED:'AI辅助后确认',MCP_ASSISTED:'助手辅助',AUTO_POLICY:'自动回复',LEGACY:'历史来源待确认'};
export const formatDate=(value:number|null)=>value===null?'未设置':new Date(value).toLocaleString('zh-CN',{hour12:false});

export function describeKnowledgeError(error:unknown):string {
  return explainSafe(error,'本次操作未完成，已有资料和当前输入保留。请重新读取状态后再试。');
}
