import * as React from "react";
import { OctagonAlertIcon, ShieldAlertIcon } from "lucide-react";
import {
  AccountDetailSheet,
  AddAccountSheet,
  CommandPaletteDialog,
  CommentReplyDialog,
  ConnectPreviewDialog,
  ModelEditorSheet,
  VerifyHeadlessDialog,
} from "@/components/AppOverlays";
import { AppSidebar, NAV_GROUPS } from "@/components/AppSidebar";
import { PLATFORM_META } from "@/components/PlatformBadge";
import { TopBar } from "@/components/TopBar";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  INITIAL_ACCOUNTS,
  INITIAL_AUDIT,
  INITIAL_DOCS,
  INITIAL_MODELS,
  INITIAL_PERSONAS,
  INITIAL_SAMPLES,
  INITIAL_THREADS,
  type PageId,
  type ScenarioMode,
} from "@/data/mockData";
import { AccountsView } from "@/views/AccountsView";
import { AnalyticsView } from "@/views/AnalyticsView";
import { AutomationView } from "@/views/AutomationView";
import { InboxView } from "@/views/InboxView";
import { KnowledgeView } from "@/views/KnowledgeView";
import { ModelsView } from "@/views/ModelsView";
import { OverviewView } from "@/views/OverviewView";
import { RuntimeView } from "@/views/RuntimeView";
import { SettingsView } from "@/views/SettingsView";

function timeNow() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

export function App(): React.ReactElement {
  const [page, setPage] = React.useState<PageId>("overview");
  const [theme, setTheme] = React.useState<"light" | "dark">("light");
  const [collapsed, setCollapsed] = React.useState(() =>
    typeof window !== "undefined" ? window.innerWidth <= 1024 : false,
  );
  const [scenario, setScenario] = React.useState<ScenarioMode>("normal");
  const [autoReplyEnabled, setAutoReplyEnabled] = React.useState(true);
  const [syncing, setSyncing] = React.useState(false);

  const [accounts, setAccounts] = React.useState(INITIAL_ACCOUNTS);
  const [threads, setThreads] = React.useState(INITIAL_THREADS);
  const [selectedThreadId, setSelectedThreadId] = React.useState(INITIAL_THREADS[0].id);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({
    thr_dy_dm_01:
      "您好，手捏粗陶杯现货今天 17:00 前下单可当天发顺丰，礼盒配防震内托和手写贺卡，方便把祝词发我吗？",
  });

  const [docs, setDocs] = React.useState(INITIAL_DOCS);
  const [samples, setSamples] = React.useState(INITIAL_SAMPLES);
  const [personas, setPersonas] = React.useState(INITIAL_PERSONAS);
  const [models, setModels] = React.useState(INITIAL_MODELS);
  const [selectedModel, setSelectedModel] = React.useState({
    connId: "conn_deepseek",
    modelId: "deepseek-chat",
  });
  const [auditRows, setAuditRows] = React.useState(INITIAL_AUDIT);
  const [mcpEnabled, setMcpEnabled] = React.useState(true);

  const [verifyOpen, setVerifyOpen] = React.useState(false);
  const [commentDialogId, setCommentDialogId] = React.useState<string | null>(null);
  const [accountSheetId, setAccountSheetId] = React.useState<string | null>(null);
  const [addAccountOpen, setAddAccountOpen] = React.useState(false);
  const [modelEditor, setModelEditor] = React.useState<{ open: boolean; id: string | null }>({
    open: false,
    id: null,
  });
  const [cmdkOpen, setCmdkOpen] = React.useState(false);
  const [connectOpen, setConnectOpen] = React.useState(false);
  const [toastMsg, setToastMsg] = React.useState<string | null>(null);

  const notify = React.useCallback((msg: string) => {
    setToastMsg(msg);
  }, []);

  React.useEffect(() => {
    if (!toastMsg) return;
    const t = window.setTimeout(() => setToastMsg(null), 3200);
    return () => window.clearTimeout(t);
  }, [toastMsg]);

  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdkOpen((o) => !o);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const emergencyStopped = scenario === "emergency_stop";
  const securityHoldActive = scenario === "security_hold";
  const pendingCount = threads.filter((t) => t.status !== "CONFIRMED").length;
  const conflictDocsCount = docs.filter((d) => d.status === "CONFLICT").length;
  const allPages = NAV_GROUPS.flatMap((g) => g.items.map(({ id, label }) => ({ id, label })));

  const triggerSync = React.useCallback(() => {
    setSyncing(true);
    setTimeout(() => {
      setSyncing(false);
      notify("已完成多渠道增量同步，未覆盖任何本地草稿。");
    }, 420);
  }, [notify]);

  const handleSendDm = (id: string) => {
    const text = (drafts[id] ?? "").trim();
    if (!text || emergencyStopped) return;
    const now = timeNow();
    setThreads((prev) =>
      prev.map((t) =>
        t.id === id
          ? {
              ...t,
              status: "CONFIRMED",
              unread: false,
              updatedAt: now.slice(0, 5),
              leaseNote: "已收到平台送达回执",
              intent: {
                intentId: `int_${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
                commandId: `cmd_${Math.random().toString(36).slice(2, 10)}`,
                status: "CONFIRMED",
                submittedAt: now,
                rechecks: `单次提交并确认回执（${now}）`,
                reason: null,
              },
              messages: [
                ...t.messages,
                { id: `m_${Date.now()}`, dir: "out", time: now.slice(0, 5), delivered: true, text },
              ],
            }
          : t,
      ),
    );
    setDrafts((prev) => ({ ...prev, [id]: "" }));
    setAuditRows((prev) => [
      { time: now, type: "确认送达", scope: "人工回复", entity: id, detail: "经唯一发送协调器单次提交并核验送达回执" },
      ...prev,
    ]);
    notify("回复已单次提交并收到送达确认，已清空原草稿。");
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-sidebar text-foreground">
      <AppSidebar
        page={page}
        collapsed={collapsed}
        theme={theme}
        scenario={scenario}
        autoReplyEnabled={autoReplyEnabled}
        emergencyStopped={emergencyStopped}
        securityHoldActive={securityHoldActive}
        pendingCount={pendingCount}
        accounts={accounts}
        threads={threads}
        conflictDocsCount={conflictDocsCount}
        onSelectPage={setPage}
        onSetCollapsed={setCollapsed}
        onToggleTheme={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
        onSetScenario={setScenario}
        onSetAutoReply={setAutoReplyEnabled}
        onOpenCmdk={() => setCmdkOpen(true)}
        onOpenAddAccount={() => setAddAccountOpen(true)}
        onQuickSelectAccount={(accId) => {
          const hit = threads.find((t) => t.accountId === accId);
          if (hit) {
            setSelectedThreadId(hit.id);
            setPage("inbox");
          } else {
            setAccountSheetId(accId);
          }
        }}
      />

      <main className="m-2 ml-0 flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/80 bg-background shadow-xs">
        <TopBar
          page={page}
          theme={theme}
          activeModel={selectedModel.modelId}
          mcpEnabled={mcpEnabled}
          syncing={syncing}
          pendingCount={pendingCount}
          onlineAccounts={accounts.length}
          onSync={triggerSync}
          onOpenCmdk={() => setCmdkOpen(true)}
          onToggleTheme={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
          onNavigate={setPage}
        />

        {emergencyStopped && (
          <div className="border-b border-destructive/20 bg-destructive/[0.04] px-5 py-2.5">
            <Alert variant="error" className="border-0 bg-transparent p-0">
              <OctagonAlertIcon />
              <AlertTitle>全局急停生效中 · 全部自动调度与外发已冻结</AlertTitle>
              <AlertDescription>
                重启或重连均不解除，已提交记录仅保留只读回读，不重发。
              </AlertDescription>
              <AlertAction>
                <Button
                  size="xs"
                  onClick={() => {
                    setScenario("normal");
                    notify("已显式核验并解除全局急停，恢复既有策略与剩余额度。");
                  }}
                >
                  检查并恢复运行
                </Button>
              </AlertAction>
            </Alert>
          </div>
        )}

        {securityHoldActive && (
          <div className="border-b border-warning/25 bg-warning/[0.05] px-5 py-2.5">
            <Alert variant="warning" className="border-0 bg-transparent p-0">
              <ShieldAlertIcon />
              <AlertTitle>禾木设计精选号 · 评论通道待安全核验</AlertTitle>
              <AlertDescription>
                仅暂停该账号评论收取与发送，同账号私信及其他账号正常运行。
              </AlertDescription>
              <AlertAction>
                <Button size="xs" onClick={() => setVerifyOpen(true)}>
                  处理原验证页面
                </Button>
              </AlertAction>
            </Alert>
          </div>
        )}

        <div className={`min-h-0 flex-1 ${page === "inbox" ? "overflow-hidden" : "overflow-y-auto"}`}>
          {page === "overview" && (
            <OverviewView
              accounts={accounts}
              threads={threads}
              syncing={syncing}
              autoReplyEnabled={autoReplyEnabled && !emergencyStopped}
              activeModel={selectedModel.modelId}
              onSync={triggerSync}
              onNavigate={setPage}
              onJumpThread={(id) => {
                setSelectedThreadId(id);
                setPage("inbox");
              }}
              onToggleAccountAuto={(id) =>
                setAccounts((prev) =>
                  prev.map((a) => (a.id === id ? { ...a, autoReply: !a.autoReply } : a)),
                )
              }
              onOpenAccountSheet={setAccountSheetId}
              onOpenAddAccount={() => setAddAccountOpen(true)}
            />
          )}

          {page === "inbox" && (
            <InboxView
              accounts={accounts}
              threads={threads}
              docs={docs}
              selectedId={selectedThreadId}
              drafts={drafts}
              emergencyStopped={emergencyStopped}
              securityHoldActive={securityHoldActive}
              onSelectThread={(id) => {
                setSelectedThreadId(id);
                setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, unread: false } : t)));
              }}
              onDraftChange={(id, text) => setDrafts((prev) => ({ ...prev, [id]: text }))}
              onSendDm={handleSendDm}
              onOpenCommentReply={setCommentDialogId}
              onMarkAllRead={() => {
                setThreads((prev) => prev.map((t) => ({ ...t, unread: false })));
                notify("已将当前列表全部标为已读。");
              }}
              onDismissMcp={(id) => {
                setThreads((prev) =>
                  prev.map((t) => (t.id === id ? { ...t, mcpConflict: null } : t)),
                );
                notify("已保留你的本地草稿输入。");
              }}
              onOpenVerify={() => setVerifyOpen(true)}
              onNotify={notify}
            />
          )}

          {page === "accounts" && (
            <AccountsView
              accounts={accounts}
              securityHoldActive={securityHoldActive}
              onToggleAuto={(id) =>
                setAccounts((prev) =>
                  prev.map((a) => (a.id === id ? { ...a, autoReply: !a.autoReply } : a)),
                )
              }
              onOpenDetail={setAccountSheetId}
              onOpenAdd={() => setAddAccountOpen(true)}
              onOpenVerify={() => setVerifyOpen(true)}
              onNotify={notify}
            />
          )}

          {page === "automation" && (
            <AutomationView
              autoReplyEnabled={autoReplyEnabled}
              emergencyStopped={emergencyStopped}
              onToggleGlobalAuto={() => setAutoReplyEnabled((v) => !v)}
              onNotify={notify}
            />
          )}

          {page === "knowledge" && (
            <KnowledgeView
              docs={docs}
              samples={samples}
              personas={personas}
              onToggleDoc={(id) => {
                setDocs((prev) =>
                  prev.map((d) =>
                    d.id === id ? { ...d, status: d.status === "DISABLED" ? "ENABLED" : "DISABLED" } : d,
                  ),
                );
                notify(`知识条目 ${id} 状态已更新。`);
              }}
              onToggleSample={(id) =>
                setSamples((prev) =>
                  prev.map((s) => (s.id === id ? { ...s, adopted: !s.adopted } : s)),
                )
              }
              onPublishPersona={(ver) => {
                setPersonas((prev) =>
                  prev.map((p) => ({ ...p, status: p.version === ver ? "PUBLISHED" : "ARCHIVED" })),
                );
                notify(`已切换生效人格至 ${ver}。`);
              }}
              onNotify={notify}
            />
          )}

          {page === "models" && (
            <ModelsView
              connections={models}
              selectedConnId={selectedModel.connId}
              selectedModelId={selectedModel.modelId}
              onApplyModel={(connId, modelId) => {
                setSelectedModel({ connId, modelId });
                notify(`全局生效模型已切换为 ${modelId}。`);
              }}
              onTestModel={(connId) => {
                setModels((prev) =>
                  prev.map((m) =>
                    m.id === connId
                      ? {
                          ...m,
                          lastTest: {
                            ok: true,
                            elapsedMs: 420 + Math.floor(Math.random() * 240),
                            modelId: m.models[0],
                            tokens: "in 18 / out 13",
                          },
                        }
                      : m,
                  ),
                );
                notify("单次连通性测速通过。");
              }}
              onOpenEditor={(id) => setModelEditor({ open: true, id })}
            />
          )}

          {page === "runtime" && (
            <RuntimeView
              auditRows={auditRows}
              securityHoldActive={securityHoldActive}
              onOpenVerify={() => setVerifyOpen(true)}
              onSimulateHold={() => {
                setScenario("security_hold");
                notify("已切换至「通道安全待核验」演示场景。");
              }}
              onExportAudit={() => notify("已导出脱敏审计记录摘要（演示态）。")}
            />
          )}

          {page === "analytics" && (
            <AnalyticsView
              accounts={accounts}
              onExportCsv={(r) => notify(`已导出近 ${r} 回复统计 CSV（演示态）。`)}
            />
          )}

          {page === "settings" && (
            <SettingsView
              theme={theme}
              mcpEnabled={mcpEnabled}
              emergencyStopped={emergencyStopped}
              onSetTheme={setTheme}
              onToggleMcp={() => {
                setMcpEnabled((v) => !v);
                notify("本机助手（MCP）连接开关已更新。");
              }}
              onTriggerEmergency={() => {
                setScenario("emergency_stop");
                notify("全局急停已持久生效。");
              }}
              onRecoverEmergency={() => {
                setScenario("normal");
                notify("已核验并恢复运行，未重发任何未知记录。");
              }}
              onOpenConnectPreview={() => setConnectOpen(true)}
              onNotify={notify}
            />
          )}
        </div>
      </main>

      <VerifyHeadlessDialog
        open={verifyOpen}
        onOpenChange={setVerifyOpen}
        onComplete={() => {
          setVerifyOpen(false);
          setScenario("normal");
          setAuditRows((prev) => [
            { time: timeNow(), type: "安全核验解除", scope: "禾木设计精选号", entity: "评论通道", detail: "原无头页面核验通过，评论通道已恢复正常" },
            ...prev,
          ]);
          notify("原无头页面复检通过，评论通道已恢复正常。");
        }}
      />

      <CommentReplyDialog
        thread={threads.find((t) => t.id === commentDialogId) ?? null}
        draft={commentDialogId ? (drafts[commentDialogId] ?? "") : ""}
        onClose={() => setCommentDialogId(null)}
        onDraftChange={(v) =>
          commentDialogId && setDrafts((prev) => ({ ...prev, [commentDialogId]: v }))
        }
        onSend={(text) => {
          if (!commentDialogId) return;
          const now = timeNow().slice(0, 5);
          setThreads((prev) =>
            prev.map((t) =>
              t.id === commentDialogId
                ? {
                    ...t,
                    status: "CONFIRMED",
                    unread: false,
                    commentChain: [
                      ...(t.commentChain ?? []),
                      { level: 2, author: "禾木手作旗舰号（已确认送达）", time: now, text, own: true },
                    ],
                  }
                : t,
            ),
          );
          setDrafts((prev) => ({ ...prev, [commentDialogId]: "" }));
          setCommentDialogId(null);
          notify("评论回复已单次提交并收到送达确认。");
        }}
      />

      <AccountDetailSheet
        account={accounts.find((a) => a.id === accountSheetId) ?? null}
        onClose={() => setAccountSheetId(null)}
      />

      <AddAccountSheet
        open={addAccountOpen}
        onClose={() => setAddAccountOpen(false)}
        onAdd={({ platform, label, handle, avatarUrl, syncCustomerAvatars }) => {
          setAccounts((prev) => [
            ...prev,
            {
              id: `acc_${Date.now()}`,
              platform,
              label,
              handle,
              avatarUrl,
              avatarCapturedAt: `采集自${PLATFORM_META[platform].name}授权页 · 刚刚`,
              syncCustomerAvatars,
              status: platform === "wechat_personal" ? "FOREGROUND_LIMITED" : "ACTIVE",
              serviceTier: platform === "wechat_personal" ? "前台按需" : "队列轮转",
              channels: ["DIRECT_MESSAGE"],
              heldChannels: [],
              autoReply: false,
              lastSync: "刚刚",
              ramMb: PLATFORM_META[platform].runtimeKind === "OFFICIAL_API" ? 0 : 210,
              todayAuto: 0,
              todayHuman: 0,
              dailyQuota: 100,
              ownerLock: "新建隔离容器",
              uptime24h: Array.from({ length: 16 }, () => "ok" as const),
            },
          ]);
          setAddAccountOpen(false);
          notify(`已接入「${label}」并同步本地头像缓存（默认关闭自动外发）。`);
        }}
      />

      <ModelEditorSheet
        open={modelEditor.open}
        connection={models.find((m) => m.id === modelEditor.id) ?? null}
        onClose={() => setModelEditor({ open: false, id: null })}
        onSave={(p) => {
          if (p.id) {
            setModels((prev) =>
              prev.map((m) =>
                m.id === p.id
                  ? { ...m, name: p.name, protocol: p.protocol, baseUrl: p.baseUrl, storage: p.storage, keyPresent: m.keyPresent || p.keyEntered }
                  : m,
              ),
            );
          } else {
            setModels((prev) => [
              ...prev,
              {
                id: `conn_${Date.now()}`,
                name: p.name,
                protocol: p.protocol,
                baseUrl: p.baseUrl,
                region: "Custom",
                storage: p.storage,
                keyPresent: p.keyEntered,
                models: ["custom-model-v1"],
                version: 1,
                callsToday: 0,
                lastTest: null,
              },
            ]);
          }
          setModelEditor({ open: false, id: null });
          notify("模型连接配置已保存。");
        }}
      />

      <CommandPaletteDialog
        open={cmdkOpen}
        onOpenChange={setCmdkOpen}
        pages={allPages}
        onNavigate={setPage}
        onToggleTheme={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
        onSetScenario={setScenario}
      />

      <ConnectPreviewDialog open={connectOpen} onOpenChange={setConnectOpen} />

      {toastMsg && (
        <div
          role="status"
          className="fixed right-5 bottom-5 z-50 flex items-center gap-2 rounded-xl border border-border bg-popover px-3.5 py-2.5 text-xs font-medium text-popover-foreground shadow-lg"
        >
          <span className="size-2 rounded-full bg-primary" />
          <span>{toastMsg}</span>
        </div>
      )}
    </div>
  );
}
