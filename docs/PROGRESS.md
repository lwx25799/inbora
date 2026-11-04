# 实施与证据记录

## 2026-11-04：基线

- 已完整读取 AGENTS.md、GOAL.zh-CN.md 与 POC-SPEC.md；目录原来仅含规则和三份需求文档，无 Git 仓库或代码。
- 顺序：P0 环境/独占/双 Page → 事件持久化与两通道读取 → 审批/一次性发送/回读 → 故障恢复与模式对照 → 全量审查及实机交接。
- 每个切片使用相关测试验证；交接前运行 typecheck、unit、integration、local-browser e2e、build 和 CLI 冒烟。
- 当前 Node 26.13.0（官方发布表列 v26 为 LTS）、pnpm 11.25.0、Edge 156.0.4314.58；依赖使用精确版本和锁文件。
- 已核对 Playwright 持久 Context 与 msedge channel 文档、better-sqlite3 WAL/事务文档、SQLite WAL 文档及 Vitest 配置文档。SQLite 使用 WAL + synchronous=FULL。
- 公开首页抓取无可读 DOM；登录后通知、会话、身份和回复结构尚未观察，不能据设计示例假定选择器。实际页面映射独立校准；未校准时禁止真实采集和发送。
- 真实模型调用：0；真实发送：0；实机验收：未执行；最终 GO：未判定；P5：未启动。

参考：[Node 发布表](https://nodejs.org/en/about/previous-releases)、[Playwright](https://playwright.dev/docs/api/class-browsertype)、[浏览器渠道](https://playwright.dev/docs/browsers)、[better-sqlite3](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)、[SQLite WAL](https://sqlite.org/wal.html)、[Vitest](https://vitest.dev/config/)。

## 切片 1：安全内核（本地验证）

- 建立严格 TS/ESM、精确依赖、pnpm 锁文件；pnpm 的内置启动运行时为 Node 24.22.1，项目命令 PATH 实际为 Node 26.13.0，两者均为受支持 LTS。仅项目内允许 SQLite/esbuild 原生构建，未修改全局配置。
- SQLite WAL/FULL、独立基线水位、事件去重/碰撞阻断、版本化审批、账号队列、唯一点击意图、收据及崩溃恢复接通。
- 本轮 typecheck、4 单元测试、17 集成测试通过。测试使用合成数据与本机持久 SQLite，没有访问真实私信、模型或发送。
- 初轮集成测试发现 INSERT 占位数错误，已修正并完整复跑通过。所有原生数据库测试均实际运行。
- 本地提交切片，尚未推送；首次推送前将审查包含需求基线和所有实现的完整待推送历史。

## 切片 2：浏览器链路和 CLI（本地验证）

- 专属持久 Edge Profile、OS 生命周期排他锁、两个专用 Page、统一账号队列已实现；实际双进程排他及杀进程后锁释放通过。
- 通知入口→原评论、私信入口→准确会话均由 DOM 适配器实际操作 Playwright Page。页面映射集中校验，夹具映射明确标为 synthetic，真实入口拒绝使用夹具配置。
- CLI 已接通初始化、状态、登录、采集、Mock/显式授权 HTTP 模型、编辑、交互审批、单次发送、暂停、未知态查看、模式对比、证据与保留期。真实模型适配为明确 JSON/HTTPS 契约，离线 transport 测试不构成真实供应商验收。
- 本轮 typecheck、6 单元、21 集成、7 Edge 浏览器 e2e 通过；有头/无头均走通两通道完整夹具闭环。另验证会话切换延迟、批准后新消息、真实 Page 中断和待审核回读。
- 原始页面、私人数据和测试数据库仅留本机私有目录；未登录真实账号、未读取真实私信、未发真实消息、未调用付费模型。
- 所有当前代码仍需首次推送前的全范围审查与最终复验；不作为真实验收通过。
