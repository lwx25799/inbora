import {z} from 'zod';
import {channelsSchema} from './automation-contracts.js';

export const localAssistantScopeSchema=z.object({
  ownId:z.string().min(1).max(300),channels:channelsSchema,
  permissions:z.object({read:z.boolean(),editControl:z.boolean(),send:z.boolean()}).strict(),
  expiresAt:z.number().int().positive().nullable(),modelLimit:z.number().int().min(0).max(1_000_000).nullable(),
  sendLimit:z.number().int().min(0).max(1_000_000).nullable(),
}).strict().refine(scope=>!scope.permissions.send||scope.permissions.read&&scope.permissions.editControl&&
  (scope.sendLimit===null||scope.sendLimit>0),
  'ASSISTANT_SEND_PERMISSIONS_REQUIRED');
export type LocalAssistantScope=z.infer<typeof localAssistantScopeSchema>;
export const localAssistantStoredScopeSchema=localAssistantScopeSchema.safeExtend({
  collection:z.object({startedAt:z.number().int().positive(),comments:z.boolean(),inbox:z.boolean(),
    workIds:z.array(z.string().min(1).max(64)).max(10000)}).strict(),
});
export type LocalAssistantStoredScope=z.infer<typeof localAssistantStoredScopeSchema>;
export interface LocalAssistantGrant {version:number;kind:'LOCAL_ASSISTANT';scope:LocalAssistantStoredScope;createdAt:number}
export interface LocalAssistantState {
  grant:LocalAssistantGrant|null;used:{MODEL:number;SEND:number};remaining:{MODEL:number|null;SEND:number|null};
  reason:string|null;connectionEnabled:boolean;
}
export type LocalAssistantPermission=keyof LocalAssistantScope['permissions'];
