# inbora 品牌标识与阶段 5 前端视觉规范

本文档固化已通过验收的 **inbora Harbor Frame（归港方匣）** 品牌标识套件、暖白纸感与深松青视觉体系、全离线可变字体方案、用户优先交互准则、头像采集隐私边界、9 大主工作区与 7 个核心抽屉/弹窗逐页规格，以及阶段 5 迁入 `desktop/src/` 生产前端的落地清单（对应 [ARCHITECTURE-DECISIONS.md](../../docs/ARCHITECTURE-DECISIONS.md) ADR-006）。

- 交互式可运行参考基线：`ui-preview/`（React 19 + TypeScript + Vite 7 + Tailwind CSS v4 + `@base-ui/react@1.9.0` + `cosscom/ui` 原语，完全独立于当前 `0.3.5` 生产代码 `src/` 与 `desktop/`）
- 高清视觉参考图集：`assets/brand/screenshots/`（7 张 2x Retina 实渲染截图）

---

## 一、品牌标识套件（Harbor Frame / 归港方匣）

### 1. 标识资产清单

| 文件 | 用途 | 规格说明 |
|---|---|---|
| `assets/brand/inbora-symbol.svg` | 标准图形主标（玄墨 `#171717`） | `256x256`，纯闭合几何路径，无 `<text>` 与滤镜 |
| `assets/brand/inbora-symbol-small.svg` | 小尺寸微调版（`16px-24px`） | 针对任务栏与标签页微调壁厚与内部留白，避免发糊 |
| `assets/brand/inbora-symbol-reversed.svg` | 深色反白主标（`#FAFAFA`） | 笔画微收约 3%，抵消深底白字光渗效应 |
| `assets/brand/inbora-lockup-horizontal.svg` | 横版标准组合标（图形 + 定制 `inbora` 字标） | `820x256`，纯矢量路径字形，零系统字体依赖 |
| `assets/brand/inbora-lockup-stacked.svg` | 竖版组合标 | `440x360`，用于引导页、封面与关于弹窗 |
| `assets/brand/inbora-wordmark.svg` | 纯字标 | `544x176`，用于窄顶栏或旁侧已有主标的场景 |
| `assets/brand/variants/` | 完整导出变体包 | 含黑白与深松清单色 SVG/PNG、`favicon.ico`、圆角应用图标与 `site.webmanifest` |

### 2. 使用边界

- **安全留白**：四周至少保留主标总宽度 15% 的无干扰区域。
- **最小尺寸**：标准主标不小于 `20px`；`16px-19px` 固定使用 `inbora-symbol-small.svg` 或 `favicon.ico`；横版组合标最小高度 `20px`。
- **禁用行为**：禁止拉伸变形、叠加投影或霓虹渐变、封闭顶部开口、用任意系统字体替代定制路径字标。

---

## 二、视觉基调与色彩令牌（暖白纸感 + 深松青）

界面定位为安静克制、耐看且信息密度充足的桌面客服工作台：用暖白纸面分层承托长时阅读，以深松青作为核心操作与品牌识别色，暖赭黄与湖松绿作为图表辅助色，零装饰性炫彩渐变。完整 CSS 变量定义固化于 `ui-preview/src/styles/globals.css`。

| 语义令牌 | 浅色模式 | 深色模式 | 作用位置 |
|---|---|---|---|
| `--sidebar` | `#f3f0ea` | `#0f1312` | 左侧可折叠导航栏与值守账号托盘底色 |
| `--background` | `#fcfbf8` | `#141918` | 主内容内嵌工作区画布 |
| `--card` / `--popover` | `#ffffff` | `#19201e` / `#1d2523` | 内容卡片、会话气泡、浮层与抽屉面板 |
| `--foreground` | `#18201e` | `#f1eee8` | 标题、正文、主要图标 |
| `--muted` | `#f2efe9` | `#1d2422` | 外层凹槽容器、分段标签槽、轻高亮背景 |
| `--muted-foreground` | `#5f6a66` | `#929e99` | 辅助说明、时间戳、表头文字 |
| `--primary` / `--primary-foreground` | `#0f5c52` / `#faf9f5` | `#2d9b8a` / `#091412` | 核心确认按钮、导航激活、AI 协助与客服气泡强调 |
| `--sidebar-accent` / `-foreground` | `rgba(15,92,82,0.085)` / `#0c4b43` | `rgba(48,160,142,0.14)` / `#84ddd0` | 侧栏当前激活项底色与文字 |
| `--border` / `--input` | `rgba(24,32,30,0.085)` / `0.13` | `rgba(241,238,232,0.08)` / `0.12` | 卡片结构细线与输入框描边 |
| `--success` / `--success-foreground` | `#16805b` / `#0e6043` | `#1ea674` / `#5cd4a6` | 在线值守、发送确认、自动回复开启 |
| `--warning` / `--warning-foreground` | `#c67a19` / `#96570b` | `#e09632` / `#f5bc69` | 待人工复核、通道需验证、额度预警 |
| `--destructive` / `--destructive-foreground` | `#c83e36` / `#9e2a23` | `#e0564e` / `#f28b85` | 紧急停止、异常冻结、删除操作 |
| `--info` / `--info-foreground` | `#2c6db2` / `#1f4f85` | `#4b8fd9` / `#85baf0` | AI 建议提示、知识参考命中 |
| `--chart-1` .. `--chart-5` | `#0f5c52`, `#c97f2a`, `#3b8a7d`, `#8a9b95`, `#d99f54` | `#30a08e`, `#e29d47`, `#5ec0b0`, `#7e8d88`, `#e6b772` | 趋势折线、时段柱图、AI 解决环与雷达图 |

---

## 三、字体体系（全离线可变字体，严禁外链 CDN）

所有字体通过 npm 本地打包进前端产物（遵守 Tauri CSP 与全离线运行要求），已在 Playwright 实渲染环境经 `document.fonts` 核验加载。

| 角色 | 字体栈 | npm 包与许可 | 适用场景 |
|---|---|---|---|
| 汉字与正文主栈 (`--font-sans`) | `"Inter Variable", "MiSans VF", "PingFang SC", "HarmonyOS Sans SC", "Noto Sans SC", sans-serif` | `misans@5.0.0` (Apache-2.0，频度切片可变 WOFF2，150-700) + `@fontsource-variable/inter@^5.3.0` (OFL-1.1) | 导航、会话消息、表单标签、表格正文、提示文案 |
| 标题与 KPI 数字 (`--font-heading`) | `"Plus Jakarta Sans Variable", "MiSans VF", "PingFang SC", "HarmonyOS Sans SC", sans-serif` | `@fontsource-variable/plus-jakarta-sans@^5.3.0` (OFL-1.1) + `misans@5.0.0` | 页面大标题、卡片标题、核心大数字（搭配 `tabular-nums`） |
| 编码与等宽 (`--font-mono`) | `"JetBrains Mono Variable", "Cascadia Mono", ui-monospace, SFMono-Regular, monospace` | `@fontsource-variable/jetbrains-mono@^5.3.0` (OFL-1.1) | 商品 SKU、快捷键徽标、模型标识、排障编号 |

排版约束：正文 `13.5px / 1.6`，表格与工具条 `12px-13px`，页面标题 `18px / 600`；中文正文严禁加负字距，数字与百分比统一启用 `font-variant-numeric: tabular-nums`。

---

## 四、用户体验第一准则与前后台分工

1. **日常 6 页说业务人话，排障观测独立收纳**：面向日常接待的 6 个工作区（工作台总览、会话中心、账号与通道、自动化规则、知识库与人格、多模型配置）及「数据统计」只呈现客服业务语言、清晰状态与明确动作；「治理与系统 -> 调度与审计」与「系统设置 -> 故障处理」定位为管理员排障与运维观测视图，按需承载进程隔离状态、内存采样、原页验证现场与只读脱敏审计账本。
2. **日常视野隐藏工程术语**：前 6 个日常工作区中不堆砌 `SendCoordinator`、`SQLite WAL`、`FTS5`、`DPAPI`、`maxRetries: 0`、`leaseGen`、`ownerLock`、`sha256`、`MCP` 顶栏常驻标签、进程内存 MB 等底层实现词汇。这些硬约束由后端与数据库持续静默强制执行。
3. **异常细节折叠展开**：仅当出现发送待确认、页面需验证或需要查看诊断记录时，通过折叠详情区（`<details>`）、「调度与审计」页或「系统设置 -> 故障处理」按需展开，不干扰日常接待视野。
4. **安全红线交互不妥协**：
   - 发送结果不明（`UNCERTAIN`）时只提供只读核对入口，绝不提供「重试发送」或强制解冻按钮。
   - 未保存的人工草稿自动暂存，切换会话、刷新与迟到回调绝不覆盖人稿。
   - 个人微信频道显式标明「前台运行」受限提示；全局紧急停止固定放置在「系统设置 -> 故障处理」，触发后顶部弹出醒目红条提示且重启不自解。

---

## 五、账号与客户头像采集规范

1. **接入即采集**：在「接入新平台账号」抽屉（`AddAccountSheet`）登录并确认账号后，自动同步采集该账号头像与名称，实时回显在左侧菜单栏「值守账号」快捷列表及账号卡片中。
2. **客户头像按需同步**：账号接入与详情设置提供「同步采集客户头像」开关（可按账号随时开关），开启后在会话队列、双侧聊天气泡与右侧客户资料卡显示客户头像，便于客服快速区分不同买家与客服身份。
3. **严格隐私、CSP 与安全边界**：
   - 真实运行期采集的头像仅作为本地缓存存入私有运行目录；阶段 5 前端加载真实头像时须复用既有受控 IPC 返回有界 `data:` URL（遵循 `desktop/src-tauri/tauri.conf.json` 现有 `img-src 'self' data:` 策略，不放宽 CSP 至公网 `https:`，不直接暴露本地磁盘路径），**严禁提交进 Git**，严禁写入公开日志。
   - 头像仅用于桌面界面视觉辨识：**严禁凭头像或昵称做目标放行校验**（仍严格依赖平台原生 ID 与 `SendCoordinator` 终核），**严禁把头像图片或链接送入大语言模型**。
   - `ui-preview/public/avatars/` 内 12 张 `192x192` JPG 均为合成演示图，仅供视觉预览使用。

---

## 六、桌面壳层、9 大主页面与 7 个核心抽屉/弹窗规格

### 1. 持久化桌面壳层

- **左侧立体分层侧栏（`AppSidebar`，`248px` / 折叠 `64px`，`Ctrl+B`）**：顶部 Harbor Frame 标识、工作室在线状态卡、全局搜索触发框（`Ctrl+K`）、三组业务导航（日常运营 / 资产与智能 / 治理与系统）及实时计数徽标、「值守账号」头像快捷托盘（含 `+ 接入` 快速入口）、今日自动回复进度与**统一自动回复总开关**。
- **顶部工具条（`TopBar`）**：当前页面面包屑、在线账号快捷跳转、当前全局模型名快捷跳转、全局搜索框（`Ctrl+K`）、手动「同步消息」按钮、最新动态提醒铃铛、浅/深色主题切换与值守角色标识；全局急停或安全待核验激活时在其正下方固定展示全局横幅。
- **最小窗口适配（`900x640`，匹配 `tauri.conf.json`）**：侧栏自动折叠为 `64px` 图标轨，会话中心右侧资料面板默认收起为顶角按钮按需抽屉打开，所有数据表格在其面板内横向滚动，整页零横向溢出。

### 2. 9 大主工作区逐页对照（替代旧 10 张静态概念图）

| 分组 | 页面名称（`PageId`） | 界面结构与核心体验 | 阶段 5 真实后端读模型与硬边界 |
|---|---|---|---|
| 日常运营 | **工作台总览**（`overview`） | 顶部运营 KPI、7/14/30 天双线趋势、09-19 分时段咨询柱图、AI 解决率环形图、高频咨询 Top 5、优先待处理队列、可搜索账号值守矩阵 | 绑定同一快照总览查询；区分已管理/在线/活跃浏览器；确认发送按首次可信收据唯一计数；零数据时返回真实零值，不填演示数 |
| 日常运营 | **会话中心**（`inbox`） | 三栏布局：左列带头像/平台徽标/待处理筛选的会话队列（`InboxQueuePanel`）；中列双侧头像气泡、内嵌商品咨询卡片、自动滚底、单行快捷工具栏与输入框（私信直发 / 评论弹层）；右列可折叠三标签资料卡（客户资料与意向度、AI 建议与知识命中、历史订单）（`InboxRightPanel`） | 跨账号分页使用稳定游标与 `accountRef`/`targetRef` 强绑定；草稿自动保存且切会话/刷新零覆盖；未知发送仅展冻结原因与只读核对；未开通媒体外发时隐藏或禁用不可用发送控件 |
| 资产与智能 | **账号与通道**（`accounts`） | 平台标签筛选（全部 / 抖音 / 企业微信 / 微信客服 / 小红书 / 个人微信）、账号实采头像卡、在线/待核验/前台受限状态、客户头像同步标记、自动回复单号开关与接入入口 | 绑定账号注册表与单持有者锁状态；新账号默认关闭自动外发；个人微信显式标注前台交互受限；解绑保留历史档案不删真实库 |
| 资产与智能 | **自动化规则**（`automation`） | 统一自动回复总开关、后台收取节奏与持续授权范围（时段/通道/有限或 `null` 无上限额度）、屏蔽词设置、规则命中预演器 | 复用持续授权与累计额度；关闭总开关不中断在线收取与人工回复；规则预演默认合成只读，不调用模型、不创建发送意图 |
| 资产与智能 | **知识库与人格**（`knowledge`） | 知识文档列表（含同主题冲突告警与启停开关）、聊天样本采纳、五轴人设风格雷达图、人格版本发布/回退与基线对比试聊 | 复用 `src/knowledge/` 与中文 FTS5；区分账号私有与显式共享范围；知识变更使未提交草稿重新校验；试聊无发送入口 |
| 资产与智能 | **多模型配置**（`models`） | 多提供商连接卡片（DeepSeek / OpenAI / Claude / Gemini 等）、凭据已配置状态、响应耗时对比柱图、当前模型适用场景与边界卡片、单次连通性测速 | 对接阶段 2 多模型 V1.0 契约（[MODEL-CONTRACT.md](../../docs/MODEL-CONTRACT.md)）：**全应用维护唯一当前全局模型选择（SQLite `m_selection`）**，各业务链路统一随全局模型联动切换，不引入未批准的跨模型分场景路由；API Key 仅存后端内存或 Windows CurrentUser DPAPI，前端绝不回显明文；禁止自动重试（`maxRetries: 0`） |
| 治理与系统 | **调度与审计**（`runtime`） | 管理员排障视图（三标签）：运行与资源（进程隔离拓扑与内存采样）、安全核验现场、本地脱敏操作审计账本（只读 + 导出） | 承接底层运行观测、原无头页内安全核验入口与只读脱敏审计查询；失败不伪造成功水位，不以动画模拟队列 |
| 治理与系统 | **数据统计**（`analytics`） | 近 7/14/30 天切换、基于确认送达账本的自动回复与人工接管构成柱图、今日各账号服务明细与 CSV 导出 | 统计按唯一已确认 `intentId` 聚合，明确分母；历史来源未知单列，不猜测补填；按配置时区聚合、原 UTC 审计保留 |
| 治理与系统 | **系统设置**（`settings`） | 私有运行目录与数据库一致备份、本机助手连接（MCP 16 工具独立启停）、隐私边界与预览缓存维护、外观主题/字体与快捷键、故障处理与全局急停 | 保留可信开发入口运行目录保护；一致备份走 SQLite Backup API；全局急停独立通道且持久不自解；清理缓存不触碰未知意图与恢复证据 |

### 3. 7 个核心抽屉与弹窗流（`AppOverlays.tsx`）

1. `VerifyHeadlessDialog`：原无头页面实时安全核验（保持同文档绑定，仅做受限指针/键盘核验，不重建页面）。
2. `CommentReplyDialog`：评论与楼中楼人工回复弹窗（展示原作品/父评论上下文，一次点击「发送」提交）。
3. `AccountDetailSheet`：账号值守详情与「同步采集客户头像」开关抽屉。
4. `AddAccountSheet`：接入新平台账号抽屉（平台选择、授权后实时头像与昵称拉取回显、客户头像同步开关）。
5. `ModelEditorSheet`：新增/编辑模型连接抽屉（协议、端点、凭据存储策略，不回显旧 Key）。
6. `CommandPaletteDialog`：全局命令面板（`Ctrl+K`，页面跳转、主题切换）。
7. `ConnectPreviewDialog`：首次连接本地私有运行目录引导弹窗。

### 4. 已固化视觉基准截图（`assets/brand/screenshots/`）

| 截图文件 | 对应界面 | 核心验收要点 |
|---|---|---|
| `assets/brand/screenshots/01-overview.png` | 工作台总览 | 顶栏、值守账号头像托盘、7/14/30 天双线趋势、分时段柱图、AI 解决率环形图、高频咨询占比、账号矩阵 |
| `assets/brand/screenshots/02-inbox-light.png` | 会话中心（浅色） | 暖白纸感底色、三栏布局、双侧头像气泡、内嵌商品咨询卡片、单行快捷发送区、三标签客户与订单侧栏 |
| `assets/brand/screenshots/03-inbox-dark.png` | 会话中心（深色） | 深松墨底色层级（`#0f1312` -> `#141918` -> `#19201e`）、高对比可读性、非刺眼状态徽标 |
| `assets/brand/screenshots/04-accounts.png` | 账号与通道 | 多平台账号卡片、实采账号头像与状态徽标、客户头像同步标记、通道运行说明 |
| `assets/brand/screenshots/05-knowledge.png` | 知识库与人格 | 知识文档管理、五轴人设风格雷达图、自然业务用语 |
| `assets/brand/screenshots/06-models.png` | 多模型配置 | 模型连接状态卡、响应耗时对比柱图、任务用途与安全边界说明（落地时绑定唯一全局模型） |
| `assets/brand/screenshots/07-add-account.png` | 接入新平台账号抽屉 | 平台选择、登录后实时头像与昵称拉取回显、「同步采集客户头像」开关 |

---

## 七、阶段 5 生产前端迁移清单（迁入根目录与 `desktop/src/`）

本仓库采用**单一根目录 `package.json`** 管理全部 Node 与 `desktop/` 前端依赖（不存在独立 `desktop/package.json`）。阶段 5 启动正式前端替换时，直接复用 `ui-preview/` 已验证资产：

1. **依赖迁入与大版本兼容核验**：在根目录 `package.json` 锁定 `@base-ui/react@1.9.0`、`tailwindcss`（v4）、`@tailwindcss/vite`、`class-variance-authority`、`clsx`、`tailwind-merge`、`lucide-react`、`misans@5.0.0` 及 `@fontsource-variable/{inter,plus-jakarta-sans,jetbrains-mono}@^5.3.0`。注意根目录当前已使用 `react@19.3.1`、`vite@8.3.6`、`typescript@7.0.2`（高于 `ui-preview` 的 `vite@7.1.7` / `typescript@5.9.3`），迁入时须先通过 `desktop/vite.config.ts` 与 `pnpm typecheck` 实测 Tailwind v4 插件与类型兼容性，不得降级根工程工具链。
2. **CSP 与离线字体核对**：确认 `misans` 与 `@fontsource-variable/*` 打包产出的 `.woff2` 走本地 `'self'` 资源（匹配 `desktop/src-tauri/tauri.conf.json` 的 `default-src 'self'`），真实头像走受控 IPC 返回有界 `data:` URL（匹配 `img-src 'self' data:`），零外部网络请求。
3. **令牌与原语直搬**：直接拷贝 `ui-preview/src/styles/globals.css`、`ui-preview/src/lib/utils.ts` 与 `ui-preview/src/components/ui/*` 至 `desktop/src/`，彻底移除旧 CSS，禁止新旧两套样式混写在同一页面。
4. **契约先行再逐批替换**：在 `src/contracts/` 与 `protocol-v2` 补齐本地头像安全预览、多账号总览、规则、调度与统计读模型后，按「壳层与导航 -> 会话中心 -> 账号与通道 -> 自动化规则 / 知识库与人格 / 多模型配置 -> 调度与审计 / 系统设置 -> 工作台总览 / 数据统计」逐批替换，保留未替换页面可用。
5. **交付门禁**：每批替换后必须通过 `pnpm typecheck`、`pnpm test`、`pnpm check:privacy`、`pnpm check:source-size`（所有受影响文件 <= 800 物理行）、双链实测及原生开发窗人工差异验收，完成 ADR-005 三轮独立审查后收口。
