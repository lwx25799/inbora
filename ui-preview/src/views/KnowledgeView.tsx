import * as React from "react";
import {
  AlertTriangleIcon,
  BookOpenIcon,
  CheckCircle2Icon,
  ClockIcon,
  DatabaseIcon,
  FileUpIcon,
  FlameIcon,
  HashIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { StyleRadarBars } from "@/components/DataWidgets";
import { PersonaRadarSvg } from "@/components/RichVisuals";
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
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import {
  PERSONA_RADAR_AXES,
  type ChatSample,
  type KnowledgeDoc,
  type PersonaVersion,
} from "@/data/mockData";

interface KnowledgeProps {
  docs: KnowledgeDoc[];
  samples: ChatSample[];
  personas: PersonaVersion[];
  onToggleDoc: (id: string) => void;
  onToggleSample: (id: string) => void;
  onPublishPersona: (ver: string) => void;
  onNotify: (msg: string) => void;
}

const DOC_TAGS: Record<string, string[]> = {
  "K-01": ["顺丰标快", "17:00 截单", "10-14 天排窑", "偏远补差"],
  "K-02": ["手工拉坯", "柴烧落灰", "自然光实拍", "支持挑货"],
  "K-03": ["原木礼盒", "防震内托", "免费手写卡", "祝福语备注"],
  "K-04": ["48 小时破损拍照", "免费顺丰补发", "无需寄回", "7 天退换"],
  "K-05": ["30 只起订", "底款刻章", "10 天打样", "13% 专票"],
  "K-06": ["大促 72 小时", "与 K-01 冲突", "已阻断生成"],
};

const DOC_RECENT_HITS: Record<string, Array<{ customer: string; time: string; channel: string }>> = {
  "K-01": [
    { customer: "林晚晴", time: "18:41", channel: "抖音私信" },
    { customer: "温景行", time: "17:15", channel: "微信客服" },
  ],
  "K-02": [
    { customer: "周明远", time: "18:37", channel: "抖音评论" },
    { customer: "苏沐川", time: "18:34", channel: "抖音私信" },
  ],
  "K-03": [
    { customer: "林晚晴", time: "18:41", channel: "抖音私信" },
    { customer: "江枕月", time: "18:19", channel: "抖音私信" },
  ],
  "K-04": [
    { customer: "宋微澜", time: "18:32", channel: "微信客服" },
    { customer: "顾清舟", time: "17:58", channel: "抖音私信" },
  ],
  "K-05": [
    { customer: "栖山咖啡器具", time: "18:09", channel: "小红书私信" },
    { customer: "陆景川", time: "17:41", channel: "企业微信" },
  ],
};

const TRIAL_PRESETS = [
  {
    label: "杯盖磕碰补发",
    input: "上次买的青釉主人杯杯口有轻微磕碰，可以补发吗？",
    baseline: "您好，非常抱歉给您带来不便。请拍摄破损照片发给我们，核实后将为您安排补发或退款。",
    candidate:
      "抱歉让您收到磕碰的杯子了！方便时拍一张杯口细节图发这里，核对订单后直接给您顺丰补发一只新的，破损件不用寄回。",
    cited: "7天无理由与破损补发",
  },
  {
    label: "17:00 截单与礼盒",
    input: "现在下单手捏粗陶杯能今天发顺丰吗？想送朋友有没有礼盒贺卡？",
    baseline: "您好，现货通常在付款后安排发出，包装为常规保护箱，有需要可以备注。",
    candidate:
      "现货今天 17:00 前下单可当天发顺丰标快，默认配原木天地盖礼盒和防震内托，免费代写手写贺卡，祝词发我就行。",
    cited: "顺丰发货与截单时间 · 礼盒与手写贺卡服务",
  },
  {
    label: "咖啡馆企业定制",
    input: "我们是独立咖啡馆，想定制 40 套带底款的分享壶和品鉴杯，能开专票吗？",
    baseline: "您好，定制业务请联系商务人员咨询具体起订量和发票事宜。",
    candidate:
      "40 套满足 30 只起订门槛，支持底部刻章与礼盒烫印，打样周期约 10 天，可开具 13% 增值税专票，需要我先发您釉色样卡参考吗？",
    cited: "联名与企业定制起订量",
  },
  {
    label: "手工器物议价",
    input: "打算买三只窑变主人杯，能不能便宜一点？",
    baseline: "您好，本店商品均为一口价，暂时不支持议价，感谢理解。",
    candidate:
      "手工器物成本比较透明不好直接改价，不过买三只可以帮您叠加满减券并免费升级顺丰保价礼盒，发货前还能拍自然光实拍让您挑釉色。",
    cited: "窑变釉色差异说明 · 采纳样本 S-103",
  },
];

const PERSONA_METRICS = [
  { label: "亲和温度", value: 84, note: "克制真诚，不油腻" },
  { label: "事实严谨度", value: 96, note: "严格绑定知识库原文" },
  { label: "回答精炼度", value: 78, note: "控制在 2 句以内" },
  { label: "主动引导力", value: 70, note: "顺手确认祝词或单号" },
];

export function KnowledgeView({
  docs,
  samples,
  personas,
  onToggleDoc,
  onToggleSample,
  onPublishPersona,
  onNotify,
}: KnowledgeProps): React.ReactElement {
  const [tab, setTab] = React.useState("docs");
  const [topicFilter, setTopicFilter] = React.useState("ALL");
  const [ftsQuery, setFtsQuery] = React.useState("");
  const [selectedDocId, setSelectedDocId] = React.useState(docs[0]?.id ?? "");

  const [trialInput, setTrialInput] = React.useState(TRIAL_PRESETS[0].input);
  const [trialBaseline, setTrialBaseline] = React.useState(TRIAL_PRESETS[0].baseline);
  const [trialCandidate, setTrialCandidate] = React.useState(TRIAL_PRESETS[0].candidate);
  const [trialCited, setTrialCited] = React.useState(TRIAL_PRESETS[0].cited);

  const conflictDoc = docs.find((d) => d.status === "CONFLICT");
  const topics = ["ALL", ...Array.from(new Set(docs.map((d) => d.topic)))];
  const enabledCount = docs.filter((d) => d.status === "ENABLED").length;
  const totalHits7d = docs.reduce((s, d) => s + d.hits7d, 0);
  const maxHits = Math.max(...docs.map((d) => d.hits7d), 1);

  const filteredDocs = docs.filter((d) => {
    const matchTopic = topicFilter === "ALL" || d.topic === topicFilter;
    const q = ftsQuery.trim();
    const matchQ = !q || d.title.includes(q) || d.content.includes(q) || d.topic.includes(q);
    return matchTopic && matchQ;
  });

  const activeDoc = docs.find((d) => d.id === selectedDocId) ?? filteredDocs[0] ?? docs[0];
  const adoptedSamples = samples.filter((s) => s.adopted).length;

  return (
    <div className="mx-auto max-w-[1240px] space-y-4 px-6 py-5">
      <AppHeader
        title="知识库与人格"
        description="用本地事实检索、可编辑语气规则与少量已采纳样本改善回复，不微调模型权重，不上传无关隐私"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                onNotify("支持导入 TXT / MD / DOCX / 文字 PDF / CSV / XLSX，默认保存为停用待核对状态。")
              }
            >
              <FileUpIcon />
              导入文档
            </Button>
            <Button size="sm" onClick={() => onNotify("已打开新增知识条目表单（演示态）。")}>
              <PlusIcon />
              新增知识
            </Button>
          </>
        }
      />

      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border">
          <TabsList variant="underline" className="pb-0">
            <TabsTab value="docs">知识条目（{docs.length}）</TabsTab>
            <TabsTab value="samples">聊天样本（{adoptedSamples} 已采纳）</TabsTab>
            <TabsTab value="persona">回复人格</TabsTab>
            <TabsTab value="trial">试聊对比</TabsTab>
          </TabsList>
          <div className="hidden items-center gap-4 pb-2 text-xs text-muted-foreground md:flex tabular-nums">
            <span className="inline-flex items-center gap-1.5">
              <DatabaseIcon className="size-3.5 text-primary" />
              知识索引正常
            </span>
            <span className="inline-flex items-center gap-1.5">
              <FlameIcon className="size-3.5 text-chart-2" />
              近 7 天引用 {totalHits7d} 次
            </span>
            <span>生效条目 {enabledCount}/{docs.length}</span>
          </div>
        </div>

        {/* Tab 1: Split Master-Detail Knowledge Studio */}
        <TabsPanel value="docs" className="space-y-4">
          {conflictDoc && (
            <Alert variant="warning">
              <AlertTriangleIcon />
              <AlertTitle>同主题知识冲突（{conflictDoc.topic} · {conflictDoc.id}）</AlertTitle>
              <AlertDescription>
                检测到同主题两条有效内容互斥，系统已自动阻断该主题直接生成；请停用其一或拆分主题后再启用。
              </AlertDescription>
              <AlertAction>
                <Button variant="outline" size="xs" onClick={() => onToggleDoc(conflictDoc.id)}>
                  停用冲突项 {conflictDoc.id}
                </Button>
              </AlertAction>
            </Alert>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {topics.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTopicFilter(t)}
                  className={`cursor-pointer rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                    topicFilter === t
                      ? "border-primary/35 bg-primary/10 text-primary"
                      : "border-border/80 bg-card text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t === "ALL" ? `全部主题 (${docs.length})` : t}
                </button>
              ))}
            </div>
            <div className="relative w-full sm:w-[270px]">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                size="sm"
                value={ftsQuery}
                onChange={(e) => setFtsQuery(e.target.value)}
                placeholder="输入客户常问的问题测试匹配..."
                className="[&_input]:pl-7"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.22fr)_400px]">
            <CardFrame>
              <CardFrameHeader>
                <CardFrameTitle>事实条目目录（{filteredDocs.length}）</CardFrameTitle>
                <CardFrameDescription>
                  新增或修改后需人工核对再启用，防止过期规则被误引用
                </CardFrameDescription>
              </CardFrameHeader>
              <Card className="divide-y divide-border/70">
                {filteredDocs.map((d) => {
                  const selected = activeDoc?.id === d.id;
                  const hitPct = Math.round((d.hits7d / maxHits) * 100);
                  return (
                    <div
                      key={d.id}
                      onClick={() => setSelectedDocId(d.id)}
                      className={`cursor-pointer px-5 py-3.5 transition-colors first:rounded-t-xl last:rounded-b-xl ${
                        selected ? "bg-primary/[0.055]" : "hover:bg-muted/40"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-[11px] text-muted-foreground">{d.id}</span>
                            <span className="font-semibold text-[13.5px] text-foreground">{d.title}</span>
                            <Badge variant="secondary" size="sm">{d.topic}</Badge>
                            <Badge
                              variant={
                                d.status === "ENABLED"
                                  ? "success"
                                  : d.status === "CONFLICT"
                                    ? "error"
                                    : "outline"
                              }
                              size="sm"
                            >
                              {d.status === "ENABLED" ? "已启用" : d.status === "CONFLICT" ? "冲突阻断" : "已停用"}
                            </Badge>
                          </div>
                          <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                            {d.content}
                          </p>
                        </div>

                        <div className="flex shrink-0 flex-col items-end gap-1.5">
                          <span className="text-[11px] font-medium text-foreground tabular-nums">
                            {d.hits7d} 次/7d
                          </span>
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                            <div
                              className={`h-full rounded-full ${
                                d.status === "CONFLICT" ? "bg-destructive" : "bg-primary/75"
                              }`}
                              style={{ width: `${Math.max(hitPct, d.hits7d > 0 ? 12 : 0)}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {filteredDocs.length === 0 && (
                  <div className="px-5 py-10 text-center text-xs text-muted-foreground">
                    未检索到匹配「{ftsQuery}」的知识条目，系统会自动回退为人工确认，绝不臆造事实。
                  </div>
                )}
              </Card>
            </CardFrame>

            {activeDoc && (
              <CardFrame>
                <CardFrameHeader>
                  <CardFrameTitle>条目核对、关键词与引用记录</CardFrameTitle>
                  <CardFrameDescription>
                    当前选中 {activeDoc.id} · 更新于 {activeDoc.updatedAt}
                  </CardFrameDescription>
                  <CardFrameAction>
                    <Badge variant="outline" size="sm">{activeDoc.channel}</Badge>
                  </CardFrameAction>
                </CardFrameHeader>
                <Card className="space-y-3.5 p-4">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-[14px] text-foreground">{activeDoc.title}</span>
                      <Badge
                        variant={
                          activeDoc.status === "ENABLED"
                            ? "success"
                            : activeDoc.status === "CONFLICT"
                              ? "error"
                              : "outline"
                        }
                        size="sm"
                      >
                        {activeDoc.status === "ENABLED" ? "检索生效中" : activeDoc.status === "CONFLICT" ? "冲突阻断" : "已停用"}
                      </Badge>
                    </div>
                    <div className="mt-2 rounded-xl border border-border/80 bg-muted/35 p-3 text-[12.5px] leading-relaxed text-foreground">
                      {activeDoc.content}
                    </div>
                  </div>

                  {/* Trigger Keywords */}
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-medium text-muted-foreground">匹配关键词</div>
                    <div className="flex flex-wrap gap-1.5">
                      {(DOC_TAGS[activeDoc.id] ?? [activeDoc.topic]).map((kw) => (
                        <span
                          key={kw}
                          className="inline-flex items-center gap-0.5 rounded-md border border-border/75 bg-background px-2 py-0.5 text-[11px] text-foreground"
                        >
                          <HashIcon className="size-2.5 text-primary" />
                          {kw}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Metadata + Recent Citations */}
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg border border-border/70 bg-background px-3 py-2">
                      <div className="text-[10.5px] text-muted-foreground">有效期</div>
                      <div className="mt-0.5 font-medium text-foreground tabular-nums">{activeDoc.validUntil}</div>
                    </div>
                    <div className="rounded-lg border border-border/70 bg-background px-3 py-2">
                      <div className="text-[10.5px] text-muted-foreground">近 7 天引用</div>
                      <div className="mt-0.5 font-medium text-foreground tabular-nums">{activeDoc.hits7d} 次</div>
                    </div>
                  </div>

                  {(DOC_RECENT_HITS[activeDoc.id] ?? []).length > 0 && (
                    <div className="space-y-1.5 rounded-lg border border-border/70 bg-background px-3 py-2.5 text-[11.5px]">
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        <ClockIcon className="size-3 text-primary" />
                        最近对话引用
                      </div>
                      {(DOC_RECENT_HITS[activeDoc.id] ?? []).map((h, i) => (
                        <div key={i} className="flex items-center justify-between text-muted-foreground">
                          <span>{h.customer} · {h.channel}</span>
                          <span className="tabular-nums">{h.time}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center gap-2 pt-0.5">
                    <Button
                      size="sm"
                      variant={activeDoc.status === "DISABLED" ? "default" : "outline"}
                      className="flex-1"
                      onClick={() => onToggleDoc(activeDoc.id)}
                    >
                      {activeDoc.status === "DISABLED" ? "人工核对并启用" : "停用此条目"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setTab("trial");
                        onNotify(`已切换至试聊沙盒，可立即验证「${activeDoc.title}」的命中效果。`);
                      }}
                    >
                      沙盒验证
                    </Button>
                  </div>
                </Card>
              </CardFrame>
            )}
          </div>
        </TabsPanel>

        {/* Tab 2: Samples */}
        <TabsPanel value="samples" className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border/80 bg-card px-4 py-3">
              <div className="text-xs text-muted-foreground">已采纳教材样本</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="font-heading text-xl font-semibold tabular-nums">{adoptedSamples} / {samples.length}</span>
                <span className="text-xs text-primary">单批提炼上限 40 组</span>
              </div>
            </div>
            <div className="rounded-xl border border-border/80 bg-card px-4 py-3">
              <div className="text-xs text-muted-foreground">自动隐私脱敏</div>
              <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-foreground">
                <CheckCircle2Icon className="size-3.5 text-primary" />
                手机号、微信号、邮箱与外链自动剔除
              </div>
            </div>
            <div className="rounded-xl border border-border/80 bg-card px-4 py-3">
              <div className="text-xs text-muted-foreground">记忆边界约束</div>
              <div className="mt-1 text-xs text-foreground">
                仅提炼语气表达，不建立联系人长期画像
              </div>
            </div>
          </div>

          <CardFrame>
            <CardFrameHeader>
              <CardFrameTitle>聊天表达样本库</CardFrameTitle>
              <CardFrameDescription>
                勾选高质量历史问答作为风格教材，含敏感联系方式的条目默认隔离不采纳
              </CardFrameDescription>
            </CardFrameHeader>
            <Card className="divide-y divide-border/70">
              {samples.map((s) => (
                <div
                  key={s.id}
                  className="flex flex-wrap items-start justify-between gap-4 px-5 py-4 first:rounded-t-xl last:rounded-b-xl"
                >
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[11px] text-muted-foreground">{s.id}</span>
                      <span className="text-xs text-muted-foreground">{s.source}</span>
                      <Badge variant={s.adopted ? "success" : "outline"} size="sm">
                        {s.adopted ? "已采纳为教材" : "未采纳"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">客：{s.question}</p>
                    <p className="rounded-lg bg-muted/40 px-3 py-2 text-[13px] text-foreground">
                      答：{s.reply}
                    </p>
                  </div>
                  <Button variant="outline" size="xs" onClick={() => onToggleSample(s.id)}>
                    {s.adopted ? "移出教材" : "确认采纳"}
                  </Button>
                </div>
              ))}
            </Card>
          </CardFrame>
        </TabsPanel>

        {/* Tab 3: Persona with True 5-Axis SVG Spider Radar + Style Bars */}
        <TabsPanel value="persona">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.15fr)_400px]">
            <CardFrame>
              <CardFrameHeader>
                <CardFrameTitle>回复人格版本</CardFrameTitle>
                <CardFrameDescription>
                  样本 ≤40 组时单批提炼直接生成草稿，支持随时发布或一键回退至历史版本
                </CardFrameDescription>
                <CardFrameAction>
                  <Button size="xs" onClick={() => onNotify("已基于当前已采纳样本发起单批提炼演示。")}>
                    <SparklesIcon />
                    提炼新草稿
                  </Button>
                </CardFrameAction>
              </CardFrameHeader>
              <Card className="divide-y divide-border/70">
                {personas.map((p) => (
                  <div
                    key={p.version}
                    className="flex flex-wrap items-start justify-between gap-4 px-5 py-4 first:rounded-t-xl"
                  >
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-[14px]">{p.name}</span>
                        <Badge variant="outline" size="sm" className="font-mono">{p.version}</Badge>
                        <Badge variant={p.status === "PUBLISHED" ? "success" : "secondary"} size="sm">
                          {p.status === "PUBLISHED" ? "当前生效" : "历史归档"}
                        </Badge>
                      </div>
                      <p className="text-xs leading-relaxed text-muted-foreground">{p.summary}</p>
                      <p className="text-[11.5px] text-muted-foreground tabular-nums">
                        {p.batches} · 创建于 {p.createdAt}
                      </p>
                    </div>
                    {p.status !== "PUBLISHED" && (
                      <Button variant="outline" size="xs" onClick={() => onPublishPersona(p.version)}>
                        回退并发布
                      </Button>
                    )}
                  </div>
                ))}
                <div className="space-y-3 p-5">
                  <StyleRadarBars metrics={PERSONA_METRICS} />
                </div>
                <div className="rounded-b-xl bg-muted/25 px-5 py-3.5 text-xs text-muted-foreground">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-foreground">当前适用账号（v2）</span>
                    <Badge variant="success" size="sm">已绑定 4 个账号</Badge>
                  </div>
                  <p className="mt-1 leading-relaxed">
                    已应用于 禾木手作旗舰号、禾木企业客服、售后保障专线、禾木设计精选号；随时可回退至历史版本，不会改动已发送的记录。
                  </p>
                </div>
              </Card>
            </CardFrame>

            <CardFrame>
              <CardFrameHeader>
                <CardFrameTitle>五维人格雷达对比</CardFrameTitle>
                <CardFrameDescription>v2 提炼版本对比 v1 初始基线</CardFrameDescription>
              </CardFrameHeader>
              <Card className="space-y-4 p-5">
                <PersonaRadarSvg axes={PERSONA_RADAR_AXES} />
                <div className="space-y-1.5 rounded-xl border border-border/70 bg-muted/30 p-3.5 text-xs">
                  <div className="flex items-center gap-1.5 font-medium text-foreground">
                    <BookOpenIcon className="size-3.5 text-primary" />
                    提炼出的核心语气规则
                  </div>
                  <ul className="space-y-1 text-[11.5px] text-muted-foreground">
                    <li>• 售后问题先致歉再给可执行方案，不推诿物流</li>
                    <li>• 未查到库存或价格时不猜测，转交人工核实</li>
                    <li>• 避免感叹号堆砌与营销套话，保持手作主理人克制感</li>
                  </ul>
                </div>
              </Card>
            </CardFrame>
          </div>
        </TabsPanel>

        {/* Tab 4: Interactive Sandbox Trial */}
        <TabsPanel value="trial">
          <CardFrame>
            <CardFrameHeader>
              <CardFrameTitle>试聊对比沙盒</CardFrameTitle>
              <CardFrameDescription>
                对比默认基线与候选人格的语气与事实准确度；此处严禁产生发送意图或打开平台页面
              </CardFrameDescription>
              <CardFrameAction>
                <Badge variant="info">零外发沙盒</Badge>
              </CardFrameAction>
            </CardFrameHeader>
            <Card className="space-y-4 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">快速场景：</span>
                {TRIAL_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => {
                      setTrialInput(preset.input);
                      setTrialBaseline(preset.baseline);
                      setTrialCandidate(preset.candidate);
                      setTrialCited(preset.cited);
                    }}
                    className={`cursor-pointer rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                      trialInput === preset.input
                        ? "border-primary/35 bg-primary/10 text-primary"
                        : "border-border bg-background text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              <div className="flex gap-2">
                <Input
                  value={trialInput}
                  onChange={(e) => setTrialInput(e.target.value)}
                  placeholder="输入一段模拟客户来信..."
                />
                <Button
                  size="sm"
                  onClick={() => {
                    setTrialBaseline(`您好，关于您提到的「${trialInput.slice(0, 16)}」，请稍候客服核实后再回复您。`);
                    setTrialCandidate(`您好！针对您问的「${trialInput.slice(0, 16)}」，对照店里现行发货与售后规则可以直接为您安排优先处理，麻烦顺手发一下订单尾号就行。`);
                    setTrialCited("自动 FTS5 事实匹配");
                    onNotify("沙盒对比已更新（零外发）。");
                  }}
                >
                  <SparklesIcon />
                  运行对比
                </Button>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-border bg-muted/35 p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-muted-foreground">基线：仅账号基础人设</span>
                    <Badge variant="outline" size="sm">无知识库 · {trialBaseline.length} 字</Badge>
                  </div>
                  <p className="text-[13.5px] leading-relaxed text-foreground">{trialBaseline}</p>
                </div>
                <div className="rounded-xl border border-primary/25 bg-primary/[0.045] p-4">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-primary">候选：温和手作主理人 v2 + 本地知识库</span>
                    <Badge variant="success" size="sm">命中：{trialCited}</Badge>
                  </div>
                  <p className="text-[13.5px] leading-relaxed text-foreground">{trialCandidate}</p>
                  <div className="mt-3 flex items-center gap-3 text-[11px] text-muted-foreground">
                    <span>字符数 {trialCandidate.length} 字</span>
                    <span>·</span>
                    <span className="text-primary">无越权承诺</span>
                    <span>·</span>
                    <span>零外发执行</span>
                  </div>
                </div>
              </div>
            </Card>
          </CardFrame>
        </TabsPanel>
      </Tabs>
    </div>
  );
}
