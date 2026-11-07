import { useEffect, useRef, useState } from "react";
import {
  request,
  desktopInfo,
  closeDesktop,
  explain,
  reasons,
  statusNames,
  sourceNames,
  type Status,
  type Inbox,
  type Thread,
  type Review,
  type SendParams,
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
};
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
    [review, setReview] = useState<Review | null>(null);
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
  const dirty =
    !!thread && (text !== (thread.draft?.text ?? "") || suggestionId !== null);
  const latestEditor = useRef({ eventId: selected, text, suggestionId });
  latestEditor.current = { eventId: selected, text, suggestionId };
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
    void request<Status>({ command: "getStatus" })
      .then((s) => {
        setRuntime(s.runtime);
        setStatus(s);
      })
      .catch(() => {});
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
  }, [connected, channel, filter, pageNumber, notice, send?.status]);
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
    if (!send || !["QUEUED", "PREFLIGHT", "SENDING"].includes(send.status))
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
              !["QUEUED", "PREFLIGHT", "SENDING"].includes(result.status) &&
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
    if (!thread) return;
    const eventId = thread.event.id,
      submittedText = text,
      submittedSuggestion = suggestionId;
    const saved = await request<NonNullable<Thread["draft"]>>({
      command: "saveDraft",
      eventId: thread.event.id,
      generation: thread.ownership.generation,
      expectedVersion: thread.draft?.version ?? 0,
      text,
      suggestionId,
    });
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
    if (capability.state !== "SEND_AVAILABLE" && !thread.controlledTrial)
      return reasons[capability.reason] ?? "通道尚未开放发送";
    if (!["MANUAL", "AI_ASSISTED"].includes(status.mode))
      return reasons.MODE_DRAFT_ONLY;
    if (
      !thread.ownership.isMine ||
      thread.ownership.lease_expires_at <= Date.now()
    )
      return "请先接管此目标";
    if (!status.operator.permissions.includes("SEND"))
      return "当前操作员没有发送权限";
    if (dirty) return "请先保存当前修改";
    if (!text.trim()) return "请输入并保存回复";
    return "";
  }
  async function prepareReview() {
    if (!thread) return;
    const params: SendParams = {
      eventId: thread.event.id,
      generation: thread.ownership.generation,
      draftId: thread.draft!.id,
      draftVersion: thread.draft!.version,
      text: thread.draft!.text,
      contextVersion: thread.contextVersion,
      selectionId: selection.current,
    };
    const current = selectedRef.current,
      r = await request<Review>({ command: "previewSend", params });
    if (current === selectedRef.current) setReview(r);
  }
  async function confirm() {
    if (!review || sending.current) return;
    sending.current = true;
    const r = review;
    setReview(null);
    setSend({ commandId: r.commandId, status: "QUEUED", reason: null });
    try {
      const result = await request<NonNullable<typeof send>>({
        command: "submitManualSend",
        commandId: r.commandId,
        params: r.params,
        confirmed: true,
      });
      setSend(result);
    } finally {
      sending.current = false;
    }
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
            升级前会验证备份、试升级和恢复；保留预算、旧意图和冻结。连接不会自动打开网页、发送或调用模型。
          </p>
          <button
            className="primary"
            disabled={!runtime || !consent || !!busy}
            onClick={() =>
              void act("连接中", async () =>
                setStatus(
                  await request<Status>({
                    command: "connect",
                    runtime,
                    initialize,
                    consent: true,
                  }),
                ),
              )
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
              void request<{paused:boolean}>({ command: "emergencyStop" })
                .then(async () => {
                  setStatus(s=>s?{...s,paused:true}:s);
                  setReview(null);
                  setNotice("急停已生效；已存意图仍需回读或冻结");
                  await refreshThread();
                })
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
              disabled={!!busy}
              onClick={() =>
                void act("同步私信", async () => {
                  setStatus(
                    await request<Status>({ command: "observe", source: "dm" }),
                  );
                  setNotice("私信同步完成");
                })
              }
            >
              同步私信
            </button>
            <button
              disabled={!!busy}
              onClick={() =>
                void act("同步评论", async () => {
                  setStatus(
                    await request<Status>({
                      command: "observe",
                      source: "works",
                    }),
                  );
                  setNotice("授权作品同步完成");
                })
              }
            >
              同步作品评论
            </button>
          </div>
        </header>
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
                    <p>使用上方同步按钮读取已授权范围，或更换筛选。</p>
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
                  <p>先查看原文与目标，再接管、编辑和确认发送。</p>
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
                  <div className="takeover">
                    <div>
                      <strong>
                        {thread.ownership.isMine
                          ? "由你接管"
                          : thread.ownership.operator_id
                            ? "由其他会话接管"
                            : "尚未接管"}
                      </strong>
                      <small>
                        代际 {thread.ownership.generation}
                        {thread.ownership.isMine
                          ? " · 租约至 " +
                            time(thread.ownership.lease_expires_at)
                          : ""}
                      </small>
                    </div>
                    <button
                      disabled={!!busy}
                      onClick={() =>
                        void act("更新接管", async () => {
                          await request({
                            command: thread.ownership.isMine
                              ? "releaseHuman"
                              : "claimHuman",
                            eventId: thread.event.id,
                            generation: thread.ownership.generation,
                          });
                          await refreshThread();
                          setReview(null);
                        })
                      }
                    >
                      {thread.ownership.isMine ? "释放接管" : "人工接管"}
                    </button>
                  </div>
                  <section className="editor">
                    <div className="editor-title">
                      <h3>回复草稿</h3>
                      <small>
                        版本 {thread.draft?.version ?? 0} ·{" "}
                        {thread.draft?.origin === "AI_ASSISTED_APPROVED"
                          ? "已引用 AI 建议"
                          : "人工输入"}{" "}
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
                          disabled={
                            !!busy ||
                            readOnly ||
                            !dirty ||
                            [...text].length > 500
                          }
                          onClick={() => void act("保存草稿", saveDraft)}
                        >
                          保存草稿
                        </button>
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
                  {send && (
                    <p role="status" className="send-state">
                      {statusNames[send.status] ?? send.status}
                      {send.reason
                        ? " · " + (reasons[send.reason] ?? send.reason)
                        : ""}
                    </p>
                  )}
                  {review ? (
                    <section className="review" aria-label="逐条发送确认">
                      <h3>核对后，仅提交这一次</h3>
                      <p>本人账号：{review.account}</p>
                      <p>对方：{review.target.actorId}</p>
                      <p>
                        {review.target.channel === "DIRECT_MESSAGE"
                          ? "会话：" + review.target.conversationId
                          : "作品：" +
                            review.target.videoId +
                            "，父评论：" +
                            review.target.commentId}
                      </p>
                      <div className="approved-text">{review.params.text}</div>
                      <small>
                        草稿 v{review.params.draftVersion} · 60 秒内有效 ·
                        不自动重试
                      </small>
                      <div>
                        <button
                          className="primary"
                          disabled={!!busy || Date.now() >= review.expiresAt}
                          onClick={() => void act("提交中", confirm)}
                        >
                          确认此目标与全文，发送一次
                        </button>
                        <button onClick={() => setReview(null)}>取消</button>
                      </div>
                    </section>
                  ) : (
                    <div className="send-footer">
                      <p className="hint">
                        {block ||
                          "已保存。下一步会重新核验网页，并展示完整目标和全文。"}
                      </p>
                      <div>
                        <button
                          className="primary"
                          disabled={!!block || !!busy}
                          onClick={() => void act("发送前核验", prepareReview)}
                        >
                          核对并发送
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
                      </div>
                    </div>
                  )}
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
    [key, setKey] = useState(""),
    [allow, setAllow] = useState(false);
  const [browserMode, setBrowserMode] = useState(status.browser.mode);
  return (
    <section className="settings scroll">
      <div className="settings-section">
        <h2>回复模式与运行</h2>
        <label>
          工作模式
          <select
            value={status.mode}
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
                    command: status.paused ? "resume" : "pause",
                    eventId: null,
                  }),
                ),
              )
            }
          >
            {status.paused ? "恢复账号" : "暂停账号"}
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
                {c.state} · {reasons[c.reason] ?? c.reason ?? "已核验"}
              </dd>
            </div>
          ))}
        </dl>
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
          只有显式点击“生成 AI 建议”才请求模型。Key
          仅保留在后端本次进程内存，保存配置会撤销旧调用授权。
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
                ? "后端本次进程已持有 Key，重新保存需重新输入"
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
              setAllow(false);
            })
          }
        >
          保存配置并清空 Key 输入
        </button>
        <label className="check">
          <input
            type="checkbox"
            checked={allow}
            onChange={(e) => setAllow(e.target.checked)}
          />
          我授权将有限的同目标上下文发送至 DeepSeek，可能产生费用，沿用累计 50
          次上限
        </label>
        <div className="row">
          <button
            disabled={!allow || !status.keyPresent || !!busy}
            onClick={() =>
              void act("授权模型", async () =>
                update(
                  await request<Status>({
                    command: "authorizeAi",
                    authorized: true,
                  }),
                ),
              )
            }
          >
            明确授权本次模型调用
          </button>
          <button
            disabled={!status.modelAuthorized}
            onClick={() =>
              void act("撤销模型授权", async () =>
                update(
                  await request<Status>({
                    command: "authorizeAi",
                    authorized: false,
                  }),
                ),
              )
            }
          >
            撤销授权
          </button>
        </div>
        <p>
          模型：{status.modelAuthorized ? "本次已授权" : "未授权"} · Key：
          {status.keyPresent ? "仅后端内存持有" : "未配置"}
        </p>
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
