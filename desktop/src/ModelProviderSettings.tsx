import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {ModelProvidersCommand, PublicModelConnection, PublicModelState} from '../../src/contracts/model-providers.js';
import {readModelConnections, reasons, request, runtimeSession, type Status} from './api';
import {explainSafe} from './error-messages';
import {ModelConnectionEditor} from './ModelConnectionEditor';
import {ModelActionFeedback, ModelSelector, type ModelFeedback} from './ModelSelector';
import './model-providers.css';

export type ChangeModelProviders = (
  command: Exclude<ModelProvidersCommand, {action: 'list'}>,
  onCommitted?: () => void,
) => Promise<Status | undefined>;

type UpdateProviders = (next: Status, previous: Status) => void;

export function ModelProviderSettings({status, update}: {status: Status; update: UpdateProviders}) {
  if (status.modelProvidersAvailable !== true || !status.modelProviders) {
    return <div className="settings-section model-settings">
      <h2>当前模型</h2>
      {status.modelProvidersSupported === true
        ? <p className="error" role="status">{explainSafe(status.modelProvidersError, '多模型模块初始化失败。')}</p>
        : <p className="hint" role="status">后端尚未更新多模型能力。</p>}
      <h3>提供商管理</h3>
      <button disabled>新建连接</button>
    </div>;
  }
  return <AvailableProviders key={runtimeSession(status)} status={status} state={status.modelProviders} update={update}/>;
}

function AvailableProviders({status, state: inline, update}: {status: Status; state: PublicModelState; update: UpdateProviders}) {
  const [editing, setEditing] = useState<{id: string | null; session: number} | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [directory, setDirectory] = useState<{source: PublicModelState; state?: PublicModelState; error?: string}>();
  const loaded = directory?.source === inline ? directory : undefined;
  const state = loaded?.state ?? inline;
  const refreshing = state.nextConnectionOffset != null;
  const editorSequence = useRef(0);
  const activeEditor = useRef(editing);
  const lastEditorConnection = useRef<{session: number; connection: PublicModelConnection} | undefined>(undefined);
  const mounted = useRef(false);
  const readSequence = useRef(0);
  const publishedRead = useRef(0);
  const latestStatus = useRef(status);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteFeedback, setDeleteFeedback] = useState<ModelFeedback>();
  const connection = state.connections.find(item => item.id === editing?.id);
  const retained = lastEditorConnection.current;
  const editorConnection = connection ?? (refreshing && retained?.session === editing?.session ? retained?.connection : undefined);
  const budgetExhausted = status.budgets.some(budget => budget.kind === 'MODEL'
    && budget.maximum !== null && budget.used >= budget.maximum);

  const showEditor = (id: string | null) => {
    if (activeEditor.current?.id !== id) {
      const next = {id, session: ++editorSequence.current};
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
      let next = await request<Status>({command: 'getStatus'});
      if (!mounted.current || runtimeSession(next) !== runtimeSession(previous)) return;
      let full: PublicModelState | undefined;
      let pageError: string | undefined;
      if (confirmWrite && next.modelProviders?.nextConnectionOffset != null) {
        try {
          ({status:next, state:full} = await readModelConnections(next));
        } catch (error) {
          pageError = explainSafe(error, '无法读取完整连接列表。');
        }
      }
      if (!mounted.current) return;
      if (sequence <= publishedRead.current || latestStatus.current !== previous) continue;
      publishedRead.current = sequence;
      if (next.modelProviders && (full || pageError)) {
        setDirectory({source:next.modelProviders, state:full, error:pageError});
      }
      update(next, previous);
      if (pageError) throw new Error('MODEL_PROVIDER_STATUS_UNCONFIRMED');
      return full ? {...next, modelProviders:full} : next;
    }
  }

  useLayoutEffect(() => { latestStatus.current = status; }, [status]);
  useLayoutEffect(() => {
    if (!editing || editing.id === null) return;
    if (connection) lastEditorConnection.current = {session:editing.session, connection};
    else if (!refreshing) {
      lastEditorConnection.current = undefined;
      activeEditor.current = null;
      setEditing(null);
      closeEditor();
    }
  }, [editing, connection, refreshing]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { void readStatus().catch(() => {}); }, []);
  useEffect(() => {
    if (inline.nextConnectionOffset == null || directory?.source === inline) return;
    let active = true;
    const read = publishedRead.current;
    void readModelConnections(status).then(result => {
      if (!active || publishedRead.current !== read) return;
      setDirectory({source:result.status.modelProviders!, state:result.state});
      if (result.status !== status) update(result.status, status);
    }).catch(error => {
      if (active && publishedRead.current === read) {
        setDirectory({source:inline, error:explainSafe(error, '无法读取完整连接列表。')});
      }
    });
    return () => { active = false; };
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
    return readStatus(true).catch(() => { throw new Error('MODEL_PROVIDER_STATUS_UNCONFIRMED'); });
  };

  async function deleteConnection(id: string) {
    const target = state.connections.find(item => item.id === id);
    if (refreshing || !target || deleting || id === state.selection.connectionId) return;
    if (!window.confirm(`删除「${target.name}」及关联的 Key？历史调用记录会保留。`)) return;
    const editor = activeEditor.current;
    setDeleting(id);
    setDeleteFeedback(undefined);
    try {
      const next = await change({command: 'modelProviders', action: 'delete', connectionId: id, expectedVersion: target.version});
      if (!mounted.current) return;
      if (!next?.modelProviders || next.modelProviders.connections.some(item => item.id === id)) throw new Error('MODEL_PROVIDER_STATUS_UNCONFIRMED');
      if (editor?.id === id && activeEditor.current === editor) {
        activeEditor.current = null;
        setEditing(null);
        closeEditor();
      }
      setDeleteFeedback({message: `已删除「${target.name}」。`});
    } catch (error) {
      if (mounted.current) setDeleteFeedback({error: true, message: explainSafe(error, '删除连接失败，请查看最新连接列表。')});
    } finally {
      if (mounted.current) setDeleting(null);
    }
  }

  return <div className="settings-section model-settings">
    <ModelSelector state={state} budgetExhausted={budgetExhausted} modelAuthorized={status.modelAuthorized} change={change} refreshing={refreshing}/>
    <section className="model-management" aria-labelledby="model-management-heading">
      <div className="model-heading">
        <h3 id="model-management-heading">提供商管理</h3>
        <button onClick={() => showEditor(null)} disabled={expanded && editing?.id === null}>新建连接</button>
      </div>
      {refreshing && (loaded?.error
        ? <p className="error" role="alert">{loaded.error} <button onClick={() => setDirectory(undefined)}>重新读取连接</button></p>
        : <p className="hint" role="status">正在读取完整连接列表…</p>)}
      {state.connections.length === 0 && <p className="hint">还没有保存的连接。</p>}
      {state.connections.length > 0 && <ul className="model-connections">
        {state.connections.map(item => {
          const current = item.id === state.selection.connectionId;
          const selected = expanded && item.id === editing?.id;
          return <li key={item.id}>
            <div className="model-heading">
              <div className="model-connection-name">
                <strong>{item.name}</strong>
                {current && <small>当前连接，切换后才可删除</small>}
              </div>
              <div className="model-actions">
                <button aria-expanded={selected} aria-label={`${selected ? '收起' : '编辑'} ${item.name}`}
                  onClick={() => selected ? closeEditor() : showEditor(item.id)}>
                  {selected ? '收起' : '编辑'}
                </button>
                <button className="danger" disabled={refreshing || current || deleting !== null}
                  aria-label={`${deleting === item.id ? '正在删除' : '删除'} ${item.name}`} onClick={() => void deleteConnection(item.id)}>
                  {deleting === item.id ? '正在删除' : '删除'}
                </button>
              </div>
            </div>
          </li>;
        })}
      </ul>}
      <ModelActionFeedback feedback={deleteFeedback}/>
      {status.keyStorageError === 'MODEL_CREDENTIAL_CLEANUP_FAILED' &&
        <p className="error" role="alert">{reasons.MODEL_CREDENTIAL_CLEANUP_FAILED}</p>}
      {editing && (editing.id === null || editorConnection) && <ModelConnectionEditor
        key={editing.session} connection={editorConnection} change={change} budgetExhausted={budgetExhausted}
        hidden={!expanded} refreshing={refreshing} selectionRevision={state.selection.selectionRevision}
        stopped={Boolean(status.automation?.emergencyStopped)}
        onCreated={id => {
          if (activeEditor.current !== editing) return;
          const next = {...editing, id};
          activeEditor.current = next;
          setEditing(next);
        }} onClose={closeEditor}/>}
    </section>
  </div>;
}
