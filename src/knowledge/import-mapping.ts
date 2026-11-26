import type {z} from 'zod';
import {requireSafe} from '../core/contracts.js';
import type {ParsedDocument} from './import-parser.js';
import type {SampleInput} from './contracts.js';

import type {importMappingSchema} from '../contracts/knowledge-import.js';
export {importMappingSchema} from '../contracts/knowledge-import.js';

export function mapChat(parsed:ParsedDocument,mapping:z.infer<typeof importMappingSchema>):SampleInput[]{
  return mapChatPreview(parsed,mapping).pairs;
}
export function mapChatPreview(parsed:ParsedDocument,mapping:z.infer<typeof importMappingSchema>){
  const fields=[mapping.speakerColumn,mapping.textColumn,mapping.conversationColumn,mapping.timeColumn].filter((field):field is string=>!!field);
  requireSafe(fields.every(field=>parsed.columns.includes(field))&&new Set(fields).size===fields.length,'KNOWLEDGE_MAPPING_REQUIRED');
  const groups=new Map<string,{speakers:Set<string>;pending:string[];reply:string[];pairs:SampleInput[]}>();
  let omitted=0,excluded=0;
  const rows=mapping.timeColumn?parsed.rows.map((row,index)=>{
    const value=row[mapping.timeColumn!]?.trim()??'';
    const stamp=/^\d{10}$|^\d{13}$/u.test(value)?Number(value)*(value.length===10?1000:1):
      /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/u.test(value)?Date.parse(value):NaN;
    requireSafe(Number.isFinite(stamp),'KNOWLEDGE_CHAT_TIME_INVALID');return{row,index,stamp};
  }).sort((a,b)=>a.stamp-b.stamp||a.index-b.index).map(item=>item.row):parsed.rows;
  const finish=(state:{pending:string[];reply:string[];pairs:SampleInput[]},group:string)=>{
    if(state.pending.length&&state.reply.length){
      const prompt=state.pending.join('\n'),response=state.reply.join('\n');
      if(prompt.length<=4000&&response.length<=2000)state.pairs.push({channel:mapping.channel,prompt,response,source:'IMPORTED',group});
      else omitted++;
    }
    state.pending=[];state.reply=[];
  };
  for(const row of rows){
    const group=mapping.conversationColumn?row[mapping.conversationColumn]??'':'import';
    const speaker=row[mapping.speakerColumn]?.trim(),text=row[mapping.textColumn]?.trim();
    requireSafe(group.length>0&&speaker&&text,'KNOWLEDGE_CHAT_ROLE_REQUIRED');
    let state=groups.get(group);if(!state){state={speakers:new Set(),pending:[],reply:[],pairs:[]};groups.set(group,state);}
    state.speakers.add(speaker);
    if(speaker===mapping.selfName){
      if(state.pending.length)state.reply.push(text);
    }else{if(state.reply.length)finish(state,group);state.pending.push(text);}
  }
  const pairs:SampleInput[]=[];
  for(const [id,group]of groups){finish(group,id);
    if(group.speakers.size===2&&group.speakers.has(mapping.selfName))pairs.push(...group.pairs);else excluded++;
  }
  requireSafe(pairs.length>0,'KNOWLEDGE_NO_PAIRED_SAMPLES');
  const warnings:string[]=[];
  if(omitted)warnings.push(`${omitted} 组问答超过长度上限，已整组略过，未截断学习。`);
  if(excluded)warnings.push(`${excluded} 个会话不是准确的双方对话，已排除。`);
  if(!mapping.timeColumn)warnings.push('未选择时间列，按文件中的原始行顺序配对。');
  return{pairs,warnings};
}
