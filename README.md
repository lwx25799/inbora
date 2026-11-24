# inbora

Windows 本地优先的智能客服桌面工作台（Tauri v2 + React + Node.js/TypeScript + Playwright + SQLite）。当前开发版为 **0.3.5**，已落地抖音单账号双通道自动化、本地知识库与回复人格学习、本机 MCP 助手连接及原无头页内安全验证接管，正按 [架构决策与演进路线](docs/ARCHITECTURE-DECISIONS.md)（修订版路线 A+）推进多模型、多账号与多平台演进。

## 当前 0.3.5 已落地能力

- **单账号双通道后台自动化**：专属无头静音 Edge Profile、单持有者锁、持久运行起点、新作品自动发现、评论（含楼中楼）与私信增量补收及对象级公平退避；收件箱支持「未读 / 等待回复 / 需人工查看 / 已回复 / 全部消息」筛选与统一「自动回复：开／关」开关。
- **人工工作台与安全发送合同**：会话级人工接管与自动保稿、连续人工回复排队、唯一 `SendCoordinator` 事务持久意图与单次提交、送达回读与有界只读补证、`UNCERTAIN` 与崩溃恢复严禁自动重发、网页未发送人稿零覆盖。
- **AI 建议、本地知识库与回复人格**：支持 DeepSeek 建议与策略自动回复（API Key 仅存后端内存或本机 Windows CurrentUser DPAPI）；「AI 与设置」内置本地知识库导入（TXT/MD/DOCX/文字 PDF/CSV/XLSX）、聊天样本筛选、人格草稿学习与试聊对比（检索与风格规则方案，不微调权重，详见 [知识与回复人格](docs/KNOWLEDGE-PERSONA.zh-CN.md)）。
- **本机助手连接（MCP）**：内置 `@modelcontextprotocol/server` 2.4.0 stdio 入口与 16 个受控工具（DPAPI 鉴权，复用客户端既有账号范围、累计额度与唯一发送协调器，GUI 独立启停控制，详见 [操作与恢复说明](docs/AUTOMATION-OPERATIONS.md)）。
- **原无头页内安全验证接管**：命中安全验证时暂停受影响通道，支持在客户端弹窗内点击「处理原验证页面」直接查看无头原文档实时画面并完成受限指针/键盘核验，不切换重建页面；平台明确要求重新登录（`LOGIN_REQUIRED`）或本人显式查看会话时使用静音有头窗口并在完成后返回无头运行。

## 启动入口与静态原型区分

- **开发启动入口（`启动inbora.cmd`）**：位于项目根目录。脚本优先使用当前 `PATH` 中的 `pnpm`（缺失时尝试开发机本地回退工具链目录）；若本机存在私有开发启动脚本则转交执行，否则直接调用 `pnpm desktop:dev` 启动 Tauri 开发壳与 Vite 热更新，由用户在连接页打开或恢复本机私有运行目录。该入口依赖本机 Node/pnpm 与 Rust/MSVC 开发环境，不是独立可分发安装包；仅在明确要求打包时才执行 `pnpm desktop:build`。
- **静态设计预览（`Inbora原型.html` / `prototype/` / `Inbora_UI_效果图合集/`）**：根目录 `Inbora原型.html` 与 `Inbora_UI_效果图合集/` 中的 10 张 PNG 为**纯静态视觉与交互设计预览**，全部使用本地演示数据且由 CSP 禁止网络连接，不连接真实后端、数据库、浏览器或平台账号，不代表当前 0.3.5 已实现多账号或多平台运行界面。详见 [交互原型说明](prototype/README.md) 与 [效果图清单](Inbora_UI_效果图合集/README.md)。

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

桌面与 CLI 入口：

```powershell
pnpm desktop:dev:web          # 仅启动前端 Vite 开发服务
pnpm desktop:dev              # 启动 Tauri 开发窗口 + Vite 热更新 + Node Sidecar
pnpm inbora --help            # 源码 CLI 帮助（tsx 链）
node dist/cli.js --help       # 编译后 CLI 帮助（普通 Node 链）
```

CLI 默认数据目录为 `%LOCALAPPDATA%\inbora`，开发调试可通过 `--runtime <私有目录>` 指定独立私有运行目录。浏览器 Profile、Cookie、API Key、真实 SQLite 数据库、私人消息与原始页面证据仅保存在本机私有运行目录，严禁提交到仓库；切勿通过删除数据库重新初始化来清除发送意图或预算记录。

## 现行文档导航（Git 追踪）

| 文档 | 用途 |
|---|---|
| [架构决策与演进路线](docs/ARCHITECTURE-DECISIONS.md) | 唯一权威架构裁决（ADR-001 ~ ADR-005：修订版路线 A+、6 阶段路线、分域规则、硬安全红线与三轮审查纪律） |
| [0.3.x 操作与恢复说明](docs/AUTOMATION-OPERATIONS.md) | 原无头页内安全验证、本机 MCP 16 工具接入、开发重载、日常操作与异常恢复 |
| [知识与回复人格](docs/KNOWLEDGE-PERSONA.zh-CN.md) | 本地知识库导入、聊天样本采纳、人格学习、试聊对比及数据调用边界 |
| [第三方来源与许可台账](UPSTREAM.md) | 依赖版本、开源实现核对记录与复用约束 |
| [诊断复用许可说明](docs/UPSTREAM-REUSE-DIAGNOSTICS.md) | 统计聚合与有界证据维护模块的来源与 MIT 许可声明 |
| [历史模型 HTTP 契约（已废弃）](docs/MODEL-CONTRACT.md) | 仅作早期 schema2 CLI 历史契约留档；现行模型与演进路线见 ADR |
| [交互原型说明](prototype/README.md) | `Inbora原型.html` 演示边界（另见 [原型验证](prototype/VERIFICATION.md)、[原型上游对照](prototype/UPSTREAM-COMPARISON.md)） |

## 历史记录说明

早期单账号 PoC CLI（含已停用的 `compare-modes` 与在 schema3 下禁用的 `approve`、`retry-comment-once`）及 0.2.9 最小客户端阶段验收材料已归档至本机被忽略的历史归档目录，仅供审计回溯，不再作为当前 0.3.5 操作指引或后续多平台研发依据。
