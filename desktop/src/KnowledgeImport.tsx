import { useEffect, useRef, useState } from 'react';
import type { Channel } from '../../src/contracts/events.js';
import {
  knowledgeRequest,
  type ChatImportMapping,
  type ImportPreview,
  type PerformKnowledge,
} from './knowledge-client';

interface MappingPreview {
  pairs: { prompt: string; response: string; group?: string }[];
  total: number;
  warnings?: string[];
}
const importChunkBytes = 48 * 1024;
const maximumFileBytes = 20 * 1024 * 1024;
function encodeChunk(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
export async function uploadKnowledgeFile(
  file: File,
  kind: 'KNOWLEDGE' | 'CHAT',
): Promise<ImportPreview> {
  if (file.size > maximumFileBytes) throw new Error('KNOWLEDGE_IMPORT_TOO_LARGE');
  const upload = await knowledgeRequest<{ id: string }>({
    action: 'importStart',
    name: file.name,
    bytes: file.size,
    kind,
  });
  try {
    for (let offset = 0, index = 0; offset < file.size; offset += importChunkBytes, index++) {
      const chunk = new Uint8Array(
        await file.slice(offset, offset + importChunkBytes).arrayBuffer(),
      );
      await knowledgeRequest({
        action: 'importChunk',
        id: upload.id,
        index,
        data: encodeChunk(chunk),
      });
    }
    return await knowledgeRequest<ImportPreview>({ action: 'importFinish', id: upload.id });
  } catch (failure) {
    await knowledgeRequest({ action: 'importCancel', id: upload.id }).catch(() => {});
    throw failure;
  }
}

const hintCls = 'hint text-xs leading-relaxed text-muted-foreground';
const labelCls = 'flex flex-col gap-1.5 text-xs font-medium text-foreground';
const inputCls =
  'h-8.5 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-[13px] text-foreground shadow-xs/5 outline-none transition-shadow focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/32';
const btnOutlineCls =
  'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-input bg-popover px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32';
const btnPrimaryCls =
  'primary inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-primary bg-primary px-3 text-xs font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';

export function KnowledgeImport({
  kind,
  busy,
  perform,
}: {
  kind: 'KNOWLEDGE' | 'CHAT';
  busy: boolean;
  perform: PerformKnowledge;
}) {
  const [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<ChatImportMapping>({
    speakerColumn: 'speaker',
    textColumn: 'text',
    selfName: '',
    channel: 'DIRECT_MESSAGE',
  });
  const [pairs, setPairs] = useState<MappingPreview | null>(null),
    [mappingSignature, setMappingSignature] = useState('');
  const input = useRef<HTMLInputElement>(null),
    uploadId = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (uploadId.current)
        void knowledgeRequest({ action: 'importCancel', id: uploadId.current }).catch(() => {});
    },
    [],
  );
  const changeMapping = (value: ChatImportMapping) => {
    setMapping(value);
    setPairs(null);
    setMappingSignature('');
  };
  const reset = () => {
    uploadId.current = null;
    setPreview(null);
    setFile(null);
    setPairs(null);
    setMappingSignature('');
    if (input.current) input.current.value = '';
  };
  const mappingReady =
    !!mapping.selfName.trim() &&
    !!mapping.speakerColumn &&
    !!mapping.textColumn &&
    mapping.speakerColumn !== mapping.textColumn;
  const ready =
    kind === 'KNOWLEDGE' ||
    (!!pairs && pairs.total > 0 && mappingSignature === JSON.stringify(mapping));

  return (
    <details className="knowledge-import rounded-xl border border-border/80 bg-muted/30 px-4 py-3 text-[13px]">
      <summary className="cursor-pointer font-medium text-[13px] text-foreground select-none">
        从文件导入{kind === 'KNOWLEDGE' ? '知识' : '聊天记录'}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <p className={hintCls}>
          {kind === 'KNOWLEDGE'
            ? '支持 TXT、MD、DOCX、文字 PDF、CSV、XLSX。'
            : '支持 TXT、CSV、JSON、JSONL。TXT 每行使用“发言人: 正文”，可在预览中映射本人。'}
          每个文件最多20 MiB，解析在本机完成。
        </p>
        {!preview ? (
          <>
            <label className={labelCls}>
              选择{kind === 'KNOWLEDGE' ? '知识' : '聊天'}文件
              <input
                ref={input}
                type="file"
                className="w-full cursor-pointer rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs text-muted-foreground file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-muted file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                disabled={busy}
                accept={
                  kind === 'KNOWLEDGE'
                    ? '.txt,.md,.docx,.pdf,.csv,.xlsx'
                    : '.txt,.csv,.json,.jsonl'
                }
                onChange={event => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
            {file && (
              <p
                className={
                  file.size > maximumFileBytes
                    ? 'error text-xs font-medium text-destructive-foreground'
                    : `${hintCls} tabular-nums`
                }
              >
                {file.name} · {(file.size / 1024).toFixed(1)} KiB
                {file.size > maximumFileBytes ? '，超过20 MiB限制' : ''}
              </p>
            )}
            <div>
              <button
                className={btnOutlineCls}
                disabled={busy || !file || file.size === 0 || file.size > maximumFileBytes}
                onClick={() => {
                  if (file)
                    void perform(
                      '解析导入文件',
                      () => uploadKnowledgeFile(file, kind),
                      result => {
                        uploadId.current = result.id;
                        setPreview(result);
                        setPairs(null);
                        setMappingSignature('');
                        setMapping(previous => ({
                          ...previous,
                          speakerColumn: result.columns.includes('speaker')
                            ? 'speaker'
                            : (result.columns[0] ?? ''),
                          textColumn: result.columns.includes('text')
                            ? 'text'
                            : (result.columns[1] ?? ''),
                        }));
                      },
                      false,
                    );
                }}
              >
                解析并预览
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-0.5">
              <h4 className="font-semibold text-[13.5px] text-foreground">{preview.name}</h4>
              <p className={`${hintCls} tabular-nums`}>已解析 {preview.totalRows} 行，尚未导入。</p>
            </div>
            {preview.warnings.map((warning, index) => (
              <p
                className="knowledge-warning rounded-lg border border-warning/35 bg-warning/8 px-3 py-2 text-xs text-warning-foreground"
                key={index}
              >
                {warning}
              </p>
            ))}
            <pre className="knowledge-text-preview max-h-52 overflow-auto rounded-lg border border-border/75 bg-card p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground">
              {preview.textPreview}
            </pre>
            {kind === 'CHAT' && (
              <>
                <div className="knowledge-fields grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {(
                    [
                      ['speakerColumn', '发言人列'],
                      ['textColumn', '正文列'],
                      ['conversationColumn', '会话列（可选）'],
                      ['timeColumn', '时间列（可选）'],
                    ] as const
                  ).map(([field, label]) => (
                    <label className={labelCls} key={field}>
                      {label}
                      <select
                        className={inputCls}
                        aria-label={label}
                        value={mapping[field] ?? ''}
                        disabled={busy}
                        onChange={event => {
                          const value = event.target.value;
                          changeMapping({ ...mapping, [field]: value || undefined });
                        }}
                      >
                        <option value="">
                          {field === 'speakerColumn' || field === 'textColumn'
                            ? '请选择'
                            : '不使用'}
                        </option>
                        {preview.columns.map(column => (
                          <option key={column} value={column}>
                            {column}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <label className={labelCls}>
                    本人发言人名称
                    <input
                      className={inputCls}
                      value={mapping.selfName}
                      disabled={busy}
                      onChange={event => changeMapping({ ...mapping, selfName: event.target.value })}
                    />
                  </label>
                  <label className={labelCls}>
                    聊天通道
                    <select
                      className={inputCls}
                      aria-label="聊天通道"
                      value={mapping.channel}
                      disabled={busy}
                      onChange={event =>
                        changeMapping({ ...mapping, channel: event.target.value as Channel })
                      }
                    >
                      <option value="DIRECT_MESSAGE">私信</option>
                      <option value="COMMENT_NOTIFICATION">评论</option>
                    </select>
                  </label>
                </div>
                <p className={hintCls}>
                  时间列接受 ISO 日期时间或 Unix 时间戳；不选择时间列时按文件顺序配对。
                </p>
                <p className={hintCls}>
                  只学习与本人准确匹配的回复；其他发言人用于还原来信上下文，不能成为本人人格。
                </p>
                <div>
                  <button
                    className={btnOutlineCls}
                    disabled={busy || !mappingReady}
                    onClick={() =>
                      void perform(
                        '预览问答配对',
                        { action: 'importPreviewMapping', id: preview.id, mapping },
                        result => {
                          setPairs(result as MappingPreview);
                          setMappingSignature(JSON.stringify(mapping));
                        },
                        false,
                      )
                    }
                  >
                    预览问答配对
                  </button>
                </div>
                {pairs && (
                  <div className="knowledge-pair-preview flex flex-col gap-2 rounded-xl border border-border/75 bg-card p-3.5">
                    <p className="text-xs font-medium text-foreground tabular-nums">
                      可导入 {pairs.total} 组问答，预览前 {pairs.pairs.length} 组
                    </p>
                    {pairs.warnings?.map((warning, index) => (
                      <p
                        className="knowledge-warning rounded-lg border border-warning/35 bg-warning/8 px-3 py-1.5 text-xs text-warning-foreground"
                        key={index}
                      >
                        {warning}
                      </p>
                    ))}
                    {pairs.pairs.map((pair, index) => (
                      <dl
                        key={index}
                        className="grid grid-cols-[44px_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-lg bg-muted/35 p-2.5 text-xs"
                      >
                        <dt className="text-muted-foreground">对方</dt>
                        <dd className="text-foreground">{pair.prompt}</dd>
                        <dt className="text-primary">本人</dt>
                        <dd className="text-foreground">{pair.response}</dd>
                      </dl>
                    ))}
                  </div>
                )}
              </>
            )}
            <p className={hintCls}>
              确认后
              {kind === 'KNOWLEDGE'
                ? '保存为停用条目，启用后才供回复使用'
                : '进入待选择样本，采纳后才参与学习'}
              。
            </p>
            <div className="row flex flex-wrap items-center gap-2">
              <button
                className={btnPrimaryCls}
                disabled={busy || !ready}
                onClick={() =>
                  void perform(
                    '确认导入',
                    {
                      action: 'importCommit',
                      id: preview.id,
                      ...(kind === 'CHAT' ? { mapping } : {}),
                    },
                    () => reset(),
                  )
                }
              >
                确认导入
              </button>
              <button
                className={btnOutlineCls}
                disabled={busy}
                onClick={() =>
                  void perform(
                    '取消导入',
                    { action: 'importCancel', id: preview.id },
                    () => reset(),
                    false,
                  )
                }
              >
                取消导入
              </button>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
