import {expect,test,vi} from 'vitest';
import {recoveryError,recoveryPoint} from '../../desktop/src/security-recovery-input.js';
import type {ManualRecoveryFrame} from '../../src/app/manual-recovery-contracts.js';

const frame:ManualRecoveryFrame={sessionId:'session',frameId:'frame',width:1280,height:720,image:'local-only',expiresAt:10_000,
  documentPreserved:true,regions:[{x:400,y:200,width:400,height:300}]};

test('scaled CSS viewport coordinates remain accurate for pointer input and reject surrounding content',()=>{
  vi.spyOn(Date,'now').mockReturnValue(1000);
  const box={left:10,top:20,width:640,height:360};
  expect(recoveryPoint(frame,box,260,170)).toEqual({x:500,y:300});
  expect(recoveryPoint(frame,box,20,30)).toBeNull();
  expect(recoveryPoint(frame,box,650,100)).toBeNull();
  expect(recoveryPoint(frame,{...box,width:0},260,170)).toBeNull();
  expect(recoveryPoint(frame,box,Number.NaN,170)).toBeNull();
  vi.restoreAllMocks();
});

test('expired screenshots cannot become pointer commands',()=>{
  vi.spyOn(Date,'now').mockReturnValue(10_001);
  expect(recoveryPoint(frame,{left:0,top:0,width:1280,height:720},500,300)).toBeNull();
  vi.restoreAllMocks();
});

test('original-document and permission errors are readable without exposing raw private errors',()=>{
  expect(recoveryError('MANUAL_RECOVERY_ORIGINAL_PAGE_UNAVAILABLE')).toContain('无法继续操作这个现场');
  expect(recoveryError('MANUAL_RECOVERY_FRAME_EXPIRED')).toContain('画面已过期');
  expect(recoveryError('MANUAL_RECOVERY_INPUT_OUTSIDE_CHALLENGE')).toContain('验证区域');
  expect(recoveryError('OPERATOR_EXPIRED')).toContain('失去操作权限');
  expect(recoveryError(new Error('https://private.invalid/message?secret=private'))).not.toContain('private');
});
