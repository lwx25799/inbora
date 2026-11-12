import {reasons,type Thread} from './api';
import {hasReplyHistory} from './reply-editor-draft';
import type {ReplyViewProps} from './reply-view-types';

type ResultState='NONE'|'CONFIRMED'|'SENDING'|'CHECKING'|'UNCONFIRMED'|'FAILED';
interface ReplyResult {state:ResultState;title:string;detail:string|null}
const pendingStates=new Set(['PREPARING','APPROVED','INTENT_RECORDED','QUEUED','PREFLIGHT','SENDING']);
const verificationReasons:Record<string,string>={
  NO_COMPLETE_PROOF:'后台核对已结束，尚未取得与本次回复完整对应的平台记录',
  VERIFICATION_DEADLINE:'后台核对已到时限，发送结果仍未确认',
  VERIFICATION_BINDING_CHANGED:'后台核对已停止，原回复与当前消息的对应关系发生变化',
  VERIFICATION_NATIVE_ID_CONFLICT:'后台核对发现回复记录不一致，发送结果仍未确认',
  VERIFICATION_CANCELLED:'后台核对已停止，发送结果仍未确认',
  COMMENT_TIME_BEFORE_INTENT:'已读到我方回复，但平台时间早于本机提交时间或落在同一时刻，旧记录又缺少提交关联，暂不能自动确认',
  COMMENT_VISIBLE_BODY_UNVERIFIED:'后台核对已结束，已读到回复记录，但页面正文仍未通过完整核对',
};
const retained='已保留本次回复和记录，不会重复发送。';

/** Describe the latest attempt without inferring delivery from visible text or an older task. */
export function replyResultPresentation(thread:Thread,send:ReplyViewProps['send']=null):ReplyResult {
  const turn=thread.followup?.latestTurn;
  if(thread.replyStatus==='REPLIED'&&(!turn||turn.status==='CONFIRMED'))
    return {state:'CONFIRMED',title:'已回复',detail:null};
  const command=turn??send;
  if(command?.status==='FAILED_BEFORE_CLICK')return {
    state:'FAILED',title:'尚未发送',detail:reasons[command.reason??'']??'本次未发送，草稿已保留',
  };
  if(pendingStates.has(command?.status??''))return {
    state:'SENDING',title:'正在发送',detail:thread.followup?.queueReady
      ?'上一条正在处理；新内容可独立排队发送':'正在处理，请勿重复发送',
  };
  if(!hasReplyHistory(thread)&&!thread.verification&&!send)return {state:'NONE',title:'',detail:null};
  // The thread verification belongs to the original intent, not a later human reply.
  const verification=!turn||turn.intentId===thread.intent?.id?thread.verification:null;
  if(verification&&['PENDING','RUNNING'].includes(verification.state))return {
    state:'CHECKING',title:'等待确认',detail:'正在后台核对发送结果，'+retained,
  };
  const finished=verification&&['REVIEW','EXHAUSTED'].includes(verification.state);
  const explanation=finished
    ?verificationReasons[verification.last_error??'']??'后台核对已结束，尚未取得可确认的发送结果'
    :'尚未取得可确认的发送结果';
  return {state:'UNCONFIRMED',title:'等待确认',detail:explanation+'。'+retained};
}
