import * as React from "react";
import { CheckCircle2Icon, AlertTriangleIcon, SparklesIcon } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Textarea } from "@/components/ui/textarea";

interface AutomationProps {
  autoReplyEnabled: boolean;
  emergencyStopped: boolean;
  onToggleGlobalAuto: () => void;
  onNotify: (msg: string) => void;
}

export function AutomationView({
  autoReplyEnabled,
  emergencyStopped,
  onToggleGlobalAuto,
  onNotify,
}: AutomationProps): React.ReactElement {
  const [commentSec, setCommentSec] = React.useState(30);
  const [dmSec, setDmSec] = React.useState(15);
  const [nestedComments, setNestedComments] = React.useState(true);
  const [futureWorks, setFutureWorks] = React.useState(true);
  const [modelUnlimited, setModelUnlimited] = React.useState(true);
  const [modelLimit, setModelLimit] = React.useState(2000);
  const [sendUnlimited, setSendUnlimited] = React.useState(false);
  const [sendLimit, setSendLimit] = React.useState(500);
  const [excludes, setExcludes] = React.useState("投诉、工商、律师、假货、退款纠纷、微信转账");
  const [instructions, setInstructions] = React.useState(
    "以温和、诚实、不夸大功效的手作器物主理人口吻回复；现货、釉色与破损补发严格依据已启用知识库作答，无法核实的事实时礼貌说明并转交人工。",
  );
  const [simText, setSimText] = React.useState("请问手捏粗陶杯明天能发顺丰吗？想送朋友当礼物");

  const excludeList = excludes.split(/[、,，\s]+/).filter(Boolean);
  const hitExclude = excludeList.find((w) => simText.includes(w));

  return (
    <div className="mx-auto max-w-[1160px] px-7 py-6">
      <AppHeader
        title="自动化规则"
        description="统一配置后台收取节奏、自动回复时段、额度上限与屏蔽词；关闭总开关不影响在线收取与人工回复"
        actions={
          <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-1.5 shadow-xs/5">
            <span className="text-xs font-medium text-foreground">
              自动回复：{autoReplyEnabled && !emergencyStopped ? "开启" : "关闭"}
            </span>
            <Switch
              checked={autoReplyEnabled && !emergencyStopped}
              disabled={emergencyStopped}
              onCheckedChange={onToggleGlobalAuto}
            />
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.45fr_1fr]">
        <CardFrame>
          <CardFrameHeader>
            <CardFrameTitle>收取节奏与持续授权范围</CardFrameTitle>
            <CardFrameDescription>
              首次运行起点（2026-11-01 09:00）前的旧历史不会生成待办，修改规则保留既有累计消耗
            </CardFrameDescription>
          </CardFrameHeader>
          <Card className="space-y-5 p-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">私信后台巡检间隔（秒）</label>
                <Input
                  type="number"
                  value={dmSec}
                  onChange={(e) => setDmSec(Number(e.target.value))}
                  className="tabular-nums"
                />
                <p className="text-[11.5px] text-muted-foreground">默认 15 秒，人工回复永远优先排队</p>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">评论后台巡检间隔（秒）</label>
                <Input
                  type="number"
                  value={commentSec}
                  onChange={(e) => setCommentSec(Number(e.target.value))}
                  className="tabular-nums"
                />
                <p className="text-[11.5px] text-muted-foreground">默认 30 秒，单作品失败自动退避让出</p>
              </div>
            </div>

            <div className="space-y-3 rounded-xl bg-muted/45 p-3.5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[13px] font-medium text-foreground">自动回复楼中楼子评论</div>
                  <div className="text-xs text-muted-foreground">精确回复目标子评论，不把回复根评论算作已完成</div>
                </div>
                <Switch checked={nestedComments} onCheckedChange={setNestedComments} />
              </div>
              <Separator />
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[13px] font-medium text-foreground">自动纳入后续新发布作品与新私信</div>
                  <div className="text-xs text-muted-foreground">新作品上线后自动进入收取与授权范围，无需逐条勾选</div>
                </div>
                <Switch checked={futureWorks} onCheckedChange={setFutureWorks} />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2 rounded-xl border border-border/80 p-3.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-foreground">模型调用额度</span>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span>无上限</span>
                    <Switch checked={modelUnlimited} onCheckedChange={setModelUnlimited} />
                  </label>
                </div>
                <Input
                  type="number"
                  size="sm"
                  disabled={modelUnlimited}
                  value={modelLimit}
                  onChange={(e) => setModelLimit(Number(e.target.value))}
                  className="tabular-nums"
                />
                <p className="text-[11.5px] text-muted-foreground tabular-nums">
                  累计已用 684 / {modelUnlimited ? "无上限" : modelLimit}
                </p>
              </div>

              <div className="space-y-2 rounded-xl border border-border/80 p-3.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-foreground">自动发送额度</span>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span>无上限</span>
                    <Switch checked={sendUnlimited} onCheckedChange={setSendUnlimited} />
                  </label>
                </div>
                <Input
                  type="number"
                  size="sm"
                  disabled={sendUnlimited}
                  value={sendLimit}
                  onChange={(e) => setSendLimit(Number(e.target.value))}
                  className="tabular-nums"
                />
                <p className="text-[11.5px] text-muted-foreground tabular-nums">
                  累计已用 331 / {sendUnlimited ? "无上限" : sendLimit}
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">
                敏感与转人工屏蔽词（命中即跳过自动回复）
              </label>
              <Input value={excludes} onChange={(e) => setExcludes(e.target.value)} />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">
                客服口吻与业务边界说明
              </label>
              <Textarea
                rows={3}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </div>

            <div className="flex items-center justify-between border-t border-border/70 pt-3">
              <span className="text-xs text-muted-foreground">
                工作时段：每日 09:00 至 23:00 · 保存不解除急停或安全冻结
              </span>
              <Button
                size="sm"
                onClick={() => onNotify("自动化策略已保存并生效，历史累计额度完整保留。")}
              >
                保存策略
              </Button>
            </div>
          </Card>
        </CardFrame>

        <CardFrame className="h-fit">
          <CardFrameHeader>
            <CardFrameTitle>规则命中预演</CardFrameTitle>
            <CardFrameDescription>
              输入模拟来信检查屏蔽词与额度闸门，不消耗模型额度
            </CardFrameDescription>
            <CardFrameAction>
              <Badge variant="outline">离线试算</Badge>
            </CardFrameAction>
          </CardFrameHeader>
          <Card className="space-y-4 p-5">
            <Textarea
              rows={4}
              value={simText}
              onChange={(e) => setSimText(e.target.value)}
              placeholder="输入任意客户咨询消息..."
            />

            <Alert variant={hitExclude ? "warning" : "success"}>
              {hitExclude ? <AlertTriangleIcon /> : <CheckCircle2Icon />}
              <AlertTitle>
                {hitExclude ? `命中屏蔽词「${hitExclude}」，已转交人工` : "符合自动回复条件"}
              </AlertTitle>
              <AlertDescription>
                {hitExclude
                  ? "跳过模型调用与自动外发，保留在会话中心「需人工」队列等待你亲自处理。"
                  : "命中有效时段与授权范围，将结合已启用知识库生成回复，并经唯一通道单次提交与回读。"}
              </AlertDescription>
            </Alert>

            <div className="space-y-2 pt-1">
              <div className="text-xs text-muted-foreground">快速切换测试语句：</div>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => setSimText("请问手捏粗陶杯明天能发顺丰吗？想送朋友当礼物")}
                >
                  <SparklesIcon />
                  日常发货咨询
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => setSimText("杯子有色差，我要去工商投诉并申请退款纠纷！")}
                >
                  触发屏蔽词
                </Button>
              </div>
            </div>
          </Card>
        </CardFrame>
      </div>
    </div>
  );
}
