import * as React from "react";
import {
  FolderOpenIcon,
  MoonIcon,
  OctagonAlertIcon,
  PaletteIcon,
  ShieldCheckIcon,
  SunIcon,
  TerminalIcon,
} from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardFrame,
  CardFrameAction,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MCP_TOOLS } from "@/data/mockData";

interface SettingsProps {
  theme: "light" | "dark";
  mcpEnabled: boolean;
  emergencyStopped: boolean;
  onSetTheme: (t: "light" | "dark") => void;
  onToggleMcp: () => void;
  onTriggerEmergency: () => void;
  onRecoverEmergency: () => void;
  onOpenConnectPreview: () => void;
  onNotify: (msg: string) => void;
}

const SECTIONS = [
  { id: "runtime", label: "运行目录与备份", icon: FolderOpenIcon },
  { id: "mcp", label: "本机助手（MCP）", icon: TerminalIcon },
  { id: "privacy", label: "隐私与缓存", icon: ShieldCheckIcon },
  { id: "appearance", label: "外观与快捷键", icon: PaletteIcon },
  { id: "fault", label: "故障处理与急停", icon: OctagonAlertIcon },
] as const;

export function SettingsView({
  theme,
  mcpEnabled,
  emergencyStopped,
  onSetTheme,
  onToggleMcp,
  onTriggerEmergency,
  onRecoverEmergency,
  onOpenConnectPreview,
  onNotify,
}: SettingsProps): React.ReactElement {
  const [section, setSection] = React.useState<(typeof SECTIONS)[number]["id"]>("runtime");
  const [retention, setRetention] = React.useState(14);
  const [cacheLimit, setCacheLimit] = React.useState(80);

  return (
    <div className="mx-auto max-w-[1160px] px-7 py-6">
      <AppHeader
        title="系统设置"
        description="管理本地运行目录、本机 MCP 助手、隐私缓存、界面外观以及独立的全局急停恢复入口"
      />

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[204px_minmax(0,1fr)]">
        <nav className="flex flex-col gap-1" aria-label="设置分类">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const active = section === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setSection(s.id)}
                className={`flex cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="size-4 opacity-80" />
                  {s.label}
                </span>
                {s.id === "fault" && emergencyStopped && (
                  <Badge variant="error" size="sm">急停中</Badge>
                )}
              </button>
            );
          })}
        </nav>

        <div>
          {section === "runtime" && (
            <CardFrame>
              <CardFrameHeader>
                <CardFrameTitle>私有运行目录与数据库备份</CardFrameTitle>
                <CardFrameDescription>
                  账号 Profile、凭据、聊天记录与证据全部仅存本机私有目录，不上传云端
                </CardFrameDescription>
                <CardFrameAction>
                  <Button variant="outline" size="xs" onClick={onOpenConnectPreview}>
                    预览首次连接引导
                  </Button>
                </CardFrameAction>
              </CardFrameHeader>
              <Card className="space-y-4 p-5 text-[13px]">
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">数据保存位置</span>
                    <span className="font-mono text-xs">%LOCALAPPDATA%\inbora</span>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">本地数据存储</span>
                    <span>本地安全数据库 · 自动留痕备份</span>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">数据备份状态</span>
                    <Badge variant="success" size="sm">健康可恢复</Badge>
                  </div>
                </div>
                <Separator />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onNotify("已重新读取本地内核状态，未保存草稿与历史意图完整保留。")
                    }
                  >
                    重新连接内核（只读核对）
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onNotify("备份完整性校验通过；切勿通过删除数据库重置发送记录或额度。")
                    }
                  >
                    校验一致性备份
                  </Button>
                </div>
              </Card>
            </CardFrame>
          )}

          {section === "mcp" && (
            <CardFrame>
              <CardFrameHeader>
                <CardFrameTitle>本机助手连接（MCP · 16 个受控工具）</CardFrameTitle>
                <CardFrameDescription>
                  经 Windows DPAPI 本机鉴权，直接复用客户端账号范围、累计额度与唯一发送通道
                </CardFrameDescription>
                <CardFrameAction>
                  <div className="flex items-center gap-2 text-xs font-medium">
                    <span>{mcpEnabled ? "已启用" : "已停用"}</span>
                    <Switch checked={mcpEnabled} onCheckedChange={onToggleMcp} />
                  </div>
                </CardFrameAction>
              </CardFrameHeader>
              <Card className="overflow-hidden">
                <div className="grid grid-cols-3 divide-x divide-border/70 border-b border-border/70 bg-muted/30 px-4 py-3 text-xs">
                  <div>
                    <div className="text-muted-foreground">规则指纹</div>
                    <div className="mt-0.5 font-mono font-medium">sha256:9f4b2c8e</div>
                  </div>
                  <div className="pl-4">
                    <div className="text-muted-foreground">助手累计模型 / 发送</div>
                    <div className="mt-0.5 font-semibold tabular-nums">42 / 11</div>
                  </div>
                  <div className="pl-4">
                    <div className="text-muted-foreground">重放与权限边界</div>
                    <div className="mt-0.5 font-medium">断线禁重发 · 无恢复急停权</div>
                  </div>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>受控工具名</TableHead>
                      <TableHead>允许范围说明</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {MCP_TOOLS.map(([name, desc]) => (
                      <TableRow key={name}>
                        <TableCell className="font-mono text-xs">{name}</TableCell>
                        <TableCell className="text-muted-foreground">{desc}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            </CardFrame>
          )}

          {section === "privacy" && (
            <CardFrame>
              <CardFrameHeader>
                <CardFrameTitle>隐私边界与预览缓存维护</CardFrameTitle>
                <CardFrameDescription>
                  图片与表情预览由原专属浏览器生成本机受限 PNG，绝不将原始 URL 暴露给前端或模型
                </CardFrameDescription>
              </CardFrameHeader>
              <Card className="space-y-4 p-5">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">证据与预览保留期（天）</label>
                    <Input
                      type="number"
                      value={retention}
                      onChange={(e) => setRetention(Number(e.target.value))}
                      className="tabular-nums"
                    />
                    <p className="text-[11.5px] text-muted-foreground">默认 14 天，最多 500 清单</p>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">预览缓存上限（MiB）</label>
                    <Input
                      type="number"
                      value={cacheLimit}
                      onChange={(e) => setCacheLimit(Number(e.target.value))}
                      className="tabular-nums"
                    />
                    <p className="text-[11.5px] text-muted-foreground">默认 80 MiB，超限自动修剪</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => onNotify("隐私与缓存配置已保存。")}>
                    保存配置
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onNotify("已清理过期临时预览缓存，保留真实库与发送证据。")}
                  >
                    清理过期预览
                  </Button>
                </div>
              </Card>
            </CardFrame>
          )}

          {section === "appearance" && (
            <CardFrame>
              <CardFrameHeader>
                <CardFrameTitle>外观主题、字体与快捷键</CardFrameTitle>
                <CardFrameDescription>
                  暖白纸感 + 深松青配色，搭载 MiSans VF + Inter + Plus Jakarta Sans 现代屏幕字体
                </CardFrameDescription>
              </CardFrameHeader>
              <Card className="space-y-5 p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-medium text-[13.5px]">主题风格</div>
                    <div className="text-xs text-muted-foreground">暖白纸感浅色 / 深松炭黑夜间</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant={theme === "light" ? "default" : "outline"}
                      onClick={() => onSetTheme("light")}
                    >
                      <SunIcon />
                      暖白纸感
                    </Button>
                    <Button
                      size="sm"
                      variant={theme === "dark" ? "default" : "outline"}
                      onClick={() => onSetTheme("dark")}
                    >
                      <MoonIcon />
                      深松夜览
                    </Button>
                  </div>
                </div>
                <Separator />
                <div className="space-y-2.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">全局快速跳转命令面板</span>
                    <kbd className="rounded border border-border bg-muted px-2 py-0.5 font-mono">Ctrl + K</kbd>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">展开 / 收起左侧导航栏</span>
                    <kbd className="rounded border border-border bg-muted px-2 py-0.5 font-mono">Ctrl + B</kbd>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">会话中心确认发送当前全文</span>
                    <kbd className="rounded border border-border bg-muted px-2 py-0.5 font-mono">Ctrl + Enter</kbd>
                  </div>
                </div>
              </Card>
            </CardFrame>
          )}

          {section === "fault" && (
            <CardFrame>
              <CardFrameHeader>
                <CardFrameTitle>故障处理与全局急停</CardFrameTitle>
                <CardFrameDescription>
                  唯一急停入口。触发后立即冻结全部自动调度与外发，重启、重连或保存配置均不解除
                </CardFrameDescription>
              </CardFrameHeader>
              <Card className="space-y-4 p-5">
                {emergencyStopped ? (
                  <Alert variant="error">
                    <OctagonAlertIcon />
                    <AlertTitle>全局急停已持久生效</AlertTitle>
                    <AlertDescription>
                      所有自动回复、模型调用与外发已停止；已提交记录仍保持只读回读，不会自动重发。
                    </AlertDescription>
                    <AlertAction>
                      <Button size="xs" onClick={onRecoverEmergency}>
                        检查并恢复运行
                      </Button>
                    </AlertAction>
                  </Alert>
                ) : (
                  <Alert variant="success">
                    <ShieldCheckIcon />
                    <AlertTitle>当前运行正常，未触发全局急停</AlertTitle>
                    <AlertDescription>
                      发现账号异常或需要立刻停止所有外发时，可随时在此手动触发独立急停（会话过期时仍有效）。
                    </AlertDescription>
                  </Alert>
                )}

                <div className="flex flex-wrap gap-2">
                  {!emergencyStopped ? (
                    <Button variant="destructive" size="sm" onClick={onTriggerEmergency}>
                      <OctagonAlertIcon />
                      立即触发全局急停
                    </Button>
                  ) : (
                    <Button size="sm" onClick={onRecoverEmergency}>
                      显式核验并恢复运行
                    </Button>
                  )}
                </div>
              </Card>
            </CardFrame>
          )}
        </div>
      </div>
    </div>
  );
}
