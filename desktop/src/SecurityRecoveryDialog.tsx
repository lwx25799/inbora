import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { ShieldCheckIcon } from 'lucide-react';
import { request, type Status } from './api';
import type {
  ManualRecoveryFrame,
  ManualRecoverySession,
  ManualRecoveryCommand,
} from '../../src/contracts/manual-recovery.js';
import { recoveryError, recoveryPoint } from './security-recovery-input';
import { cn } from './lib/utils';

type RecoveryInput = Extract<ManualRecoveryCommand, { action: 'input' }>['input'];
type QueuedInput = { input: RecoveryInput; frameId: string; completed?: () => void };
const allowedKeys = new Set(['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter']);

export function SecurityRecoveryDialog({
  session,
  update,
  onClosed,
}: {
  session: ManualRecoverySession;
  update: (status: Status) => void;
  onClosed: () => void;
}) {
  const [frame, setFrame] = useState<ManualRecoveryFrame | null>(null);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [text, setText] = useState('');
  const dialog = useRef<HTMLElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const displayed = useRef<ManualRecoveryFrame | null>(null);
  const active = useRef(true);
  const stopped = useRef(false);
  const finalized = useRef(false);
  const finalizing = useRef(false);
  const sequence = useRef(0);
  const pointer = useRef<number | null>(null);
  const queue = useRef<QueuedInput[]>([]);
  const sending = useRef(false);
  const lastMove = useRef(0);
  const moveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingMove = useRef<QueuedInput | null>(null);
  const closeAction = useRef<() => void>(() => {});
  const submittingText = useRef(false);
  const [textSubmitting, setTextSubmitting] = useState(false);

  const fail = (cause: unknown) => {
    stopped.current = true;
    queue.current = [];
    pendingMove.current = null;
    submittingText.current = false;
    if (moveTimer.current) clearTimeout(moveTimer.current);
    if (active.current) {
      setTextSubmitting(false);
      setError(recoveryError(cause));
    }
  };

  const drain = async () => {
    if (sending.current || stopped.current || !active.current) return;
    sending.current = true;
    try {
      while (queue.current.length && !stopped.current && active.current) {
        const item = queue.current.shift()!;
        await request({
          command: 'securityRecovery',
          action: 'input',
          sessionId: session.sessionId,
          frameId: item.frameId,
          sequence: ++sequence.current,
          input: item.input,
        });
        if (active.current) item.completed?.();
      }
    } catch (cause) {
      fail(cause);
    } finally {
      sending.current = false;
    }
  };

  const enqueue = (item: QueuedInput): boolean => {
    if (stopped.current || !active.current || finalized.current || finalizing.current) return false;
    const last = queue.current.at(-1);
    if (
      item.input.kind === 'pointer' &&
      item.input.phase === 'move' &&
      last?.input.kind === 'pointer' &&
      last.input.phase === 'move'
    ) {
      queue.current[queue.current.length - 1] = item;
    } else if (queue.current.length < 8) {
      queue.current.push(item);
    } else {
      fail('MANUAL_RECOVERY_INPUT_QUEUE_FULL');
      void closeAction.current();
      return false;
    }
    void drain();
    return true;
  };

  const flushMove = () => {
    if (moveTimer.current) clearTimeout(moveTimer.current);
    moveTimer.current = undefined;
    const item = pendingMove.current;
    pendingMove.current = null;
    if (item) {
      lastMove.current = performance.now();
      enqueue(item);
    }
  };

  const input = (value: RecoveryInput, completed?: () => void): boolean => {
    const current = displayed.current;
    if (!current || Date.now() > current.expiresAt) {
      fail('MANUAL_RECOVERY_FRAME_EXPIRED');
      return false;
    }
    flushMove();
    return enqueue({ input: value, frameId: current.frameId, completed });
  };

  const pointerInput = (event: ReactPointerEvent<HTMLImageElement>, phase: 'down' | 'move' | 'up') => {
    if (stopped.current || finalized.current || finalizing.current || (event.button !== 0 && phase === 'down')) {
      return;
    }
    if (phase !== 'down' && pointer.current !== event.pointerId) return;
    const current = displayed.current;
    const box = image.current?.getBoundingClientRect();
    const point = current && box ? recoveryPoint(current, box, event.clientX, event.clientY) : null;
    event.preventDefault();
    if (!point) {
      if (pointer.current !== null) void closeAction.current();
      return;
    }
    if (phase === 'down') {
      if (pointer.current !== null) return;
      pointer.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
    }
    const item: QueuedInput = { input: { kind: 'pointer', phase, ...point }, frameId: current!.frameId };
    if (phase === 'move') {
      pendingMove.current = item;
      if (!moveTimer.current) {
        const remaining = Math.max(0, 50 - (performance.now() - lastMove.current));
        moveTimer.current = setTimeout(flushMove, remaining);
      }
    } else {
      flushMove();
      enqueue(item);
      if (phase === 'up') {
        pointer.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }
    }
  };

  const close = async () => {
    if (finalized.current) return;
    finalized.current = true;
    stopped.current = true;
    queue.current = [];
    pendingMove.current = null;
    if (moveTimer.current) clearTimeout(moveTimer.current);
    if (active.current) setClosing(true);
    try {
      const status = await request<Status>({
        command: 'securityRecovery',
        action: 'close',
        sessionId: session.sessionId,
      });
      update(status);
      if (active.current) onClosed();
    } catch (cause) {
      if (active.current) {
        finalized.current = false;
        setClosing(false);
        setError(recoveryError(cause));
      }
    }
  };
  closeAction.current = () => {
    void close();
  };

  const finish = async () => {
    if (finishing || finalized.current) return;
    if (pointer.current !== null) {
      setError('请先松开画面中的拖动，再完成核验。');
      return;
    }
    finalizing.current = true;
    setFinishing(true);
    if (moveTimer.current) clearTimeout(moveTimer.current);
    try {
      // A submitted human input completes before verification; it is never replayed.
      const deadline = Date.now() + 5000;
      while (sending.current || queue.current.length) {
        if (Date.now() > deadline) throw Error('MANUAL_RECOVERY_INPUT_TIMEOUT');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      stopped.current = true;
      pendingMove.current = null;
      const status = await request<Status>({
        command: 'securityRecovery',
        action: 'finish',
        sessionId: session.sessionId,
      });
      finalized.current = true;
      update(status);
      onClosed();
    } catch (cause) {
      fail(cause);
      setFinishing(false);
    }
  };

  useEffect(() => {
    // Identical consecutive images do not dispatch another load event.
    if (frame && image.current?.complete && image.current.naturalWidth > 0 && image.current.getAttribute('src') === frame.image) {
      displayed.current = frame;
    }
  }, [frame]);

  const keyInput = (event: ReactKeyboardEvent<HTMLImageElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      void close();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || !allowedKeys.has(event.key)) return;
    event.preventDefault();
    input({ kind: 'key', key: event.key as Extract<RecoveryInput, { kind: 'key' }>['key'] });
  };

  const dialogKeys = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      void close();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(
      dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? [],
    );
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const previousFocus = document.activeElement as HTMLElement | null;
    active.current = true;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const poll = async () => {
      if (stopped.current || finalized.current) return;
      try {
        const next = await request<ManualRecoveryFrame>({
          command: 'securityRecovery',
          action: 'frame',
          sessionId: session.sessionId,
        });
        if (active.current && !stopped.current) setFrame(next);
      } catch (cause) {
        fail(cause);
      }
      if (active.current && !stopped.current) timer = setTimeout(() => void poll(), 500);
    };
    void poll();
    // Do not close on window blur or visibility change so switching apps for SMS codes or IME focus never drops the session.
    const pageHide = () => closeAction.current();
    window.addEventListener('pagehide', pageHide);
    return () => {
      active.current = false;
      stopped.current = true;
      submittingText.current = false;
      if (timer) clearTimeout(timer);
      if (moveTimer.current) clearTimeout(moveTimer.current);
      window.removeEventListener('pagehide', pageHide);
      queue.current = [];
      pendingMove.current = null;
      if (previousFocus?.isConnected) previousFocus.focus();
      if (!finalized.current) {
        finalized.current = true;
        void request({ command: 'securityRecovery', action: 'close', sessionId: session.sessionId }).catch(() => {});
      }
    };
  }, [session.sessionId]);

  const submitCodeText = () => {
    if (!text || !frame || !!error || closing || finishing || submittingText.current) return;
    submittingText.current = true;
    setTextSubmitting(true);
    const submitted = text;
    const accepted = input({ kind: 'text', text: submitted }, () => {
      submittingText.current = false;
      setTextSubmitting(false);
      setText(current => (current === submitted ? '' : current));
    });
    if (!accepted) {
      submittingText.current = false;
      setTextSubmitting(false);
    }
  };

  return (
    <div className="security-recovery-backdrop fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-5 backdrop-blur-[2px] max-[700px]:p-2">
      <section
        ref={dialog}
        className="security-recovery-dialog flex max-h-[calc(100vh-40px)] w-[min(1180px,100%)] flex-col gap-3 rounded-2xl border border-border bg-card p-5 text-foreground shadow-2xl max-[700px]:max-h-[calc(100vh-16px)] max-[700px]:p-3.5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="security-recovery-title"
        onKeyDown={dialogKeys}
      >
        <div className="security-recovery-heading flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border/80 pb-3">
          <div className="flex items-center gap-2">
            <ShieldCheckIcon aria-hidden="true" className="size-4.5 shrink-0 text-primary" />
            <h2 id="security-recovery-title" className="font-heading text-base font-semibold text-foreground">
              {session.recreated ? '处理当前验证页面' : '处理原验证页面'}
            </h2>
          </div>
          <button
            type="button"
            disabled={closing || finishing}
            onClick={() => void close()}
            aria-label="关闭验证页面"
            className="inline-flex h-7.5 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-input bg-card px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32"
          >
            关闭
          </button>
        </div>

        <div className="shrink-0 space-y-1">
          <p className="text-[13px] leading-relaxed text-foreground">
            {session.recreated
              ? '原现场已丢失，这是在原授权地址重新检查后出现的新验证。'
              : '这是' + (session.channel === 'DIRECT_MESSAGE' ? '私信' : '评论') + '原无头页面的实时画面。'}
            请在画面内完成验证，可点击或拖动；处理期间后台浏览器操作暂停。
          </p>
          <p className="security-recovery-note text-xs text-muted-foreground">
            关闭后保留当前拦截；完成验证后点击“完成并核验”。
          </p>
        </div>

        {error && (
          <p
            className="security-recovery-error shrink-0 rounded-xl border border-destructive/30 bg-destructive/8 px-3.5 py-2 text-xs text-destructive-foreground"
            role="alert"
          >
            {error}
          </p>
        )}

        <div
          className="security-recovery-viewport min-h-[140px] flex-1 overflow-auto rounded-xl border border-border bg-muted/65"
          aria-busy={!frame}
        >
          {frame ? (
            <img
              ref={image}
              src={frame.image}
              alt="原验证页面实时画面"
              width={frame.width}
              height={frame.height}
              draggable={false}
              tabIndex={0}
              className={cn(
                'security-recovery-image block h-auto w-full select-none touch-none outline-offset-[-3px] focus-visible:outline-2 focus-visible:outline-primary',
                error ? 'blocked cursor-default opacity-70' : 'cursor-crosshair',
              )}
              onLoad={() => {
                displayed.current = frame;
              }}
              onPointerDown={event => pointerInput(event, 'down')}
              onPointerMove={event => pointerInput(event, 'move')}
              onPointerUp={event => pointerInput(event, 'up')}
              onPointerCancel={() => void close()}
              onLostPointerCapture={() => {
                if (pointer.current !== null) void close();
              }}
              onKeyDown={keyInput}
              onContextMenu={event => event.preventDefault()}
            />
          ) : (
            <p className="flex h-full min-h-[140px] items-center justify-center text-xs text-muted-foreground">
              正在取得原页面画面…
            </p>
          )}
        </div>

        <div className="security-recovery-text flex shrink-0 flex-wrap items-center gap-2.5 rounded-xl border border-border/80 bg-muted/35 px-3 py-2.5">
          <label htmlFor="security-recovery-code" className="shrink-0 text-xs font-medium text-foreground">
            文字验证码
          </label>
          <input
            id="security-recovery-code"
            value={text}
            maxLength={100}
            autoComplete="off"
            disabled={!!error || closing || finishing || textSubmitting}
            onChange={event => setText(event.target.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                submitCodeText();
              }
            }}
            placeholder="先在画面中点击验证码输入框，输入后按 Enter 提交"
            className="h-8 min-w-[180px] flex-1 rounded-lg border border-input bg-card px-2.5 text-sm text-foreground shadow-xs/5 outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-55 dark:bg-input/32"
          />
          <button
            type="button"
            disabled={!text || !frame || !!error || closing || finishing || textSubmitting}
            onClick={submitCodeText}
            className="inline-flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-input bg-card px-3 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32"
          >
            输入到验证框
          </button>
        </div>

        <div className="security-recovery-actions flex shrink-0 flex-wrap items-center justify-end gap-2.5 border-t border-border/80 pt-3">
          <button
            type="button"
            disabled={!frame || closing || finishing}
            onClick={() => void finish()}
            className="inline-flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-primary bg-primary px-4 text-xs font-medium text-primary-foreground shadow-xs shadow-primary/20 transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-55"
          >
            {finishing ? '正在核验…' : '完成并核验'}
          </button>
          <button
            type="button"
            disabled={closing || finishing}
            onClick={() => void close()}
            className="inline-flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-input bg-card px-3.5 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32"
          >
            暂不处理
          </button>
        </div>
      </section>
    </div>
  );
}
