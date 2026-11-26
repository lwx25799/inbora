# inbora

Windows 本地优先的智能客服桌面工作台（Tauri v2 + React + Node.js/TypeScript + Playwright + SQLite）。当前开发版仍维持版本号 **0.3.5**，在单账号抖音实机基线之上，已按 [架构决策与演进路线](docs/ARCHITECTURE-DECISIONS.md)（修订版路线 A+）合入 **阶段 0 ~ 阶段 3** 的底层架构演进代码（纯 `contracts` 契约层、`PlatformConnector`、多模型提供商 V1.0、显式 `schema4` 与 `legacy_target_aliases`、协议 v2、独立 Node Browser Worker 及 Tauri Rust Win32 能力桥），下一步待推进 **阶段 4（多平台分批接入）** 与 **阶段 5（9 页正式版工作台逐批替换）**。

## 当前代码基线与验证边界（0.3.5 开发版）

- **单账号抖音双通道自动化与安全发送（已有实机范围 GO）**：专属无头静音 Edge Profile、单持有者锁、持久运行起点、新作品自动发现、评论（含楼中楼）与私信增量补收及对象级公平退避；会话级人工接管与自动保稿、唯一 `SendCoordinator` 事务持久意图与单次提交、`UNCERTAIN` 与崩溃恢复严禁自动重发、网页未发送人稿零覆盖、原无头页内安全验证接管。
- **本地知识库、回复人格与本机 MCP 助手**：内置本地知识库导入（TXT/MD/DOCX/文字 PDF/CSV/XLSX）、聊天样本筛选、人格草稿学习与试聊对比（见 [知识与回复人格](docs/KNOWLEDGE-PERSONA.zh-CN.md)）；内置 `@modelcontextprotocol/server` 2.4.0 stdio 入口与 16 个受控工具（DPAPI 鉴权，复用客户端授权与唯一发送协调器，见 [操作与恢复说明](docs/AUTOMATION-OPERATIONS.md)）。
- **多模型提供商 V1.0（阶段 2 代码与离线/合成回归已合入；付费调用与原生 GUI 人工交互待本人实测）**：支持 DeepSeek、OpenAI、Claude、Gemini、通义千问、豆包、硅基流动、OpenRouter 与自定义云端连接，全应用维护唯一当前模型选择（SQLite `m_selection`），独立凭据存储于后端内存或 Windows CurrentUser DPAPI，禁止自动重试（见 [多模型提供商 V1.0 路由契约](docs/MODEL-CONTRACT.md)）。
- **内核解耦与多账号隔离底座（阶段 1 与阶段 3 代码与离线/合成回归已合入）**：已抽离纯共享 `src/contracts/` 与 `src/platform/`（`PlatformConnector`），落地显式 `schema4` 迁移、`legacy_target_aliases`、鉴权 stdio 协议 v2、独立 Node Browser Worker（`src/workers/`，禁止直连 SQLite）、Tauri Rust Win32 能力桥（`src/native/`）及 3 页过渡界面内的最小账号面板；真实多平台接入留待阶段 4，9 页正式界面替换留待阶段 5。

## 启动入口与阶段 5 前端视觉基线区分

- **当前开发启动入口（`启动inbora.cmd`）**：位于项目根目录。脚本优先使用当前 `PATH` 中的 `pnpm`（缺失时尝试开发机本地回退工具链目录）；若本机存在私有开发启动脚本则转交执行，否则直接调用 `pnpm desktop:dev` 启动当前过渡版 3 页 Tauri 开发壳与 Vite 热更新，由用户在连接页打开或恢复本机私有运行目录。该入口依赖本机 Node/pnpm 与 Rust/MSVC 开发环境，不是独立可分发安装包；仅在明确要求打包时才执行 `pnpm desktop:build`。
- **阶段 5 正式版前端视觉与交互基线（`ui-preview/` 与 `assets/brand/`）**：采用已定稿的 **Harbor Frame（归港方匣）** 品牌套件、暖白纸感 + 深松青浅深双主题、`cosscom/ui` + `@base-ui/react@1.9.0` + Tailwind CSS v4 组件体系，以及全离线打包的可变字体栈（`MiSans VF` + `Plus Jakarta Sans Variable` + `Inter Variable` + `JetBrains Mono Variable`），完整覆盖 9 大业务工作区与 7 个核心抽屉/弹窗，落实用户体验第一准则与账号/客户头像本机采集展示规范。
  - `ui-preview/` 使用离线合成数据与合成演示头像，完全独立于当前 `src/` 与 `desktop/`，不连接真实后端、数据库、浏览器或平台账号，不代表阶段 5 正式界面已完成真实后端接线。
  - 7 张 2x 实渲染视觉参考图见 `assets/brand/screenshots/`，完整设计与阶段 5 迁移规范见 [品牌标识与阶段 5 前端视觉规范](assets/brand/BRAND-AND-UI-SPEC.md)，本地交互预览说明见 [阶段 5 前端交互基线说明](ui-preview/README.md)。

## 环境与常用开发命令

支持目标为 Windows 10 / Windows 11 x64（当前实机基线为 Windows 10 专业版 x64 Build 19045，Windows 11 列为正式版待验）。依赖锁定为 Node `24.22.1+` 或 `26.13.0+`、pnpm `11.25.0`、Microsoft Edge 与 `better-sqlite3@13.0.3` 预编译 Node-API 包（禁止隐式 `node-gyp` 构建）。

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm test:built
pnpm check:privacy
pnpm check:source-size
```

桌面、CLI 与阶段 5 界面基线预览入口：

```powershell
pnpm desktop:dev:web          # 启动当前桌面前端 Vite 开发服务
pnpm desktop:dev              # 启动当前 Tauri 开发窗口 + Vite 热更新 + Node Sidecar
pnpm inbora --help            # 源码 CLI 帮助（tsx 链）
node dist/cli.js --help       # 编译后 CLI 帮助（普通 Node 链）

# 独立浏览阶段 5 前端视觉与交互基线（不连接真实数据）
cd ui-preview; npm.cmd install; npm.cmd run dev
```

CLI 默认数据目录为 `%LOCALAPPDATA%\inbora`，开发调试可通过 `--runtime <私有目录>` 指定独立私有运行目录。浏览器 Profile、Cookie、API Key、真实 SQLite 数据库、私人消息、本机缓存的真实头像与原始页面证据仅保存在本机私有运行目录，严禁提交到仓库；切勿通过删除数据库重新初始化来清除发送意图或预算记录。

## 现行文档导航（Git 追踪）

| 文档 | 用途 |
|---|---|
| [架构决策与演进路线](docs/ARCHITECTURE-DECISIONS.md) | 唯一权威架构裁决（ADR-001 ~ ADR-006：修订版路线 A+、6 阶段路线与现状、分域规则、硬安全红线、三轮审查纪律与阶段 5 视觉/交互基线） |
| [核心契约与 schema4 规范](docs/CORE-PROTOCOL-AND-SCHEMA4.md) | 阶段 1/3 已合入底层契约：`PlatformConnector`、鉴权协议 v2、单库 `schema4` 迁移、独立 Browser Worker 与 Rust Win32 能力桥 |
| [阶段交接与实机待验总表](docs/STAGE-HANDOFF.md) | 全 6 阶段基线提交、离线/合成覆盖、待本人实机补验项与阶段 4 新会话接棒指引 |
| [品牌标识与阶段 5 前端视觉规范](assets/brand/BRAND-AND-UI-SPEC.md) | Harbor Frame 品牌套件、暖白纸感/深松青令牌、离线可变字体、用户优先准则、头像采集边界、9 页逐页功能与契约对照及迁移清单 |
| [阶段 5 前端交互基线说明](ui-preview/README.md) | `ui-preview/` 本地预览命令、目录结构与演示边界 |
| [多模型提供商 V1.0 路由契约](docs/MODEL-CONTRACT.md) | 现行阶段 2 多模型单一全局路由（`m_selection`）、四协议与 9 供应商验证矩阵 |
| [0.3.x 操作与恢复手册](docs/AUTOMATION-OPERATIONS.md) | 当前过渡版桌面端操作指引：日常值守、多模型与单库多账号入口、原无头页内安全验证、本机 MCP 16 工具与备份恢复 |
| [知识与回复人格](docs/KNOWLEDGE-PERSONA.zh-CN.md) | 本地知识库导入、聊天样本采纳、人格学习、试聊对比及数据调用边界 |
| [第三方来源与许可台账](UPSTREAM.md) | 全仓依赖版本、固定上游源码核对记录与许可证归档索引 |

## 历史记录与已清理资产说明

- 早期单账号 PoC CLI（含已停用的 `compare-modes` 与在 schema3/4 下禁用的 `approve`、`retry-comment-once`）及 0.2.9 最小客户端阶段验收材料已归档至本机被忽略的历史归档目录，仅供审计回溯，不再作为当前操作指引或后续研发依据。
- 早期静态概念效果图（旧 `Inbora_UI_效果图合集/`）与旧版单页 HTML 原型（旧 `Inbora原型.html` 与 `prototype/`）已正式清理移除，阶段 5 前端统一以 `assets/brand/` 与 `ui-preview/` 为准。
