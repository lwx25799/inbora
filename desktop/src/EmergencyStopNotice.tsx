import {request,type Status} from './api';
import './emergency-stop.css';

const stopReasons:Record<string,string>={
  MANUAL_EMERGENCY_STOP:'你已手动停止全部后台操作。',
  OBSERVATION_PAGE_BLOCKED:'页面安全检查未通过，当时的记录未区分具体阻断条件。',
  OBSERVATION_UNEXPECTED_ORIGIN:'浏览器页面来源与已授权网站不一致。',
  UNEXPECTED_ORIGIN:'浏览器页面来源与已授权网站不一致。',
  OBSERVATION_SECURITY_TITLE:'页面标题出现验证码、安全验证或访问受限提示。',
  OBSERVATION_SECURITY_COMPONENT:'页面出现已识别的安全验证组件。',
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
  if(!status.automation?.emergencyStopped)return null;
  const incident=status.automation.emergencyStop,legacy=!incident||incident.legacy;
  const reason=incident?stopReasons[incident.reason]:undefined;
  const recovery=status.browser.loginRecovery||status.browser.mode==='headed';
  const resume=async()=>{
    if(recovery)update(await request<Status>({command:'browser',open:true,mode:'headless'}));
    update(await request<Status>({command:'resume',eventId:null}));
  };
  return <section className="emergency-stop-notice" aria-label="全局急停原因与处理" aria-live="polite">
    <div className="emergency-stop-heading"><strong>全局急停，等待恢复</strong>
      <span>{incident?.stoppedAt?new Date(incident.stoppedAt).toLocaleString('zh-CN',{hour12:false}):'旧版本未记录急停时间'}</span></div>
    <p>{legacy?'旧版本未独立记录本次急停原因。':reason??'后台检查未通过，已停止全部调度。'}</p>
    {legacy&&reason&&<p>最近收取错误（供排查）：{reason}</p>}
    <p className="emergency-stop-meta">{legacy?'排查来源':'触发来源'}：{stopSources[incident?.source??'UNKNOWN']??stopSources.UNKNOWN}。停止收取、模型和发送；已有草稿保留。</p>
    <p className="emergency-stop-help">网页账号正常时可直接检查恢复；仍有登录或验证提示时再处理。恢复前会重新检查，重启不会自动解除急停。</p>
    <div className="row">
      <button disabled={!!busy} onClick={()=>void act('检查并恢复运行',resume)}>{recovery?'返回无头并检查恢复':'检查并恢复运行'}</button>
      {!recovery&&<button disabled={!!busy} onClick={()=>void act('打开登录或验证处理',async()=>update(await request<Status>({
        command:'browser',open:true,mode:'headed',loginRecovery:true,manualVisible:true,
      })))}>处理登录或验证</button>}
    </div>
  </section>;
}
