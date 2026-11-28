# 阶段推进状态、交接单与实机待验总表

本表按 [架构决策记录](ARCHITECTURE-DECISIONS.md) ADR-002、ADR-005、ADR-006 与 ADR-007 维护，严格区分「代码与离线/合成验证」与「真实账号/原生 GUI 实机验收」，供跨阶段验收与发布前核对使用。

> 分支说明：ADR-007、阶段 4（第一、二批）及阶段 5 均在 `dev` 分支演进（当前分叉基线 `origin/dev` 位于 `a66773a`，`main` / `origin/main` 位于 `2d6f1ac`）。

---

## 一、全 6 阶段基线总览（当前基线：2026-11-27，`dev` 分支）

| 阶段 | 基线提交（所属分支） | 代码与离线/合成验证状态 | 实机验收状态 |
|---|---|---|---|
| **阶段 0：止血与文档唯一化** | `ac6a096`（`main` / `dev`） | 已合入，P0 修复与定向回归通过 | 沿用 0.3.5 单账号抖音范围 GO |
| **阶段 1：内核解耦与 `PlatformConnector`** | `4edb238`（`main` / `dev`） | 已合入，`src/contracts/`、`src/platform/`、参数化 `accountId` 回归通过 | 单账号抖音兼容链路与阶段 0 基线一致 |
| **阶段 2：多模型提供商接入与切换 V1.0** | `702acd2`（`main` / `dev`） | 已合入，9 供应商预设、四协议合成响应、DPAPI/Sidecar 合成宿主、UI 与回归套件通过 | **待本人补验**：自备 Key 真实付费调用 + 原生 GUI 人工交互（见 [MODEL-CONTRACT.md](MODEL-CONTRACT.md)） |
| **阶段 3：`schema4` + 协议 v2 + 隔离 Worker + Win32 桥** | `38e7a2b`（`main` / `dev`） | 已合入，`schema4` 迁移、协议 v2、多账号隔离、独立 Browser Worker、Mock 第二平台与 3 页最小账号面板回归通过 | **待本人补验**：真实库私有副本 `schema3 -> schema4` 试升级与恢复实机核验 |
| **阶段 5 前置：品牌与前端视觉/交互基线锁定** | `4659a2c`、`56b12eb`、`ae45288`（`main` / `dev`） | 已定稿并固化于 `assets/brand/` 与 `ui-preview/`（Playwright 2x 7 视图与 `tsc`/`vite build` 通过） | 纯离线视觉参考基线，由阶段 5 M1–M5 正式工作台承接落地 |
| **ADR-007：混合检索、8 阶段回复与渐进四槽位** | `ee4ad90`、`0434ef6`、`51f4112`、`a28a04e`（`dev`） | 已合入，中文 FTS5 + ONNX 向量混合底座、8 阶段流水线、碎片聚合、四槽位路由、只读业务工具、视觉安全隔离与本地回复素材库通过离线/合成回归 | **待本人补验**：真实语料召回效果、ONNX 模型首启下载、四槽位真实多模型与多模态看图实测 |
| **阶段 4 第一批：官方渠道（企业微信智能机器人 / 微信客服）** | `f2f2e89..efdf17c`、`d153dd1`（`dev`） | 已合入，`wecom-aibot` 长连接与 `wechat-kf` 官方 API 协议核心、运行期接入、离线只读分发、三轮审查修复与工作台最小接入通过 | **待本人补验**：自备真实 `BotID`/`Secret` 及 `CorpID`/`OpenKfID`/`Secret` 在原生开发窗口实测建连与收发 |
| **阶段 4 第二批：网页连接器（小红书 / B 站）** | `a66773a`（`dev`） | 已合入，独立 Node Browser Worker 隔离、双网页连接器、Profile 冲突与安全守卫及 R1–R3 修复通过（`tests/fixtures` 合成契约） | **待本人补验**：真实小红书 / B 站创作者后台 DOM 选择器校准与真号收发验证（未校准真实页禁发） |
| **阶段 5（M1–M5）：9 页正式工作台与读模型/安全缓存** | `dev` 当前工作区（M1–M4 已就绪，M5 本批交付） | **9 页正式工作台（M1–M5）离线/合成验证通过**：含 M1–M4 壳层与业务页及 **M5（第 9 页数据统计只读模型 `getAnalytics`、9 页导航接入、脱敏 CSV 导出、本机头像安全缓存 `AvatarCacheStore` 与 `getAvatarPreview` 纯只读隔离预览、每账号原子同步开关）**；线上远程 CDN 头像拉取仍待各平台真号采集接线 | **待本人补验**：开发模式原生窗口 9 页全流程走查、真号实采头像入库与预览实测、`pnpm desktop:build` 正式安装包构建与 Windows 11 兼容核验 |

---

## 二、阶段 5 里程碑 M1–M5 离线/合成交付清单

1. **M1–M2（品牌壳层、概览与收件箱）**：`Harbor Frame` 标识、暖白纸感/深松青令牌、`MiSans VF` / `Plus Jakarta Sans` / `Inter` / `JetBrains Mono` 离线字体、`AppSidebar` + `TopBar` + `CommandPalette`（`Cmd/Ctrl+K`）、概览页、收件箱列表与三段式回复详情。
2. **M3（知识库、8 阶段自动回复与多模型）**：`KnowledgePageView`（FTS5/ONNX 检索调试、FAQ 候选采纳、人格学习）、`AutomationView`（8 阶段流水线、节流阀、转人工归因）、`ModelsPageView`（9 供应商、四槽位路由、DPAPI 凭据状态）。
3. **M4（全渠道账号、运行态与系统设置）**：`AccountsView`（抖音/小红书/B 站/企微/微信客服适配配置与通道开关）、`RuntimeView`（连接器与队列运行态）、`SystemSettingsView`（急停恢复与诊断）。
4. **M5（第 9 页数据统计 & 本机头像安全缓存预览）**：
   - `src/contracts/analytics.ts` & `src/contracts/avatar.ts` & `src/contracts/ai-runtime.ts` + `protocol-v2` / `service-guards` 只读直通与 Tauri `ALLOWED` 白名单。
   - `src/app/analytics-queries.ts`：`readAnalyticsSummary` 严格纯只读（`sqlite_schema` 存在性先检、走零写直通路径不触发会话续期或冷恢复）；汇总有效确认送达（含 `verification_results` 补证与 `audit_events` 评论人工重试回执，按 `policy_commands` / `manual_send_commands` / `human_reply_turns` 准确归因并单独单列历史未知来源 `unknownConfirmed`）、同队列批次元组口径 `autoReplySuccessRate`、`SUBMISSION_PROOF` 优先的响应耗时与显式作用域标注 `scopes`。
   - `src/app/avatar-cache.ts`：`AvatarCacheStore` 经 `assertPrivateRuntimeRoot` 校验规范化真实路径防目录联接逃逸，私有目录 `<runtimeRoot>/avatars/<accountDigest>/` 原子落盘、魔数与 256 KiB 校验、`syncCustomerAvatars` 读写双门控、单账号串行队列与 500 条 LRU（含只读内存访问保鲜）、纯只读 360 KB UTF-8 有界 `data:` URL 返回，与 `vision-input.ts` / `SendCoordinator` / 身份校验严格隔离；提供 `ingestCachedAvatar` 离线安全入库入口（实时远程头像拉取待真号实测阶段对接各连接器采集）。
   - `src/storage/account-ai-features.ts` & `src/app/ai-runtime-commands.ts`：新增事务化 `setSyncCustomerAvatars` 原子修补，防止切号瞬态覆盖其余 AI 能力开关。
   - `desktop/src/views/AnalyticsView.tsx`、`desktop/src/useAvatarPreview.ts`、`desktop/src/PageContent.tsx`：第 9 页数据统计（7/14/30 天切换、KPI 卡、堆叠柱状图、转人工归因分布、账号明细、防公式注入 UTF-8 BOM 脱敏 CSV 导出）及全工作台 9 页导航与账号绑定头像预览接线。

---

## 三、当前已验证离线/合成回归入口

```powershell
pnpm typecheck
.\node_modules\.bin\tsc.cmd -p desktop/tsconfig.json
pnpm check:source-size
pnpm check:privacy
```

重点自动化测试：
- 阶段 1/2：`tests/unit/`、`tests/integration/`（多模型切换、取消、测速与 `desktop/src` 组件测试）
- 阶段 3：`tests/integration/schema4-migration.test.ts`、`tests/integration/protocol-v2-and-accounts.test.ts`、`tests/integration/browser-worker-isolation.test.ts`、`tests/integration/mock-platform-pluggability.test.ts`、`tests/unit/worker-isolation-boundaries.test.ts`
- ADR-007 与阶段 4：`tests/unit/wecom-aibot-ws.test.ts`、`tests/unit/wechat-kf-protocol.test.ts`、`tests/integration/wecom-aibot-connector.test.ts`、`tests/integration/wechat-kf-connector.test.ts`、`tests/integration/official-channels-runtime.test.ts`、`tests/integration/web-platform-lifecycle.test.ts`、`tests/unit/vision-input-isolation.test.ts`
- 阶段 5 M5：`tests/integration/analytics-and-avatar.test.ts`、`tests/integration/desktop-ipc.test.ts`、`desktop/src/AnalyticsView.test.tsx`、`desktop/src/ux-polish.test.tsx`
- 双链构建烟测：`pnpm build` + `pnpm test:built`（验证源码 `tsx` 链与构建后 Node 链一致）

---

## 四、明确未验证与待本人实机补验清单（阻塞发布结论）

以下项目均未获得真实环境实机通过结论，任何交付不得将其表述为已验收：

1. **真实网页 DOM 校准、真号收发与远程头像采集（抖音 / 小红书 / B 站）**：
   - 小红书与 B 站目前仅通过 `tests/fixtures` 合成页验证，实际网页映射需存入私有目录完成真实创作者后台 DOM 校准；**未校准真实页严禁对外发送**。
   - 头像缓存目前仅完成本地安全落盘、读取隔离与离线 `ingestCachedAvatar` 入口验证；线上网页/官方渠道远程头像图片下载与真号预览显示须在真号 DOM/凭据实机阶段接线并验证。
   - 抖音真实账号仍须在原生开发窗口维持单账号绑定、人稿保护与 `SendCoordinator` 回执闭环验证。
2. **阶段 4 第一批官方渠道真实凭据实机验收（企业微信智能机器人 / 微信客服）**：
   - 仅完成离线合成 WSS/HTTPS 夹具与无凭据安全守卫验证，待填写真实 `BotID`/`Secret` 与 `CorpID`/`OpenKfID`/`Secret` 完成真实收发与回执实测。
3. **阶段 2 & ADR-007 多模型真实付费调用（9 家供应商）**：
   - DeepSeek、OpenAI、Claude、Gemini、通义千问、豆包、硅基流动、OpenRouter、自定义云端均仅通过离线合成响应验证，待自备 9 家 Key 在原生开发窗口完成单次测速、四槽位路由、多模态看图及本人语料知识库/人格学习实测。
4. **真实库 `schema3 -> schema4` 首次升级核验**：
   - 须严格执行「退出当前客户端释放锁 -> SQLite 在线备份 -> 私有副本试升级与恢复验证 -> 再升原库」，已发生新外发后禁以旧快照回退。
5. **个人微信 4.x 纯 UIA 通道（阶段 4 第三批）**：
   - 按 ADR-002 / ADR-003 规划延后按需接入无状态 Python UIA Worker，目前未实施。
6. **阶段 5 9 页桌面端实机走查、Windows 11 兼容性与安装包分发**：
   - 当前实机基线为 Windows 10 专业版 x64 Build 19045；Windows 11 兼容、9 页开发模式原生 GUI 实机走查与 `pnpm desktop:build` 正式安装包构建均列为正式发布前专项待验。

---

## 五、工程红线备忘

- 未经用户明确要求禁止执行 `pnpm desktop:build` 打包；禁止改动或重置本机私有真实运行目录与真实数据库。
- 所有源码、界面、样式、脚本与测试文件严格 `<= 800` 物理行；新引入外部开源实现须先核对许可、固定 commit SHA 并登记进 [UPSTREAM.md](../UPSTREAM.md)。
- 头像缓存仅存私有目录 `<runtimeRoot>/avatars/` 并通过 `getAvatarPreview` 返回有界 `data:` URL，严禁传入模型、严禁作为目标放行依据、严禁入 Git。
