import {expect,test,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {setupAssistant} from '../mcp-helpers.js';

const start={command:'securityRecovery',action:'start',channel:'COMMENT_NOTIFICATION'} as const;

test('verification input is available to the native operator only, even when the assistant has control permission',async()=>{
  const f=await setupAssistant();
  try{
    const calls=vi.spyOn(f.browser,'securityRecovery').mockImplementation(async(_command,_token,check)=>{
      check();return{sessionId:randomUUID(),channel:'COMMENT_NOTIFICATION',incidentId:randomUUID()};
    });
    const before=f.store.budgets(),readOnly=f.service.authority.issueSession(['READ']);
    await expect(f.service.dispatch(readOnly,start)).rejects.toThrow('OPERATOR_PERMISSION_DENIED');
    await expect(f.service.dispatch(f.token,start)).rejects.toThrow('ASSISTANT_CANNOT_CONTROL_VERIFICATION');
    expect(calls).not.toHaveBeenCalled();
    await expect(f.service.dispatch(f.gui,start)).resolves.toMatchObject({channel:'COMMENT_NOTIFICATION'});
    expect(calls).toHaveBeenCalledTimes(1);expect(calls.mock.calls[0]![1]).toBe(f.gui);
    expect(f.store.budgets()).toEqual(before);expect(f.calls()).toBe(0);expect(f.browser.clicks).toBe(0);
    calls.mockRestore();
  }finally{await f.close();}
});

test('the browser receives a live permission check rather than authority captured before a user session expires',async()=>{
  const f=await setupAssistant();
  try{
    const before=f.store.budgets();
    const calls=vi.spyOn(f.browser,'securityRecovery').mockImplementation(async(_command,_token,check)=>{
      check();f.service.authority.revoke(f.gui);check();
    });
    await expect(f.service.dispatch(f.gui,start)).rejects.toThrow('OPERATOR_EXPIRED');
    expect(calls).toHaveBeenCalledTimes(1);expect(f.store.budgets()).toEqual(before);
    expect(f.calls()).toBe(0);expect(f.browser.clicks).toBe(0);calls.mockRestore();
  }finally{await f.close();}
});

test('ordinary resume cannot race a manual verification lease and remove its stop',async()=>{
  const f=await setupAssistant();
  try{
    await f.service.dispatch(f.gui,{command:'emergencyStop'});
    const before=f.store.budgets(),active=vi.spyOn(f.browser,'manualRecoveryActive','get').mockReturnValue(true);
    await expect(f.service.dispatch(f.gui,{command:'resume',eventId:null})).rejects.toThrow('MANUAL_RECOVERY_IN_PROGRESS');
    expect(f.auto.state().emergencyStopped).toBe(true);expect(f.store.budgets()).toEqual(before);
    expect(f.calls()).toBe(0);expect(f.browser.clicks).toBe(0);active.mockRestore();
  }finally{await f.close();}
});
