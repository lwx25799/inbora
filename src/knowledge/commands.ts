import {z} from 'zod';
import {knowledgeInputSchema} from './contracts.js';
import {importMappingSchema} from './import-mapping.js';

const uuid=z.uuid(),ids=z.array(uuid).max(1000),channel=z.enum(['DIRECT_MESSAGE','COMMENT_NOTIFICATION']);
const command={command:z.literal('replyKnowledge')};
const actions=z.discriminatedUnion('action',[
  z.object({...command,action:z.literal('overview'),page:z.number().int().min(0).max(100000).optional()}).strict(),
  z.object({...command,action:z.literal('saveKnowledge'),input:knowledgeInputSchema}).strict(),
  z.object({...command,action:z.literal('setKnowledgeState'),id:uuid,state:z.enum(['ACTIVE','DISABLED'])}).strict(),
  z.object({...command,action:z.literal('deleteSource'),sourceId:uuid}).strict(),
  z.object({...command,action:z.literal('selectSamples'),ids,accepted:z.boolean()}).strict(),
  z.object({...command,action:z.literal('collectCandidates')}).strict(),
  z.object({...command,action:z.literal('savePersona'),text:z.string().min(1).max(2000),sampleIds:ids}).strict(),
  z.object({...command,action:z.literal('publishPersona'),id:uuid}).strict(),
  z.object({...command,action:z.literal('analyze'),sampleIds:ids,taskId:uuid.optional(),confirmed:z.literal(true)}).strict(),
  z.object({...command,action:z.literal('tryReply'),channel,message:z.string().trim().min(1).max(4000),sourceIds:ids,
    personaVersionId:uuid.nullable(),comparePersonaVersionId:uuid.nullable().optional(),confirmed:z.literal(true)}).strict(),
  z.object({...command,action:z.literal('importStart'),name:z.string().min(1).max(200),bytes:z.number().int().positive().max(20*1024*1024),
    kind:z.enum(['KNOWLEDGE','CHAT'])}).strict(),
  z.object({...command,action:z.literal('importChunk'),id:uuid,index:z.number().int().min(0),data:z.string().max(65536)}).strict(),
  z.object({...command,action:z.literal('importFinish'),id:uuid}).strict(),
  z.object({...command,action:z.literal('importPreviewMapping'),id:uuid,mapping:importMappingSchema}).strict(),
  z.object({...command,action:z.literal('importCommit'),id:uuid,mapping:importMappingSchema.optional()}).strict(),
  z.object({...command,action:z.literal('importCancel'),id:uuid}).strict(),
]);
export const knowledgeCommandSchema=actions;
export type KnowledgeCommand=z.infer<typeof actions>;
