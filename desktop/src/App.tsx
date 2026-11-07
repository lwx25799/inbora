import { useEffect, useRef, useState } from "react";
import { AutomationSettings } from './AutomationSettings';
import {
  request,
  desktopInfo,
  closeDesktop,
  explain,
  reasons,
  statusNames,
  capabilityNames,
  sourceNames,
  type Status,
  type Inbox,
  type Thread,
} from "./api";

function time(value: string | number | null | undefined) {
  return value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "尚无成功记录";
}
const modes = {
  OBSERVE: "只读观察",
  DRAFT_ONLY: "仅保存草稿",
  MANUAL: "纯人工回复",
  AI_ASSISTED: "AI 辅助回复",
  LIMITED_AUTO: "规则自动回复",
};
const syncNames={works:'评论',dm:'私信'};
const syncStates={PENDING:'等待同步',RUNNING:'同步中',SUCCEEDED:'同步完成',FAILED:'同步失败',SKIPPED:'未继续同步',CANCELLED:'同步已停止'};
const draftOrigins = new Map([
  ["HUMAN_TYPED", "人工输入"],
  ["AI_ASSISTED_APPROVED", "已引用 AI 建议"],
  ["LEGACY", "历史草稿"],
]);
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
      "ALL" | "PENDING" | "REVIEW" | "UNCERTAIN" | "CONFIRMED"
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
  const [audit, setAudit] = useState<
      {
        time: string;
        event_type: string;
        entity_id: string;
        detail_redacted: string;
      }[]
    >([]),
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
  const saveTask=useRef<Promise<unknown>|null>(null),dialogElement=useRef<HTMLDialogElement|null>(null);
  const dirty =
    !!thread && (text !== (thread.draft?.text ?? "") || suggestionId !== null);
  const latestEditor = useRef({ eventId: selected, text, suggestionId });
  latestEditor.current = { eventId: selected, text, suggestionId };
  useEffect(() => {
    if(dialogOpen&&!dialogElement.current?.open)dialogElement.current?.showModal();
    if(!dialogOpen&&dialogElement.current?.open)dialogElement.current.close();
  },[dialogOpen]);
  useEffect(() => {
    if (detailElement.current) detailElement.current.scrollTop = 0;
  }, [thread?.event.id]);

  useEffect(() => {
    void desktopInfo()
      .then((i) => {
        setRuntime(i.runtime);
        setVersion(i.version);
      })
      .catch((e) => setError(explain(e)));
    const previous=localStorage.getItem('inbora-runtime');
    void request<Status>({ command: "getStatus" })
      .then((s) => {
        setRuntime(s.runtime);
        setStatus(s);
      })
      .catch(() => {if(previous)void request<Status>({command:'connect',runtime:previous,initialize:false,consent:true}).then(s=>{setRuntime(s.runtime);setStatus(s);}).catch(e=>setError(explain(e)));});
  }, []);
  useEffect(() => {
    if (!connected) return;
    let ignore = false;
    const refresh = () =>
      request<Status>({ command: "getStatus" })
        .then((s) => {
          if (!ignore) setStatus(s);
        })
        .catch((e) => {
          if (!ignore) setError("内核连接中断：" + explain(e));
        });
    const id = setInterval(() => void refresh(), 1500);
    return () => {
      ignore = true;
      clearInterval(id);
    };
  }, [connected]);
  useEffect(() => {
    if (!connected) return;
    let ignore = false;
    void request<Inbox>({
      command: "getInbox",
      channel,
      status: filter,
      page: pageNumber,
    })
      .then((i) => {
        if (!ignore) setInbox(i);
      })
      .catch((e) => {
        if (!ignore) setError(explain(e));
      });
    return () => {
      ignore = true;
    };
  }, [connected, channel, filter, pageNumber, notice, send?.status,status?.sync.runId,status?.sync.running,
    status?.sync.results.map(result=>result.state).join('|'),status?.automation?.inboxRevision]);
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
      .then(() => {
        if (!ignore) return refreshThread(selected);
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
    if(!dialogOpen||!dirty||!thread?.ownership.isMine||saving||sending.current)return;
    const id=setTimeout(()=>{void saveDraft().catch(e=>setError(explain(e)));},500);
    return()=>clearTimeout(id);
  },[dialogOpen,dirty,text,suggestionId,thread?.ownership.isMine,thread?.draft?.version,saving]);
  useEffect(() => {
    if (!connected || !selected) return;
    const eventId = selected;
    void refreshThread(eventId).catch(() => {});
  }, [
    connected,
    selected,
    status?.browser.state,
    status?.paused,
    status?.browser.version,
    status?.capabilities.map((c) => c.state + ":" + c.reason).join("|"),
    status?.automation?.inboxRevision,
  ]);
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
  useEffect(() => {
    if (!connected || page !== "audit") return;
    let ignore = false;
    void request<{ items: typeof audit }>({
      command: "getAudit",
      page: auditPage,
    })
      .then((r) => {
        if (!ignore) setAudit(r.items);
      })
      .catch((e) => setError(explain(e)));
    return () => {
      ignore = true;
    };
  }, [connected, page, auditPage, notice]);

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
  async function refreshThread(eventId = selectedRef.current) {
    if (eventId && eventId === selectedRef.current) {
      const requestId = ++detailRequest.current,
        selectionId = selection.current;
      const t = await request<Thread>({ command: "getThread", eventId });
      if (
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
    if (thread && dirty)
      buffers.current.set(thread.event.id, {
        text,
        version: thread.draft?.version ?? 0,
        suggestionId,
      });
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
      submittedText = text,
      submittedSuggestion = suggestionId;
    setSaving(true);
    const task=request<NonNullable<Thread["draft"]>>({
      command: "saveDraft",
      eventId: thread.event.id,
      generation: thread.ownership.generation,
      expectedVersion: thread.draft?.version ?? 0,
      text,
      suggestionId,
    });
    saveTask.current=task;
    let saved:NonNullable<Thread['draft']>;
    try{saved=await task;}finally{saveTask.current=null;setSaving(false);}
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
    if (thread.intent)
      return thread.intent.status === "CONFIRMED"
        ? "此事件已有确认收据"
        : "此事件已有发送意图，禁止重复提交";
    if (thread.frozen) return reasons.TARGET_FROZEN;
    if (status.paused) return reasons.ACCOUNT_PAUSED;
    if (thread.paused) return reasons.TARGET_PAUSED;
    if (!thread.strong || thread.event.status === "MANUAL_REVIEW")
      return "目标需核对，请保留草稿";
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
      return "请先接管此目标";
    if (!status.operator.permissions.includes("SEND"))
      return "当前操作员没有发送权限";
    if (!text.trim()) return "请输入回复";
    return "";
  }
  async function openDialog(){
    if(!thread)return;
    const id=thread.event.id,selectionId=selection.current;
    const detail=await request<Thread>({command:'openHumanDialog',eventId:id,selectionId});
    if(selectedRef.current===id&&selection.current===selectionId){setThread(detail);setDialogOpen(true);}
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
    await request({command:'emergencyStop'});setStatus(s=>s?{...s,paused:true}:s);setReview(null);
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
      !!thread?.intent ||
      (!!thread && !thread.ownership.isMine) ||
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
                setPage(p);
                setReview(null);
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
            <span className={"dot " + (status.paused ? "warn" : "")} />
            {status.paused ? "账号已暂停" : "内核已连接"}
          </p>
          <small>
            浏览器：
            {status.browser.state === "CLOSED"
              ? "已关闭"
              : status.browser.state === "OPEN_LAST_READ_VERIFIED"
                ? "最近读取已核验"
                : status.browser.state === "STARTING"
                  ? "正在启动"
                  : "已打开，身份待核验"}
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
          <button
            className="danger"
            onClick={() =>
              void emergencyStop()
                .catch((e) => setError(explain(e)))
            }
          >
            全局急停
          </button>
          <small>已开始的提交无法撤回</small>
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
              {modes[status.mode]} · {status.paused ? "已暂停" : "手动操作"}
            </span>
          </div>
          <div className="toolbar">
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
            <section className="inbox-list">
              <div className="filters">
                <div className="segments" aria-label="通道筛选">
                  {(
                    ["ALL", "COMMENT_NOTIFICATION", "DIRECT_MESSAGE"] as const
                  ).map((c) => (
                    <button
                      key={c}
                      className={c === channel ? "active" : ""}
                      onClick={() => {
                        setChannel(c);
                        setPageNumber(0);
                      }}
                    >
                      {c === "ALL"
                        ? "全部"
                        : c === "DIRECT_MESSAGE"
                          ? "私信"
                          : "评论"}
                    </button>
                  ))}
                </div>
                <select
                  aria-label="任务状态"
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value as typeof filter);
                    setPageNumber(0);
                  }}
                >
                  <option value="ALL">所有任务</option>
                  <option value="PENDING">待处理 / 待确认</option>
                  <option value="REVIEW">目标需核对</option>
                  <option value="UNCERTAIN">结果待核实</option>
                  <option value="CONFIRMED">已确认</option>
                </select>
                <small>{inbox.total} 条任务</small>
              </div>
              <div className="task-list scroll">
                {inbox.items.map((i) => (
                  <button
                    key={i.id}
                    className={"task " + (selected === i.id ? "selected" : "")}
                    aria-pressed={selected === i.id}
                    onClick={() => choose(i.id)}
                  >
                    <div>
                      <strong>{i.author || "身份待核对"}</strong>
                      <span
                        className={
                          "badge " +
                          (["UNCERTAIN", "MANUAL_REVIEW"].includes(i.status)
                            ? "warn"
                            : "")
                        }
                      >
                        {statusNames[i.status] ?? i.status}
                      </span>
                    </div>
                    <p>{i.preview}</p>
                    <small>
                      {i.channel === "DIRECT_MESSAGE" ? "私信" : "评论"} ·{" "}
                      {sourceNames[i.source]}
                      <br />
                      {time(i.time)}
                    </small>
                  </button>
                ))}
                {!inbox.items.length && (
                  <div className="empty">
                    <strong>当前没有这类待办</strong>
                    <p>后台会按已启用范围自动收取，也可以立即同步或更换筛选。</p>
                  </div>
                )}
              </div>
              <div className="pager">
                <button
                  disabled={pageNumber === 0}
                  onClick={() => setPageNumber((n) => n - 1)}
                >
                  上一页
                </button>
                <span>{pageNumber + 1}</span>
                <button
                  disabled={(pageNumber + 1) * 20 >= inbox.total}
                  onClick={() => setPageNumber((n) => n + 1)}
                >
                  下一页
                </button>
              </div>
            </section>
            <section
              ref={detailElement}
              className="detail scroll"
              aria-label="消息详情"
            >
              {!thread ? (
                <div className="empty detail-empty">
                  <span className="detail-mark">i</span>
                  <h2>
                    {selected ? "正在读取准确目标" : "从左侧选择一条消息"}
                  </h2>
                  <p>查看原文与准确目标，打开人工回复后输入并发送。</p>
                </div>
              ) : (
                <>
                  <div className="detail-heading">
                    <div>
                      <p className="eyebrow">
                        {thread.event.payload.channel === "DIRECT_MESSAGE"
                          ? "私信会话"
                          : "作品评论"}{" "}
                        ·{" "}
                        {
                          sourceNames[
                            thread.event.payload.discovery ??
                              (thread.event.payload.channel === "DIRECT_MESSAGE"
                                ? "DIRECT_MESSAGE"
                                : "NOTIFICATION")
                          ]
                        }
                      </p>
                      <h2>{thread.event.payload.actorName || "身份待核对"}</h2>
                    </div>
                    <span className="badge">
                      {statusNames[thread.event.status]}
                    </span>
                  </div>
                  <details className="identity" open>
                    <summary>
                      准确目标与身份 ·{" "}
                      {thread.strong
                        ? "本地字段完整，发送前仍核验网页"
                        : "需人工核对"}
                    </summary>
                    <dl>
                      <dt>本人账号</dt>
                      <dd>{status.account?.identity ?? "未绑定"}</dd>
                      <dt>对方账号</dt>
                      <dd>
                        {thread.event.payload.actorId ?? "未取得稳定标识"}
                      </dd>
                      {thread.event.payload.channel === "DIRECT_MESSAGE" ? (
                        <>
                          <dt>会话</dt>
                          <dd>
                            {thread.event.payload.conversationId ?? "未取得"}
                          </dd>
                        </>
                      ) : (
                        <>
                          <dt>作品</dt>
                          <dd>{thread.event.payload.videoId ?? "未取得"}</dd>
                          {thread.workUrl && (
                            <>
                              <dt>作品链接</dt>
                              <dd>{thread.workUrl}</dd>
                            </>
                          )}
                          <dt>原父评论</dt>
                          <dd>{thread.event.payload.commentId ?? "未取得"}</dd>
                          <dt>回复关系</dt>
                          <dd>只回复此父评论，不在作品下另发顶层评论</dd>
                        </>
                      )}
                      <dt>原事件</dt>
                      <dd>
                        {thread.event.payload.platformEventId ?? "未取得"}
                      </dd>
                    </dl>
                  </details>
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      void act("打开准确原对象", async () => {
                        await request({
                          command: "openTarget",
                          eventId: thread.event.id,
                        });
                        setNotice("已在专属浏览器中定位，未填写或发送");
                      })
                    }
                  >
                    在专属浏览器查看原对象
                  </button>
                  <section className="original">
                    <h3>
                      {thread.event.payload.channel === "DIRECT_MESSAGE"
                        ? "触发此任务的私信"
                        : "原父评论"}
                    </h3>
                    <p>{thread.event.payload.text}</p>
                    <small>{time(thread.event.payload.occurredAt)}</small>
                  </section>
                  <details className="history">
                    <summary>有限上下文 · {thread.history.length} 条</summary>
                    {thread.history.map((h, i) => (
                      <article
                        key={i}
                        className={h.direction === "OUTGOING" ? "outgoing" : ""}
                      >
                        <small>
                          {h.direction === "OUTGOING"
                            ? "我方已确认回复"
                            : "入站观察"}{" "}
                          · {time(h.occurredAt)}
                        </small>
                        <p>{h.text}</p>
                      </article>
                    ))}
                  </details>
                  <button className="primary" onClick={()=>void act('打开人工回复',openDialog)}>打开人工回复</button>
                  <dialog ref={dialogElement} className="human-dialog" aria-label="人工回复对话框" onCancel={e=>{e.preventDefault();void act('保存并关闭',closeDialog);}}>
                    <div className="dialog-heading"><h2>回复 {thread.event.payload.actorName || '当前目标'}</h2>
                      <button className="danger" onClick={()=>void emergencyStop().catch(e=>setError(explain(e)))}>全局急停</button>
                      <button onClick={()=>void act('保存并关闭',closeDialog)}>关闭并保留草稿</button></div>
                    {!thread.ownership.isMine&&!thread.intent&&<button onClick={()=>void act('恢复编辑',openDialog)}>恢复编辑</button>}
                    <p className="identity">本人：{status.account?.identity} · 对方：{thread.event.payload.actorId}<br/>
                      {thread.event.payload.channel==='DIRECT_MESSAGE'?'会话：'+thread.event.payload.conversationId:'作品：'+thread.event.payload.videoId+' · 父评论：'+thread.event.payload.commentId}</p>
                    <blockquote>{thread.event.payload.text}</blockquote>
                    <details><summary>上下文 · {thread.history.length} 条</summary>{thread.history.map((h,i)=><p key={i}>{h.direction==='OUTGOING'?'我方：':'对方：'}{h.text}</p>)}</details>
                    <p className="hint">{thread.ownership.isMine?'编辑期间自动接管、续期与保存':'此目标当前只读'}{saving?' · 正在保存':dirty?' · 等待自动保存':' · 修改已保存'}</p>
                    {(error||notice||busy)&&<p role={error?'alert':'status'} className={error?'error':'hint'}>{error||busy||notice}</p>}
                  <section className="editor">
                    <div className="editor-title">
                      <h3>回复草稿</h3>
                      <small>
                        版本 {thread.draft?.version ?? 0} ·{" "}
                        {thread.draft
                          ? draftOrigins.get(thread.draft.origin) ?? "来源待核对"
                          : "尚未保存"}{" "}
                        · {[...text].length}/500 字
                      </small>
                    </div>
                    <textarea
                      aria-label="人工回复草稿"
                      value={text}
                      readOnly={readOnly}
                      placeholder={
                        readOnly
                          ? "先接管目标，开始人工编辑"
                          : "直接输入回复，无需 Key"
                      }
                      onChange={(e) => {
                        setText(e.target.value);
                        setReview(null);
                      }}
                    />
                    <div className="editor-actions">
                      <div>
                        <button
                          disabled={readOnly || !!busy || !text}
                          onClick={() => {
                            setText("");
                            setSuggestionId(null);
                            setReview(null);
                          }}
                        >
                          清空
                        </button>
                      </div>
                      <button
                        disabled={
                          !!busy ||
                          status.modelBusy ||
                          !status.modelAuthorized ||
                          !!thread.intent ||
                          status.mode === "OBSERVE"
                        }
                        onClick={() =>
                          void act("生成 AI 建议", async () => {
                            await request({
                              command: "generateSuggestion",
                              eventId: thread.event.id,
                              draftVersion: thread.draft?.version ?? 0,
                            });
                            await refreshThread();
                            setNotice("AI 建议已到达，当前人稿保留");
                          })
                        }
                      >
                        生成 AI 建议
                      </button>
                    </div>
                    {!status.keyPresent && (
                      <p className="hint">
                        未配置 Key，人工输入、保存与确认发送均不调用模型。
                      </p>
                    )}
                  </section>
                  {thread.suggestions.map((s) => (
                    <section className="suggestion" key={s.id}>
                      <h3>
                        AI 建议{" "}
                        <small>
                          {s.model}
                          {s.draft_version !== (thread.draft?.version ?? 0)
                            ? " · 基于旧草稿版本"
                            : ""}
                        </small>
                      </h3>
                      <p>{s.text}</p>
                      <button
                        disabled={readOnly}
                        onClick={() => {
                          setText(s.text);
                          setSuggestionId(s.id);
                          setReview(null);
                        }}
                      >
                        引用到编辑器
                      </button>
                      <button
                        onClick={() =>
                          void act("拒绝建议", async () => {
                            await request({
                              command: "dismissSuggestion",
                              suggestionId: s.id,
                            });
                            await refreshThread();
                          })
                        }
                      >
                        拒绝建议
                      </button>
                    </section>
                  ))}
                  {thread.receipt && (
                    <section className="receipt">
                      <strong>{statusNames[thread.receipt.result]}</strong>
                      <p>回读记录：{time(thread.receipt.verified_at)}</p>
                      <small>原收据保留；异常或未知不会因刷新被解冻。</small>
                    </section>
                  )}
                  {thread.verification&&<p className="receipt">{thread.verification.verified?'后续核验已确认送达，原异常与冻结保留':thread.verification.state==='REVIEW'?'后台补证结束，需要核对结果':'后台正在有界补证，无需重复发送'} · 已核验 {thread.verification.attempts} 次</p>}
                  {thread.automationJob&&<p className="hint">自动处理：{statusNames[thread.automationJob.state]??thread.automationJob.state}{thread.automationJob.reason?' · '+(reasons[thread.automationJob.reason]??thread.automationJob.reason):''}</p>}
                  {send && (
                    <p role="status" className="send-state">
                      {statusNames[send.status] ?? send.status}
                      {send.reason
                        ? " · " + (reasons[send.reason] ?? send.reason)
                        : ""}
                    </p>
                  )}
                    <div className="send-footer">
                      <p className="hint">
                        {block ||
                          "点击发送即确认当前目标与完整回复，后台自动核验并提交一次。"}
                      </p>
                      <div>
                        <small>Ctrl+Enter 也可发送当前全文</small>
                        <button
                          className="primary"
                          disabled={!!block || !!busy}
                          onClick={() => void act("发送中", sendCurrentText)}
                        >
                          发送
                        </button>
                        <button
                          onClick={() =>
                            void act("更新暂停", async () => {
                              setStatus(
                                await request<Status>({
                                  command: thread.paused ? "resume" : "pause",
                                  eventId: thread.event.id,
                                }),
                              );
                              await refreshThread();
                              setReview(null);
                            })
                          }
                        >
                          {thread.paused ? "恢复此目标" : "暂停此目标"}
                        </button>
                        {thread.intent && (
                          <button
                            disabled={!!busy}
                            onClick={() =>
                              void act("只读核验", async () => {
                                const result = await request<{
                                  verified: boolean;
                                }>({
                                  command: "reconcileUncertain",
                                  eventId: thread.event.id,
                                  decision: "READ_ONLY_VERIFY",
                                });
                                setNotice(
                                  result.verified
                                    ? "本次只读核验取得证明，原收据与冻结保留"
                                    : "本次未取得完整证明，原收据与冻结保留",
                                );
                              })
                            }
                          >
                            只读核验
                          </button>
                        )}
                        {!thread.intent&&status.automation&&<button onClick={()=>void act('恢复自动处理',async()=>{const eventId=thread.event.id;await closeDialog();await request({command:'resumeAutomation',eventId});await refreshThread();})}>恢复此目标自动处理</button>}
                      </div>
                    </div>
                  </dialog>
                </>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function Settings({
  status,
  runtime,
  busy,
  act,
  update,
}: {
  status: Status;
  runtime: string;
  busy: string;
  act: (s: string, f: () => Promise<void>) => Promise<void>;
  update: (s: Status) => void;
}) {
  const [settings, setSettings] = useState(status.settings),
    [key, setKey] = useState("");
  const [browserMode, setBrowserMode] = useState(status.browser.mode);
  return (
    <section className="settings scroll">
      {status.automation&&<AutomationSettings status={status} busy={busy} act={act} update={update}/>}
      <div className="settings-section">
        <h2>回复模式与运行</h2>
        <label>
          工作模式
          <select
            value={status.configuredMode}
            onChange={(e) =>
              void act("更新模式", async () =>
                update(
                  await request<Status>({
                    command: "setMode",
                    mode: e.target.value as Status["mode"],
                  }),
                ),
              )
            }
          >
            {Object.entries(modes).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <p className="hint">
          切换模式不会开启未经核验的发送能力；新账号默认仅保存草稿。
        </p>
        {status.mode !== status.configuredMode && (
          <p className="hint" role="status">
            已选择{modes[status.configuredMode]}；当前{modes[status.mode]}。请打开专属浏览器，并查看下方通道状态。
          </p>
        )}
        <label>
          浏览器模式
          <select
            value={browserMode}
            onChange={(e) =>
              setBrowserMode(e.target.value as typeof browserMode)
            }
          >
            <option value="headed">有头 Edge（扫码 / 人工验证）</option>
            <option value="headless">无头 Edge（证据单列）</option>
          </select>
        </label>
        <div className="row">
          <button
            disabled={!!busy}
            onClick={() =>
              void act("启动浏览器", async () =>
                update(
                  await request<Status>({
                    command: "browser",
                    open: true,
                    mode: browserMode,
                  }),
                ),
              )
            }
          >
            打开专属浏览器
          </button>
          <button
            disabled={!!busy}
            onClick={() =>
              void act("关闭浏览器", async () =>
                update(
                  await request<Status>({
                    command: "browser",
                    open: false,
                    mode: browserMode,
                  }),
                ),
              )
            }
          >
            关闭浏览器
          </button>
          <button
            onClick={() =>
              void act("更新账号暂停", async () =>
                update(
                  await request<Status>({
                    command: status.paused||status.automation?.emergencyStopped ? "resume" : "pause",
                    eventId: null,
                  }),
                ),
              )
            }
          >
            {status.paused||status.automation?.emergencyStopped ? "恢复发送" : "暂停发送"}
          </button>
        </div>
        <p>
          数据目录：<code>{runtime}</code>
        </p>
        <button onClick={() => void closeDesktop().catch(() => {})}>
          退出工作台并保留数据
        </button>
        <p className="hint">
          网络为本机直连。登录和验证码在正常可见浏览器中由本人处理，所有网页自启动即静音。
        </p>
        <dl>
          {status.capabilities.map((c) => (
            <div key={c.channel}>
              <dt>
                {c.channel === "DIRECT_MESSAGE" ? "私信能力" : "评论能力"}
              </dt>
              <dd>
                {capabilityNames[c.state] ?? c.state}
                {c.reason && <> · {reasons[c.reason] ?? c.reason}</>}
              </dd>
            </div>
          ))}
        </dl>
        <p className="hint">通道状态与 AI Key 分别生效；未配置 Key 仍可人工编辑和保存。</p>
        <button
          disabled={!!busy}
          onClick={() =>
            void act("同步通知", async () => {
              update(
                await request<Status>({
                  command: "observe",
                  source: "notifications",
                }),
              );
            })
          }
        >
          同步顶部通知（独立来源）
        </button>
      </div>
      <div className="settings-section">
        <h2>DeepSeek 辅助回复</h2>
        <p>
          手工建议与规则自动回复分别受已启用授权约束。Key 默认只留后端内存，普通配置保存保留现有 Key 与持续授权。
        </p>
        <label>
          模型
          <input
            value={settings.model}
            onChange={(e) =>
              setSettings({ ...settings, model: e.target.value })
            }
          />
        </label>
        <small>官方接口：https://api.deepseek.com/chat/completions</small>
        {(["persona", "business", "rules"] as const).map((field, i) => (
          <label key={field}>
            {["账号人设", "业务说明", "回复规则"][i]}
            <textarea
              value={settings[field]}
              onChange={(e) =>
                setSettings({ ...settings, [field]: e.target.value })
              }
            />
          </label>
        ))}
        <label>
          本次 API Key
          <input
            type="password"
            value={key}
            autoComplete="off"
            onChange={(e) => setKey(e.target.value)}
            placeholder={
              status.keyPresent
                ? "已持有 Key，留空保存可保留"
                : "不填写也可人工回复"
            }
          />
        </label>
        <button
          disabled={!!busy}
          onClick={() =>
            void act("保存 AI 配置", async () => {
              const submitted = key;
              setKey("");
              update(
                await request<Status>({
                  command: "configureAi",
                  settings,
                  key: submitted,
                }),
              );
            })
          }
        >
          保存配置并清空 Key 输入
        </button>
        <p>
          模型：{status.modelAuthorized ? "持续授权有效" : "未授权"} · Key：
          {status.keyPresent ? status.keyStored?'当前用户 DPAPI 安全保存':'仅后端内存持有' : "未配置"}
        </p>
        <label className="check"><input type="checkbox" checked={!!status.keyStored} disabled={!status.keyPresent||!!busy}
          onChange={e=>void act('更新安全保存',async()=>update(await request<Status>({command:'setKeyStorage',storage:e.target.checked?'DPAPI':'MEMORY'})))}/>
          在本机安全保存 Key（Windows 当前用户 DPAPI，默认关闭）</label>
        {status.keyStorageError&&<p className="error">{reasons[status.keyStorageError]??status.keyStorageError}</p>}
        <button disabled={!status.keyPresent&&!status.keyStored&&!status.keyStorageError} onClick={()=>void act('删除 Key',async()=>update(await request<Status>({command:'setKeyStorage',storage:'DELETE'})))}>删除已保存 Key 并清除内存</button>
        <div className="budget">
          {status.budgets.map((b) => (
            <p key={b.kind}>
              {b.kind === "MODEL" ? "累计模型预占" : "累计发送意图"}{" "}
              <strong>
                {b.used} / {b.maximum}
              </strong>
            </p>
          ))}
          <p>
            已记录 Token{" "}
            <strong>
              {status.usage.inputTokens} 输入 / {status.usage.outputTokens} 输出
            </strong>
          </p>
        </div>
        <p className="hint">
          预算上限不代替授权。超时或失败不自动重试，未返回 usage 时不推算
          Token。
        </p>
      </div>
    </section>
  );
}
