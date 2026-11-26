import { useState } from 'react';
import { ImagesIcon, PlayIcon } from 'lucide-react';

export interface SharedWork {
  kind: 'DOUYIN_WORK';
  url: string;
  workId: string;
}

export function validShare(share: SharedWork | undefined): SharedWork | null {
  if (share?.kind !== 'DOUYIN_WORK') return null;
  const match = /^https:\/\/www\.douyin\.com\/(video|note)\/([0-9]{1,64})$/.exec(share.url);
  return match && match[2] === share.workId ? share : null;
}

export const sharedWorkLabel = (share: SharedWork) => (share.url.includes('/note/') ? '图集' : '视频');

export function ShareLink({ share }: { share: SharedWork }) {
  const [notice, setNotice] = useState('');
  const link = validShare(share);
  if (!link) return null;
  const label = sharedWorkLabel(link);
  const isNote = label === '图集';

  async function copy() {
    try {
      await navigator.clipboard.writeText(link!.url);
      setNotice('链接已复制');
    } catch {
      setNotice('请选中链接后复制');
    }
  }

  return (
    <section className="shared-work mt-2 flex w-[min(360px,100%)] flex-col gap-2 rounded-xl border border-border/80 bg-card p-3 text-foreground shadow-xs/5">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary dark:bg-primary/18"
        >
          {isNote ? <ImagesIcon className="size-3.5" /> : <PlayIcon className="size-3.5 fill-current" />}
        </span>
        <strong className="text-xs font-semibold text-foreground">分享{label}</strong>
      </div>
      <input
        aria-label={`分享${label}链接`}
        readOnly
        value={link.url}
        onClick={event => event.currentTarget.select()}
        className="h-7.5 w-full min-w-0 rounded-md border border-input bg-muted/45 px-2.5 font-mono text-[11.5px] text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex h-7 w-fit shrink-0 cursor-pointer items-center justify-center rounded-md border border-input bg-card px-2.5 text-xs font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-input/32 dark:hover:bg-input/55"
        >
          复制{label}链接
        </button>
        {notice && (
          <small role="status" className="text-[11px] font-medium text-success-foreground">
            {notice}
          </small>
        )}
      </div>
    </section>
  );
}
