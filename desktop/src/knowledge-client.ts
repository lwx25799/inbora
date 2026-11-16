import type {KnowledgeInput,KnowledgeOverview} from '../../src/knowledge/contracts.js';
import type {Channel} from '../../src/core/contracts.js';
import {request} from './api.js';

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
  | {action:'importStart';name:string;bytes:number;kind:'KNOWLEDGE'|'CHAT'}
  | {action:'importChunk';id:string;index:number;data:string}
  | {action:'importFinish';id:string}
  | {action:'importPreviewMapping';id:string;mapping:ChatImportMapping}
  | {action:'importCommit';id:string;mapping?:ChatImportMapping}
  | {action:'importCancel';id:string};

export function knowledgeRequest<T>(body:KnowledgeAction):Promise<T> {
  return request<T>({command:'replyKnowledge',...body});
}
export type PerformKnowledge=<T>(label:string,action:KnowledgeAction|(()=>Promise<T>),onSuccess?:(result:T)=>void,refresh?:boolean)=>Promise<void>;
export interface KnowledgePanelProps {overview:KnowledgeOverview;busy:boolean;perform:PerformKnowledge}
export const channelName=(channel:string)=>channel==='DIRECT_MESSAGE'?'私信':'评论';
export const sourceNames:Record<string,string>={HUMAN_TYPED:'本人输入',HUMAN_FOLLOWUP:'本人后续回复',IMPORTED:'外部导入',
  OBSERVED_UNKNOWN:'网页回复，来源待确认',AI_ASSISTED_APPROVED:'AI辅助后确认',MCP_ASSISTED:'助手辅助',AUTO_POLICY:'自动回复',LEGACY:'历史来源待确认'};
export const formatDate=(value:number|null)=>value===null?'未设置':new Date(value).toLocaleString('zh-CN',{hour12:false});

export function describeKnowledgeError(error:unknown):string {
  const code=typeof error==='string'?error:error instanceof Error?error.message:'';
  const known:Record<string,string>={
    KNOWLEDGE_NOT_AVAILABLE:'知识与人格资料尚未就绪，请重新读取。',
    KNOWLEDGE_NOT_READY:'知识存储尚未就绪，请重新连接运行目录后读取。',
    KNOWLEDGE_MIGRATION_REQUIRED:'知识存储尚未升级。请重新连接运行目录，由应用完成备份与升级。',
    KNOWLEDGE_VERSION_CONFLICT:'条目已被更新。你的输入保留，请重新读取后核对版本。',
    KNOWLEDGE_ACCOUNT_REQUIRED:'请先连接并核验本人账号。',
    ACCOUNT_NOT_BOUND:'尚未绑定本人账号，请先完成账号连接与核验。',
    ACCOUNT_NOT_VERIFIED:'当前本人账号尚未核验，或与已保存许可不一致。请先完成账号核验。',
    ACCOUNT_IDENTITY_MISMATCH:'当前账号与许可不一致，请核对本人账号后再继续。',
    KNOWLEDGE_NOT_FOUND:'此知识条目已不存在，请重新读取。',
    KNOWLEDGE_SOURCE_NOT_FOUND:'此来源已被删除，请重新读取。',
    KNOWLEDGE_SOURCE_INVALID:'来源不可用，请重新读取后选择有效来源。',
    KNOWLEDGE_SOURCE_SELECTION_INVALID:'所选知识来源已变化，请重新选择来源。',
    KNOWLEDGE_INVALID_DATES:'生效时间必须早于到期时间，请修改日期后保存。',
    INVALID_COMMAND:'输入格式不符合要求，请检查必填项、文字长度、关键词数量和文件大小。',
    KNOWLEDGE_MODEL_NOT_AUTHORIZED:'当前模型许可不可用，请核对已保存的模型配置和剩余额度。',
    REAL_MODEL_AUTHORIZATION_REQUIRED:'请先在 AI 与设置中配置模型 Key，并启用覆盖本账号和通道的模型许可或自动回复策略。',
    MODEL_GRANT_EXHAUSTED:'剩余模型额度不足以完成本次操作。请在 AI 与设置中调整额度后再继续；已完成的分析批次会保留。',
    MODEL_BUDGET_EXHAUSTED:'应用累计模型额度已用尽，请在 AI 与设置中调整模型额度。',
    MODEL_CHANNEL_NOT_AUTHORIZED:'当前模型许可未覆盖所选通道，请核对许可范围或调整样本、试聊通道。',
    KNOWLEDGE_MODEL_BUSY:'已有模型任务进行中，请等待完成后再继续。',
    PERSONA_ANALYSIS_PENDING:'此分析正在进行，请等待完成后重新读取。',
    PERSONA_TASK_SELECTION_CHANGED:'已采纳样本或模型已变化，无法继续旧分析。请点击“从已采纳样本学习”重新学习。',
    PERSONA_TASK_RESULT_UNAVAILABLE:'上次分析结果已失效，请重新学习并检查候选人格。',
    PERSONA_SAMPLES_REQUIRED:'还没有可用于学习的本人样本，请先在聊天样本中采纳有效回复。',
    PERSONA_SAMPLE_SELECTION_INVALID:'关联样本已被排除或删除，请重新选择样本并学习。',
    PERSONA_SAMPLE_LIMIT:'关联样本超过200组，请减少后再保存。',
    PERSONA_TEXT_INVALID:'人格内容不能为空且最多2000字，请修改后保存。',
    PERSONA_VERSION_INVALID:'此人格版本或关联来源已失效，请重新学习或保存有效草稿。',
    PERSONA_MODEL_FORMAT_INVALID:'模型未返回可用的人格格式，未发布。可继续上次分析，仍会计入模型额度。',
    KNOWLEDGE_CONTEXT_CHANGED:'生成期间知识、人格或样本已变化。请重新读取后再次试聊。',
    KNOWLEDGE_CONFLICT:'检索到的知识存在冲突，请先核对并停用过期条目。',
    KNOWLEDGE_SENSITIVE_CONTENT:'资料包含敏感内容，请先在本地预览中检查并排除。',
    SENSITIVE_MANUAL_HANDLING:'必要片段含敏感信息，已阻止外发。请在本地修改或排除相关内容后再试。',
    MODEL_SENSITIVE_OUTPUT:'模型结果包含不适合保留的敏感内容，未发布。请检查样本后再试。',
    KNOWLEDGE_IMPORT_TOO_LARGE:'文件超过20 MiB，请拆分后再导入。',
    KNOWLEDGE_FILE_TOO_LARGE:'文件为空或超过20 MiB，请选择有效文件或拆分后导入。',
    KNOWLEDGE_BATCH_TOO_LARGE:'待确认导入文件合计超过100 MiB，请先确认或取消已有预览。',
    KNOWLEDGE_TOO_MANY_UPLOADS:'待确认文件已达20个，请先确认或取消已有预览。',
    KNOWLEDGE_FORMAT_UNSUPPORTED:'不支持此格式，请使用界面列出的文件类型。',
    KNOWLEDGE_UPLOAD_NOT_FOUND:'此导入预览已失效，请重新选择文件并解析。',
    KNOWLEDGE_UPLOAD_ORDER:'文件上传顺序异常，请取消本次导入后重新解析。',
    KNOWLEDGE_INVALID_CHUNK:'文件片段校验失败，请重新选择文件并解析。',
    KNOWLEDGE_UPLOAD_SIZE:'文件片段与声明大小不符，请重新选择文件并解析。',
    KNOWLEDGE_UPLOAD_INCOMPLETE:'文件尚未完整上传，请取消本次导入后重新解析。',
    KNOWLEDGE_IMPORT_BUSY:'文件仍在解析，请等待完成后继续。',
    KNOWLEDGE_IMPORT_PREVIEW_REQUIRED:'请先解析文件并核对预览，再确认导入。',
    KNOWLEDGE_MAPPING_PREVIEW_REQUIRED:'字段映射已变化，请重新预览问答配对后再确认导入。',
    KNOWLEDGE_MAPPING_REQUIRED:'请选择发言人列和正文列，并填写本人发言人名称。',
    KNOWLEDGE_CHAT_ROLE_REQUIRED:'无法确认本人发言，请核对发言人列与本人名称。',
    KNOWLEDGE_CHAT_TIME_INVALID:'时间列包含无效日期。请改为 ISO 日期时间或 Unix 时间戳，或不选择时间列以按文件顺序导入。',
    KNOWLEDGE_NO_PAIRED_SAMPLES:'未找到“对方来信、本人回复”的有效配对，请核对本人名称、正文列和会话列。',
    KNOWLEDGE_UTF8_REQUIRED:'文本文件需要 UTF-8 编码，请另存为 UTF-8 后重新导入。',
    KNOWLEDGE_INVALID_JSON:'JSON 内容无法解析，请检查格式后重新导入。',
    KNOWLEDGE_JSON_ARRAY_REQUIRED:'JSON 文件须为记录对象组成的数组；逐行对象请使用 JSONL。',
    KNOWLEDGE_JSON_UNSAFE_NUMBER:'JSON 含超出精确范围的数字。请让导出程序将长账号或会话编号保存为带引号的字符串后重新导入。',
    KNOWLEDGE_INVALID_CHAT_ROWS:'聊天记录每行须为对象，发言人和正文使用文字字段。',
    KNOWLEDGE_DUPLICATE_COLUMNS:'表格列名重复，请改为不同列名后重新导入。',
    KNOWLEDGE_TOO_MANY_COLUMNS:'文件超过100列，请保留必要列后重新导入。',
    KNOWLEDGE_TOO_MANY_ROWS:'文件超过10万行，请拆分后重新导入。',
    KNOWLEDGE_TABLE_TOO_LARGE:'表格超过10万行或100列，请拆分并保留必要列。',
    KNOWLEDGE_TEXT_TOO_LARGE:'提取文字超过400万字，请拆分文件后重新导入。',
    KNOWLEDGE_TOO_MANY_PAGES:'PDF 超过500页，请拆分后重新导入。',
    KNOWLEDGE_ARCHIVE_TOO_LARGE:'文档解压体积过大，请拆分或另存为纯文本后导入。',
    KNOWLEDGE_INVALID_ARCHIVE:'文档结构无法识别，请重新保存为 DOCX 或 XLSX 后导入。',
    KNOWLEDGE_ACTIVE_CONTENT_UNSUPPORTED:'文档包含宏或外部链接，请移除后导入，或另存为纯文本。',
    KNOWLEDGE_NO_TEXT:'未提取到文字。扫描 PDF 请先在本机转成文字文件后导入。',
    KNOWLEDGE_PARSE_TIMEOUT:'文件解析超时，请拆分为较小文件后重试。',
    KNOWLEDGE_PARSE_CANCELLED:'文件解析已取消，请重新选择文件后解析。',
    KNOWLEDGE_PARSE_FAILED:'文件无法解析。请检查是否损坏或加密；扫描 PDF 需先转成文字。',
    MODEL_KEY_REQUIRED:'请先配置模型 Key。',
    INVALID_MODEL_KEY:'模型 Key 不可用，请在 AI 与设置中重新配置。',
    MODEL_PAUSED:'模型配置或运行状态已变化，本次任务停止。请核对配置后继续。',
    MODEL_CANCELLED:'本次模型任务已取消，已完成的分析批次保留。',
    GRANT_REVOKED:'模型许可已撤销或变化，请核对当前许可后继续。',
    EMERGENCY_STOPPED:'全局急停已生效。请在 AI 与设置的故障处理区域明确恢复后继续。',
    SECURITY_CHANNEL_HELD:'所选通道存在平台安全验证，请按应用提示完成本人处理后继续。',
    SECURITY_STATE_CHANGED:'通道安全状态已变化，请重新读取当前状态后继续。',
    CLIENT_CLOSING:'运行目录正在断开，请连接完成后重新读取。',
    MODEL_FAILED_NO_RETRY:'模型请求失败，未自动重试。已发布人格和知识保持。',
  };
  return known[code]??'本次操作未完成，已有资料和当前输入保留。请重新读取状态后再试。';
}
