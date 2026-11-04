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
