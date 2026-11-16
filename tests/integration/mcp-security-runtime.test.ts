import {randomUUID} from 'node:crypto';
import {expect,test} from 'vitest';
import {AssistantFacade} from '../../src/mcp/assistant-facade.js';
import {statusSchema} from '../../src/mcp/tool-contracts.js';
import {securityRuntime} from '../../src/app/security-runtime.js';
import {holdSecurityChannel,readSecurityHold} from '../../src/storage/security-holds.js';
import {setupAssistant} from '../mcp-helpers.js';

test('MCP reports loaded rules for its exact backend instance and projects only hold metadata',async()=>{
  const f=await setupAssistant(),facade=new AssistantFacade(f.service),session=randomUUID();
  try{
    const before=f.store.budgets(),incidentId=randomUUID();
    const hold=holdSecurityChannel(f.store,'COMMENT_NOTIFICATION',{incidentId,reason:'OBSERVATION_SECURITY_SUSPECT',mode:'headless',
      source:'COLLECTION_COMMENTS',documentDigest:'ab'.repeat(32)});
    const result=statusSchema.parse(await facade.dispatch(session,'inbora_get_status',{}));
    expect(result.securityRuntime).toEqual(securityRuntime(result.instanceId));
    expect(result.securityHolds).toEqual([{channel:hold.channel,reason:hold.reason,incidentId,revision:hold.revision,heldAt:hold.heldAt,mode:'headless'}]);
    expect(readSecurityHold(f.store,'COMMENT_NOTIFICATION')?.documentDigest).toBe('ab'.repeat(32));
    expect(JSON.stringify(result.securityHolds)).not.toMatch(/documentDigest|"source"|"href"|"url"/u);
    expect(JSON.stringify(result)).not.toMatch(/"href"|"url"|hello|Synthetic assistant reply/u);
    expect(f.store.budgets()).toEqual(before);expect(f.browser.clicks).toBe(0);
  }finally{await facade.close();await f.close();}
});
