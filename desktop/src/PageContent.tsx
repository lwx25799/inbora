import type { Dispatch, SetStateAction } from "react";
import type * as React from "react";
import { DEFAULT_ACCOUNT_ID } from "../../src/contracts/account.js";
import type { DesktopPageId } from "@/components/AppSidebar";
import { AccountsView } from "@/views/AccountsView";
import { AnalyticsView } from "@/views/AnalyticsView";
import { AutomationView } from "@/views/AutomationView";
import { KnowledgePageView } from "@/views/KnowledgePageView";
import { ModelsPageView } from "@/views/ModelsPageView";
import { OverviewView } from "@/views/OverviewView";
import { RuntimeView, type RuntimeTabId } from "@/views/RuntimeView";
import { SystemSettingsView } from "@/views/SystemSettingsView";
import type { useBusinessPrompts } from "@/useBusinessPrompts";
import type { AuditRow } from "@/useWorkbenchRefresh";
import type { AccountSummary, ActiveWorkbenchAccount, Inbox, Status } from "@/api";

export interface PageContentProps {
  page: Exclude<DesktopPageId, "inbox">;
  sessionKey: string;
  status: Status;
  runtime: string;
  inboxSummary: Inbox;
  busy: string;
  error: string;
  notice: string;
  theme: "light" | "dark";
  pendingAutoReply: boolean | null;
  hasUnsavedDraft: boolean;
  activeAccount: ActiveWorkbenchAccount | null;
  promptsState: ReturnType<typeof useBusinessPrompts>;
  audit: AuditRow[];
  auditPage: number;
  setAuditPage: Dispatch<SetStateAction<number>>;
  runtimeTab: RuntimeTabId;
  onRuntimeTabChange: (tab: RuntimeTabId) => void;
  act: (label: string, fn: () => Promise<void>) => Promise<void>;
  updateStatus: (status: Status) => void;
  updateProviders: (next: Status, previous: Status) => void;
  onNavigate: (page: DesktopPageId) => void;
  onSync: () => void;
  onSelectEvent: (eventId: string) => void;
  onToggleAuto: (enabled: boolean) => Promise<void>;
  onSelectWorkbenchAccount: (account: AccountSummary | null) => void;
  onToggleTheme: () => void;
  onEmergencyStop: () => void;
  onReconnect: () => Promise<void>;
}

export function PageContent({
  page,
  sessionKey,
  status,
  runtime,
  inboxSummary,
  busy,
  error,
  notice,
  theme,
  pendingAutoReply,
  hasUnsavedDraft,
  activeAccount,
  promptsState,
  audit,
  auditPage,
  setAuditPage,
  runtimeTab,
  onRuntimeTabChange,
  act,
  updateStatus,
  updateProviders,
  onNavigate,
  onSync,
  onSelectEvent,
  onToggleAuto,
  onSelectWorkbenchAccount,
  onToggleTheme,
  onEmergencyStop,
  onReconnect,
}: PageContentProps): React.ReactElement | null {
  switch (page) {
    case "overview":
      return (
        <OverviewView
          status={status}
          inbox={inboxSummary}
          busy={busy}
          pendingAutoReply={pendingAutoReply}
          onNavigate={onNavigate}
          onSync={onSync}
          onSelectEvent={onSelectEvent}
          onToggleAuto={(enabled) => act("更新自动回复", () => onToggleAuto(enabled))}
        />
      );
    case "accounts":
      return (
        <AccountsView
          key={sessionKey}
          status={status}
          busy={busy}
          act={act}
          update={updateStatus}
          activeAccount={activeAccount}
          activeAccountRef={activeAccount?.accountRef}
          onSelectWorkbenchAccount={onSelectWorkbenchAccount}
        />
      );
    case "automation":
      return (
        <AutomationView
          key={sessionKey}
          status={status}
          busy={busy}
          error={error}
          notice={notice}
          act={act}
          update={updateStatus}
          promptsState={promptsState}
          toggleAuto={onToggleAuto}
          pendingAutoReply={pendingAutoReply}
        />
      );
    case "knowledge":
      return <KnowledgePageView key={sessionKey} status={status} busy={busy} />;
    case "models":
      return (
        <ModelsPageView
          key={sessionKey}
          status={status}
          updateProviders={updateProviders}
        />
      );
    case "runtime":
      return (
        <RuntimeView
          status={status}
          audit={audit}
          auditPage={auditPage}
          setAuditPage={setAuditPage}
          tab={runtimeTab}
          onTabChange={onRuntimeTabChange}
        />
      );
    case "analytics":
      return (
        <AnalyticsView
          key={sessionKey}
          activeAccountRef={activeAccount?.accountRef ?? DEFAULT_ACCOUNT_ID}
        />
      );
    case "settings":
      return (
        <SystemSettingsView
          key={sessionKey}
          status={status}
          runtime={runtime}
          busy={busy}
          hasUnsavedDraft={hasUnsavedDraft}
          theme={theme}
          onToggleTheme={onToggleTheme}
          act={act}
          update={updateStatus}
          stop={onEmergencyStop}
          reconnect={onReconnect}
        />
      );
    default:
      return null;
  }
}
