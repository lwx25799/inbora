import type { ReplyStatus, Status } from './api';

export function replyStatusLabel(status: ReplyStatus): string {
  return status === 'REPLIED'
    ? '已回复'
    : status === 'NOT_REQUIRED'
      ? '可人工回复'
      : status === 'MANUAL_ONLY'
        ? '需人工查看'
        : '等待回复';
}

export function time(value: string | number | null | undefined) {
  return value
    ? new Date(value).toLocaleString('zh-CN', { hour12: false })
    : '尚无成功记录';
}

/** Compact timestamp for dense inbox rows and cards; pair with full `time()` in `title`. */
export function compactTime(value: string | number | null | undefined): string {
  if (!value) return '尚无记录';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '尚无记录';
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return hhmm;
  }
  const mmdd = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (date.getFullYear() === now.getFullYear()) return `${mmdd} ${hhmm}`;
  return `${date.getFullYear()}-${mmdd} ${hhmm}`;
}

const SYNC_SOURCE_NAMES: Record<'works' | 'dm', string> = {
  works: '评论',
  dm: '私信',
};

export function formatSyncLabel(sync: Status['sync']): string {
  if (!sync.running) return '同步收件箱';
  if (sync.cancelled) return '正在结束同步…';
  if (sync.source) return `正在同步${SYNC_SOURCE_NAMES[sync.source]}…`;
  return '正在启动同步…';
}

export function budgetKindLabel(kind: string): string {
  const upper = kind.toUpperCase();
  if (upper === 'MODEL') return '模型';
  if (upper === 'SEND') return '发送';
  return kind;
}

export function formatBudgetLimit(maximum: number | null): string {
  return maximum === null ? '无上限' : String(maximum);
}

export const modes = {
  OBSERVE: '只读观察',
  DRAFT_ONLY: '仅保存草稿',
  MANUAL: '纯人工回复',
  AI_ASSISTED: 'AI 辅助回复',
  LIMITED_AUTO: '规则自动回复',
};

export function browserState(state: string, stopped = false) {
  if (state === 'MANUAL_VISIBLE') return '登录窗口已打开，返回后台静音运行后继续后台处理';
  if (state === 'MANUAL_VISIBLE_PENDING') return '可见窗口尚未打开，网页内容已保留';
  if (state === 'LOGIN_RECOVERY') return '等待本人登录，完成后自动恢复后台静音运行';
  if (state === 'CLOSED') return stopped ? '已关闭（已急停）' : '正在自动连接';
  if (state === 'STARTING') return '正在启动';
  if (state === 'OPEN_LAST_READ_VERIFIED') return '已连接';
  if (state === 'OPEN_IDENTITY_UNVERIFIED') return '已打开';
  if (state === 'BROWSER_START_FAILED') return '启动未完成，后台重试中';
  return '正在更新连接状态';
}
