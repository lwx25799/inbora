import { useEffect, useState } from 'react';
import type * as React from 'react';
import {
  FolderOpenIcon,
  LogOutIcon,
  MoonIcon,
  OctagonAlertIcon,
  PaletteIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SunIcon,
} from 'lucide-react';
import { BrowserDraftRecovery } from '@/BrowserDraftRecovery';
import { LocalAssistantSettings } from '@/LocalAssistantSettings';
import { PageHeader } from '@/components/PageHeader';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { closeDesktop, request, type Status } from '@/api';

export interface SystemSettingsViewProps {
  status: Status;
  runtime: string;
  busy: string;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  act: (label: string, fn: () => Promise<void>) => Promise<void>;
  update: (status: Status) => void;
  stop: () => void;
  reconnect: () => Promise<void>;
}

export function SystemSettingsView({
  status,
  runtime,
  busy,
  theme,
  onToggleTheme,
  act,
  update,
  stop,
  reconnect,
}: SystemSettingsViewProps): React.ReactElement {
  const emergencyStopped = Boolean(status.automation?.emergencyStopped);
  const [faultOpen, setFaultOpen] = useState(emergencyStopped);

  useEffect(() => {
    if (emergencyStopped) setFaultOpen(true);
  }, [emergencyStopped]);

  return (
    <div className="mx-auto max-w-[1160px] space-y-5 px-6 py-5">
      <PageHeader
        title="系统设置"
        description="管理本机助手连接（MCP）、外观主题与快捷键、运行目录安全退出以及独立的故障处理与全局急停"
      />

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
        {/* Appearance & Shortcuts */}
        <CardFrame>
          <CardFrameHeader>
            <CardFrameTitle>外观主题与快捷键</CardFrameTitle>
            <CardFrameDescription>
              暖白纸感浅色与深松夜览双主题，采用全离线可变屏幕字体
            </CardFrameDescription>
            <CardFrameAction>
              <PaletteIcon className="size-4 text-primary" />
            </CardFrameAction>
          </CardFrameHeader>
          <Card className="space-y-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-[13.5px] font-medium text-foreground">界面主题</div>
                <div className="text-xs text-muted-foreground">
                  当前：{theme === 'light' ? '暖白纸感（浅色）' : '深松夜览（深色）'}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant={theme === 'light' ? 'default' : 'outline'}
                  onClick={() => {
                    if (theme !== 'light') onToggleTheme();
                  }}
                >
                  <SunIcon />
                  暖白纸感
                </Button>
                <Button
                  size="sm"
                  variant={theme === 'dark' ? 'default' : 'outline'}
                  onClick={() => {
                    if (theme !== 'dark') onToggleTheme();
                  }}
                >
                  <MoonIcon />
                  深松夜览
                </Button>
              </div>
            </div>

            <Separator />

            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">展开 / 收起左侧导航栏</span>
                <kbd className="rounded border border-border bg-muted px-2 py-0.5 font-mono text-[11px] text-foreground">
                  Ctrl + B
                </kbd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">会话中心确认发送当前全文</span>
                <kbd className="rounded border border-border bg-muted px-2 py-0.5 font-mono text-[11px] text-foreground">
                  Ctrl + Enter
                </kbd>
              </div>
            </div>
          </Card>
        </CardFrame>

        {/* Runtime Directory, Reconnect & Safe Exit */}
        <CardFrame>
          <CardFrameHeader>
            <CardFrameTitle>私有运行目录与本地内核</CardFrameTitle>
            <CardFrameDescription>
              账号资料、草稿与审计记录仅存于本机运行目录，网络为本机直连
            </CardFrameDescription>
            <CardFrameAction>
              <FolderOpenIcon className="size-4 text-primary" />
            </CardFrameAction>
          </CardFrameHeader>
          <Card className="space-y-4 p-5 text-xs">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span className="shrink-0 text-muted-foreground">数据目录</span>
                <code className="min-w-0 truncate rounded bg-muted px-2 py-0.5 font-mono text-[11.5px] text-foreground" title={runtime}>
                  {runtime}
                </code>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">本地库结构</span>
                <Badge variant="outline" size="sm" className="font-mono">
                  schema{status.schema}
                </Badge>
              </div>
            </div>

            <p className="leading-relaxed text-muted-foreground">
              网络为本机直连。日常采用无头运行，平台安全验证优先在客户端内直接操作原无头页面完成；仅遇重新登录等情况时可临时打开有头浏览器处理，所有网页自启动即静音。
            </p>

            <Separator />

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!!busy}
                onClick={() => void act('重新连接内核', reconnect)}
              >
                <RefreshCwIcon />
                重新连接内核
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void closeDesktop().catch(() => {})}
              >
                <LogOutIcon />
                退出工作台并保留数据
              </Button>
            </div>
          </Card>
        </CardFrame>
      </div>

      {/* Local Assistant (MCP 16 tools) */}
      <LocalAssistantSettings
        key={`${status.account?.identity ?? 'none'}:${status.localAssistant?.grant?.version ?? 'none'}`}
        status={status}
        busy={busy}
        act={act}
        update={update}
      />

      {/* Collapsed Fault Recovery & Emergency Stop (auto-opens when emergencyStopped) */}
      <details
        className="fault-controls rounded-2xl border border-destructive/25 bg-card p-5 shadow-xs/5"
        open={faultOpen}
        onToggle={e => setFaultOpen(e.currentTarget.open)}
      >
        <summary
          className="flex cursor-pointer list-none items-center justify-between gap-3 select-none"
          onClick={e => {
            e.preventDefault();
            setFaultOpen(open => !open);
          }}
        >
          <div className="flex items-center gap-2.5">
            <OctagonAlertIcon className="size-4 text-destructive" />
            <div>
              <span className="font-heading text-[15px] font-semibold text-foreground">
                故障处理与全局急停
              </span>
              <p className="text-xs text-muted-foreground">
                网页未发送内容核对清理，以及独立的全局急停与显式恢复入口
              </p>
            </div>
          </div>
          <Badge variant={emergencyStopped ? 'error' : 'outline'} size="sm">
            {emergencyStopped ? '急停生效中' : faultOpen ? '收起' : '按需展开'}
          </Badge>
        </summary>

        {faultOpen && (
          <div className="mt-4 space-y-4 border-t border-border/75 pt-4">
            <BrowserDraftRecovery busy={busy} act={act} />

            {emergencyStopped ? (
              <Alert variant="error">
                <OctagonAlertIcon />
                <AlertTitle>全局急停已持久生效</AlertTitle>
                <AlertDescription>
                  所有后台收取、模型调用与自动外发均已停止；已提交消息继续只读核对，不会撤回或重发。重启或保存配置均不会自动解除急停。
                </AlertDescription>
              </Alert>
            ) : (
              <Alert variant="success">
                <ShieldCheckIcon />
                <AlertTitle>当前运行正常，未触发全局急停</AlertTitle>
                <AlertDescription>
                  仅在需要立刻停止全部后台操作时使用。急停会停止收取、模型和发送；已提交消息不会撤回或重复发送。
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="destructive" size="sm" onClick={stop}>
                <OctagonAlertIcon />
                全局急停
              </Button>
              {emergencyStopped && (
                <Button
                  size="sm"
                  disabled={!!busy}
                  onClick={() =>
                    void act('检查并恢复运行', async () => {
                      if (status.browser.loginRecovery || status.browser.mode === 'headed') {
                        update(
                          await request<Status>({
                            command: 'browser',
                            open: true,
                            mode: 'headless',
                          }),
                        );
                      }
                      update(await request<Status>({ command: 'resume', eventId: null }));
                    })
                  }
                >
                  恢复运行
                </Button>
              )}
            </div>
          </div>
        )}
      </details>
    </div>
  );
}
