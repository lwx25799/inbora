import type {ManualRecoveryFrame} from '../../src/app/manual-recovery-contracts.js';

/** Screenshots and browser input use the same CSS pixel viewport. */
export function recoveryPoint(frame:ManualRecoveryFrame,box:{left:number;top:number;width:number;height:number},clientX:number,clientY:number){
  if(box.width<=0||box.height<=0||Date.now()>frame.expiresAt)return null;
  const x=(clientX-box.left)*frame.width/box.width,y=(clientY-box.top)*frame.height/box.height;
  if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=frame.width||y>=frame.height)return null;
  if(!frame.regions.some(region=>x>=region.x&&y>=region.y&&x<region.x+region.width&&y<region.y+region.height))return null;
  return {x,y};
}

export function recoveryError(error:unknown):string{
  const code=typeof error==='string'?error:error instanceof Error?error.message:'';
  if(/^(?:MANUAL_RECOVERY_)?(?:ORIGINAL_PAGE_UNAVAILABLE|ORIGINAL_PAGE_CHANGED|DOCUMENT_CHANGED|PAGE_CHANGED)$/u.test(code)||
    ['SECURITY_RECOVERY_ORIGINAL_PAGE_UNAVAILABLE','SECURITY_RECOVERY_CHANGED','MANUAL_RECOVERY_BROWSER_CLOSED'].includes(code))
    return '原验证页面已关闭或发生变化，无法继续操作这个现场。已有拦截和现场证据保留。';
  if(/FRAME_(?:EXPIRED|STALE|UNAVAILABLE)/u.test(code))return '画面已过期，操作没有继续。请关闭窗口后重新接管原页面。';
  if(code==='MANUAL_RECOVERY_INPUT_REPLAY')return '这次操作已失效，未再次执行。请关闭窗口后重新接管原页面。';
  if(code==='MANUAL_RECOVERY_INPUT_TIMEOUT')return '操作响应超时，尚未继续核验。请先关闭窗口后重试。';
  if(code==='MANUAL_RECOVERY_ALREADY_ACTIVE')return '原页面正在另一个人工处理窗口中，请先关闭该窗口。';
  if(/(?:REGION|FOCUS|INPUT)_/u.test(code)||/OUTSIDE|NOT_ALLOWED/u.test(code))
    return '这次操作不在可处理的验证区域内，页面和已有输入保留。';
  if(/(?:SESSION|RECOVERY)_(?:EXPIRED|CLOSED|UNAVAILABLE|NOT_ACTIVE)/u.test(code))
    return '本次人工处理已结束，已有拦截保留。';
  if(/OPERATOR_|ASSISTANT_|PERMISSION/u.test(code))return '当前连接已失去操作权限，请关闭窗口并重新连接客户端。';
  if(/OBSERVATION_SECURITY|CHALLENGE_REQUIRED|SECURITY_VERIFICATION/u.test(code))return '页面仍显示验证要求，尚未恢复运行。';
  return '这次操作未完成，已有页面、草稿和拦截保留。请关闭窗口后查看当前状态。';
}
