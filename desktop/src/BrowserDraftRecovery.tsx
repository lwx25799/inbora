import { useEffect, useRef, useState } from 'react';
import { request, reasons, type BrowserDraftChoice } from './api';

const btnOutlineCls =
  'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-input bg-popover px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32';
const btnWarnCls =
  'inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-warning/40 bg-warning/10 px-3 text-xs font-medium text-warning-foreground shadow-xs/5 transition-colors hover:bg-warning/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55';

export function BrowserDraftRecovery({
  busy,
  act,
}: {
  busy: string;
  act: (label: string, run: () => Promise<void>) => Promise<void>;
}) {
  const [choice, setChoice] = useState<BrowserDraftChoice | null>(null),
    [message, setMessage] = useState('正在检查当前网页未发送内容…');
  const sequence = useRef(0),
    mounted = useRef(false),
    stopAutomatic = useRef(false);
  useEffect(() => {
    mounted.current = true;
    stopAutomatic.current = false;
    let attempts = 0,
      timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      if (!mounted.current || stopAutomatic.current) return;
      const id = ++sequence.current;
      attempts++;
      setMessage('正在检查当前网页未发送内容…');
      try {
        const value = await request<BrowserDraftChoice | null>({
          command: 'browser',
          action: 'inspectSavedDraftRecovery',
        });
        if (!mounted.current || id !== sequence.current) return;
        setChoice(value);
        setMessage(value ? '' : '当前没有可安全清理的已保存自动回复稿，网页输入已保留。');
        if (value) stopAutomatic.current = true;
      } catch {
        if (mounted.current && id === sequence.current)
          setMessage('暂时无法核对当前网页未发送内容，应用回复稿和网页输入均已保留。');
      }
      if (mounted.current && id === sequence.current && !stopAutomatic.current && attempts < 4)
        timer = setTimeout(() => void check(), 15_000);
    };
    void check();
    return () => {
      mounted.current = false;
      sequence.current++;
      clearTimeout(timer);
    };
  }, []);
  return (
    <section
      aria-label="网页未发送内容恢复"
      className="flex flex-col gap-3 rounded-xl border border-border/80 bg-card p-4"
    >
      <h3 className="font-heading text-[13.5px] font-semibold text-foreground">
        网页未发送内容恢复
      </h3>
      <p className="hint text-xs leading-relaxed text-muted-foreground">
        保留已保存的应用回复草稿和版本，仅清空当前准确会话中与该自动回复稿完全一致的网页未发送内容；不会发送或重试。
      </p>
      {choice && (
        <div className="flex flex-col gap-2.5 rounded-xl border border-warning/35 bg-warning/6 p-3.5">
          <p className="text-xs font-medium text-foreground">
            私信 · {choice.author ?? '当前会话'} · 已保存版本 {choice.draftVersion}
          </p>
          <blockquote className="rounded-lg border border-border/70 bg-background px-3 py-2 text-xs text-muted-foreground">
            {choice.originalText}
          </blockquote>
          <p className="message-text rounded-lg bg-muted/40 px-3 py-2 text-[13px] leading-relaxed text-foreground">
            {choice.text}
          </p>
          <div>
            <button
              className={btnWarnCls}
              disabled={!!busy}
              onClick={() =>
                void act('清空网页未发送内容', async () => {
                  stopAutomatic.current = true;
                  const id = ++sequence.current;
                  try {
                    await request({
                      command: 'browser',
                      action: 'clearSavedDraftRecovery',
                      eventId: choice.eventId,
                      draftId: choice.draftId,
                      draftVersion: choice.draftVersion,
                      expectedText: choice.text,
                      contextVersion: choice.contextVersion,
                      confirmed: true,
                    });
                    if (mounted.current && id === sequence.current) {
                      setChoice(null);
                      setMessage('网页未发送内容已清空，应用回复草稿和版本已保留；未发送或重试。');
                    }
                  } catch (error) {
                    const code =
                      typeof error === 'string'
                        ? error
                        : error instanceof Error
                          ? error.message
                          : '';
                    if (mounted.current && id === sequence.current)
                      setMessage(
                        reasons[code] ??
                          '未能安全清理网页内容，应用回复稿和网页输入已保留，请重新检查。',
                      );
                    throw error;
                  }
                })
              }
            >
              保留应用回复稿并清空网页未发送内容
            </button>
          </div>
        </div>
      )}
      {message && (
        <p className="hint text-xs leading-relaxed text-muted-foreground" role="status">
          {message}
        </p>
      )}
      <div>
        <button
          className={btnOutlineCls}
          disabled={!!busy}
          onClick={() =>
            void act('检查网页未发送内容', async () => {
              stopAutomatic.current = true;
              const id = ++sequence.current,
                value = await request<BrowserDraftChoice | null>({
                  command: 'browser',
                  action: 'inspectSavedDraftRecovery',
                });
              if (mounted.current && id === sequence.current) {
                setChoice(value);
                setMessage(value ? '' : '当前没有可安全清理的已保存自动回复稿，网页输入已保留。');
              }
            })
          }
        >
          重新检查网页未发送内容
        </button>
      </div>
    </section>
  );
}
