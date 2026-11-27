import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";
import { explain, request, type Inbox, type Status } from "./api";
import type { DesktopPageId } from "./components/AppSidebar";
import { ReadRefresh, refreshTargets } from "./read-refresh";
import type { RuntimeTabId } from "./views/RuntimeView";

export interface AuditRow {
  time: string;
  event_type: string;
  entity_id: string;
  detail_redacted: string;
}

type RefreshPage = DesktopPageId | "audit";

interface RefreshView {
  connected: boolean;
  activeAccountRef?: string | undefined;
  status: Status | null;
  selected: string | null;
  channel: "ALL" | "COMMENT_NOTIFICATION" | "DIRECT_MESSAGE";
  filter: "ALL" | "UNREAD" | "PENDING" | "MANUAL_ONLY" | "CONFIRMED";
  pageNumber: number;
  page: RefreshPage;
  runtimeTab?: RuntimeTabId;
  auditPage: number;
  notice: string;
  sendStatus: string | undefined;
  readThread: (alive: () => boolean) => Promise<unknown>;
  setStatus: Dispatch<SetStateAction<Status | null>>;
  setInbox: Dispatch<SetStateAction<Inbox>>;
  setInboxSummary?: Dispatch<SetStateAction<Inbox>>;
  setUnreadCount?: Dispatch<SetStateAction<number>>;
  setAudit: Dispatch<SetStateAction<AuditRow[]>>;
  setError: (error: string) => void;
}

const allReads = ["status", "inbox", "thread", "audit"] as const;
const inboxKey = (view: RefreshView) => [view.channel, view.filter, view.pageNumber].join("|");
const isAuditVisible = (view: RefreshView) =>
  view.page === "audit" || (view.page === "runtime" && (view.runtimeTab ?? "audit") === "audit");
const unreadFrom = (data: Inbox) =>
  data.unreadTotal ?? data.items.filter((item) => item.unread).length;

/** Read-only refreshes share one queue per type; selection and human text stay owned by App. */
export function useWorkbenchRefresh(view: RefreshView): void {
  const latest = useRef(view);
  latest.current = view;
  const queue = useRef<ReadRefresh | null>(null);

  useEffect(() => {
    if (!view.connected) return;
    let disposed = false;
    let stopListening: (() => void) | undefined;
    const alive = () => !disposed && latest.current.connected;
    const refresh = new ReadRefresh(
      {
        status: async (current) => {
          const previous = latest.current.status;
          const status = await request<Status>({ command: "getStatus" });
          if (alive() && current()) {
            latest.current.setStatus((existing) => (existing === previous ? status : existing));
          }
        },
        inbox: async (current) => {
          const currentView = latest.current;
          if (currentView.page === "inbox") {
            const key = inboxKey(currentView);
            const inbox = await request<Inbox>({
              command: "getInbox",
              channel: currentView.channel,
              status: currentView.filter,
              page: currentView.pageNumber,
            });
            if (!alive() || !current()) return;
            if (key === inboxKey(latest.current)) {
              latest.current.setInbox(inbox);
            }
            if (currentView.channel === "ALL") {
              latest.current.setUnreadCount?.(unreadFrom(inbox));
              if (currentView.filter === "ALL" && currentView.pageNumber === 0) {
                latest.current.setInboxSummary?.(inbox);
              }
            } else {
              const summary = await request<Inbox>({
                command: "getInbox",
                channel: "ALL",
                status: "ALL",
                page: 0,
              });
              if (alive() && current()) {
                latest.current.setInboxSummary?.(summary);
                latest.current.setUnreadCount?.(unreadFrom(summary));
              }
            }
            return;
          }
          const summary = await request<Inbox>({
            command: "getInbox",
            channel: "ALL",
            status: "ALL",
            page: 0,
          });
          if (alive() && current()) {
            latest.current.setInboxSummary?.(summary);
            latest.current.setUnreadCount?.(unreadFrom(summary));
          }
        },
        thread: async (current) => {
          if (alive()) await latest.current.readThread(() => alive() && current());
        },
        audit: async (current) => {
          const currentView = latest.current;
          if (!isAuditVisible(currentView)) return;
          const result = await request<{ items: AuditRow[] }>({
            command: "getAudit",
            page: currentView.auditPage,
          });
          if (
            alive() &&
            current() &&
            isAuditVisible(latest.current) &&
            latest.current.auditPage === currentView.auditPage
          ) {
            latest.current.setAudit(result.items);
          }
        },
      },
      (error, target) => {
        if (alive()) {
          latest.current.setError((target === "status" ? "内核连接中断：" : "") + explain(error));
        }
      },
    );
    queue.current = refresh;
    // Capture a fresh snapshot after asynchronous listener registration, including events during setup.
    const unlisten = listen<{ event?: unknown }>("inbora_status_updated", (event) => {
      if (!alive() || typeof event.payload?.event !== "string") return;
      if (event.payload.event === "sidecar_response_too_large") {
        latest.current.setError(explain("SIDECAR_RESPONSE_TOO_LARGE"));
        return;
      }
      refresh.schedule(refreshTargets(event.payload.event));
    });
    void unlisten
      .then((stop) => {
        if (disposed) stop();
        else {
          stopListening = stop;
          refresh.schedule(allReads);
        }
      })
      .catch(() => {});
    const focus = () => refresh.schedule(allReads);
    window.addEventListener("focus", focus);
    const timer = setInterval(() => refresh.schedule(allReads, 0), 15_000);
    return () => {
      disposed = true;
      refresh.dispose();
      if (queue.current === refresh) queue.current = null;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      stopListening?.();
    };
  }, [view.connected]);

  const status = view.status;
  const nonEmptyNotice = view.notice ? view.notice : "";
  const noticeSignal = useRef(0);
  const lastNotice = useRef("");
  if (nonEmptyNotice && nonEmptyNotice !== lastNotice.current) {
    noticeSignal.current++;
  }
  lastNotice.current = nonEmptyNotice;
  const noticeTick = noticeSignal.current;

  useEffect(() => {
    if (view.connected) queue.current?.schedule(allReads, 0);
  }, [view.connected, view.activeAccountRef]);

  useEffect(() => {
    if (view.connected) queue.current?.schedule(["inbox"], 0);
  }, [
    view.connected,
    view.page,
    view.channel,
    view.filter,
    view.pageNumber,
    noticeTick,
    view.sendStatus,
    status?.sync.runId,
    status?.sync.running,
    status?.sync.results.map((result) => result.state).join("|"),
    status?.automation?.inboxRevision,
  ]);
  useEffect(() => {
    if (view.connected) queue.current?.schedule(["thread"], 0);
  }, [
    view.connected,
    view.selected,
    status?.browser.state,
    status?.browser.version,
    status?.paused,
    status?.automation?.emergencyStopped,
    status?.capabilities.map((capability) => capability.state + ":" + capability.reason).join("|"),
    status?.automation?.inboxRevision,
  ]);
  useEffect(() => {
    if (view.connected && isAuditVisible(view)) queue.current?.schedule(["audit"], 0);
  }, [view.connected, view.page, view.runtimeTab, view.auditPage, noticeTick]);
}
