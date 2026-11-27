import type * as React from "react";
import { AlertCircleIcon, MoonIcon, ShieldCheckIcon, SunIcon } from "lucide-react";
import { BrandTile, BrandWordmark } from "@/components/BrandLogo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardFrame,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export interface ConnectScreenProps {
  runtime: string;
  initialize: boolean;
  consent: boolean;
  busy: string;
  error: string;
  version: string;
  theme?: "light" | "dark";
  onToggleTheme?: () => void;
  onRuntimeChange: (value: string) => void;
  onInitializeChange: (checked: boolean) => void;
  onConsentChange: (checked: boolean) => void;
  onConnect: () => void;
}

export function ConnectScreen({
  runtime,
  initialize,
  consent,
  busy,
  error,
  version,
  theme = "light",
  onToggleTheme,
  onRuntimeChange,
  onInitializeChange,
  onConsentChange,
  onConnect,
}: ConnectScreenProps): React.ReactElement {
  const canConnect = Boolean(runtime) && consent && !busy;

  return (
    <main className="relative flex min-h-screen w-full flex-col items-center justify-center overflow-y-auto bg-sidebar px-6 py-10 text-foreground">
      {onToggleTheme && (
        <div className="fixed top-4 right-5">
          <Button
            variant="outline"
            size="icon-xs"
            aria-label="切换浅色/深色主题"
            title={theme === "dark" ? "切换浅色模式" : "切换深色模式"}
            onClick={onToggleTheme}
          >
            {theme === "dark" ? (
              <SunIcon aria-hidden="true" />
            ) : (
              <MoonIcon aria-hidden="true" />
            )}
          </Button>
        </div>
      )}

      <div className="w-full max-w-[464px] space-y-6">
        {/* Harbor Frame Brand Header */}
        <div className="flex flex-col items-center gap-2.5 text-center">
          <BrandTile size={44} />
          <BrandWordmark height={18} className="text-foreground" />
          <p className="text-xs text-muted-foreground">
            Windows 本地优先 · 多平台智能客服工作台
          </p>
        </div>

        {/* Centered Archival CardFrame */}
        <CardFrame>
          <CardFrameHeader className="gap-y-1.5">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" size="sm">
                本机优先 · 隐私隔离
              </Badge>
            </div>
            <CardFrameTitle
              render={<h1 />}
              className="font-heading text-base text-foreground"
            >
              连接你的本地收件箱
            </CardFrameTitle>
            <CardFrameDescription className="text-xs leading-relaxed">
              评论与私信统一处理。未配置模型 Key 也可以直接人工回复。
            </CardFrameDescription>
          </CardFrameHeader>

          <Card className="p-5">
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (canConnect) onConnect();
              }}
            >
              <div className="space-y-1.5">
                <label
                  htmlFor="connect-runtime"
                  className="block text-xs font-medium text-foreground"
                >
                  私有运行目录
                </label>
                <Input
                  id="connect-runtime"
                  value={runtime}
                  onChange={(event) => onRuntimeChange(event.target.value)}
                  spellCheck={false}
                  className="font-mono text-xs"
                  placeholder="输入本地私有运行目录路径"
                />
              </div>

              <div className="space-y-2">
                <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border/75 bg-muted/35 px-3 py-2.5 text-xs leading-relaxed text-foreground transition-colors hover:border-input">
                  <input
                    type="checkbox"
                    checked={initialize}
                    onChange={(event) => onInitializeChange(event.target.checked)}
                    className="mt-0.5 size-4 shrink-0 cursor-pointer rounded accent-primary"
                  />
                  <span>初始化全新目录（已有资料不勾选）</span>
                </label>

                <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border/75 bg-muted/35 px-3 py-2.5 text-xs leading-relaxed text-foreground transition-colors hover:border-input">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(event) => onConsentChange(event.target.checked)}
                    className="mt-0.5 size-4 shrink-0 cursor-pointer rounded accent-primary"
                  />
                  <span>
                    我确认这是已授权账号的本地运行目录，允许读取并升级数据库
                  </span>
                </label>
              </div>

              <div className="flex items-start gap-2 rounded-xl border border-border/70 bg-background/75 px-3 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
                <ShieldCheckIcon
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0 text-primary"
                />
                <span>
                  升级前会自动验证备份，保留已有记录与额度。连接后恢复已开启的后台收取，仅在你的授权范围内自动发送。
                </span>
              </div>

              {error && (
                <Alert variant="error">
                  <AlertCircleIcon aria-hidden="true" />
                  <AlertDescription className="text-xs text-destructive-foreground">
                    {error}
                  </AlertDescription>
                </Alert>
              )}

              <div className="space-y-1.5">
                <Button
                  type="submit"
                  size="default"
                  className="w-full"
                  disabled={!canConnect}
                >
                  {busy || "连接收件箱"}
                </Button>
                {!canConnect && !busy && (
                  <p className="text-center text-[11px] text-muted-foreground">
                    {!runtime.trim() ? "请先填写本地私有运行目录" : "勾选上方确认后即可连接"}
                  </p>
                )}
              </div>
            </form>
          </Card>
        </CardFrame>

        <p className="text-center text-[11px] text-muted-foreground tabular-nums">
          版本 {version || "读取中"} · 账号资料与对话记录仅保存在本机私有目录
        </p>
      </div>
    </main>
  );
}
