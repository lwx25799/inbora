import { useEffect, useRef, useState } from 'react';
import { request, type TimelineItem } from './api';
import type { MessagePreviewData } from '../../src/contracts/inbox.js';

const mediaPlaceholders = {
  IMAGE: '[图片或表情消息，需人工查看]',
  VIDEO: '[视频消息，需人工查看]',
  AUDIO: '[音频消息，需人工查看]',
  MIXED: '[含媒体的消息，需人工查看]',
};

export const isMediaPlaceholder = (text: string, contentType?: TimelineItem['contentType']) =>
  contentType ? text === mediaPlaceholders[contentType] : Object.values(mediaPlaceholders).includes(text);

export function MessageAttachments({
  message,
  allowRefresh = true,
}: {
  message: Pick<TimelineItem, 'eventId' | 'attachments'> &
    Partial<Pick<TimelineItem, 'contentType' | 'observationIssue'>>;
  allowRefresh?: boolean;
}) {
  const [images, setImages] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const pending = useRef<string | null>(null);
  const current = useRef(message.eventId);
  current.current = message.eventId;
  const attachments = message.attachments ?? [];
  const identity = JSON.stringify(attachments.map(item => [item.previewId, item.state, item.reason]));

  useEffect(() => {
    let cancelled = false;
    setImages({});
    setFailed({});
    setNotice('');
    for (const attachment of attachments.slice(0, 4)) {
      if (attachment.state !== 'READY' || !attachment.previewId) continue;
      const previewId = attachment.previewId;
      void request<MessagePreviewData>({ command: 'getMessagePreview', eventId: message.eventId, previewId })
        .then(image => {
          if (cancelled) return;
          if (
            image.previewId !== previewId ||
            image.mime !== 'image/png' ||
            image.dataUrl.length > 220000 ||
            !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image.dataUrl) ||
            image.width < 1 ||
            image.width > 512 ||
            image.height < 1 ||
            image.height > 512
          ) {
            setFailed(previous => ({ ...previous, [previewId]: true }));
            return;
          }
          setImages(previous => ({ ...previous, [previewId]: image.dataUrl }));
        })
        .catch(() => {
          if (!cancelled) setFailed(previous => ({ ...previous, [previewId]: true }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [message.eventId, identity]);

  const ready = attachments
    .slice(0, 4)
    .filter(attachment => attachment.state === 'READY' && attachment.previewId && !failed[attachment.previewId]);
  const unavailable = attachments
    .slice(0, 4)
    .some(attachment => attachment.state !== 'READY' || !attachment.previewId || failed[attachment.previewId]);
  const missing =
    unavailable ||
    (attachments.length === 0 &&
      message.observationIssue === 'DM_CONTENT_UNVERIFIED' &&
      ['IMAGE', 'MIXED'].includes(message.contentType ?? ''));
  const shareUnavailable = attachments.some(attachment => attachment.reason === 'MESSAGE_PREVIEW_SHARE_LINK_UNVERIFIED');
  const identified = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(message.eventId);

  async function refresh() {
    const eventId = message.eventId;
    if (pending.current === eventId || !identified) return;
    pending.current = eventId;
    setRefreshing(eventId);
    setNotice('');
    try {
      const result = await request<{ scheduled: boolean }>({ command: 'getMessagePreview', eventId, refresh: true });
      if (current.current === eventId) {
        setNotice(result.scheduled ? '已请求更新预览，结果会自动显示' : '暂时无法更新，请稍后再试');
      }
    } catch {
      if (current.current === eventId) setNotice('暂时无法更新，请稍后再试');
    } finally {
      if (pending.current === eventId) pending.current = null;
      if (current.current === eventId) setRefreshing(null);
    }
  }

  return (
    <div className="message-attachments mt-2 flex flex-wrap items-center gap-2 empty:hidden [.task_&]:mt-1">
      {ready.map((attachment, index) => (
        <figure key={attachment.previewId ?? index} className="m-0 max-w-full space-y-1">
          {attachment.previewId && images[attachment.previewId] ? (
            <img
              src={images[attachment.previewId]}
              alt={attachment.label || '私信图片预览'}
              className="block max-h-[180px] max-w-[min(240px,100%)] rounded-lg border border-border/75 bg-muted/40 object-contain shadow-xs/5 [.task_&]:max-h-10 [.task_&]:max-w-12 [.task_&]:rounded-md"
            />
          ) : (
            <span className="attachment-loading inline-flex items-center rounded-lg border border-dashed border-input bg-card/90 px-2.5 py-1.5 text-[11px] text-muted-foreground">
              正在读取图片预览
            </span>
          )}
          {attachment.label && (
            <figcaption className="text-[11px] text-muted-foreground [.task_&]:hidden">{attachment.label}</figcaption>
          )}
        </figure>
      ))}
      {missing && (
        <>
          <span className="attachment-unavailable inline-flex items-center rounded-md border border-border/75 bg-card/90 px-2 py-0.5 text-[11px] text-muted-foreground">
            {shareUnavailable ? '分享作品链接暂未取得' : '消息预览暂不可用'}
          </span>
          {allowRefresh &&
            (identified ? (
              <button
                type="button"
                disabled={refreshing === message.eventId}
                onClick={event => {
                  event.stopPropagation();
                  void refresh();
                }}
                className="inline-flex h-6.5 shrink-0 cursor-pointer items-center justify-center rounded-md border border-input bg-card px-2 text-[11.5px] font-medium text-foreground shadow-xs/5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 dark:bg-input/32 dark:hover:bg-input/55"
              >
                更新预览
              </button>
            ) : (
              <small className="text-[11px] text-muted-foreground">消息身份暂不可核对，无法更新预览</small>
            ))}
        </>
      )}
      {notice && (
        <small role="status" className="text-[11px] text-muted-foreground">
          {notice}
        </small>
      )}
    </div>
  );
}
