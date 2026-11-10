import { useEffect, useRef, useState } from "react";
import { Settings } from './Settings';
import { ReplyDetail } from './ReplyDetail';
import {InboxList} from './InboxList';
import { modes, time, browserState } from './presentation';
import { useDevelopmentReconnect } from './useDevelopmentReconnect';
import {useWorkbenchRefresh,type AuditRow} from './useWorkbenchRefresh';
import {
  request,
  restoreDesktop,
  explain,
  reasons,
  type Status,
  type Inbox,
  type Thread,
} from "./api";

const syncNames={works:'评论',dm:'私信'};
const syncStates={PENDING:'等待同步',RUNNING:'同步中',SUCCEEDED:'本轮同步完成',DEFERRED:'后台继续收取',FAILED:'同步失败',SKIPPED:'未继续同步',CANCELLED:'同步已停止'};
interface BufferDraft {
  text: string;
  version: number;
  suggestionId: string | null;
}

export function App() {
  const [runtime, setRuntime] = useState(""),
    [initialize, setInitialize] = useState(false),
    [consent, setConsent] = useState(false);
  const [version, setVersion] = useState(""),
    [status, setStatus] = useState<Status | null>(null),
    [page, setPage] = useState<"inbox" | "settings" | "audit">("inbox");
  const [channel, setChannel] = useState<
    "ALL" | "COMMENT_NOTIFICATION" | "DIRECT_MESSAGE"
  >("ALL");
  const [filter, setFilter] = useState<
      "PENDING" | "CONFIRMED"
    >("PENDING"),
    [pageNumber, setPageNumber] = useState(0);
  const [inbox, setInbox] = useState<Inbox>({
      items: [],
      total: 0,
      page: 0,
      pageSize: 20,
    }),
    [selected, setSelected] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null),
    [text, setText] = useState(""),
    [suggestionId, setSuggestionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [, setReview] = useState<null>(null);
  const [send, setSend] = useState<{
    commandId: string;
    status: string;
    reason: string | null;
  } | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]),
    [auditPage, setAuditPage] = useState(0);
  const selection = useRef(crypto.randomUUID()),
    selectedRef = useRef<string | null>(null),
    buffers = useRef(new Map<string, BufferDraft>());
  const detailRequest = useRef(0),
    editorLoaded = useRef(false);
  const detailElement = useRef<HTMLElement | null>(null);
  const sending = useRef(false),
    connected = !!status;
  const [dialogOpen,setDialogOpen]=useState(false),[saving,setSaving]=useState(false);
  const [pendingAutoReply,setPendingAutoReply]=useState<boolean|null>(null),autoReplyUpdating=useRef(false);
  const saveTask=useRef<Promise<unknown>|null>(null),dialogElement=useRef<HTMLDialogElement|null>(null);
  const navigation=useRef(0);
  const opening=useRef<{id:string;selectionId:string;task:Promise<void>}|null>(null);
  const localDraftVersions=useRef(new Map<string,number>());
  const dirty =
    !!thread && (text !== (thread.draft?.text ?? "") || suggestionId !== null);
  const latestEditor = useRef({ eventId: selected, text, suggestionId });
  latestEditor.current = { eventId: selected, text, suggestionId };
  const devRecovery=useDevelopmentReconnect({
    selectedRef,selection,detailRequest,latestEditor,dialogOpen,
    setStatus,setThread,setReview,setSend,setError,setNotice,
  });
  useWorkbenchRefresh({connected,status,selected,channel,filter,pageNumber,page,auditPage,notice,sendStatus:send?.status,
    readThread:alive=>refreshThread(undefined,alive),setStatus,setInbox,setAudit,setError});
  useEffect(() => {
    if(dialogOpen&&!dialogElement.current?.open)dialogElement.current?.showModal();
    if(!dialogOpen&&dialogElement.current?.open)dialogElement.current.close();
  },[dialogOpen]);
  useEffect(() => {
    if (detailElement.current) detailElement.current.scrollTop = 0;
  }, [thread?.event.id]);

  useEffect(() => {
    let ignore=false;
    void restoreDesktop().then(result=>{
      if(ignore)return;
      setRuntime(result.runtime);setVersion(result.version);setStatus(result.status);setError(result.error);
    }).catch(()=>{if(!ignore)setError('无法读取本地客户端信息，请重新连接。');});
    return()=>{ignore=true;};
  }, []);
  useEffect(()=>{
    if(!thread?.intent||thread.replyStatus!=='REPLIED'||thread.event.payload.channel!=='DIRECT_MESSAGE'||dirty||sending.current)return;
    const next=inbox.items.find(item=>item.groupKey===thread.groupKey&&item.replyStatus==='WAITING'&&item.id!==selected);
    if(next)choose(next.resumeEventId??next.id);
  },[inbox.items,thread?.intent,thread?.replyStatus,dirty,selected]);
  useEffect(() => {
    if (!connected || !selected) return;
    let ignore = false;
    setThread(null);
    editorLoaded.current = false;
    setReview(null);
    setSend(null);
    setText("");
    const selectionId = crypto.randomUUID();
    selection.current = selectionId;
    setDialogOpen(false);
    void request({ command: "selectTarget", eventId: selected, selectionId })
      .then(async () => {
        if(ignore)return;
        const requestId=++detailRequest.current;
        const detail=await request<Thread>({command:'getThread',eventId:selected});
        if(!ignore&&selectedRef.current===selected&&selection.current===selectionId&&detailRequest.current===requestId){
          detailRequest.current++;setThread(detail);editorLoaded.current=true;
          const saved=buffers.current.get(selected);setText(saved?.text??detail.draft?.text??'');setSuggestionId(saved?.suggestionId??null);
        }
        if(ignore||!detail||detail.event.payload.channel!=='DIRECT_MESSAGE')return;
        setDialogOpen(status?.configuredMode!=='LIMITED_AUTO');
        if(detail.intent)return;
        if(status?.configuredMode==='LIMITED_AUTO')return;
        const claimed=await request<Thread>({command:'openHumanDialog',eventId:selected,selectionId});
        if(!ignore&&selectedRef.current===selected&&selection.current===selectionId){detailRequest.current++;setThread(claimed);}
      })
      .catch((e) => {
        if (!ignore) setError(explain(e));
      });
    return () => {
      ignore = true;
      detailRequest.current++;
    };
  }, [connected, selected]);
  useEffect(()=>{
    if(devRecovery.blockAutosave||!dialogOpen||!dirty||!thread?.ownership.isMine||thread.intent||saving||sending.current)return;
    const id=setTimeout(()=>{void saveDraft().catch(e=>setError(explain(e)));},500);
    return()=>clearTimeout(id);
  },[devRecovery.blockAutosave,dialogOpen,dirty,text,suggestionId,thread?.ownership.isMine,thread?.draft?.version,thread?.intent,saving]);
  useEffect(()=>{
    if(!devRecovery.restoring&&dialogOpen&&dirty&&thread&&!thread.ownership.isMine&&!thread.intent)
      void openDialog().catch(e=>setError(explain(e)));
  },[devRecovery.restoring,dialogOpen,dirty,thread?.ownership.isMine,thread?.ownership.generation,thread?.intent]);
  useEffect(() => {
    if (!connected || !thread?.ownership.isMine || !selected) return;
    const generation = thread.ownership.generation,
      eventId = selected;
    const id = setInterval(
      () =>
        void request<Thread["ownership"]>({
          command: "renewHuman",
          eventId,
          generation,
        })
          .then((ownership) => {
            if (selectedRef.current === eventId)
              setThread((t) =>
                t &&
                t.event.id === eventId &&
                t.ownership.generation === generation
                  ? { ...t, ownership: { ...ownership, isMine: true } }
                  : t,
              );
          })
          .catch((e) => setError(explain(e))),
      30_000,
    );
    return () => clearInterval(id);
  }, [
    connected,
    selected,
    thread?.ownership.isMine,
    thread?.ownership.generation,
  ]);
  useEffect(() => {
    if (!send || !["PREPARING", "QUEUED", "PREFLIGHT", "SENDING"].includes(send.status))
      return;
    let ignore = false;
    const id = setInterval(
      () =>
        void request<typeof send>({
          command: "getSendResult",
          commandId: send.commandId,
        })
          .then(async (result) => {
            if (ignore || !result) return;
            setSend(result);
            if (
              !["PREPARING", "QUEUED", "PREFLIGHT", "SENDING"].includes(result.status) &&
              selectedRef.current
            ) {
              await refreshThread(selectedRef.current);
            }
          })
          .catch((e) => {
            if (!ignore) setError(explain(e));
          }),
      500,
    );
    return () => {
      ignore = true;
      clearInterval(id);
    };
  }, [send?.commandId, send?.status]);

  async function act(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy("");
    }
  }
  async function refreshThread(eventId = selectedRef.current,alive:()=>boolean=()=>true) {
    if (eventId && eventId === selectedRef.current) {
      const requestId = ++detailRequest.current,
        selectionId = selection.current;
      const t = await request<Thread>({ command: "getThread", eventId });
      if (
        alive()&&
        selectedRef.current === eventId &&
        selection.current === selectionId &&
        detailRequest.current === requestId
      ) {
        setThread(t);
        if (!editorLoaded.current) {
          editorLoaded.current = true;
          const saved = buffers.current.get(eventId);
          setText(saved?.text ?? t.draft?.text ?? "");
          setSuggestionId(saved?.suggestionId ?? null);
          if (saved && saved.version !== (t.draft?.version ?? 0))
            setError(
              "本地未保存内容保留，但服务器草稿已变化。请核对后重新保存。",
            );
        }
        return t;
      }
    }
    return null;
  }
  function choose(id: string) {
    if (selected === id) return;
    const version=++navigation.current;
    if (thread && dirty)
      buffers.current.set(thread.event.id, {
        text,
        version: thread.draft?.version ?? 0,
        suggestionId,
      });
    const leaving=thread&&dirty&&thread.event.payload.channel==='DIRECT_MESSAGE'&&thread.ownership.isMine&&!thread.intent;
    if(leaving){
      void (async()=>{
        do{await saveDraft();}while(latestEditor.current.eventId===thread.event.id&&latestEditor.current.text!==thread.draft?.text&&
          (await request<Thread>({command:'getThread',eventId:thread.event.id})).draft?.text!==latestEditor.current.text);
        if(navigation.current===version)select(id);
      })().catch(error=>setError(explain(error)));
      return;
    }
    select(id);
  }
  function select(id:string){
    setReview(null);
    detailRequest.current++;
    selectedRef.current = id;
    setSelected(id);
    setError("");
    setNotice("");
  }
  async function saveDraft() {
    if(saveTask.current){await saveTask.current;return;}
    if (!thread) return;
    const eventId = thread.event.id,
      submittedText = latestEditor.current.text,
      submittedSuggestion = latestEditor.current.suggestionId;
    if(latestEditor.current.eventId!==eventId)return;
    setSaving(true);
    const task=request<NonNullable<Thread["draft"]>>({
      command: "saveDraft",
      eventId: thread.event.id,
      generation: thread.ownership.generation,
      expectedVersion: Math.max(thread.draft?.version??0,localDraftVersions.current.get(eventId)??0),
      text:submittedText,
      suggestionId:submittedSuggestion,
    });
    saveTask.current=task;
    let saved:NonNullable<Thread['draft']>;
    try{saved=await task;}finally{saveTask.current=null;setSaving(false);}
    localDraftVersions.current.set(eventId,saved.version);
    const buffered = buffers.current.get(eventId);
    if (buffered) {
      if (
        buffered.text === submittedText &&
        buffered.suggestionId === submittedSuggestion
      )
        buffers.current.delete(eventId);
      else
        buffers.current.set(eventId, { ...buffered, version: saved.version });
    }
    const current = latestEditor.current;
    if (
      current.eventId === eventId &&
      current.text === submittedText &&
      current.suggestionId === submittedSuggestion
    )
      setSuggestionId(null);
    await refreshThread(eventId);
    setNotice("草稿已保存，旧审批已失效");
    if (selectedRef.current === eventId) setReview(null);
  }
  async function reconnect(){
    const next=await request<Status>({command:'connect',runtime,initialize:false,consent:true});setStatus(next);setReview(null);setSend(null);
    const eventId=selectedRef.current,selectionId=crypto.randomUUID();selection.current=selectionId;
    await request({command:'selectTarget',eventId,selectionId});await refreshThread(eventId);setNotice('已读取内核权威状态，未重放发送；未保存人稿保留');
  }
  function sendDisabled() {
    if (!thread || !status) return "请选择一条任务";
    if (devRecovery.restoring) return "开发内核正在恢复连接，人稿已保留";
    if (thread.intent)
      return thread.replyStatus === 'REPLIED'
        ? "这条消息已回复"
        : "这条回复已提交，正在后台检查送达情况，请勿重复发送";
    if (thread.frozen) return reasons.TARGET_FROZEN;
    if (status.automation?.emergencyStopped||status.paused) return "已急停，恢复运行后可继续回复";
    if (thread.paused) return reasons.TARGET_PAUSED;
    const human=thread.humanReplyEligibility;
    if (human?!human.eligible:!thread.strong||thread.event.status==='MANUAL_REVIEW')
      return human?.reason
        ? reasons[human.reason]??'这条消息暂时无法人工发送，草稿已保留'
        : thread.event.payload.observationIssue?reasons[thread.event.payload.observationIssue]??"这条消息需人工处理，草稿已保留"
        : "这条消息暂时无法发送，草稿已保留，后台正在处理";
    const capability =
      status.capabilities.find(
        (c) => c.channel === thread.event.payload.channel,
      ) ?? thread.capability;
    if (!status.automation&&capability.state !== "SEND_AVAILABLE" && !thread.controlledTrial)
      return reasons[capability.reason] ?? "通道尚未开放发送";
    if (!["MANUAL", "AI_ASSISTED", "LIMITED_AUTO"].includes(status.configuredMode))
      return reasons.MODE_DRAFT_ONLY;
    if (
      !thread.ownership.isMine ||
      thread.ownership.lease_expires_at <= Date.now()
    )
      return "正在自动准备编辑，输入内容会保留";
    if (!status.operator.permissions.includes("SEND"))
      return "当前操作员没有发送权限";
    if (!text.trim()) return "请输入回复";
    return "";
  }
  async function toggleAuto(enabled:boolean){
    if(autoReplyUpdating.current)return;
    autoReplyUpdating.current=true;setPendingAutoReply(enabled);
    try{
      await saveTask.current;
      if(dirty&&thread?.ownership.isMine&&!thread.intent)await saveDraft();
      setStatus(await request<Status>({command:'setAutomaticReply',enabled}));
      await refreshThread();
    }finally{autoReplyUpdating.current=false;setPendingAutoReply(null);}
  }
  async function navigatePage(next:typeof page){
    if(page==='inbox'&&next!=='inbox'&&thread?.ownership.isMine&&!thread.intent)await closeDialog();
    setPage(next);setReview(null);
  }
  async function openDialog(){
    if(!thread)return;
    const id=thread.event.id,selectionId=selection.current;
    if(opening.current?.id===id&&opening.current.selectionId===selectionId)return opening.current.task;
    const task=(async()=>{
      const detail=await request<Thread>({command:'openHumanDialog',eventId:id,selectionId});
      if(selectedRef.current===id&&selection.current===selectionId){detailRequest.current++;setThread(detail);setDialogOpen(true);}
    })();
    opening.current={id,selectionId,task};
    try{await task;}finally{if(opening.current?.task===task)opening.current=null;}
  }
  async function closeDialog(){
    await saveTask.current;
    if(thread&&latestEditor.current.eventId===thread.event.id){
      const detail=await request<Thread>({command:'getThread',eventId:thread.event.id});
      const latest=latestEditor.current;
      if(detail.ownership.isMine&&latest.text!==(detail.draft?.text??''))await request({command:'saveDraft',eventId:detail.event.id,
        generation:detail.ownership.generation,expectedVersion:detail.draft?.version??0,text:latest.text,suggestionId:latest.suggestionId});
    }
    if(thread?.ownership.isMine)await request({command:'closeHumanDialog',eventId:thread.event.id,generation:thread.ownership.generation});
    setDialogOpen(false);await refreshThread();
  }
  async function emergencyStop(){
    await request({command:'emergencyStop'});setStatus(s=>s?{...s,paused:true,automation:s.automation?{...s.automation,emergencyStopped:true}:s.automation}:s);setReview(null);
    setNotice('急停已生效；已存意图仍需回读或冻结');await refreshThread();
  }
  async function sendCurrentText(){
    if(!thread||sending.current)return;
    sending.current=true;
    const eventId=thread.event.id,selectionId=selection.current;
    const submittedText=latestEditor.current.text,submittedSuggestion=latestEditor.current.suggestionId;
    try{
      await saveTask.current;
      const detail=await request<Thread>({command:'getThread',eventId});
      if(selectedRef.current!==eventId||selection.current!==selectionId)throw Error('TARGET_SELECTION_CHANGED');
      const commandId=crypto.randomUUID();setSend({commandId,status:'PREPARING',reason:null});
      const result=await request<NonNullable<typeof send>>({command:'sendHumanReply',commandId,input:{eventId,generation:detail.ownership.generation,
        expectedVersion:detail.draft?.version??0,text:submittedText,contextVersion:detail.contextVersion,selectionId,suggestionId:submittedSuggestion}});
      setSend(result);await refreshThread(eventId);
    }finally{sending.current=false;}
  }

  if (!status)
    return (
      <main className="connect">
        <div className="connect-mark">
          inbora<span>本地人工客服工作台</span>
        </div>
        <section className="connect-form">
          <p className="eyebrow">单账号 · 受控试用</p>
          <h1>连接你的本地收件箱</h1>
          <p>评论与私信统一处理。没有 Key，也可以人工写回复。</p>
          <label>
            私有运行目录
            <input
              value={runtime}
              onChange={(e) => setRuntime(e.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={initialize}
              onChange={(e) => setInitialize(e.target.checked)}
            />
            初始化全新目录（已有资料不勾选）
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            我确认这是已授权账号的本地运行目录，允许读取并升级数据库
          </label>
          <p className="hint">
            升级前验证备份与恢复，保留预算、旧意图和冻结。连接后恢复已启用的后台收取；外发仅在你已启用的准确策略内执行。
          </p>
          <button
            className="primary"
            disabled={!runtime || !consent || !!busy}
            onClick={() =>
              void act("连接中", async () => {
                const result=await request<Status>({
                    command: "connect",
                    runtime,
                    initialize,
                    consent: true,
                  });setStatus(result);localStorage.setItem('inbora-runtime',result.runtime);
              })
            }
          >
            {busy || "连接收件箱"}
          </button>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <small>
            版本 {version || "读取中"} · PoC GO 与客户端验收分别记录
          </small>
        </section>
      </main>
    );
  const block = sendDisabled(),
    readOnly =
      devRecovery.restoring || !!thread?.intent ||
      status.mode === "OBSERVE";
  return (
    <div className="app">
      <a className="skip" href="#main-content">
        跳至内容
      </a>
      <aside className="sidebar">
        <div className="brand">
          inbora<span>人工收件箱</span>
        </div>
        <div className="account">
          <span className="account-avatar">本</span>
          <div>
            <strong>本人测试账号</strong>
            <small>{status.account ? "已绑定本地账号" : "尚未核验账号"}</small>
          </div>
        </div>
        <nav aria-label="主导航">
          {(["inbox", "settings", "audit"] as const).map((p) => (
            <button
              key={p}
              aria-current={page === p ? "page" : undefined}
              className={page === p ? "active" : ""}
              onClick={() => {
                void navigatePage(p).catch(e=>setError(explain(e)));
              }}
            >
              {p === "inbox"
                ? "收件箱"
                : p === "settings"
                  ? "AI 与设置"
                  : "操作审计"}
            </button>
          ))}
        </nav>
        <div className="runtime-status">
          <p>
            <span className={"dot " + (status.automation?.emergencyStopped ? "warn" : "")} />
            {status.automation?.emergencyStopped ? "已急停" : status.browser.state.startsWith('OPEN') ? "账号保持连接" : "正在连接账号"}
          </p>
          <small>
            浏览器：
            {browserState(status.browser.state,status.automation?.emergencyStopped)}
          </small>
          <small>
            {status.browser.mode === "headed" ? "有头 Edge" : "无头 Edge"}{" "}
            {status.browser.version ?? ""}
          </small>
          {status.lastSync.map((s) => (
            <small key={s.channel}>
              {s.channel === "DIRECT_MESSAGE" ? "私信" : "评论"}最近同步
              <br />
              {time(s.at)}
            </small>
          ))}
          {!status.lastSync.length && <small>尚无成功同步记录</small>}
        </div>
        <div className="sidebar-bottom">
          <button disabled={!!busy} onClick={()=>void act('重新连接内核',reconnect)}>重新连接内核</button>
          <small>{version} · 受控试用</small>
        </div>
      </aside>
      <main id="main-content" className="workspace">
        <header className="topbar">
          <div>
            <h1>
              {page === "inbox"
                ? "收件箱"
                : page === "settings"
                  ? "AI 与设置"
                  : "操作审计"}
            </h1>
            <span className="muted">
              {modes[status.configuredMode]} · {status.automation?.emergencyStopped ? "已急停" : "单账号持续连接"}
            </span>
          </div>
          <div className="toolbar">
            <label className="check"><input type="checkbox" role="switch" aria-label="自动回复" checked={pendingAutoReply??(status.configuredMode==='LIMITED_AUTO'&&!!status.automation?.replyPolicy)}
              disabled={pendingAutoReply!==null||!!busy||!status.automation?.replyPolicy} onChange={e=>{const enabled=e.target.checked;void act('更新自动回复',()=>toggleAuto(enabled));}}/>
              {pendingAutoReply!==null?pendingAutoReply?'正在开启自动回复…':'正在关闭自动回复…':`自动回复：${status.configuredMode==='LIMITED_AUTO'&&status.automation?.replyPolicy?'开':'关'}`}</label>
            {!status.automation?.replyPolicy&&<button onClick={()=>setPage('settings')}>设置自动回复</button>}
            <button
              disabled={!!busy||status.sync.running}
              onClick={() =>
                void act("启动同步", async () => {
                  setStatus(
                    await request<Status>({ command: "syncInbox" }),
                  );
                })
              }
            >
              {status.sync.running?(status.sync.cancelled?'正在结束同步…':status.sync.source?`正在同步${syncNames[status.sync.source]}…`:'正在启动同步…'):'同步收件箱'}
            </button>
          </div>
        </header>
        {status.sync.runId&&<div className={"message"+(status.sync.results.some(result=>result.state==='FAILED')?' error':'')}
          role={status.sync.results.some(result=>result.state==='FAILED')?'alert':'status'} data-testid="inbox-sync-progress">
          {status.sync.results.map(result=>`${syncNames[result.source]}${syncStates[result.state]}${result.error?'：'+(reasons[result.error]??result.error):''}`).join('；')}
        </div>}
        {(error || notice || busy) && (
          <div
            className={"message " + (error ? "error" : "")}
            role={error ? "alert" : "status"}
          >
            {error || busy || notice}
          </div>
        )}
        {page === "settings" ? (
          <Settings
            status={status}
            runtime={runtime}
            busy={busy}
            act={act}
            update={setStatus}
            toggleAuto={toggleAuto}
            pendingAutoReply={pendingAutoReply}
            stop={()=>void emergencyStop().catch(e=>setError(explain(e)))}
          />
        ) : page === "audit" ? (
          <section className="audit scroll">
            <p>仅展示本地脱敏审计。未知收据和历史证据保留原记录。</p>
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>动作</th>
                  <th>本地记录</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a, i) => (
                  <tr key={i}>
                    <td>{time(a.time)}</td>
                    <td>{a.event_type}</td>
                    <td>
                      <code>{a.entity_id}</code>
                      <small>{a.detail_redacted}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pager">
              <button
                disabled={auditPage === 0}
                onClick={() => setAuditPage((n) => n - 1)}
              >
                上一页
              </button>
              <span>第 {auditPage + 1} 页</span>
              <button
                disabled={audit.length < 50}
                onClick={() => setAuditPage((n) => n + 1)}
              >
                下一页
              </button>
            </div>
          </section>
        ) : (
          <div className="inbox-layout">
            <InboxList inbox={inbox} selected={selected} selectedGroup={thread?.event.id===selected?thread.groupKey:undefined}
              channel={channel} setChannel={setChannel} filter={filter} setFilter={setFilter}
              pageNumber={pageNumber} setPageNumber={setPageNumber} choose={choose}/>
            <ReplyDetail
              detailElement={detailElement}
              dialogElement={dialogElement}
              thread={thread}
              status={status}
              setStatus={setStatus}
              selected={selected}
              busy={busy}
              act={act}
              setNotice={setNotice}
              openDialog={openDialog}
              closeDialog={closeDialog}
              readOnly={readOnly}
              saving={saving}
              dirty={dirty}
              error={error}
              notice={notice}
              text={text}
              setText={setText}
              setSuggestionId={setSuggestionId}
              setReview={setReview}
              refreshThread={()=>refreshThread()}
              block={block}
              send={send}
              sendCurrentText={sendCurrentText}
            />

          </div>
        )}
      </main>
    </div>
  );
}
