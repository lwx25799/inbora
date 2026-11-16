import {afterEach,expect,test,vi} from 'vitest';

afterEach(()=>{vi.doUnmock('../../src/adapters/security-components.js');vi.doUnmock('../../src/storage/security-holds.js');vi.resetModules();});

test('runtime fingerprint is stable within a loaded generation and follows the actual loaded detector',async()=>{
  const initial=await import('../../src/app/security-runtime.js');
  const first=initial.securityRuntime('instance-a');
  expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  expect(initial.securityRuntime('instance-b')).toEqual({...first,instanceId:'instance-b'});
  expect(first.ruleVersion).toBe(initial.securityRuleVersion);

  vi.resetModules();
  vi.doMock('../../src/adapters/security-components.js',()=>({
    hasVisibleSecurityComponent:function changedLoadedDetector(){return false;},
  }));
  const changed=await import('../../src/app/security-runtime.js');
  expect(changed.securityRuntime('instance-a').fingerprint).not.toBe(first.fingerprint);
  expect(initial.securityRuntime('instance-a')).toEqual(first);
});

test('changing the loaded persistent gate changes the runtime fingerprint',async()=>{
  const initial=await import('../../src/app/security-runtime.js'),before=initial.securityRuntime('instance-a');
  vi.resetModules();
  vi.doMock('../../src/storage/security-holds.js',async importOriginal=>{
    const original=await importOriginal<typeof import('../../src/storage/security-holds.js')>();
    return {...original,assertSecurityChannelClear:function changedPersistentGate(){throw Error('SYNTHETIC_CHANGED_GATE');}};
  });
  const changed=await import('../../src/app/security-runtime.js');
  expect(changed.securityRuntime('instance-a').fingerprint).not.toBe(before.fingerprint);
  expect(initial.securityRuntime('instance-a')).toEqual(before);
});
