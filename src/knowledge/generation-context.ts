import {digest,requireSafe,type InboundEvent} from '../core/contracts.js';
import type {AiSettings} from '../app/contracts.js';
import type {EventStore} from '../storage/store.js';
import {ReplyKnowledgeStore} from './store.js';
import {knowledgeLimits,type ReplyKnowledgeContext} from './contracts.js';

export const privateModelText=(text:string)=>/[\w.+-]+@[\w.-]+\.\w+|\b\d{11,19}\b|(?:密码|验证码|身份证|银行卡)\s*[:：]\s*\S+/iu.test(text);
export const sensitiveModelOutputTerms=/转账|验证码|密码|身份证|银行卡|金钱|password|verification|payment/iu;
export const unsafeModelOutput=(text:string)=>{
  const normalized=text.normalize('NFKC');
  return privateModelText(text)||privateModelText(normalized)||/https?:\/\//iu.test(normalized)||sensitiveModelOutputTerms.test(normalized);
};
export const replySettingsFingerprint=(settings:AiSettings,persona:string|undefined,rules=settings.rules)=>
  digest({...settings,persona:persona||settings.persona,rules});
export function assertKnowledgePromptSafe(context:ReplyKnowledgeContext,event?:Pick<InboundEvent,'accountId'|'channel'|'text'>):void{
  if(event)requireSafe(context.accountId===event.accountId&&context.channel===event.channel&&context.query===event.text,'KNOWLEDGE_CONTEXT_MISMATCH');
  requireSafe(context.conflicts.length===0,'KNOWLEDGE_CONFLICT');
  requireSafe(context.knowledge.length<=knowledgeLimits.knowledgeCount&&context.examples.length<=knowledgeLimits.exampleCount&&
    Array.from(context.persona).length<=knowledgeLimits.personaCharacters&&
    context.knowledge.reduce((n,item)=>n+Array.from(item.text).length,0)<=knowledgeLimits.knowledgeCharacters&&
    context.examples.reduce((n,item)=>n+Array.from(item.prompt+item.response).length,0)<=knowledgeLimits.exampleCharacters,
    'KNOWLEDGE_CONTEXT_TOO_LARGE');
  requireSafe(!privateModelText([context.persona,...context.knowledge.map(item=>item.text),
    ...context.examples.flatMap(item=>[item.prompt,item.response])].join('\n')),'SENSITIVE_MANUAL_HANDLING');
}
export function knowledgePromptData(context:ReplyKnowledgeContext){
  return{knowledge:context.knowledge.map((item,index)=>({source:'K'+(index+1),text:item.text})),
    styleExamples:context.examples.map(item=>({question:item.prompt,reply:item.response,channel:item.channel}))};
}
export function assertReplyKnowledgeCurrent(store:EventStore,context:ReplyKnowledgeContext|null|undefined):void{
  if(!context)return;
  requireSafe(new ReplyKnowledgeStore(store).isCurrent(context),'KNOWLEDGE_CONTEXT_CHANGED');
}
function hasBindings(store:EventStore):boolean{
  return !!store.db.prepare("SELECT name FROM sqlite_master WHERE name='k_generation_contexts'").get();
}
export function bindReplyKnowledge(store:EventStore,kind:'SUGGESTION'|'DRAFT',id:string,version:number,context:ReplyKnowledgeContext|null|undefined):void{
  if(!context)return;assertReplyKnowledgeCurrent(store,context);
  requireSafe(hasBindings(store),'KNOWLEDGE_MIGRATION_REQUIRED');
  const snapshot={...context,persona:'',knowledge:[],examples:[],conflicts:[]};
  store.db.prepare('INSERT INTO k_generation_contexts VALUES(?,?,?,?)').run(kind,id,version,JSON.stringify(snapshot));
}
function boundContext(store:EventStore,kind:'SUGGESTION'|'DRAFT',id:string,version:number):ReplyKnowledgeContext|null{
  if(!hasBindings(store))return null;
  const row=store.db.prepare('SELECT snapshot_json FROM k_generation_contexts WHERE kind=? AND entity_id=? AND version=?')
    .get(kind,id,version) as {snapshot_json:string}|undefined;
  if(!row)return null;
  let context:ReplyKnowledgeContext;try{context=JSON.parse(row.snapshot_json) as ReplyKnowledgeContext;
    requireSafe(context&&typeof context.fingerprint==='string'&&Array.isArray(context.knowledge)&&Array.isArray(context.examples),
      'KNOWLEDGE_CONTEXT_INVALID');}catch{requireSafe(false,'KNOWLEDGE_CONTEXT_INVALID');}
  return context;
}
export function bindSuggestionLearningToDraft(store:EventStore,suggestionId:string,draftId:string,version:number):void{
  if(!hasBindings(store))return;
  const row=store.db.prepare("SELECT version FROM k_generation_contexts WHERE kind='SUGGESTION' AND entity_id=? ORDER BY version DESC LIMIT 1")
    .get(suggestionId) as {version:number}|undefined;
  if(row)bindReplyKnowledge(store,'DRAFT',draftId,version,boundContext(store,'SUGGESTION',suggestionId,row.version));
}
/** Invoked again by the transactional dispatch guard immediately before the intent is committed. */
export function assertDraftLearningCurrent(store:EventStore,draftId:string,version:number):void{
  if(store.db.prepare('SELECT id FROM send_intents WHERE draft_id=?').get(draftId))return;
  assertReplyKnowledgeCurrent(store,boundContext(store,'DRAFT',draftId,version));
}
