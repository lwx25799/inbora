# inbora 品牌标识与阶段 5 前端视觉规范

本文档固化已通过验收的 **inbora Harbor Frame（归港方匣）** 品牌标识套件、暖白纸感与深松青视觉体系、全离线可变字体方案、用户优先交互准则、头像采集隐私边界，以及阶段 5 迁入 `desktop/src/` 生产前端的落地清单。

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

界面定位为安静克制、耐看且信息密度充足的桌面客服工作台：用暖白纸面分层承托长时阅读，以深松青作为核心操作与品牌识别色，暖赭黄与湖松绿作为图表辅助色，零装饰性炫彩渐变。Exact CSS 变量定义固化于 `ui-preview/src/styles/globals.css`。

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

1. **前台说业务人话，后台静默守底线**：日常工作区（工作台总览、会话中心、账号管理、自动回复规则、知识库与人设、模型管理、数据统计、系统设置）只向操作员呈现与客服业务直接相关的信息、状态与动作。
2. **隐藏工程实现术语**：日常界面中不出现 `SendCoordinator`、`SQLite WAL`、`FTS5`、`DPAPI`、`maxRetries: 0`、`leaseGen`、`ownerLock`、`sha256`、`MCP` 顶栏常驻标签、进程内存 MB 等底层实现词汇。这些硬约束由后端与数据库持续静默强制执行。
3. **排障信息折叠收纳**：仅当出现发送待确认、页面需验证或需要查看诊断记录时，通过折叠详情区（`<details>`）、「运行状态」页或「系统设置 -> 故障处理」按需展开，不干扰日常接待视野。
4. **安全红线交互不妥协**：
   - 发送结果不明（`UNCERTAIN`）时只提供「核对状态」只读入口，绝不提供「重试发送」按钮。
   - 未保存的人工草稿自动暂存，切换会话、刷新与迟到回调绝不覆盖人稿。
   - 个人微信频道显式标明「前台运行」受限提示；全局紧急停止固定放置在「系统设置 -> 故障处理」，触发后顶部弹出醒目红条提示。

---

## 五、账号与客户头像采集规范

1. **接入即采集**：在「添加账号」抽屉（`AddAccountSheet`）登录并确认账号后，自动同步采集该账号头像与名称，实时回显在左侧菜单栏「值守账号」快捷列表及账号管理卡片中。
2. **客户头像按需同步**：账号接入配置提供「同步采集客户头像」开关（可按账号随时开关），开启后在会话队列、双侧聊天气泡与右侧客户资料卡显示客户头像，便于客服快速区分不同买家与客服身份。
3. **严格隐私与安全边界**：
   - 真实运行期采集的头像仅作为本地缓存存入私有运行目录，**严禁提交进 Git**，严禁写入公开日志。
   - 头像仅用于桌面界面视觉辨识：**严禁凭头像或昵称做目标放行校验**（仍严格依赖平台原生 ID 与 `SendCoordinator` 终核），**严禁把头像图片或链接送入大语言模型**。
   - `ui-preview/public/avatars/` 内 12 张 `192x192` JPG 均为合成演示图，仅供视觉预览使用。

---

## 六、页面布局、组件密度与 7 张视觉基准图

### 1. 桌面空间结构

- **固定顶栏（`TopBar`）**：当前页面语境、全局快捷搜索（`Ctrl+K`）、自动回复总开关、深浅色切换与快捷入口。
- **立体分层侧栏（`AppSidebar`，`244px` / 折叠 `56px`）**：品牌标识、主导航（含待处理红点计数）、「值守账号」头像快捷托盘（含 `+ 接入` 快速入口）与底部本地工作区状态卡。
- **三栏会话中心（`InboxQueuePanel` + `InboxView` + `InboxRightPanel`）**：左侧带头像/平台徽标/未读与待复核筛选的会话队列，中间带双侧头像气泡、商品咨询卡片、自动滚底与单行富工具栏输入框的对话主区，右侧可折叠三标签面板（客户资料与意向度、AI 建议与知识命中、历史订单）。
- **最小窗口适配（`900x640`）**：侧栏可收起至图标轨，右侧资料面板默认收起为抽屉按需打开，表格在卡片内部横向滚动，整页零横向溢出。

### 2. 已固化视觉基准截图（`assets/brand/screenshots/`）

| 截图文件 | 对应界面 | 核心验收要点 |
|---|---|---|
| `assets/brand/screenshots/01-overview.png` | 工作台总览 | 顶部工具条、值守账号头像托盘、7/14/30 天双线趋势、分时段柱图、AI 解决率环形图、高频咨询占比、账号状态矩阵 |
| `assets/brand/screenshots/02-inbox-light.png` | 会话中心（浅色） | 暖白纸感底色、三栏布局、双侧头像气泡、内嵌商品咨询卡片、单行快捷发送区、三标签客户与订单侧栏 |
| `assets/brand/screenshots/03-inbox-dark.png` | 会话中心（深色） | 深松墨底色层级（`#0f1312` -> `#141918` -> `#19201e`）、高对比可读性、非刺眼状态徽标 |
| `assets/brand/screenshots/04-accounts.png` | 账号管理 | 多平台账号卡片、实采账号头像与状态徽标、客户头像同步标记、通道运行说明 |
| `assets/brand/screenshots/05-knowledge.png` | 知识库与人设 | 知识文档管理、五轴人设风格雷达图、本地化自然业务用语 |
| `assets/brand/screenshots/06-models.png` | 模型管理 | 模型连接状态卡、响应耗时对比柱图、按场景路由分配表 |
| `assets/brand/screenshots/07-add-account.png` | 添加账号抽屉 | 平台选择、登录后实时头像与昵称拉取回显、「同步采集客户头像」开关 |

---

## 七、阶段 5 生产前端迁移清单（迁入 `desktop/src/`）

阶段 5 启动正式前端替换时，直接复用 `ui-preview/` 已验证资产，避免推倒重来：

1. **依赖迁入**：在 `desktop/package.json` 锁定 `@base-ui/react@1.9.0`、`tailwindcss@^4.1.17`、`@tailwindcss/vite@^4.1.17`、`class-variance-authority`、`clsx`、`tailwind-merge`、`lucide-react`、`misans@5.0.0` 及 `@fontsource-variable/{inter,plus-jakarta-sans,jetbrains-mono}@^5.3.0`。
2. **令牌与原语直搬**：直接拷贝 `ui-preview/src/styles/globals.css`、`ui-preview/src/lib/utils.ts` 与 `ui-preview/src/components/ui/*` 至 `desktop/src/`，彻底移除旧 CSS，禁止新旧两套样式混写在同一页面。
3. **契约先行再换页**：在 `src/contracts/` 与 `protocol-v2` 补齐头像本地安全预览协议（走本机鉴权读取，不落公网外链）、多账号总览、规则、模型与统计读模型后，按「壳层与导航 -> 会话中心 -> 总览与账号 -> 知识库与人设 -> 规则/模型/统计/设置」逐批替换。
4. **交付门禁**：每批替换后必须通过 `pnpm typecheck`、`pnpm test`、`pnpm check:privacy`、`pnpm check:source-size`（所有受影响文件 <= 800 物理行）及双链实测。
