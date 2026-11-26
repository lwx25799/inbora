import * as React from "react";
import {
  CameraIcon,
  RefreshCwIcon,
  SearchIcon,
  SendIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TerminalIcon,
} from "lucide-react";
import { BrandTile, BrandWordmark } from "@/components/BrandLogo";
import { AccountAvatar, PLATFORM_META } from "@/components/PlatformBadge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardFrame,
  CardFrameDescription,
  CardFrameHeader,
  CardFrameTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { AccountItem, ModelConnection, PageId, PlatformId, ThreadItem } from "@/data/mockData";

export function VerifyHeadlessDialog({
  open,
  onOpenChange,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onComplete: () => void;
}) {
  const [slider, setSlider] = React.useState(18);
  React.useEffect(() => {
    if (open) setSlider(18);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>原无头页面实时安全核验 · 禾木设计精选号</DialogTitle>
          <DialogDescription>
            直接将本人受限操作转交原无头文档，不切换浏览器、不重建页面、不自动求解
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="flex flex-col items-center justify-center gap-3.5 rounded-xl border border-border bg-muted/50 px-6 py-8 text-center">
            <Badge variant="warning">无头静音 Edge 原文档实时视图（受限交互）</Badge>
            <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
              向右拖动滑块模拟完成原文档安全拼图核验；达到终点后点击「提交核验并恢复」，仅解除当前绑定版本的评论通道暂停。
            </p>
            <div className="flex w-full max-w-xs items-center gap-3 rounded-xl border border-input bg-card px-3 py-2 shadow-xs">
              <input
                type="range"
                min={0}
                max={100}
                value={slider}
                onChange={(e) => setSlider(Number(e.target.value))}
                className="flex-1 accent-primary"
                aria-label="安全核验滑块"
              />
              <span className="w-10 text-right font-mono text-xs tabular-nums">
                {slider}%
              </span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            原现场截图与证据仅保存在本机私有运行目录，界面不公开原始页面链接。
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            暂不处理
          </Button>
          <Button size="sm" disabled={slider < 92} onClick={onComplete}>
            提交核验并复检恢复
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function CommentReplyDialog({
  thread,
  draft,
  onClose,
  onDraftChange,
  onSend,
}: {
  thread: ThreadItem | null;
  draft: string;
  onClose: () => void;
  onDraftChange: (v: string) => void;
  onSend: (text: string) => void;
}) {
  return (
    <Dialog open={Boolean(thread)} onOpenChange={(o) => !o && onClose()}>
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>人工回复评论 · {thread?.author}</DialogTitle>
          <DialogDescription>
            作品：{thread?.workTitle} · 完整保留一级根评论与楼中楼关系
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {(thread?.commentChain ?? []).map((c, i) => (
            <div
              key={i}
              className={`rounded-xl border px-3.5 py-2.5 text-xs ${
                c.level > 1 ? "ml-5" : ""
              } ${c.isTarget ? "border-primary/40 bg-primary/[0.04]" : "border-border bg-muted/40"}`}
            >
              <div className="mb-1 flex justify-between text-muted-foreground">
                <strong className="text-foreground">{c.author}</strong>
                <span className="tabular-nums">{c.time}</span>
              </div>
              <p className="text-[13px] text-foreground">{c.text}</p>
            </div>
          ))}
          <div className="space-y-1.5 pt-1">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium">回复全文（单次确认发送）</label>
              {thread?.suggestion && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => onDraftChange(thread.suggestion ?? "")}
                >
                  <SparklesIcon />
                  填入 AI 建议
                </Button>
              )}
            </div>
            <Textarea
              rows={4}
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              placeholder="输入精确回复该条子评论的内容..."
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            保存草稿并关闭
          </Button>
          <Button
            size="sm"
            disabled={!draft.trim()}
            onClick={() => onSend(draft.trim())}
          >
            <SendIcon />
            确认发送
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function AccountDetailSheet({
  account,
  onClose,
}: {
  account: AccountItem | null;
  onClose: () => void;
}) {
  const pf = account ? PLATFORM_META[account.platform] : null;
  return (
    <Sheet open={Boolean(account)} onOpenChange={(o) => !o && onClose()}>
      <SheetPopup variant="inset">
        <SheetHeader>
          <div className="flex items-center gap-3">
            {account && (
              <AccountAvatar
                label={account.label}
                platform={account.platform}
                avatarUrl={account.avatarUrl}
                size="lg"
              />
            )}
            <div>
              <SheetTitle>{account?.label}</SheetTitle>
              <SheetDescription>
                {pf?.name} · {account?.handle}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>
        <SheetPanel className="space-y-4">
          <CardFrame>
            <CardFrameHeader>
              <CardFrameTitle>账号值守与头像同步</CardFrameTitle>
            </CardFrameHeader>
            <Card className="space-y-2.5 p-4 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">头像同步</span>
                <span className="font-medium text-primary">{account?.avatarCapturedAt}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">客户头像显示</span>
                <span className="font-medium">
                  {account?.syncCustomerAvatars ? "已开启" : "已关闭"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">在线模式</span>
                <span className="font-medium">{account?.serviceTier}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">今日已回复</span>
                <span className="tabular-nums font-medium">
                  {(account?.todayAuto ?? 0) + (account?.todayHuman ?? 0)} / {account?.dailyQuota ?? 0} 条
                </span>
              </div>
              <details className="border-t border-border/70 pt-2.5 text-[11px] text-muted-foreground">
                <summary className="cursor-pointer select-none hover:text-foreground">
                  展开技术运行信息
                </summary>
                <div className="mt-2 space-y-1.5">
                  <div className="flex justify-between">
                    <span>通道类型</span>
                    <span className="text-foreground">{pf?.runtimeLabel}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>隔离环境</span>
                    <span className="text-foreground">{account?.ownerLock}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>内存占用</span>
                    <span className="tabular-nums text-foreground">
                      {account?.ramMb ? `${account.ramMb} MiB` : "官方接口（无需浏览器）"}
                    </span>
                  </div>
                </div>
              </details>
            </Card>
          </CardFrame>
        </SheetPanel>
        <SheetFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            关闭
          </Button>
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}

const AVATAR_PRESETS = [
  { url: "/avatars/acc-flagship.jpg", name: "青灰釉器物" },
  { url: "/avatars/acc-wecom.jpg", name: "茶席平拍" },
  { url: "/avatars/acc-wxkf.jpg", name: "礼盒丝带" },
  { url: "/avatars/acc-xhs.jpg", name: "手冲器具" },
  { url: "/avatars/acc-personal.jpg", name: "拉坯手作" },
];

export function AddAccountSheet({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (payload: {
    platform: PlatformId;
    label: string;
    handle: string;
    avatarUrl: string;
    syncCustomerAvatars: boolean;
  }) => void;
}) {
  const [platform, setPlatform] = React.useState<PlatformId>("bilibili");
  const [label, setLabel] = React.useState("");
  const [handle, setHandle] = React.useState("");
  const [avatarUrl, setAvatarUrl] = React.useState("/avatars/acc-xhs.jpg");
  const [captured, setCaptured] = React.useState(false);
  const [syncCustomerAvatars, setSyncCustomerAvatars] = React.useState(true);

  const simulateCapture = () => {
    const presetMap: Record<PlatformId, { label: string; handle: string; avatar: string }> = {
      douyin: { label: "禾木窑口直播号", handle: "@hemu_kiln_live", avatar: "/avatars/acc-flagship.jpg" },
      wecom: { label: "禾木大客户专席", handle: "企业微信 · 商务组", avatar: "/avatars/acc-wecom.jpg" },
      wxkf: { label: "微信客服 · 礼赠专席", handle: "微信客服 · 礼赠组", avatar: "/avatars/acc-wxkf.jpg" },
      xiaohongshu: { label: "禾木器物研究所", handle: "小红书号 8832104", avatar: "/avatars/acc-xhs.jpg" },
      bilibili: { label: "禾木手作 B站官方号", handle: "UID 40918273", avatar: "/avatars/acc-personal.jpg" },
      wechat_personal: { label: "主理人二号机", handle: "桌面微信客户端", avatar: "/avatars/acc-studio.jpg" },
    };
    const p = presetMap[platform];
    setLabel(p.label);
    setHandle(p.handle);
    setAvatarUrl(p.avatar);
    setCaptured(true);
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetPopup variant="inset">
        <SheetHeader>
          <SheetTitle>接入新平台账号</SheetTitle>
          <SheetDescription>
            登录授权后自动采集账号头像、昵称与标识，新账号默认仅观察与人工回复
          </SheetDescription>
        </SheetHeader>
        <SheetPanel className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">目标平台</label>
            <select
              value={platform}
              onChange={(e) => {
                setPlatform(e.target.value as PlatformId);
                setCaptured(false);
              }}
              className="h-8 w-full rounded-lg border border-input bg-popover px-2.5 text-sm shadow-xs"
            >
              <option value="douyin">抖音</option>
              <option value="wecom">企业微信</option>
              <option value="wxkf">微信客服</option>
              <option value="xiaohongshu">小红书</option>
              <option value="bilibili">B站</option>
              <option value="wechat_personal">个人微信（需保持桌面微信开启）</option>
            </select>
          </div>

          {/* Live Avatar Auto-Capture Preview Card */}
          <div className="space-y-3 rounded-xl border border-border/85 bg-muted/35 p-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <CameraIcon className="size-3.5 text-primary" />
                账号头像与资料采集
              </span>
              <Button variant="outline" size="xs" onClick={simulateCapture}>
                <RefreshCwIcon />
                {captured ? "重新采集资料" : "模拟扫码采集头像"}
              </Button>
            </div>
            <div className="flex items-center gap-3">
              <AccountAvatar
                label={label || PLATFORM_META[platform].name}
                platform={platform}
                avatarUrl={avatarUrl}
                size="lg"
              />
              <div className="min-w-0 flex-1 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-semibold text-foreground">
                    {label || "待采集账号昵称"}
                  </span>
                  <Badge variant={captured ? "success" : "secondary"} size="sm">
                    {captured ? "已采集头像" : "默认预览"}
                  </Badge>
                </div>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {handle || `${PLATFORM_META[platform].name} · 登录完成后自动抓取主页头像与 ID`}
                </p>
                <div className="mt-2 flex items-center gap-1.5">
                  {AVATAR_PRESETS.map((a) => (
                    <button
                      key={a.url}
                      type="button"
                      title={a.name}
                      onClick={() => {
                        setAvatarUrl(a.url);
                        setCaptured(true);
                      }}
                      className={`cursor-pointer overflow-hidden rounded-lg p-[1.5px] transition-all ${
                        avatarUrl === a.url ? "ring-2 ring-primary" : "opacity-70 hover:opacity-100"
                      }`}
                    >
                      <img src={a.url} alt={a.name} className="size-6 rounded-md object-cover" />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">账号备注名称</label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="例如：禾木手作 B站官方号"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">平台账号标识</label>
              <Input
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="自动采集或手动补录"
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl border border-border/80 bg-card px-3.5 py-2.5 text-xs">
            <div className="min-w-0">
              <div className="font-medium text-foreground">同步显示该账号下的客户头像</div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                自动获取并保存在本地，方便你在会话列表中快速辨认客户
              </p>
            </div>
            <Switch checked={syncCustomerAvatars} onCheckedChange={setSyncCustomerAvatars} />
          </div>

          <Alert variant="info">
            <ShieldCheckIcon />
            <AlertDescription>
              新账号默认仅人工回复，确认收发正常后可随时到「自动化规则」开启自动回复。
            </AlertDescription>
          </Alert>
        </SheetPanel>
        <SheetFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button
            size="sm"
            onClick={() => {
              onAdd({
                platform,
                label: label.trim() || `${PLATFORM_META[platform].name} · 新接入号`,
                handle: handle.trim() || `${PLATFORM_META[platform].name}新账号`,
                avatarUrl,
                syncCustomerAvatars,
              });
              setLabel("");
              setHandle("");
              setCaptured(false);
            }}
          >
            完成接入
          </Button>
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}

export function ModelEditorSheet({
  open,
  connection,
  onClose,
  onSave,
}: {
  open: boolean;
  connection: ModelConnection | null;
  onClose: () => void;
  onSave: (payload: {
    id: string | null;
    name: string;
    protocol: ModelConnection["protocol"];
    baseUrl: string;
    storage: "DPAPI" | "MEMORY";
    keyEntered: boolean;
  }) => void;
}) {
  const [name, setName] = React.useState("");
  const [protocol, setProtocol] = React.useState<ModelConnection["protocol"]>("OpenAI Chat");
  const [baseUrl, setBaseUrl] = React.useState("https://api.siliconflow.cn/v1");
  const [storage, setStorage] = React.useState<"DPAPI" | "MEMORY">("DPAPI");
  const [keyInput, setKeyInput] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setName(connection?.name ?? "");
    setProtocol(connection?.protocol ?? "OpenAI Chat");
    setBaseUrl(connection?.baseUrl ?? "https://api.siliconflow.cn/v1");
    setStorage(connection?.storage ?? "DPAPI");
    setKeyInput("");
  }, [open, connection]);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetPopup variant="inset">
        <SheetHeader>
          <SheetTitle>{connection ? `编辑模型连接 · ${connection.name}` : "新增模型连接"}</SheetTitle>
          <SheetDescription>留空密钥保留原值；前端绝不回显或持久化明文 Key</SheetDescription>
        </SheetHeader>
        <SheetPanel className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">连接名称</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：硅基流动兼容网关" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">协议类型</label>
            <select
              value={protocol}
              onChange={(e) => setProtocol(e.target.value as ModelConnection["protocol"])}
              className="h-8 w-full rounded-lg border border-input bg-popover px-2.5 text-sm shadow-xs"
            >
              <option value="OpenAI Chat">OpenAI Chat</option>
              <option value="OpenAI Responses">OpenAI Responses</option>
              <option value="Anthropic Messages">Anthropic Messages</option>
              <option value="Gemini">Gemini</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">HTTPS Base URL</label>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="font-mono" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">密钥存储方式</label>
            <select
              value={storage}
              onChange={(e) => setStorage(e.target.value as "DPAPI" | "MEMORY")}
              className="h-8 w-full rounded-lg border border-input bg-popover px-2.5 text-sm shadow-xs"
            >
              <option value="DPAPI">Windows 本机 DPAPI 加密持久化</option>
              <option value="MEMORY">仅后端内存（退出需补填）</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">API Key（演示态不保存真实密钥）</label>
            <Input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={connection?.keyPresent ? "已配置（留空保留原密钥）" : "输入任意占位字符激活演示"}
            />
          </div>
        </SheetPanel>
        <SheetFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button
            size="sm"
            onClick={() =>
              onSave({
                id: connection?.id ?? null,
                name: name.trim() || "自定义兼容网关",
                protocol,
                baseUrl: baseUrl.trim(),
                storage,
                keyEntered: Boolean(keyInput.trim()),
              })
            }
          >
            保存配置
          </Button>
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}

export function CommandPaletteDialog({
  open,
  onOpenChange,
  pages,
  onNavigate,
  onToggleTheme,
  onSetScenario,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  pages: Array<{ id: PageId; label: string }>;
  onNavigate: (p: PageId) => void;
  onToggleTheme: () => void;
  onSetScenario: (m: "normal" | "security_hold" | "emergency_stop") => void;
}) {
  const [q, setQ] = React.useState("");
  React.useEffect(() => {
    if (open) setQ("");
  }, [open]);

  const matched = pages.filter((p) => !q.trim() || p.label.includes(q.trim()));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup showCloseButton={false} className="overflow-hidden p-0 sm:max-w-lg">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <SearchIcon className="size-4 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索功能页面或快捷演示场景..."
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            ESC
          </kbd>
        </div>
        <div className="max-h-80 overflow-y-auto p-2">
          <div className="px-2.5 py-1.5 text-[11px] font-semibold text-muted-foreground">
            工作区页面
          </div>
          {matched.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                onNavigate(p.id);
                onOpenChange(false);
              }}
              className="flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted"
            >
              <span>{p.label}</span>
              <span className="text-xs text-muted-foreground">跳转</span>
            </button>
          ))}
          <div className="mt-1 px-2.5 py-1.5 text-[11px] font-semibold text-muted-foreground">
            快捷动作与演示场景
          </div>
          <button
            type="button"
            onClick={() => { onToggleTheme(); onOpenChange(false); }}
            className="flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted"
          >
            <span className="flex items-center gap-2"><TerminalIcon className="size-3.5 text-muted-foreground" />切换浅色暖白 / 深松暗夜</span>
            <span className="text-xs text-muted-foreground">外观</span>
          </button>
          <button
            type="button"
            onClick={() => { onSetScenario("security_hold"); onOpenChange(false); }}
            className="flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted"
          >
            <span className="flex items-center gap-2"><TerminalIcon className="size-3.5 text-muted-foreground" />切换到「通道安全待核验」场景</span>
            <span className="text-xs text-muted-foreground">演示</span>
          </button>
          <button
            type="button"
            onClick={() => { onSetScenario("emergency_stop"); onOpenChange(false); }}
            className="flex w-full cursor-pointer items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm hover:bg-muted"
          >
            <span className="flex items-center gap-2"><TerminalIcon className="size-3.5 text-muted-foreground" />切换到「全局急停」场景</span>
            <span className="text-xs text-muted-foreground">演示</span>
          </button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

export function ConnectPreviewDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-md">
        <div className="flex flex-col items-center gap-2.5 pt-6 pb-2 text-center">
          <BrandTile size={44} />
          <BrandWordmark height={18} className="text-foreground" />
          <p className="text-xs text-muted-foreground">Windows 本地优先 · 多平台智能客服工作台</p>
        </div>
        <DialogPanel>
          <CardFrame>
            <CardFrameHeader>
              <CardFrameTitle>连接本地私有运行目录</CardFrameTitle>
              <CardFrameDescription>
                没有模型 Key 也可以先人工回复；首次升级自动校验备份与恢复
              </CardFrameDescription>
            </CardFrameHeader>
            <Card className="space-y-3 p-4">
              <div className="space-y-1">
                <label className="text-xs font-medium">私有运行目录</label>
                <Input readOnly value="C:\Users\Operator\AppData\Local\inbora" className="font-mono text-xs" />
              </div>
              <label className="flex items-start gap-2 text-xs text-muted-foreground">
                <input type="checkbox" defaultChecked className="mt-0.5 accent-primary" />
                <span>我确认这是已授权账号的本地目录，允许按备份校验流程打开数据库</span>
              </label>
            </Card>
          </CardFrame>
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            返回工作台
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
