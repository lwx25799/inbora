import {z} from 'zod';

export const manualRecoveryInputSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('pointer'),phase:z.enum(['down','move','up']),
    x:z.number().finite().min(0).max(16384),y:z.number().finite().min(0).max(16384)}).strict(),
  z.object({kind:z.literal('text'),text:z.string().min(1).max(100)}).strict(),
  z.object({kind:z.literal('key'),key:z.enum(['Backspace','Delete','ArrowLeft','ArrowRight','Home','End','Enter'])}).strict(),
]);
export type ManualRecoveryInput=z.infer<typeof manualRecoveryInputSchema>;
const session={sessionId:z.uuid()};
export const manualRecoveryCommandSchema=z.discriminatedUnion('action',[
  z.object({command:z.literal('securityRecovery'),action:z.literal('start'),
    channel:z.enum(['COMMENT_NOTIFICATION','DIRECT_MESSAGE'])}).strict(),
  z.object({command:z.literal('securityRecovery'),action:z.literal('frame'),...session}).strict(),
  z.object({command:z.literal('securityRecovery'),action:z.literal('input'),...session,frameId:z.uuid(),
    sequence:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),input:manualRecoveryInputSchema}).strict(),
  z.object({command:z.literal('securityRecovery'),action:z.literal('finish'),...session}).strict(),
  z.object({command:z.literal('securityRecovery'),action:z.literal('close'),...session}).strict(),
]);
export type ManualRecoveryCommand=z.infer<typeof manualRecoveryCommandSchema>;
export interface ManualRecoverySession {
  sessionId:string;channel:'COMMENT_NOTIFICATION'|'DIRECT_MESSAGE';incidentId:string;
  recreated?:boolean;
}
export type ManualRecoveryStart=ManualRecoverySession|{state:'CLEARED'};
export type ManualRecoveryStatus = Pick<ManualRecoverySession, 'channel' | 'incidentId'> & { active: true };
export interface ManualRecoveryRegion {x:number;y:number;width:number;height:number}
export interface ManualRecoveryFrame {
  sessionId:string;frameId:string;image:string;width:number;height:number;
  regions:ManualRecoveryRegion[];expiresAt:number;documentPreserved:true;
}
export type ManualRecoveryResult = ManualRecoveryStart | ManualRecoveryFrame | { accepted: true } | void;
