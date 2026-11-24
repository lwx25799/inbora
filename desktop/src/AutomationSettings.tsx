import { useEffect, useRef, useState } from 'react';
import { request, reasons, type Status } from './api';
import type { ReplyPolicy } from '../../src/contracts/automation.js';
import {
  collectionSnapshot,
  policySnapshot,
  policySyncKey,
  sameCollectionForm,
  samePolicyForm,
  type CollectionForm,
  type PolicyForm,
} from './settings-form-sync';
import {SettingsDialog} from './SettingsDialog';

export function AutomationSettings({
  status,
  busy,
  error = '',
  notice = '',
  act,
  update,
}:{
  status:Status;
  busy:string;
  error?:string;
  notice?:string;
  act:(label:string,fn:()=>Promise<void>)=>Promise<void>;
  update:(s:Status)=>void;
}) {
  const state=status.automation!;
  const [collection,setCollection]=useState<CollectionForm>(()=>collectionSnapshot(status));
  const syncedCollection=useRef(collection),latestCollection=useRef(collection);
  latestCollection.current=collection;
  const collectionKey=JSON.stringify(state.collection??null);
  useEffect(()=>{
    const next=collectionSnapshot(status);
    if(sameCollectionForm(latestCollection.current,syncedCollection.current)){
      syncedCollection.current=next;
      latestCollection.current=next;
      setCollection(next);
    }
  },[collectionKey]);

  const [policyForm,setPolicyForm]=useState<PolicyForm>(()=>policySnapshot(status));
  const syncedPolicy=useRef(policyForm),latestPolicy=useRef(policyForm);
  latestPolicy.current=policyForm;
  const policyKey=policySyncKey(status);
  useEffect(()=>{
    const next=policySnapshot(status);
    if(samePolicyForm(latestPolicy.current,syncedPolicy.current)){
      syncedPolicy.current=next;
      latestPolicy.current=next;
      setPolicyForm(next);
    }
  },[policyKey]);

  const applyCollectionResponse=(submitted:CollectionForm,next:Status)=>{
    const snap=collectionSnapshot(next);
    syncedCollection.current=snap;
    if(sameCollectionForm(latestCollection.current,submitted)){
      latestCollection.current=snap;
      setCollection(snap);
    }
    update(next);
  };
  const applyPolicyResponse=(submitted:PolicyForm,next:Status)=>{
    const snap=policySnapshot(next);
    syncedPolicy.current=snap;
    if(samePolicyForm(latestPolicy.current,submitted)){
      latestPolicy.current=snap;
      setPolicyForm(snap);
    }
    update(next);
  };

  const [ruleOpen,setRuleOpen]=useState(false);
  const {comments,inbox,commentSeconds,dmSeconds}=collection;
  const {
    commentReply,dmReply,replyToNestedComments,workIds,conversations,future,entireInbox,
    excludes,instructions,modelLimit,sendLimit,startHour,endHour,unlimitedModel,unlimitedSend,
  }=policyForm;
  const setCollectionField=<K extends keyof CollectionForm>(field:K,value:CollectionForm[K])=>
    setCollection(current=>({...current,[field]:value}));
  const setPolicyField=<K extends keyof PolicyForm>(field:K,value:PolicyForm[K])=>
    setPolicyForm(current=>({...current,[field]:value}));
  const ownId=status.account?.identity??'';
  const list=(s:string)=>s.split(/[,，\n]/u).map(s=>s.trim()).filter(Boolean);
  const channels:ReplyPolicy['channels']=[...(commentReply?['COMMENT_NOTIFICATION' as const]:[]),...(dmReply?['DIRECT_MESSAGE' as const]:[])];
  const targetsValid=(!commentReply||future||list(workIds).length>0)&&(!dmReply||entireInbox||list(conversations).length>0);
  return <div className="settings-section settings-automation">
    <h2>后台收取与持续授权</h2>
    <p>绑定本人账号：<code>{ownId||'等待账号核验'}</code></p>
    <p className="hint">收取起点：{new Date(state.startedAt).toLocaleString('zh-CN',{hour12:false})}。本号此后新作品自动纳入，停机新增恢复后补查；收取独立于 AI。</p>
    <label className="check"><input type="checkbox" checked={comments} onChange={e=>setCollectionField('comments',e.target.checked)}/>收取本号新视频评论，并保留原已纳入作品</label>
    <label className="check"><input type="checkbox" checked={inbox} onChange={e=>setCollectionField('inbox',e.target.checked)}/>收取本账号私信收件箱的新消息及新会话</label>
    <details className="settings-disclosure"><summary>轮询参数 · 评论 {commentSeconds} 秒 / 私信 {dmSeconds} 秒</summary>
      <div className="policy-fields"><label>评论轮询秒数<input type="number" min="15" max="3600" value={commentSeconds} onChange={e=>setCollectionField('commentSeconds',Number(e.target.value))}/></label>
        <label>私信轮询秒数<input type="number" min="15" max="3600" value={dmSeconds} onChange={e=>setCollectionField('dmSeconds',Number(e.target.value))}/></label></div>
    </details>
    <button disabled={!ownId||!!busy} onClick={()=>void act('保存收取范围',async()=>{
      const submitted=latestCollection.current;
      const next=await request<Status>({command:'configureCollection',settings:{ownId,comments:submitted.comments,inbox:submitted.inbox,commentIntervalMs:submitted.commentSeconds*1000,dmIntervalMs:submitted.dmSeconds*1000}});
      applyCollectionResponse(submitted,next);
    })}>保存收取范围</button>
    {state.emergencyStopped&&<p className="error">当前全局急停，保存范围不会恢复调度。请使用页面上方的“检查并恢复运行”。</p>}
    {state.collector.channels.map(c=><p className="hint" key={c.source}>{c.source==='dm'?'私信':'评论'}：{state.collector.running&&state.collector.source===c.source?'读取中':c.last_success?'最近成功 '+new Date(c.last_success).toLocaleTimeString('zh-CN'):'尚无成功轮次'}{c.elapsed_ms!==null?' · '+c.elapsed_ms+'ms':''}{c.last_error?' · '+c.last_error:''}</p>)}
    <h3 className="settings-subtitle">模型与自动回复范围</h3>
    <div className="settings-options">
    <label className="check"><input type="checkbox" checked={commentReply} onChange={e=>setPolicyField('commentReply',e.target.checked)}/>评论通道</label>
    <label className="check"><input type="checkbox" checked={dmReply} onChange={e=>setPolicyField('dmReply',e.target.checked)}/>私信通道</label>
    <label className="check"><input type="checkbox" checked={replyToNestedComments} onChange={e=>setPolicyField('replyToNestedComments',e.target.checked)}/>自动回复楼中楼评论</label>
    </div>
    <p className="hint">关闭楼中楼自动回复仍保留收取和人工回复，不影响一级评论及私信；保存规则后生效。</p>
    <div className="policy-fields"><div><label>本次持续授权的模型次数<input type="number" min="1" disabled={unlimitedModel} value={modelLimit} onChange={e=>setPolicyField('modelLimit',Number(e.target.value))}/></label>
      <label className="check"><input type="checkbox" checked={unlimitedModel} onChange={e=>setPolicyField('unlimitedModel',e.target.checked)}/>模型次数无上限</label></div>
      <div><label>本次持续授权的发送次数<input type="number" min="1" disabled={unlimitedSend} value={sendLimit} onChange={e=>setPolicyField('sendLimit',Number(e.target.value))}/></label>
      <label className="check"><input type="checkbox" checked={unlimitedSend} onChange={e=>setPolicyField('unlimitedSend',e.target.checked)}/>发送次数无上限</label></div></div>
    <p className="hint">累计额度：{status.budgets.map(b=>`${b.kind} ${b.used}/${b.maximum===null?'无上限':b.maximum}`).join(' · ')}。保存后生效，已用次数不重置；改回有限额度时扣除已用次数，重启保留。</p>
    <p className="hint">首次保存 API Key 会自动开启模型调用授权，撤销后再次保存不再自动恢复。自动回复由统一开关和已保存范围控制，累计额度不会重置。</p>
    <details><summary>仅生成 AI 建议（可选）</summary>
      <p className="hint">用于人工编辑时生成建议。下方规则自动回复已包含模型调用许可，无需先启用此项。</p>
      <div className="row"><button disabled={!ownId||!channels.length||!!busy} onClick={()=>void act('启用持续模型授权',async()=>{
        const submitted=latestPolicy.current;
        const next=await request<Status>({command:'setModelGrant',scope:{ownId,channels,model:status.settings.model,modelLimit:submitted.unlimitedModel?null:submitted.modelLimit,expiresAt:null},confirmed:true});
        applyPolicyResponse(submitted,next);
      })}>仅启用模型授权</button>
        <button disabled={!state.modelGrant||!!busy} onClick={()=>void act('撤销模型授权',async()=>{
          const submitted=latestPolicy.current;
          const next=await request<Status>({command:'setModelGrant',scope:null,confirmed:true});
          applyPolicyResponse(submitted,next);
        })}>撤销模型授权</button></div>
    </details>
    <div className="policy-targets"><div>
    <label>允许回复的作品原生 ID（逗号或换行分隔）<textarea value={workIds} onChange={e=>setPolicyField('workIds',e.target.value)}/></label>
    <label className="check"><input type="checkbox" checked={future} onChange={e=>setPolicyField('future',e.target.checked)}/>回复策略覆盖本号运行起点后所有新视频</label>
    </div><div>
    <label>允许回复的私信原生会话 ID<textarea value={conversations} onChange={e=>setPolicyField('conversations',e.target.value)}/></label>
    <label className="check"><input type="checkbox" checked={entireInbox} onChange={e=>setPolicyField('entireInbox',e.target.checked)}/>回复策略覆盖本账号已启用收件箱内的新会话</label>
    </div></div>
    <p className="hint">开启后回复范围内全部新评论和私信，AI根据每条原文及必要上下文生成回复，不需要触发词。</p>
    <label>屏蔽词（命中后不自动回复）<input value={excludes} onChange={e=>setPolicyField('excludes',e.target.value)}/></label>
    <div className="settings-rule-summary"><h3>自动回复规则</h3>
      <p className="hint">{instructions.trim()?`${[...instructions].length} 字 · ${instructions.replace(/\s+/gu,' ').slice(0,64)}`:'尚未填写规则'}</p>
      <button onClick={()=>setRuleOpen(true)}>编辑自动回复规则</button>
    </div>
    <SettingsDialog title="编辑自动回复规则" open={ruleOpen} onClose={()=>setRuleOpen(false)} busy={busy} error={error} notice={notice}>
      <p className="hint">关闭保留输入。回到页面保存启用范围后，规则才生效。</p>
      <label className="settings-rule">自动回复规则<textarea value={instructions} onChange={e=>setPolicyField('instructions',e.target.value)}/></label>
      <button className="primary" onClick={()=>setRuleOpen(false)}>完成编辑</button>
    </SettingsDialog>
    <div className="policy-fields"><label>每日开始小时（北京时间）<input type="number" min="0" max="23" value={startHour} onChange={e=>setPolicyField('startHour',Number(e.target.value))}/></label>
      <label>每日结束小时<input type="number" min="1" max="24" value={endHour} onChange={e=>setPolicyField('endHour',Number(e.target.value))}/></label></div>
    <p className="hint">一次启用即允许范围内模型调用与发送，并恢复普通发送暂停。人工接管、历史基线、我方消息、未知冻结和范围外任务均不自动外发；全局急停须先显式恢复。失败的模型调用不自动重试。</p>
    {!targetsValid&&<p className="hint">请为每个已选通道填写作品或会话 ID，或选择对应的新视频／收件箱覆盖范围；空范围不会自动回复。</p>}
    <div className="row"><button className="primary" disabled={!ownId||!channels.length||!targetsValid||!instructions.trim()||!!busy} onClick={()=>void act('启用规则自动回复',async()=>{
      const submitted=latestPolicy.current;
      const policy:ReplyPolicy={ownId,channels,replyToNestedComments:submitted.replyToNestedComments,model:status.settings.model,modelLimit:submitted.unlimitedModel?null:submitted.modelLimit,sendLimit:submitted.unlimitedSend?null:submitted.sendLimit,expiresAt:null,workIds:list(submitted.workIds),futureOwnWorks:submitted.future,conversationIds:list(submitted.conversations),entireInbox:submitted.entireInbox,containsAny:[],excludesAny:list(submitted.excludes),instructions:submitted.instructions,startHour:submitted.startHour,endHour:submitted.endHour};
      const next=await request<Status>({command:'enableReplyPolicy',policy,confirmed:true});
      applyPolicyResponse(submitted,next);
    })}>按此范围启用规则自动回复</button>
      <button disabled={!state.replyPolicy||!!busy} onClick={()=>void act('撤销自动回复策略',async()=>{
        const submitted=latestPolicy.current;
        const next=await request<Status>({command:'setReplyPolicy',policy:null,confirmed:true});
        applyPolicyResponse(submitted,next);
      })}>撤销自动回复策略</button></div>
    <p>自动回复（含模型调用）：{state.replyPolicy?'策略版本 '+state.replyPolicy.version:'关闭'} · 人工 AI 建议：{state.modelGrant?'授权版本 '+state.modelGrant.version:'关闭'}</p>
    {state.autoStopReason&&<p className="hint">自动回复等待：{reasons[state.autoStopReason]??state.autoStopReason}</p>}
    {state.unresolvedSends?.map(item=><p className="hint" key={item.channel}>{item.count} 条{item.channel==='DIRECT_MESSAGE'?'私信':'评论'}发送结果仍不明确，原记录保留且禁止重发。后续已核验的独立新消息继续处理；尚在发送或无法区分新旧时暂缓。</p>)}
  </div>;
}
