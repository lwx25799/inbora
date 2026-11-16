import {useState} from 'react';
import {request,type Status} from './api';
import type {ManualRecoverySession} from '../../src/app/manual-recovery-contracts.js';
import {SecurityRecoveryDialog} from './SecurityRecoveryDialog';
import {recoveryError} from './security-recovery-input';
import './emergency-stop.css';

const stopReasons:Record<string,string>={
  MANUAL_EMERGENCY_STOP:'你已手动停止全部后台操作。',
  OBSERVATION_PAGE_BLOCKED:'页面安全检查未通过，当时的记录未区分具体阻断条件。',
  OBSERVATION_UNEXPECTED_ORIGIN:'浏览器页面来源与已授权网站不一致。',
  UNEXPECTED_ORIGIN:'浏览器页面来源与已授权网站不一致。',
  OBSERVATION_SECURITY_TITLE:'旧记录仅命中了页面标题，尚不能确认发生了安全验证。',
  OBSERVATION_SECURITY_COMPONENT:'旧记录命中了候选安全组件，缺少足以确认验证生效的现场证明。',
  OBSERVATION_SECURITY_SUSPECT:'页面安全状态待核验，尚未确认发生了安全验证。',
  SECURITY_VERIFICATION_CONFIRMED:'平台已明确要求本人完成安全验证。',
  CHALLENGE_REQUIRED:'平台要求本人完成安全验证。',
  LOGIN_REQUIRED:'平台要求重新登录。',
  PLATFORM_STOP:'平台要求停止操作。',
  OBSERVATION_ACCOUNT_CHANGED:'浏览器账号与绑定账号不一致。',
  ACCOUNT_CHANGED:'浏览器账号与绑定账号不一致。',
  OWN_WORKS_ACCOUNT_CHANGED:'作品页面账号与绑定账号不一致。',
  NATIVE_REPLY_ACCOUNT_CHANGED:'私信页面账号与绑定账号不一致。',
  COMMENT_REPLY_ACCOUNT_CHANGED:'评论页面账号与绑定账号不一致。',
  ACCOUNT_NOT_VERIFIED:'当前账号身份未通过核验。',
  OWNER_LOCKED_OR_PORT_UNAVAILABLE:'专属浏览器被占用或连接不可用。',
  NATIVE_REPLY_PAGE_BLOCKED:'私信页面的登录或安全检查未通过。',
  COMMENT_REPLY_PAGE_BLOCKED:'评论页面的登录或安全检查未通过。',
};
const stopSources:Record<string,string>={MANUAL:'手动急停',COLLECTION_COMMENTS:'评论后台收取',COLLECTION_DM:'私信后台收取',
  VERIFICATION:'已提交消息的后台核验',CONNECTION:'账号连接',AUTOMATIC_REPLY:'自动回复',UNKNOWN:'未记录来源'};

export function EmergencyStopNotice({status,busy,act,update}:{status:Status;busy:string;
  act:(label:string,run:()=>Promise<void>)=>Promise<void>;update:(status:Status)=>void}){
  const [session,setSession]=useState<ManualRecoverySession|null>(null),[openingError,setOpeningError]=useState('');
  const holds=status.securityHolds??[],stopped=status.automation?.emergencyStopped;
  const recovery=status.browser.loginRecovery||status.browser.mode==='headed';
  const resume=async()=>{
    if(recovery)update(await request<Status>({command:'browser',open:true,mode:'headless'}));
    update(await request<Status>({command:'resume',eventId:null}));
  };
  const openLogin=()=>act('打开登录处理',async()=>update(await request<Status>({
    command:'browser',open:true,mode:'headed',loginRecovery:true,manualVisible:true,
  })));
  const openOriginal=(channel:ManualRecoverySession['channel'])=>act('正在接管原验证页面…',async()=>{
    setOpeningError('');
    try{setSession(await request<ManualRecoverySession>({command:'securityRecovery',action:'start',channel}));}
    catch(error){setOpeningError(recoveryError(error));}
  });
  const recoveryHelp='在客户端内处理原无头页面，保留当前验证现场。若原页面已关闭或变化，会说明无法接管；可点击“检查并恢复运行”重新核验，原现场证据仍单独保留。';
  const originalButtons=holds.map(hold=><button key={hold.revision} disabled={!!busy||!!session||!!recovery}
    onClick={()=>void openOriginal(hold.channel)}>
    {holds.length>1?`${hold.channel==='DIRECT_MESSAGE'?'私信':'评论'}：`:''}处理原验证页面</button>);
  let notice=null;
  if(!stopped&&holds.length){
    notice=<section className="emergency-stop-notice" aria-label="通道安全状态待核验" aria-live="polite">
      <div className="emergency-stop-heading"><strong>页面安全状态待核验</strong></div>
      <p>后台正在检查原页面；受影响通道的收取、模型和发送暂停，已有草稿可继续保存。</p>
      {holds.map(hold=><p key={hold.revision}>
        {hold.channel==='DIRECT_MESSAGE'?'私信':'评论'}通道 · {new Date(hold.heldAt).toLocaleString('zh-CN',{hour12:false})}
        <span className="emergency-stop-meta"> · 现场编号：<code>{hold.incidentId}</code></span>
      </p>)}
      <p className="emergency-stop-help">{recoveryHelp}</p>
      {openingError&&<p role="alert">{openingError}</p>}
      <div className="row">{recovery?
        <button disabled={!!busy} onClick={()=>void act('检查并恢复运行',resume)}>返回无头并检查恢复</button>:
        <>{originalButtons}<button disabled={!!busy||!!session} onClick={()=>void act('检查并恢复运行',resume)}>检查并恢复运行</button></>}
      </div>
    </section>;
  }
  if(stopped){
  const incident=status.automation!.emergencyStop,legacy=!incident||incident.legacy;
  const reason=incident?stopReasons[incident.reason]:undefined;
  notice=<section className="emergency-stop-notice" aria-label="全局急停原因与处理" aria-live="polite">
    <div className="emergency-stop-heading"><strong>全局急停，等待恢复</strong>
      <span>{incident?.stoppedAt?new Date(incident.stoppedAt).toLocaleString('zh-CN',{hour12:false}):'旧版本未记录急停时间'}</span></div>
    <p>{legacy?'旧版本未独立记录本次急停原因。':reason??'后台检查未通过，已停止全部调度。'}</p>
    {legacy&&reason&&<p>最近收取错误（供排查）：{reason}</p>}
    <p className="emergency-stop-meta">{legacy?'排查来源':'触发来源'}：{stopSources[incident?.source??'UNKNOWN']??stopSources.UNKNOWN}。停止收取、模型和发送；已有草稿保留。</p>
    <p className="emergency-stop-help">{recoveryHelp}重启不会自动解除急停。</p>
    {openingError&&<p role="alert">{openingError}</p>}
    <div className="row">
      <button disabled={!!busy||!!session} onClick={()=>void act('检查并恢复运行',resume)}>{recovery?'返回无头并检查恢复':'检查并恢复运行'}</button>
      {!recovery&&originalButtons}
      {!recovery&&incident?.reason==='LOGIN_REQUIRED'&&<button disabled={!!busy||!!session} onClick={()=>void openLogin()}>处理登录</button>}
    </div>
  </section>;
  }
  return <>{notice}{session&&<SecurityRecoveryDialog session={session} update={update} onClosed={()=>setSession(null)}/>}</>;
}
