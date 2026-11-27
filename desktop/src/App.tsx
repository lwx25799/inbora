import { useCallback, useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import { EmergencyStopNotice } from "./EmergencyStopNotice";
import { InboxList } from "./InboxList";
import { ReplyDetail } from "./ReplyDetail";
import { AppSidebar, type DesktopPageId } from "./components/AppSidebar";
import { CommandPalette } from "./components/CommandPalette";
import { ConnectScreen } from "./components/ConnectScreen";
import { TopBar } from "./components/TopBar";
import { Spinner } from "./components/ui/spinner";
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
  setActiveWorkbenchAccount,
  type AccountSummary,
  type ActiveWorkbenchAccount,
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

function hasBlockingModalOpen(): boolean {
  return Boolean(
    document.querySelector(
      'dialog[open]:not([data-command-palette="true"]), [role="dialog"][aria-modal="true"]:not([data-command-palette="true"])',
    ),
  );
}

function isStickyNotice(text: string): boolean {
  return (
    text.includes("未重放发送") ||
    text.includes("全局急停") ||
    text.includes("开发内核已恢复") ||
    text.includes("恢复运行")
  );
}

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
  const [safetyNotice, setSafetyNotice] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [recoveryModalActive, setRecoveryModalActive] = useState(false);
  const [dismissedSyncKey, setDismissedSyncKey] = useState("");
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [auditPage, setAuditPage] = useState(0);
  const [activeAccount, setActiveAccount] = useState<ActiveWorkbenchAccount | null>(null);
  const [pendingAutoReply, setPendingAutoReply] = useState<boolean | null>(null);
  const autoReplyUpdating = useRef(false);
  const accountSwitchSeq = useRef(0);
  const pendingPageFocusRef = useRef<DesktopPageId | null>(null);
  const connected = !!status;

  const setAppNotice = useCallback((next: string) => {
    if (!next) {
      setNotice("");
      return;
    }
    if (isStickyNotice(next)) {
      setSafetyNotice(next);
      setNotice("");
      return;
    }
    setNotice(next);
  }, []);

  const handleRecoveryActiveChange = useCallback((active: boolean) => {
    setRecoveryModalActive(active);
    if (active) setPaletteOpen(false);
  }, []);

  const workspace = useReplyWorkspace({
    connected,
    status,
    runtime,
    inbox,
    error,
    setStatus,
    setError,
    setNotice: setAppNotice,
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
    devRecoveryRestoring: workspace.devRecovery.restoring,
    updatePrompts,
  });

  useWorkbenchRefresh({
    connected,
    activeAccountRef: activeAccount?.accountRef,
    status,
    selected: workspace.selected,
    channel,
    filter,
    pageNumber,
    page,
    runtimeTab,
    auditPage,
    notice: notice || safetyNotice,
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

  useEffect(() => {
    if (!connected) {
      setPaletteOpen(false);
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "k"
      ) {
        if (recoveryModalActive || hasBlockingModalOpen()) return;
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [connected, recoveryModalActive]);

  useEffect(() => {
    if (pendingPageFocusRef.current !== page) return;
    pendingPageFocusRef.current = null;
    const frame = requestAnimationFrame(() => {
      const target =
        document.querySelector<HTMLElement>("#main-content h1, #main-content h2") ??
        document.getElementById("main-content");
      if (target) {
        if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [page]);

  useEffect(() => {
    if (!notice || error || busy) return;
    const timer = setTimeout(() => setNotice(""), 5_000);
    return () => clearTimeout(timer);
  }, [notice, error, busy]);

  async function act(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError("");
    setAppNotice("");
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
    if (
      next !== page &&
      status?.sync.runId &&
      !status.sync.running &&
      status.sync.results.length > 0 &&
      status.sync.results.every((result) => result.state === "SUCCEEDED")
    ) {
      setDismissedSyncKey(
        `${status.sync.runId}:${status.sync.results.map((result) => `${result.source}:${result.state}:${result.error ?? ""}`).join("|")}`,
      );
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
    setAppNotice("全局急停已生效，后台收取与自动回复已停止；已提交消息仅做结果核对，不会重复发送。");
    await workspace.refreshThread();
  }

  async function selectWorkbenchAccount(account: AccountSummary | null) {
    const seq = ++accountSwitchSeq.current;
    if (
      workspace.thread?.ownership.isMine &&
      canContinueReply(workspace.thread)
    ) {
      await workspace.closeDialog();
    }
    if (accountSwitchSeq.current !== seq) return;
    const next = account
      ? { accountRef: account.accountRef, displayLabel: account.displayLabel, platform: account.platform }
      : null;
    setActiveWorkbenchAccount(next);
    setActiveAccount(next);
    workspace.clearSelection();
    setPageNumber(0);
    setInbox({ items: [], total: 0, page: 0, pageSize: 20 });
    setUnreadCount(0);
    if (next) {
      setPage("inbox");
      setAppNotice(`已切换工作台至「${next.displayLabel}」。`);
    } else {
      setAppNotice("已返回主账号工作台。");
    }
    try {
      const nextStatus = await request<Status>({ command: "getStatus" });
      if (accountSwitchSeq.current === seq) setStatus(nextStatus);
    } catch (cause) {
      if (accountSwitchSeq.current === seq) setError(explain(cause));
    }
  }

  function syncInbox() {
    setDismissedSyncKey("");
    void act("正在同步收件箱…", async () => {
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
  const syncSignature = status.sync.runId
    ? `${status.sync.runId}:${status.sync.results.map((result) => `${result.source}:${result.state}:${result.error ?? ""}`).join("|")}`
    : "";
  const showSyncBar =
    Boolean(status.sync.runId) &&
    (status.sync.running || dismissedSyncKey !== syncSignature);
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
        status={status}
        version={version}
        busy={busy}
        pendingCount={pendingCount}
        pendingAutoReply={pendingAutoReply}
        onSelectPage={(next) => {
          void navigatePage(next).catch((cause) => setError(explain(cause)));
        }}
        onSetCollapsed={setCollapsed}
        onToggleAutoReply={(enabled) => {
          void act("更新自动回复", () => toggleAuto(enabled));
        }}
        onReconnect={() => {
          void act("重新连接内核", workspace.reconnect);
        }}
      />

      <main
        id="main-content"
        tabIndex={-1}
        className="workspace m-2 ml-0 flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/80 bg-background shadow-xs outline-none"
      >
        <TopBar
          page={page}
          theme={theme}
          status={status}
          busy={busy}
          activeAccount={activeAccount}
          onReturnPrimaryAccount={() => {
            void selectWorkbenchAccount(null);
          }}
          onSync={syncInbox}
          onToggleTheme={toggleTheme}
          onOpenPalette={() => {
            if (!recoveryModalActive && !hasBlockingModalOpen()) setPaletteOpen(true);
          }}
          onNavigate={(next) => {
            void navigatePage(next).catch((cause) => setError(explain(cause)));
          }}
        />

        <EmergencyStopNotice
          status={status}
          busy={busy}
          act={act}
          update={setStatus}
          onRecoveryActiveChange={handleRecoveryActiveChange}
        />

        {showSyncBar && (
          <div
            className={cn(
              "message flex shrink-0 items-center justify-between gap-3 border-b px-5 py-2 text-xs leading-relaxed",
              syncFailed
                ? "error border-destructive/30 bg-destructive/8 text-destructive-foreground"
                : "border-border/75 bg-muted/45 text-muted-foreground",
            )}
            role={syncFailed ? "alert" : "status"}
            data-testid="inbox-sync-progress"
          >
            <span>
              {status.sync.results
                .map(
                  (result) =>
                    `${syncNames[result.source]}${syncStates[result.state]}${result.error ? "：" + (reasons[result.error] ?? result.error) : ""}`,
                )
                .join("；")}
            </span>
            {!status.sync.running && (
              <button
                type="button"
                aria-label="关闭同步提示"
                onClick={() => setDismissedSyncKey(syncSignature)}
                className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <XIcon aria-hidden="true" className="size-3.5" />
              </button>
            )}
          </div>
        )}

        {safetyNotice && (
          <div
            className="message flex shrink-0 items-center justify-between gap-3 border-b border-primary/25 bg-primary/[0.06] px-5 py-2 text-xs leading-relaxed text-foreground"
            role="status"
          >
            <span>{safetyNotice}</span>
            <button
              type="button"
              aria-label="关闭安全回执"
              onClick={() => setSafetyNotice("")}
              className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-current/70 transition-colors hover:bg-black/5 hover:text-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/10"
            >
              <XIcon aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        )}

        {(error || notice || busy) && (
          <div
            className={cn(
              "message flex shrink-0 items-center justify-between gap-3 border-b px-5 py-2 text-xs leading-relaxed",
              error
                ? "error border-destructive/30 bg-destructive/8 font-medium text-destructive-foreground"
                : "border-primary/20 bg-primary/[0.05] text-foreground",
            )}
            role={error ? "alert" : "status"}
          >
            <span className="flex min-w-0 items-center gap-2">
              {!error && busy && <Spinner className="size-3.5 shrink-0 text-primary" />}
              <span>{error || busy || notice}</span>
            </span>
            {(error || (!busy && notice)) && (
              <button
                type="button"
                aria-label="关闭提示"
                onClick={() => {
                  if (error) setError("");
                  else setNotice("");
                }}
                className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-current/70 transition-colors hover:bg-black/5 hover:text-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-white/10"
              >
                <XIcon aria-hidden="true" className="size-3.5" />
              </button>
            )}
          </div>
        )}

        {page === "inbox" ? (
          <div className="inbox-layout flex min-h-0 flex-1 overflow-hidden">
            <InboxList
              inbox={inbox}
              accountUnreadTotal={unreadCount}
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
              setNotice={setAppNotice}
              openDialog={workspace.openDialog}
              closeDialog={workspace.closeDialog}
              readOnly={readOnly}
              localDraft={workspace.localDraft}
              saving={workspace.saving}
              dirty={workspace.dirty}
              error={error}
              notice={notice || safetyNotice}
              text={workspace.text}
              suggestionId={workspace.suggestionId}
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
                activeAccountRef={activeAccount?.accountRef}
                onSelectWorkbenchAccount={(account) => {
                  void selectWorkbenchAccount(account);
                }}
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
                hasUnsavedDraft={workspace.hasUnsavedDraft}
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

      <CommandPalette
        open={paletteOpen}
        theme={theme}
        collapsed={collapsed}
        syncDisabled={Boolean(busy) || status.sync.running}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(next) => {
          pendingPageFocusRef.current = next;
          if (next === page) {
            pendingPageFocusRef.current = null;
            requestAnimationFrame(() => {
              const target =
                document.querySelector<HTMLElement>("#main-content h1, #main-content h2") ??
                document.getElementById("main-content");
              if (target) {
                if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
                target.focus({ preventScroll: true });
              }
            });
            return;
          }
          void navigatePage(next).catch((cause) => {
            if (pendingPageFocusRef.current === next) pendingPageFocusRef.current = null;
            setError(explain(cause));
          });
        }}
        onSync={syncInbox}
        onToggleTheme={toggleTheme}
        onToggleCollapsed={() => setCollapsed((current) => !current)}
      />
    </div>
  );
}
