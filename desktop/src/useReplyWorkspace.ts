import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  remoteDraftConflict,
  remoteDraftUpdate,
  mayAdvanceReplySelection,
  type RemoteDraftEditor,
} from "./remote-draft";
import {
  canContinueReply,
  hasLocalReplyDraft,
  hasReplyHistory,
  matchesSentDraft,
  replyDraft,
  replyEditorDraft,
  submissionEditorUpdate,
  type ReplyCommandResult,
  type SubmittedReply,
} from "./reply-editor-draft";
import { useDevelopmentReconnect } from "./useDevelopmentReconnect";
import { explain, reasons, request, type Inbox, type Status, type Thread } from "./api";

interface BufferDraft {
  text: string;
  version: number;
  suggestionId: string | null;
  editVersion?: number;
  submitted?: SubmittedReply;
}

export interface SendState {
  commandId: string;
  eventId: string;
  selectionId: string;
  submitted?: SubmittedReply;
  accepted?: boolean;
  intentId?: string | null;
  status: string;
  reason: string | null;
}

interface ReplyWorkspaceParams {
  connected: boolean;
  status: Status | null;
  runtime: string;
  inbox: Inbox;
  error: string;
  setStatus: Dispatch<SetStateAction<Status | null>>;
  setError: Dispatch<SetStateAction<string>>;
  setNotice: Dispatch<SetStateAction<string>>;
}

export function useReplyWorkspace({
  connected,
  status,
  runtime,
  inbox,
  error,
  setStatus,
  setError,
  setNotice,
}: ReplyWorkspaceParams) {
  const [selected, setSelected] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [text, setText] = useState("");
  const [suggestionId, setSuggestionId] = useState<string | null>(null);
  const [send, setSend] = useState<SendState | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const selection = useRef(crypto.randomUUID());
  const selectedRef = useRef<string | null>(null);
  const buffers = useRef(new Map<string, BufferDraft>());
  const detailRequest = useRef(0);
  const editorLoaded = useRef(false);
  const detailElement = useRef<HTMLElement | null>(null);
  const sending = useRef(false);
  const saveTask = useRef<Promise<unknown> | null>(null);
  const dialogElement = useRef<HTMLDialogElement | null>(null);
  const navigation = useRef(0);
  const opening = useRef<{ id: string; selectionId: string; task: Promise<void> } | null>(null);
  const localDraftVersions = useRef(new Map<string, number>());
  const remoteConflicts = useRef(new Set<string>());
  const latestEditor = useRef({ eventId: selected, text, suggestionId, editVersion: 0 });
  const latestThread = useRef(thread);

  latestThread.current = thread;
  latestEditor.current = {
    eventId: selected,
    text,
    suggestionId,
    editVersion: latestEditor.current.editVersion ?? 0,
  };

  const localDraft =
    !!thread &&
    thread.event.id === selected &&
    hasLocalReplyDraft(thread, {
      ...latestEditor.current,
      submitted:
        buffers.current.get(thread.event.id)?.submitted ??
        (send?.eventId === thread.event.id ? send.submitted : undefined),
    });

  const dirty =
    !!thread &&
    (text !== replyEditorDraft(thread).text ||
      suggestionId !== null ||
      (hasReplyHistory(thread) && !canContinueReply(thread) && localDraft));

  const devRecovery = useDevelopmentReconnect({
    selectedRef,
    selection,
    detailRequest,
    latestEditor,
    dialogOpen,
    setStatus,
    setThread,
    setSend,
    setError,
    setNotice,
  });

  useEffect(() => {
    if (dialogOpen && !dialogElement.current?.open) dialogElement.current?.showModal();
    if (!dialogOpen && dialogElement.current?.open) dialogElement.current.close();
  }, [dialogOpen]);

  useEffect(() => {
    if (detailElement.current) detailElement.current.scrollTop = 0;
  }, [thread?.event.id]);

  useEffect(() => {
    if (!thread || thread.event.id !== selectedRef.current) return;
    if (thread.intent) {
      const saved = buffers.current.get(thread.event.id);
      const editor = {
        ...latestEditor.current,
        submitted:
          saved?.submitted ?? (send?.eventId === thread.event.id ? send.submitted : undefined),
      };
      if (editor.eventId === thread.event.id && matchesSentDraft(thread, editor)) {
        if (saved && matchesSentDraft(thread, saved)) buffers.current.delete(thread.event.id);
        setText("");
        setSuggestionId(null);
      } else if (editor.submitted) {
        buffers.current.set(thread.event.id, { ...editor, version: thread.draft?.version ?? 0 });
      }
    }
    if (
      !thread?.intent ||
      thread.replyStatus !== "REPLIED" ||
      thread.event.payload.channel !== "DIRECT_MESSAGE" ||
      dirty ||
      sending.current
    )
      return;
    if (!mayAdvanceReplySelection(thread, send?.eventId, send?.intentId)) return;
    const next = inbox.items.find(
      (item) =>
        item.groupKey === thread.groupKey && item.replyStatus === "WAITING" && item.id !== selected,
    );
    if (next) choose(next.resumeEventId ?? next.id);
  }, [inbox.items, thread, dirty, selected, send]);

  useEffect(() => {
    if (!connected || !selected) return;
    let ignore = false;
    setThread(null);
    editorLoaded.current = false;
    setSend(null);
    setText("");
    const selectionId = crypto.randomUUID();
    selection.current = selectionId;
    setDialogOpen(false);
    void request({ command: "selectTarget", eventId: selected, selectionId })
      .then(async () => {
        if (ignore) return;
        const requestId = ++detailRequest.current;
        const detail = await request<Thread>({ command: "getThread", eventId: selected });
        if (
          !ignore &&
          selectedRef.current === selected &&
          selection.current === selectionId &&
          detailRequest.current === requestId
        ) {
          detailRequest.current++;
          latestThread.current = detail;
          setThread(detail);
          editorLoaded.current = true;
          const editor = replyEditorDraft(detail, buffers.current.get(selected));
          latestEditor.current = {
            eventId: selected,
            text: editor.text,
            suggestionId: editor.suggestionId,
            editVersion: editor.editVersion ?? 0,
          };
          setText(editor.text);
          setSuggestionId(editor.suggestionId);
          const saved = buffers.current.get(selected);
          if (
            saved &&
            saved.version !== (detail.draft?.version ?? 0) &&
            detail.draft?.origin === "MCP_ASSISTED" &&
            editor.text !== detail.draft.text
          ) {
            remoteConflicts.current.add(selected);
            setError(reasons.MCP_DRAFT_VERSION_CHANGED!);
          }
        }
        if (ignore || !detail || detail.event.payload.channel !== "DIRECT_MESSAGE") return;
        setDialogOpen(status?.configuredMode !== "LIMITED_AUTO");
        if (detail.intent) return;
        if (status?.configuredMode === "LIMITED_AUTO") return;
        const before = { ...latestEditor.current };
        const previous = latestThread.current;
        const claimed = await request<Thread>({
          command: "openHumanDialog",
          eventId: selected,
          selectionId,
        });
        if (!ignore && selectedRef.current === selected && selection.current === selectionId) {
          detailRequest.current++;
          reconcileRemoteDraft(previous, claimed, before);
          latestThread.current = claimed;
          setThread(claimed);
        }
      })
      .catch((cause) => {
        if (!ignore) setError(explain(cause));
      });
    return () => {
      ignore = true;
      detailRequest.current++;
    };
  }, [connected, selected]);

  useEffect(() => {
    if (
      devRecovery.blockAutosave ||
      !dialogOpen ||
      !dirty ||
      !thread?.ownership.isMine ||
      remoteConflicts.current.has(thread.event.id) ||
      !canContinueReply(thread) ||
      saving ||
      sending.current ||
      (send &&
        ["PREPARING", "QUEUED", "PREFLIGHT", "SENDING"].includes(send.status) &&
        !thread.followup?.queueReady)
    )
      return;
    const id = setTimeout(() => {
      void saveDraft().catch((cause) => setError(explain(cause)));
    }, 500);
    return () => clearTimeout(id);
  }, [
    devRecovery.blockAutosave,
    dialogOpen,
    dirty,
    text,
    suggestionId,
    thread?.ownership.isMine,
    thread?.draft?.version,
    thread?.followup?.draft?.version,
    thread?.followup?.queueReady,
    thread?.intent,
    saving,
    send?.status,
  ]);

  useEffect(() => {
    if (
      !devRecovery.restoring &&
      dialogOpen &&
      dirty &&
      thread &&
      !thread.ownership.isMine &&
      canContinueReply(thread)
    ) {
      void openDialog().catch((cause) => setError(explain(cause)));
    }
  }, [
    devRecovery.restoring,
    dialogOpen,
    dirty,
    thread?.ownership.isMine,
    thread?.ownership.generation,
    thread?.intent,
    thread?.followup?.eligible,
    thread?.followup?.queueReady,
  ]);

  useEffect(() => {
    if (!send || !["PREPARING", "QUEUED", "PREFLIGHT", "SENDING"].includes(send.status)) return;
    const { commandId, eventId, selectionId } = send;
    let submitted = send.submitted;
    if (!eventId || !selectionId) {
      setSend(null);
      return;
    }
    let ignore = false;
    let timer: ReturnType<typeof setTimeout>;
    const current = () =>
      !ignore && selectedRef.current === eventId && selection.current === selectionId;
    const poll = async () => {
      if (!current()) return;
      try {
        const result = await request<ReplyCommandResult>({ command: "getSendResult", commandId });
        if (!current()) return;
        if (result.commandId !== commandId) throw Error("COMMAND_NOT_FOUND");
        submitted = applySubmission(result, commandId, submitted);
        setSend({ ...result, eventId, selectionId, submitted });
        if (!["PREPARING", "QUEUED", "PREFLIGHT", "SENDING"].includes(result.status)) {
          await refreshThread(eventId);
          return;
        }
      } catch (cause) {
        if (current()) setError(explain(cause));
      }
      if (current()) timer = setTimeout(() => void poll(), 500);
    };
    timer = setTimeout(() => void poll(), 500);
    return () => {
      ignore = true;
      clearTimeout(timer);
    };
  }, [send?.commandId, send?.status, selected]);

  async function refreshThread(
    eventId = selectedRef.current,
    alive: () => boolean = () => true,
  ): Promise<Thread | null> {
    if (eventId && eventId === selectedRef.current) {
      const requestId = ++detailRequest.current;
      const selectionId = selection.current;
      const previous = latestThread.current;
      const before = { ...latestEditor.current };
      const detail = await request<Thread>({ command: "getThread", eventId });
      if (
        alive() &&
        selectedRef.current === eventId &&
        selection.current === selectionId &&
        detailRequest.current === requestId
      ) {
        if (editorLoaded.current) reconcileRemoteDraft(previous, detail, before);
        latestThread.current = detail;
        setThread(detail);
        if (detail.replyStatus === "REPLIED") {
          setError((current) => (current === "COMMAND_NOT_FOUND" ? "" : current));
        }
        if (!editorLoaded.current) {
          editorLoaded.current = true;
          const saved = buffers.current.get(eventId);
          const editor = replyEditorDraft(detail, saved);
          latestEditor.current = {
            eventId,
            text: editor.text,
            suggestionId: editor.suggestionId,
            editVersion: editor.editVersion ?? 0,
          };
          setText(editor.text);
          setSuggestionId(editor.suggestionId);
          if (saved && editor.text && saved.version !== (detail.draft?.version ?? 0)) {
            setError("本地未保存内容保留，但服务器草稿已变化。请核对后重新保存。");
          }
        }
        return detail;
      }
    }
    return null;
  }

  function reconcileRemoteDraft(
    previous: Thread | null,
    next: Thread,
    before: RemoteDraftEditor,
  ): void {
    const changed = remoteDraftUpdate(previous, next, before, latestEditor.current);
    if (!changed) {
      if (remoteDraftConflict(previous, next, latestEditor.current)) {
        remoteConflicts.current.add(next.event.id);
        buffers.current.set(next.event.id, {
          ...latestEditor.current,
          version: previous?.draft?.version ?? 0,
        });
        setError(reasons.MCP_DRAFT_VERSION_CHANGED!);
      }
      return;
    }
    const buffered = buffers.current.get(next.event.id);
    if (buffered?.text === before.text && buffered.suggestionId === before.suggestionId) {
      buffers.current.delete(next.event.id);
    }
    latestEditor.current = changed;
    setText(changed.text);
    setSuggestionId(changed.suggestionId);
  }

  function select(id: string): void {
    detailRequest.current++;
    selectedRef.current = id;
    setSelected(id);
    setError("");
    setNotice("");
  }

  function choose(id: string): void {
    if (selected === id) return;
    const version = ++navigation.current;
    if (thread && dirty) {
      buffers.current.set(thread.event.id, {
        text,
        version: thread.draft?.version ?? 0,
        suggestionId,
        editVersion: latestEditor.current.editVersion,
        submitted: buffers.current.get(thread.event.id)?.submitted,
      });
    }
    const leaving =
      thread &&
      dirty &&
      !remoteConflicts.current.has(thread.event.id) &&
      thread.event.payload.channel === "DIRECT_MESSAGE" &&
      thread.ownership.isMine &&
      canContinueReply(thread);
    if (leaving) {
      void (async () => {
        do {
          await saveDraft();
        } while (
          latestEditor.current.eventId === thread.event.id &&
          latestEditor.current.text !== replyEditorDraft(thread).text &&
          replyEditorDraft(await request<Thread>({ command: "getThread", eventId: thread.event.id }))
            .text !== latestEditor.current.text
        );
        if (navigation.current === version) select(id);
      })().catch((cause) => setError(explain(cause)));
      return;
    }
    select(id);
  }

  async function saveDraft(): Promise<void> {
    if (saveTask.current) {
      await saveTask.current;
      return;
    }
    if (!thread) return;
    if (remoteConflicts.current.has(thread.event.id)) throw Error("MCP_DRAFT_VERSION_CHANGED");
    const eventId = thread.event.id;
    const submittedText = latestEditor.current.text;
    const submittedSuggestion = latestEditor.current.suggestionId;
    if (latestEditor.current.eventId !== eventId) return;
    setSaving(true);
    const task = request<NonNullable<Thread["draft"]>>({
      eventId: thread.event.id,
      generation: thread.ownership.generation,
      expectedVersion: Math.max(
        replyDraft(thread)?.version ?? 0,
        localDraftVersions.current.get(`${eventId}:${hasReplyHistory(thread)}`) ?? 0,
      ),
      text: submittedText,
      ...(hasReplyHistory(thread)
        ? { command: "saveHumanFollowupDraft" as const, suggestionId: null }
        : { command: "saveDraft" as const, suggestionId: submittedSuggestion }),
    });
    saveTask.current = task;
    let saved: NonNullable<Thread["draft"]>;
    try {
      saved = await task;
    } finally {
      saveTask.current = null;
      setSaving(false);
    }
    localDraftVersions.current.set(`${eventId}:${hasReplyHistory(thread)}`, saved.version);
    const buffered = buffers.current.get(eventId);
    if (buffered) {
      if (buffered.text === submittedText && buffered.suggestionId === submittedSuggestion) {
        buffers.current.delete(eventId);
      } else {
        buffers.current.set(eventId, { ...buffered, version: saved.version });
      }
    }
    const current = latestEditor.current;
    if (
      current.eventId === eventId &&
      current.text === submittedText &&
      current.suggestionId === submittedSuggestion
    ) {
      setSuggestionId(null);
    }
    await refreshThread(eventId);
    setNotice("草稿已保存，旧审批已失效");
  }

  async function reconnect(): Promise<void> {
    const next = await request<Status>({
      command: "connect",
      runtime,
      initialize: false,
      consent: true,
    });
    setStatus(next);
    setSend(null);
    const eventId = selectedRef.current;
    const selectionId = crypto.randomUUID();
    selection.current = selectionId;
    await request({ command: "selectTarget", eventId, selectionId });
    await refreshThread(eventId);
    setNotice("已读取内核权威状态，未重放发送；未保存人稿保留");
  }

  function sendDisabled(): string {
    if (thread && remoteConflicts.current.has(thread.event.id)) {
      return reasons.MCP_DRAFT_VERSION_CHANGED!;
    }
    if (!thread || !status) return "请选择一条任务";
    if (devRecovery.restoring) return "开发内核正在恢复连接，人稿已保留";
    if (hasReplyHistory(thread) && !canContinueReply(thread)) {
      return thread.followup?.reason
        ? (reasons[thread.followup.reason] ?? "上一条回复尚未确认，暂不可再次发送")
        : "上一条回复正在确认，可先输入新内容";
    }
    if (
      send &&
      ["PREPARING", "QUEUED", "PREFLIGHT", "SENDING"].includes(send.status) &&
      !thread.followup?.queueReady
    ) {
      return "正在发送这条回复，请勿重复发送";
    }
    if (thread.frozen && !thread.followup?.queueReady) return reasons.TARGET_FROZEN!;
    if (status.automation?.emergencyStopped || status.paused) {
      return "已急停，恢复运行后可继续回复";
    }
    if (thread.paused) return reasons.TARGET_PAUSED!;
    const human = thread.humanReplyEligibility;
    if (human ? !human.eligible : !thread.strong || thread.event.status === "MANUAL_REVIEW") {
      return human?.reason
        ? (reasons[human.reason] ?? "这条消息暂时无法人工发送，草稿已保留")
        : thread.event.payload.observationIssue
          ? (reasons[thread.event.payload.observationIssue] ?? "这条消息需人工处理，草稿已保留")
          : "这条消息暂时无法发送，草稿已保留，后台正在处理";
    }
    const capability =
      status.capabilities.find((c) => c.channel === thread.event.payload.channel) ??
      thread.capability;
    if (!status.automation && capability.state !== "SEND_AVAILABLE" && !thread.controlledTrial) {
      return reasons[capability.reason] ?? "通道尚未开放发送";
    }
    if (!["MANUAL", "AI_ASSISTED", "LIMITED_AUTO"].includes(status.configuredMode)) {
      return reasons.MODE_DRAFT_ONLY!;
    }
    if (!thread.ownership.isMine || thread.ownership.lease_expires_at <= Date.now()) {
      return "正在自动准备编辑，输入内容会保留";
    }
    if (!status.operator.permissions.includes("SEND")) return "当前操作员没有发送权限";
    if (!text.trim()) return "请输入回复";
    if ([...text].length > 500) return "回复内容不能超过 500 字";
    return "";
  }

  async function openDialog(): Promise<void> {
    if (!thread) return;
    const id = thread.event.id;
    const selectionId = selection.current;
    if (opening.current?.id === id && opening.current.selectionId === selectionId) {
      return opening.current.task;
    }
    const previous = latestThread.current;
    const before = { ...latestEditor.current };
    const task = (async () => {
      const detail = await request<Thread>({
        command: "openHumanDialog",
        eventId: id,
        selectionId,
      });
      if (selectedRef.current === id && selection.current === selectionId) {
        detailRequest.current++;
        reconcileRemoteDraft(previous, detail, before);
        latestThread.current = detail;
        setThread(detail);
        setDialogOpen(true);
      }
    })();
    opening.current = { id, selectionId, task };
    try {
      await task;
    } finally {
      if (opening.current?.task === task) opening.current = null;
    }
  }

  async function closeDialog(): Promise<void> {
    await saveTask.current;
    if (thread && latestEditor.current.eventId === thread.event.id) {
      const previous = latestThread.current;
      const before = { ...latestEditor.current };
      const detail = await request<Thread>({ command: "getThread", eventId: thread.event.id });
      reconcileRemoteDraft(previous, detail, before);
      const latest = latestEditor.current;
      if (
        !remoteConflicts.current.has(detail.event.id) &&
        detail.ownership.isMine &&
        canContinueReply(detail) &&
        latest.text !== replyEditorDraft(detail).text
      ) {
        await request({
          eventId: detail.event.id,
          generation: detail.ownership.generation,
          expectedVersion: replyDraft(detail)?.version ?? 0,
          text: latest.text,
          ...(hasReplyHistory(detail)
            ? { command: "saveHumanFollowupDraft" as const, suggestionId: null }
            : { command: "saveDraft" as const, suggestionId: latest.suggestionId }),
        });
      }
    }
    if (thread?.ownership.isMine) {
      await request({
        command: "closeHumanDialog",
        eventId: thread.event.id,
        generation: thread.ownership.generation,
      });
    }
    setDialogOpen(false);
    await refreshThread();
  }

  function applySubmission(
    result: ReplyCommandResult,
    commandId: string,
    submitted: SubmittedReply | undefined,
  ): SubmittedReply | undefined {
    if (!submitted) return submitted;
    const next = submissionEditorUpdate(latestEditor.current, submitted, result, commandId);
    if (!next) return submitted;
    const current = { ...latestEditor.current, text: next.text, suggestionId: next.suggestionId };
    latestEditor.current = current;
    buffers.current.set(current.eventId!, {
      ...current,
      version: replyDraft(thread!)?.version ?? 0,
      submitted: next.submitted,
    });
    setText(next.text);
    setSuggestionId(next.suggestionId);
    return next.submitted;
  }

  async function sendCurrentText(): Promise<void> {
    if (!thread || sending.current) return;
    if (remoteConflicts.current.has(thread.event.id)) throw Error("MCP_DRAFT_VERSION_CHANGED");
    sending.current = true;
    const eventId = thread.event.id;
    const selectionId = selection.current;
    const submittedText = latestEditor.current.text;
    const submittedSuggestion = latestEditor.current.suggestionId;
    const editVersion = latestEditor.current.editVersion;
    try {
      await saveTask.current;
      const detail = await request<Thread>({ command: "getThread", eventId });
      if (selectedRef.current !== eventId || selection.current !== selectionId) {
        throw Error("TARGET_SELECTION_CHANGED");
      }
      const submitted = { text: submittedText, suggestionId: submittedSuggestion, editVersion };
      buffers.current.set(eventId, {
        ...latestEditor.current,
        version: detail.draft?.version ?? 0,
        submitted,
      });
      const commandId = crypto.randomUUID();
      setSend(null);
      const result = await request<ReplyCommandResult>({
        command: hasReplyHistory(detail) ? "sendHumanFollowup" : "sendHumanReply",
        commandId,
        input: {
          eventId,
          generation: detail.ownership.generation,
          expectedVersion: replyDraft(detail)?.version ?? 0,
          text: submittedText,
          contextVersion: detail.contextVersion,
          selectionId,
          suggestionId: hasReplyHistory(detail) ? null : submittedSuggestion,
        },
      });
      if (selectedRef.current !== eventId || selection.current !== selectionId) return;
      if (result.commandId !== commandId) throw Error("COMMAND_NOT_FOUND");
      setSend({
        ...result,
        eventId,
        selectionId,
        submitted: applySubmission(result, commandId, submitted),
      });
      await refreshThread(eventId);
    } catch (cause) {
      if (selectedRef.current === eventId && selection.current === selectionId) {
        await refreshThread(eventId).catch(() => {});
        throw cause;
      }
    } finally {
      sending.current = false;
    }
  }

  function updateEditorText(value: string): void {
    if (selected) remoteConflicts.current.delete(selected);
    if (error === reasons.MCP_DRAFT_VERSION_CHANGED) setError("");
    latestEditor.current.editVersion++;
    setText(value);
  }

  function updateEditorSuggestion(value: string | null): void {
    if (selected) remoteConflicts.current.delete(selected);
    if (error === reasons.MCP_DRAFT_VERSION_CHANGED) setError("");
    latestEditor.current.editVersion++;
    setSuggestionId(value);
  }

  async function flushDraftBeforeAutoToggle(): Promise<void> {
    await saveTask.current;
    if (dirty && thread?.ownership.isMine && canContinueReply(thread)) {
      await saveDraft();
    }
  }

  return {
    selected,
    thread,
    text,
    send,
    saving,
    dirty,
    localDraft,
    devRecovery,
    detailElement,
    dialogElement,
    choose,
    refreshThread,
    reconnect,
    sendDisabled,
    openDialog,
    closeDialog,
    sendCurrentText,
    updateEditorText,
    updateEditorSuggestion,
    flushDraftBeforeAutoToggle,
  };
}
