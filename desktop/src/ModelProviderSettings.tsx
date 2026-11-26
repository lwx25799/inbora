import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  ModelProvidersCommand,
  PublicModelConnection,
  PublicModelState,
} from '../../src/contracts/model-providers.js';
import { readModelConnections, reasons, request, runtimeSession, type Status } from './api';
import { explainSafe } from './error-messages';
import { ModelConnectionEditor } from './ModelConnectionEditor';
import { ModelActionFeedback, ModelSelector, type ModelFeedback } from './ModelSelector';

export type ChangeModelProviders = (
  command: Exclude<ModelProvidersCommand, { action: 'list' }>,
  onCommitted?: () => void,
) => Promise<Status | undefined>;

type UpdateProviders = (next: Status, previous: Status) => void;

const cardCls =
  'settings-section model-settings flex flex-col gap-5 rounded-2xl border border-border/85 bg-card p-5 text-card-foreground shadow-xs/5';
const btnOutlineCls =
  'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-input bg-popover px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32 dark:hover:bg-input/64';
const btnDangerCls =
  'danger inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-destructive/35 bg-destructive/8 px-3 text-xs font-medium text-destructive-foreground shadow-xs/5 transition-colors hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';

export function ModelProviderSettings({
  status,
  update,
  onDirectoryStateChange,
}: {
  status: Status;
  update: UpdateProviders;
  onDirectoryStateChange?: (state: PublicModelState) => void;
}) {
  if (status.modelProvidersAvailable !== true || !status.modelProviders) {
    return (
      <div className={cardCls}>
        <h2 className="font-heading text-[15px] font-semibold text-foreground">当前模型</h2>
        {status.modelProvidersSupported === true ? (
          <p
            className="error rounded-xl border border-destructive/30 bg-destructive/6 px-3.5 py-2.5 text-xs font-medium text-destructive-foreground"
            role="status"
          >
            {explainSafe(status.modelProvidersError, '多模型模块初始化失败。')}
          </p>
        ) : (
          <p className="hint text-xs text-muted-foreground" role="status">
            后端尚未更新多模型能力。
          </p>
        )}
        <h3 className="font-heading text-[14px] font-semibold text-foreground">提供商管理</h3>
        <div>
          <button className={btnOutlineCls} disabled>
            新建连接
          </button>
        </div>
      </div>
    );
  }
  return (
    <AvailableProviders
      key={runtimeSession(status)}
      status={status}
      state={status.modelProviders}
      update={update}
      onDirectoryStateChange={onDirectoryStateChange}
    />
  );
}

function AvailableProviders({
  status,
  state: inline,
  update,
  onDirectoryStateChange,
}: {
  status: Status;
  state: PublicModelState;
  update: UpdateProviders;
  onDirectoryStateChange?: (state: PublicModelState) => void;
}) {
  const [editing, setEditing] = useState<{ id: string | null; session: number } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [directory, setDirectory] = useState<{
    source: PublicModelState;
    state?: PublicModelState;
    error?: string;
  }>();
  const loaded = directory?.source === inline ? directory : undefined;
  const state = loaded?.state ?? inline;
  const refreshing = state.nextConnectionOffset != null;
  const editorSequence = useRef(0);
  const activeEditor = useRef(editing);
  const lastEditorConnection = useRef<
    { session: number; connection: PublicModelConnection } | undefined
  >(undefined);
  const mounted = useRef(false);
  const readSequence = useRef(0);
  const publishedRead = useRef(0);
  const latestStatus = useRef(status);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteFeedback, setDeleteFeedback] = useState<ModelFeedback>();
  const connection = state.connections.find(item => item.id === editing?.id);
  const retained = lastEditorConnection.current;
  const editorConnection =
    connection ??
    (refreshing && retained?.session === editing?.session ? retained?.connection : undefined);
  const budgetExhausted = status.budgets.some(
    budget => budget.kind === 'MODEL' && budget.maximum !== null && budget.used >= budget.maximum,
  );

  const showEditor = (id: string | null) => {
    if (activeEditor.current?.id !== id) {
      const next = { id, session: ++editorSequence.current };
      activeEditor.current = next;
      setEditing(next);
    }
    setExpanded(true);
  };
  const closeEditor = () => setExpanded(false);

  async function readStatus(confirmWrite = false): Promise<Status | undefined> {
    for (let attempt = 0; attempt < (confirmWrite ? 3 : 1); attempt++) {
      const previous = latestStatus.current;
      const sequence = ++readSequence.current;
      let next = await request<Status>({ command: 'getStatus' });
      if (!mounted.current || runtimeSession(next) !== runtimeSession(previous)) return;
      let full: PublicModelState | undefined;
      let pageError: string | undefined;
      if (confirmWrite && next.modelProviders?.nextConnectionOffset != null) {
        try {
          ({ status: next, state: full } = await readModelConnections(next));
        } catch (error) {
          pageError = explainSafe(error, '无法读取完整连接列表。');
        }
      }
      if (!mounted.current) return;
      if (sequence <= publishedRead.current || latestStatus.current !== previous) continue;
      publishedRead.current = sequence;
      if (next.modelProviders && (full || pageError)) {
        setDirectory({ source: next.modelProviders, state: full, error: pageError });
      }
      update(next, previous);
      if (pageError) throw new Error('MODEL_PROVIDER_STATUS_UNCONFIRMED');
      return full ? { ...next, modelProviders: full } : next;
    }
  }

  useLayoutEffect(() => {
    latestStatus.current = status;
  }, [status]);
  useLayoutEffect(() => {
    if (!editing || editing.id === null) return;
    if (connection) lastEditorConnection.current = { session: editing.session, connection };
    else if (!refreshing) {
      lastEditorConnection.current = undefined;
      activeEditor.current = null;
      setEditing(null);
      closeEditor();
    }
  }, [editing, connection, refreshing]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onDirectoryStateChange?.(state);
  }, [state, onDirectoryStateChange]);
  useEffect(() => {
    void readStatus().catch(() => {});
  }, []);
  useEffect(() => {
    if (inline.nextConnectionOffset == null || directory?.source === inline) return;
    let active = true;
    const read = publishedRead.current;
    void readModelConnections(status)
      .then(result => {
        if (!active || publishedRead.current !== read) return;
        setDirectory({ source: result.status.modelProviders!, state: result.state });
        if (result.status !== status) update(result.status, status);
      })
      .catch(error => {
        if (active && publishedRead.current === read) {
          setDirectory({
            source: inline,
            error: explainSafe(error, '无法读取完整连接列表。'),
          });
        }
      });
    return () => {
      active = false;
    };
  }, [inline, directory?.source]);

  const change: ChangeModelProviders = async (command, onCommitted) => {
    if (!mounted.current) return;
    if (refreshing) throw new Error('MODEL_CONNECTION_CONFLICT');
    try {
      await request<unknown>(command);
    } catch (error) {
      if (mounted.current) await readStatus(true).catch(() => {});
      throw error;
    }
    if (!mounted.current) return;
    onCommitted?.();
    return readStatus(true).catch(() => {
      throw new Error('MODEL_PROVIDER_STATUS_UNCONFIRMED');
    });
  };

  async function deleteConnection(id: string) {
    const target = state.connections.find(item => item.id === id);
    if (refreshing || !target || deleting || id === state.selection.connectionId) return;
    if (!window.confirm(`删除「${target.name}」及关联的 Key？历史调用记录会保留。`)) return;
    const editor = activeEditor.current;
    setDeleting(id);
    setDeleteFeedback(undefined);
    try {
      const next = await change({
        command: 'modelProviders',
        action: 'delete',
        connectionId: id,
        expectedVersion: target.version,
      });
      if (!mounted.current) return;
      if (!next?.modelProviders || next.modelProviders.connections.some(item => item.id === id))
        throw new Error('MODEL_PROVIDER_STATUS_UNCONFIRMED');
      if (editor?.id === id && activeEditor.current === editor) {
        activeEditor.current = null;
        setEditing(null);
        closeEditor();
      }
      setDeleteFeedback({ message: `已删除「${target.name}」。` });
    } catch (error) {
      if (mounted.current)
        setDeleteFeedback({
          error: true,
          message: explainSafe(error, '删除连接失败，请查看最新连接列表。'),
        });
    } finally {
      if (mounted.current) setDeleting(null);
    }
  }

  return (
    <div className={cardCls}>
      <ModelSelector
        state={state}
        budgetExhausted={budgetExhausted}
        modelAuthorized={status.modelAuthorized}
        change={change}
        refreshing={refreshing}
      />

      <section
        className="model-management flex flex-col gap-3 border-t border-border/75 pt-4"
        aria-labelledby="model-management-heading"
      >
        <div className="model-heading flex flex-wrap items-center justify-between gap-2">
          <h3 id="model-management-heading" className="font-heading text-[14px] font-semibold text-foreground">
            提供商管理
          </h3>
          <button
            className={btnOutlineCls}
            onClick={() => showEditor(null)}
            disabled={expanded && editing?.id === null}
          >
            新建连接
          </button>
        </div>

        {refreshing &&
          (loaded?.error ? (
            <p
              className="error flex flex-wrap items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/6 px-3.5 py-2.5 text-xs font-medium text-destructive-foreground"
              role="alert"
            >
              <span>{loaded.error}</span>
              <button className={btnOutlineCls} onClick={() => setDirectory(undefined)}>
                重新读取连接
              </button>
            </p>
          ) : (
            <p className="hint text-xs text-muted-foreground" role="status">
              正在读取完整连接列表…
            </p>
          ))}

        {state.connections.length === 0 && (
          <p className="hint text-xs text-muted-foreground">还没有保存的连接。</p>
        )}

        {state.connections.length > 0 && (
          <ul className="model-connections divide-y divide-border/75 overflow-hidden rounded-xl border border-border/80 bg-background">
            {state.connections.map(item => {
              const current = item.id === state.selection.connectionId;
              const selected = expanded && item.id === editing?.id;
              return (
                <li
                  key={item.id}
                  className={`px-4 py-3 transition-colors ${
                    current ? 'bg-primary/[0.04]' : 'hover:bg-muted/35'
                  }`}
                >
                  <div className="model-heading flex flex-wrap items-center justify-between gap-3">
                    <div className="model-connection-name flex min-w-0 flex-col gap-0.5">
                      <strong className="truncate text-[13.5px] font-semibold text-foreground">
                        {item.name}
                      </strong>
                      {current && (
                        <small className="text-[11.5px] text-primary">
                          当前连接，切换后才可删除
                        </small>
                      )}
                    </div>
                    <div className="model-actions flex shrink-0 items-center gap-2">
                      <button
                        className={btnOutlineCls}
                        aria-expanded={selected}
                        aria-label={`${selected ? '收起' : '编辑'} ${item.name}`}
                        onClick={() => (selected ? closeEditor() : showEditor(item.id))}
                      >
                        {selected ? '收起' : '编辑'}
                      </button>
                      <button
                        className={btnDangerCls}
                        disabled={refreshing || current || deleting !== null}
                        aria-label={`${deleting === item.id ? '正在删除' : '删除'} ${item.name}`}
                        onClick={() => void deleteConnection(item.id)}
                      >
                        {deleting === item.id ? '正在删除' : '删除'}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <ModelActionFeedback feedback={deleteFeedback} />
        {status.keyStorageError === 'MODEL_CREDENTIAL_CLEANUP_FAILED' && (
          <p
            className="error rounded-xl border border-destructive/30 bg-destructive/6 px-3.5 py-2.5 text-xs font-medium text-destructive-foreground"
            role="alert"
          >
            {reasons.MODEL_CREDENTIAL_CLEANUP_FAILED}
          </p>
        )}

        {editing && (editing.id === null || editorConnection) && (
          <ModelConnectionEditor
            key={editing.session}
            connection={editorConnection}
            change={change}
            budgetExhausted={budgetExhausted}
            hidden={!expanded}
            refreshing={refreshing}
            selectionRevision={state.selection.selectionRevision}
            stopped={Boolean(status.automation?.emergencyStopped)}
            onCreated={id => {
              if (activeEditor.current !== editing) return;
              const next = { ...editing, id };
              activeEditor.current = next;
              setEditing(next);
            }}
            onClose={closeEditor}
          />
        )}
      </section>
    </div>
  );
}
