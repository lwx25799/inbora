import { useEffect, useRef, type ReactNode } from 'react';

/** Keep fields mounted so closing an editor never discards its unsaved React state. */
export function SettingsDialog({
  title,
  open,
  onClose,
  busy = '',
  error = '',
  notice = '',
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  busy?: string;
  error?: string;
  notice?: string;
  children: ReactNode;
}) {
  const element = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !element.current?.open) element.current?.showModal();
    if (!open && element.current?.open) element.current.close();
  }, [open]);

  return (
    <dialog
      ref={element}
      className="settings-dialog m-auto max-h-[86vh] w-[min(640px,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-border bg-card p-0 text-card-foreground shadow-xl backdrop:bg-foreground/30 backdrop:backdrop-blur-[2px] open:flex open:flex-col"
      aria-label={title}
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-heading flex items-center justify-between gap-3 border-b border-border/80 bg-muted/35 px-5 py-3.5">
        <h2 className="font-heading text-[15px] font-semibold text-foreground">{title}</h2>
        <button
          type="button"
          className="inline-flex h-7.5 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-input bg-popover px-2.5 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onClose}
        >
          关闭并保留输入
        </button>
      </div>
      <div className="flex flex-col gap-3.5 p-5">
        {(error || notice || busy) && (
          <p
            className={
              error
                ? 'dialog-feedback error rounded-xl border border-destructive/30 bg-destructive/6 px-3.5 py-2.5 text-xs font-medium text-destructive-foreground'
                : 'dialog-feedback rounded-xl border border-primary/25 bg-primary/[0.06] px-3.5 py-2.5 text-xs font-medium text-foreground'
            }
            role={error ? 'alert' : 'status'}
          >
            {error || busy || notice}
          </p>
        )}
        {children}
      </div>
    </dialog>
  );
}
