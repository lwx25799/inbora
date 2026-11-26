import type {Page} from 'playwright';
import {z} from 'zod';
import {Blocked} from '../core/contracts.js';

const coordinate=z.number().finite();
const geometry={left:coordinate,top:coordinate,right:coordinate,bottom:coordinate};
export const securitySignalSchema=z.object({
  version:z.literal(1),state:z.enum(['CLEAR','SUSPECT']),
  href:z.string().max(2048),origin:z.string().max(256),title:z.string().max(160),
  documentStartedAt:z.number().finite().nonnegative(),observedAt:z.number().finite().nonnegative(),
  kind:z.enum(['TITLE','COMPONENT']),
  scope:z.enum(['TARGET','ACCOUNT_PAGE']).optional(),
  target:z.object({workId:z.string().max(64).optional(),conversationId:z.string().max(512).optional()}).optional(),
  matches:z.array(z.object({selector:z.string().max(2000),tag:z.string().max(24),id:z.string().max(160),
    visible:z.boolean(),...geometry})).max(12),
  frames:z.array(z.object({src:z.string().max(2048),title:z.string().max(160),...geometry})).max(8),
});
export type SecuritySignal=z.infer<typeof securitySignalSchema>;
type Observer=(signal:SecuritySignal|null)=>Promise<void>;
const observers=new WeakMap<Page,Observer>();
const prefix='INBORA_SECURITY_SIGNAL:';

/** The observer runs before the account task releases its page. Never use raw error text outside this boundary. */
export function registerSecurityObserver(page:Page,observer:Observer):()=>void {
  observers.set(page,observer);return()=>{if(observers.get(page)===observer)observers.delete(page);};
}
export function parseSecuritySignal(error:unknown):SecuritySignal|null {
  if(!(error instanceof Error)||error.message.length>50_000)return null;
  const at=error.message.indexOf(prefix);if(at<0)return null;
  try{
    const raw=error.message.slice(at+prefix.length).split('\n')[0]!;
    const result=securitySignalSchema.safeParse(JSON.parse(raw));return result.success?result.data:null;
  }catch{return null;}
}
export function isSecurityFailure(error:unknown):boolean {
  return error instanceof Error&&(/OBSERVATION_SECURITY_(?:SUSPECT|TITLE|COMPONENT)/u.test(error.message)||error.message.includes(prefix));
}
/** Always replaces a private browser envelope with a fixed error, even when recording fails. */
export async function reportSecurityFailure(page:Page,error:unknown):Promise<never> {
  if(!isSecurityFailure(error))throw error;
  try{await observers.get(page)?.(parseSecuritySignal(error));}
  finally{throw new Blocked('OBSERVATION_SECURITY_SUSPECT');}
}
