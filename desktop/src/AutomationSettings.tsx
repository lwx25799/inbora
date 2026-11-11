import { useState } from 'react';
import { request, reasons, type Status } from './api';
import type { ReplyPolicy } from '../../src/app/automation-contracts.js';
import {SettingsDialog} from './SettingsDialog';

export function AutomationSettings({status,busy,act,update}:{status:Status;busy:string;act:(label:string,fn:()=>Promise<void>)=>Promise<void>;update:(s:Status)=>void}) {
  const state=status.automation!;
  const [comments,setComments]=useState(state.collection?.comments??false),[inbox,setInbox]=useState(state.collection?.inbox??false);
  const [commentSeconds,setCommentSeconds]=useState((state.collection?.commentIntervalMs??30_000)/1000),[dmSeconds,setDmSeconds]=useState((state.collection?.dmIntervalMs??15_000)/1000);
  const saved=state.replyPolicy?.scope;
  const savedModelLimit=saved?saved.modelLimit:state.modelGrant?.scope.modelLimit;
  const [commentReply,setCommentReply]=useState(saved?.channels.includes('COMMENT_NOTIFICATION')??true),[dmReply,setDmReply]=useState(saved?.channels.includes('DIRECT_MESSAGE')??true);
  const [replyToNestedComments,setReplyToNestedComments]=useState(saved?.replyToNestedComments!==false);
  const [workIds,setWorkIds]=useState(saved?.workIds.join('\n')??''),[conversations,setConversations]=useState(saved?.conversationIds.join('\n')??'');
  const [future,setFuture]=useState(saved?.futureOwnWorks??false),[entireInbox,setEntireInbox]=useState(saved?.entireInbox??false);
  const [excludes,setExcludes]=useState(saved?.excludesAny.join(', ')??'');
  const [instructions,setInstructions]=useState(saved?.instructions??status.settings.rules);
  const [modelLimit,setModelLimit]=useState(savedModelLimit??1),[sendLimit,setSendLimit]=useState(saved?.sendLimit??1),[startHour,setStartHour]=useState(saved?.startHour??0),[endHour,setEndHour]=useState(saved?.endHour??24);
  const [unlimitedModel,setUnlimitedModel]=useState(savedModelLimit===null),[unlimitedSend,setUnlimitedSend]=useState(saved?.sendLimit===null);
  const [ruleOpen,setRuleOpen]=useState(false);
  const ownId=status.account?.identity??'';
  const list=(s:string)=>s.split(/[,，\n]/u).map(s=>s.trim()).filter(Boolean);
  const channels:ReplyPolicy['channels']=[...(commentReply?['COMMENT_NOTIFICATION' as const]:[]),...(dmReply?['DIRECT_MESSAGE' as const]:[])];
  const targetsValid=(!commentReply||future||list(workIds).length>0)&&(!dmReply||entireInbox||list(conversations).length>0);
  return <div className="settings-section settings-automation">
    <h2>后台收取与持续授权</h2>
    <p>绑定本人账号：<code>{ownId||'等待账号核验'}</code></p>
    <p className="hint">收取起点：{new Date(state.startedAt).toLocaleString('zh-CN',{hour12:false})}。本号此后新作品自动纳入，停机新增恢复后补查；收取独立于 AI。</p>
    <label className="check"><input type="checkbox" checked={comments} onChange={e=>setComments(e.target.checked)}/>收取本号新视频评论，并保留原已纳入作品</label>
    <label className="check"><input type="checkbox" checked={inbox} onChange={e=>setInbox(e.target.checked)}/>收取本账号私信收件箱的新消息及新会话</label>
    <details className="settings-disclosure"><summary>轮询参数 · 评论 {commentSeconds} 秒 / 私信 {dmSeconds} 秒</summary>
      <div className="policy-fields"><label>评论轮询秒数<input type="number" min="15" max="3600" value={commentSeconds} onChange={e=>setCommentSeconds(Number(e.target.value))}/></label>
        <label>私信轮询秒数<input type="number" min="15" max="3600" value={dmSeconds} onChange={e=>setDmSeconds(Number(e.target.value))}/></label></div>
    </details>
    <button disabled={!ownId||!!busy} onClick={()=>void act('保存收取范围',async()=>update(await request<Status>({command:'configureCollection',settings:{ownId,comments,inbox,commentIntervalMs:commentSeconds*1000,dmIntervalMs:dmSeconds*1000}})))}>保存并恢复后台收取</button>
    {state.emergencyStopped&&<p className="error">全局急停或账号验证已停止调度。处理必要异常后显式恢复，重启不会解除。</p>}
    {state.collector.channels.map(c=><p className="hint" key={c.source}>{c.source==='dm'?'私信':'评论'}：{state.collector.running&&state.collector.source===c.source?'读取中':c.last_success?'最近成功 '+new Date(c.last_success).toLocaleTimeString('zh-CN'):'尚无成功轮次'}{c.elapsed_ms!==null?' · '+c.elapsed_ms+'ms':''}{c.last_error?' · '+c.last_error:''}</p>)}
    <h3 className="settings-subtitle">模型与自动回复范围</h3>
    <div className="settings-options">
    <label className="check"><input type="checkbox" checked={commentReply} onChange={e=>setCommentReply(e.target.checked)}/>评论通道</label>
    <label className="check"><input type="checkbox" checked={dmReply} onChange={e=>setDmReply(e.target.checked)}/>私信通道</label>
    <label className="check"><input type="checkbox" checked={replyToNestedComments} onChange={e=>setReplyToNestedComments(e.target.checked)}/>自动回复楼中楼评论</label>
    </div>
    <p className="hint">关闭楼中楼自动回复仍保留收取和人工回复，不影响一级评论及私信；保存规则后生效。</p>
    <div className="policy-fields"><div><label>本次持续授权的模型次数<input type="number" min="1" disabled={unlimitedModel} value={modelLimit} onChange={e=>setModelLimit(Number(e.target.value))}/></label>
      <label className="check"><input type="checkbox" checked={unlimitedModel} onChange={e=>setUnlimitedModel(e.target.checked)}/>模型次数无上限</label></div>
      <div><label>本次持续授权的发送次数<input type="number" min="1" disabled={unlimitedSend} value={sendLimit} onChange={e=>setSendLimit(Number(e.target.value))}/></label>
      <label className="check"><input type="checkbox" checked={unlimitedSend} onChange={e=>setUnlimitedSend(e.target.checked)}/>发送次数无上限</label></div></div>
    <p className="hint">累计额度：{status.budgets.map(b=>`${b.kind} ${b.used}/${b.maximum===null?'无上限':b.maximum}`).join(' · ')}。保存后生效，已用次数不重置；改回有限额度时扣除已用次数，重启保留。</p>
    <p className="hint">保存 API Key 即同意模型调用。自动回复由统一开关和已保存范围控制，累计额度不会重置。</p>
    <details><summary>仅生成 AI 建议（可选）</summary>
      <p className="hint">用于人工编辑时生成建议。下方规则自动回复已包含模型调用许可，无需先启用此项。</p>
      <div className="row"><button disabled={!ownId||!channels.length||!!busy} onClick={()=>void act('启用持续模型授权',async()=>{update(await request<Status>({command:'setModelGrant',scope:{ownId,channels,model:status.settings.model,modelLimit:unlimitedModel?null:modelLimit,expiresAt:null},confirmed:true}));})}>仅启用模型授权</button>
        <button disabled={!state.modelGrant||!!busy} onClick={()=>void act('撤销模型授权',async()=>update(await request<Status>({command:'setModelGrant',scope:null,confirmed:true})))}>撤销模型授权</button></div>
    </details>
    <div className="policy-targets"><div>
    <label>允许回复的作品原生 ID（逗号或换行分隔）<textarea value={workIds} onChange={e=>setWorkIds(e.target.value)}/></label>
    <label className="check"><input type="checkbox" checked={future} onChange={e=>setFuture(e.target.checked)}/>回复策略覆盖本号运行起点后所有新视频</label>
    </div><div>
    <label>允许回复的私信原生会话 ID<textarea value={conversations} onChange={e=>setConversations(e.target.value)}/></label>
    <label className="check"><input type="checkbox" checked={entireInbox} onChange={e=>setEntireInbox(e.target.checked)}/>回复策略覆盖本账号已启用收件箱内的新会话</label>
    </div></div>
    <p className="hint">开启后回复范围内全部新评论和私信，AI根据每条原文及必要上下文生成回复，不需要触发词。</p>
    <label>屏蔽词（命中后不自动回复）<input value={excludes} onChange={e=>setExcludes(e.target.value)}/></label>
    <div className="settings-rule-summary"><h3>自动回复规则</h3>
      <p className="hint">{instructions.trim()?`${[...instructions].length} 字 · ${instructions.replace(/\s+/gu,' ').slice(0,64)}`:'尚未填写规则'}</p>
      <button onClick={()=>setRuleOpen(true)}>编辑自动回复规则</button>
    </div>
    <SettingsDialog title="编辑自动回复规则" open={ruleOpen} onClose={()=>setRuleOpen(false)}>
      <p className="hint">关闭保留输入。回到页面保存启用范围后，规则才生效。</p>
      <label className="settings-rule">自动回复规则<textarea value={instructions} onChange={e=>setInstructions(e.target.value)}/></label>
      <button className="primary" onClick={()=>setRuleOpen(false)}>完成编辑</button>
    </SettingsDialog>
    <div className="policy-fields"><label>每日开始小时（北京时间）<input type="number" min="0" max="23" value={startHour} onChange={e=>setStartHour(Number(e.target.value))}/></label>
      <label>每日结束小时<input type="number" min="1" max="24" value={endHour} onChange={e=>setEndHour(Number(e.target.value))}/></label></div>
    <p className="hint">一次启用即允许范围内模型调用与发送，并恢复普通发送暂停。人工接管、历史基线、我方消息、未知冻结和范围外任务均不自动外发；全局急停须先显式恢复。失败的模型调用不自动重试。</p>
    {!targetsValid&&<p className="hint">请为每个已选通道填写作品或会话 ID，或选择对应的新视频／收件箱覆盖范围；空范围不会自动回复。</p>}
    <div className="row"><button className="primary" disabled={!ownId||!channels.length||!targetsValid||!instructions.trim()||!!busy} onClick={()=>void act('启用规则自动回复',async()=>{
      const policy:ReplyPolicy={ownId,channels,replyToNestedComments,model:status.settings.model,modelLimit:unlimitedModel?null:modelLimit,sendLimit:unlimitedSend?null:sendLimit,expiresAt:null,workIds:list(workIds),futureOwnWorks:future,conversationIds:list(conversations),entireInbox,containsAny:[],excludesAny:list(excludes),instructions,startHour,endHour};
      update(await request<Status>({command:'enableReplyPolicy',policy,confirmed:true}));
    })}>按此范围启用规则自动回复</button>
      <button disabled={!state.replyPolicy||!!busy} onClick={()=>void act('撤销自动回复策略',async()=>update(await request<Status>({command:'setReplyPolicy',policy:null,confirmed:true})))}>撤销自动回复策略</button></div>
    <p>自动回复（含模型调用）：{state.replyPolicy?'策略版本 '+state.replyPolicy.version:'关闭'} · 人工 AI 建议：{state.modelGrant?'授权版本 '+state.modelGrant.version:'关闭'}</p>
    {state.autoStopReason&&<p className="hint">自动回复等待：{reasons[state.autoStopReason]??state.autoStopReason}</p>}
    {state.unresolvedSends?.map(item=><p className="hint" key={item.channel}>{item.count} 条{item.channel==='DIRECT_MESSAGE'?'私信':'评论'}发送结果仍不明确，原记录保留且禁止重发。后续已核验的独立新消息继续处理；尚在发送或无法区分新旧时暂缓。</p>)}
  </div>;
}
