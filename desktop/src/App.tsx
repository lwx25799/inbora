import { useEffect, useRef, useState } from "react";
import { EmergencyStopNotice } from "./EmergencyStopNotice";
import { InboxList } from "./InboxList";
import { ReplyDetail } from "./ReplyDetail";
import { AppSidebar, type DesktopPageId } from "./components/AppSidebar";
import { ConnectScreen } from "./components/ConnectScreen";
import { TopBar } from "./components/TopBar";
import { AccountsView } from "./views/AccountsView";
import { AutomationView } from "./views/AutomationView";
import { KnowledgePageView } from "./views/KnowledgePageView";
import { ModelsPageView } from "./views/ModelsPageView";
import { OverviewView } from "./views/OverviewView";
import { RuntimeView, type RuntimeTabId } from "./views/RuntimeView";
import { SystemSettingsView } from "./views/SystemSettingsView";
import { cn } from "./lib/utils";
import { businessPrompts, samePrompts } from "./settings-form-sync";
import { canContinueReply } from "./reply-editor-draft";
import { useBusinessPrompts } from "./useBusinessPrompts";
import { useReplyWorkspace } from "./useReplyWorkspace";
import { useWorkbenchRefresh, type AuditRow } from "./useWorkbenchRefresh";
import {
  explain,
  reasons,
  request,
  restoreDesktop,
  runtimeSession,
  type BusinessPrompts,
  type Inbox,
  type Status,
} from "./api";

const syncNames = { works: "评论", dm: "私信" };
const syncStates = {
  PENDING: "等待同步",
  RUNNING: "同步中",
  SUCCEEDED: "本轮同步完成",
  DEFERRED: "后台继续收取",
  FAILED: "同步失败",
  SKIPPED: "未继续同步",
  CANCELLED: "同步已停止",
};

function readInitialTheme(): "light" | "dark" {
  try {
    return localStorage.getItem("inbora-theme") === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function App() {
  const [runtime, setRuntime] = useState("");
  const [initialize, setInitialize] = useState(false);
  const [consent, setConsent] = useState(false);
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  // Default to inbox so existing E2E flows and daily operators land straight on incoming conversations; overview sits 1 click away at top of sidebar.
  const [page, setPage] = useState<DesktopPageId>("inbox");
  const [theme, setTheme] = useState<"light" | "dark">(readInitialTheme);
  const [collapsed, setCollapsed] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth <= 1024 : false,
  );
  const [channel, setChannel] = useState<"ALL" | "COMMENT_NOTIFICATION" | "DIRECT_MESSAGE">("ALL");
  const [filter, setFilter] = useState<"ALL" | "UNREAD" | "PENDING" | "MANUAL_ONLY" | "CONFIRMED">(
    "UNREAD",
  );
  const [pageNumber, setPageNumber] = useState(0);
  const [inbox, setInbox] = useState<Inbox>({ items: [], total: 0, page: 0, pageSize: 20 });
  const [inboxSummary, setInboxSummary] = useState<Inbox>({
    items: [],
    total: 0,
    page: 0,
    pageSize: 20,
  });
  const [unreadCount, setUnreadCount] = useState(0);
  const [runtimeTab, setRuntimeTab] = useState<RuntimeTabId>("diagnostics");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [auditPage, setAuditPage] = useState(0);
  const [pendingAutoReply, setPendingAutoReply] = useState<boolean | null>(null);
  const autoReplyUpdating = useRef(false);
  const connected = !!status;

  const workspace = useReplyWorkspace({
    connected,
    status,
    runtime,
    inbox,
    error,
    setStatus,
    setError,
    setNotice,
  });

  function updatePrompts(session: string, prompts: BusinessPrompts) {
    setStatus((current) =>
      current && workspace.devRecovery.isCurrent() && runtimeSession(current) === session
        ? { ...current, settings: { ...current.settings, ...prompts } }
        : current,
    );
  }

  const promptsState = useBusinessPrompts({
    status,
    devRecoveryGeneration: workspace.devRecovery.generation,
    updatePrompts,
  });

  useWorkbenchRefresh({
    connected,
    status,
    selected: workspace.selected,
    channel,
    filter,
    pageNumber,
    page,
    runtimeTab,
    auditPage,
    notice,
    sendStatus: workspace.send?.status,
    readThread: (alive) => workspace.refreshThread(undefined, alive),
    setStatus,
    setInbox,
    setInboxSummary,
    setUnreadCount,
    setAudit,
    setError,
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem("inbora-theme", theme);
    } catch {
      // Ignore restricted WebView storage errors.
    }
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 1024px)");
    const syncCollapsed = (matches: boolean) => setCollapsed(matches);
    syncCollapsed(media.matches);
    const onChange = (event: MediaQueryListEvent) => syncCollapsed(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    let ignore = false;
    void restoreDesktop()
      .then((result) => {
        if (ignore) return;
        setRuntime(result.runtime);
        setVersion(result.version);
        setStatus(result.status);
        setError(result.error);
      })
      .catch(() => {
        if (!ignore) setError("无法读取本地客户端信息，请重新连接。");
      });
    return () => {
      ignore = true;
    };
  }, []);

  async function act(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (cause) {
      setError(explain(cause));
    } finally {
      setBusy("");
    }
  }

  function toggleTheme() {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }

  async function toggleAuto(enabled: boolean) {
    if (autoReplyUpdating.current) return;
    autoReplyUpdating.current = true;
    setPendingAutoReply(enabled);
    try {
      await workspace.flushDraftBeforeAutoToggle();
      setStatus(await request<Status>({ command: "setAutomaticReply", enabled }));
      await workspace.refreshThread();
    } finally {
      autoReplyUpdating.current = false;
      setPendingAutoReply(null);
    }
  }

  async function navigatePage(next: DesktopPageId) {
    if (
      page === "inbox" &&
      next !== "inbox" &&
      workspace.thread?.ownership.isMine &&
      canContinueReply(workspace.thread)
    ) {
      await workspace.closeDialog();
    }
    setPage(next);
  }

  async function emergencyStop() {
    await request({ command: "emergencyStop" });
    setStatus((current) =>
      current
        ? {
            ...current,
            paused: true,
            automation: current.automation
              ? { ...current.automation, emergencyStopped: true }
              : current.automation,
          }
        : current,
    );
    setNotice("急停已生效；已存意图仍需回读或冻结");
    await workspace.refreshThread();
  }

  function syncInbox() {
    void act("启动同步", async () => {
      setStatus(await request<Status>({ command: "syncInbox" }));
    });
  }

  function updateProviders(next: Status, previous: Status) {
    setStatus((current) => {
      if (
        !current ||
        !workspace.devRecovery.isCurrent() ||
        runtimeSession(current) !== runtimeSession(previous) ||
        runtimeSession(next) !== runtimeSession(previous)
      ) {
        return current;
      }
      const latest = current.modelProviders;
      const incoming = next.modelProviders;
      if (
        latest &&
        (!incoming ||
          incoming.selection.selectionRevision < latest.selection.selectionRevision ||
          (incoming.listRevision ?? -1) < (latest.listRevision ?? -1) ||
          incoming.connections.some((item) =>
            latest.connections.some(
              (known) => known.id === item.id && known.version > item.version,
            ),
          ))
      ) {
        return current;
      }
      return samePrompts(current.settings, previous.settings)
        ? next
        : { ...next, settings: { ...next.settings, ...businessPrompts(current.settings) } };
    });
  }

  if (!status) {
    return (
      <ConnectScreen
        runtime={runtime}
        initialize={initialize}
        consent={consent}
        busy={busy}
        error={error}
        version={version}
        theme={theme}
        onToggleTheme={toggleTheme}
        onRuntimeChange={setRuntime}
        onInitializeChange={setInitialize}
        onConsentChange={setConsent}
        onConnect={() =>
          void act("连接中", async () => {
            const result = await request<Status>({
              command: "connect",
              runtime,
              initialize,
              consent: true,
            });
            setStatus(result);
            localStorage.setItem("inbora-runtime", result.runtime);
          })
        }
      />
    );
  }

  const block = workspace.sendDisabled();
  const readOnly = workspace.devRecovery.restoring || status.mode === "OBSERVE";
  const pendingCount = unreadCount;
  const syncFailed = status.sync.results.some((result) => result.state === "FAILED");
  const sessionKey = JSON.stringify([runtimeSession(status), workspace.devRecovery.generation]);

  return (
    <div className="app flex h-screen w-screen overflow-hidden bg-sidebar text-foreground">
      <a
        className="skip sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-3 focus:py-1.5 focus:text-xs focus:font-medium focus:text-primary-foreground focus:shadow-md"
        href="#main-content"
      >
        跳至内容
      </a>

      <AppSidebar
        page={page}
        collapsed={collapsed}
        theme={theme}
        status={status}
        version={version}
        busy={busy}
        pendingCount={pendingCount}
        pendingAutoReply={pendingAutoReply}
        onSelectPage={(next) => {
          void navigatePage(next).catch((cause) => setError(explain(cause)));
        }}
        onSetCollapsed={setCollapsed}
        onToggleTheme={toggleTheme}
        onToggleAutoReply={(enabled) => {
          void act("更新自动回复", () => toggleAuto(enabled));
        }}
        onReconnect={() => {
          void act("重新连接内核", workspace.reconnect);
        }}
      />

      <main
        id="main-content"
        className="workspace m-2 ml-0 flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/80 bg-background shadow-xs"
      >
        <TopBar
          page={page}
          theme={theme}
          status={status}
          busy={busy}
          onSync={syncInbox}
          onToggleTheme={toggleTheme}
          onNavigate={(next) => {
            void navigatePage(next).catch((cause) => setError(explain(cause)));
          }}
        />

        <EmergencyStopNotice status={status} busy={busy} act={act} update={setStatus} />

        {status.sync.runId && (
          <div
            className={cn(
              "message shrink-0 border-b px-5 py-2 text-xs leading-relaxed",
              syncFailed
                ? "error border-destructive/30 bg-destructive/8 text-destructive-foreground"
                : "border-border/75 bg-muted/45 text-muted-foreground",
            )}
            role={syncFailed ? "alert" : "status"}
            data-testid="inbox-sync-progress"
          >
            {status.sync.results
              .map(
                (result) =>
                  `${syncNames[result.source]}${syncStates[result.state]}${result.error ? "：" + (reasons[result.error] ?? result.error) : ""}`,
              )
              .join("；")}
          </div>
        )}

        {(error || notice || busy) && (
          <div
            className={cn(
              "message shrink-0 border-b px-5 py-2 text-xs leading-relaxed",
              error
                ? "error border-destructive/30 bg-destructive/8 font-medium text-destructive-foreground"
                : "border-primary/20 bg-primary/[0.05] text-foreground",
            )}
            role={error ? "alert" : "status"}
          >
            {error || busy || notice}
          </div>
        )}

        {page === "inbox" ? (
          <div className="inbox-layout flex min-h-0 flex-1 overflow-hidden">
            <InboxList
              inbox={inbox}
              selected={workspace.selected}
              selectedGroup={
                workspace.thread?.event.id === workspace.selected
                  ? workspace.thread.groupKey
                  : undefined
              }
              channel={channel}
              setChannel={setChannel}
              filter={filter}
              setFilter={setFilter}
              pageNumber={pageNumber}
              setPageNumber={setPageNumber}
              choose={workspace.choose}
              markingRead={!!busy}
              markRead={() =>
                void act("正在标记已读…", async () => {
                  await request({ command: "markInboxRead" });
                  setPageNumber(0);
                  setNotice("已全部标为已读。消息和回复记录仍保留。");
                })
              }
            />
            <ReplyDetail
              detailElement={workspace.detailElement}
              dialogElement={workspace.dialogElement}
              thread={workspace.thread}
              status={status}
              setStatus={setStatus}
              selected={workspace.selected}
              choose={workspace.choose}
              busy={busy}
              act={act}
              setNotice={setNotice}
              openDialog={workspace.openDialog}
              closeDialog={workspace.closeDialog}
              readOnly={readOnly}
              localDraft={workspace.localDraft}
              saving={workspace.saving}
              dirty={workspace.dirty}
              error={error}
              notice={notice}
              text={workspace.text}
              setText={workspace.updateEditorText}
              setSuggestionId={workspace.updateEditorSuggestion}
              refreshThread={() => workspace.refreshThread()}
              block={block}
              send={workspace.send}
              sendCurrentText={workspace.sendCurrentText}
            />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {page === "overview" && (
              <OverviewView
                status={status}
                inbox={inboxSummary}
                busy={busy}
                pendingAutoReply={pendingAutoReply}
                onNavigate={(next) => {
                  void navigatePage(next).catch((cause) => setError(explain(cause)));
                }}
                onSync={syncInbox}
                onSelectEvent={(eventId) => {
                  workspace.choose(eventId);
                  setPage("inbox");
                }}
                onToggleAuto={(enabled) => act("更新自动回复", () => toggleAuto(enabled))}
              />
            )}
            {page === "accounts" && (
              <AccountsView
                key={sessionKey}
                status={status}
                busy={busy}
                act={act}
                update={setStatus}
              />
            )}
            {page === "automation" && (
              <AutomationView
                key={sessionKey}
                status={status}
                busy={busy}
                error={error}
                notice={notice}
                act={act}
                update={setStatus}
                promptsState={promptsState}
                toggleAuto={toggleAuto}
                pendingAutoReply={pendingAutoReply}
              />
            )}
            {page === "knowledge" && (
              <KnowledgePageView key={sessionKey} status={status} busy={busy} />
            )}
            {page === "models" && (
              <ModelsPageView
                key={sessionKey}
                status={status}
                updateProviders={updateProviders}
              />
            )}
            {page === "runtime" && (
              <RuntimeView
                status={status}
                audit={audit}
                auditPage={auditPage}
                setAuditPage={setAuditPage}
                tab={runtimeTab}
                onTabChange={setRuntimeTab}
              />
            )}
            {page === "settings" && (
              <SystemSettingsView
                key={sessionKey}
                status={status}
                runtime={runtime}
                busy={busy}
                theme={theme}
                onToggleTheme={toggleTheme}
                act={act}
                update={setStatus}
                stop={() => void emergencyStop().catch((cause) => setError(explain(cause)))}
                reconnect={workspace.reconnect}
              />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
