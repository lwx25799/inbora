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

## 切片 3：审查回归修复

- Deep审查完成安全、架构专家及四个adversarial角度；高风险点击竞态经独立复现和skeptic调用链验证后修复。全部审查仅使用本机合成数据。
- 先实际运行3项浏览器红测和6项集成红测，确认原版失败；修复实际点击时同步身份/上下文/文本门禁、初始无pane、迟加载旧历史、敏感邮箱、已确认发送上下文、运行中pause和status任务恢复。
- 同形检查补充pointerover、pointerdown、document click capture三个时间点，人工已发送消息后的旧审批不再放行；暂停使未点击旧审批失效。点击意图提交前门禁不启用。
- 补充实际子进程硬退出86后SQLite恢复、独立Profile双Page共享和关闭后Cookie复用、证据保留期及非所属文件保护。
- 后续实际默认tsx子进程发现__name函数序列化差异，新增独立红测后修复；源码CLI真实浏览器夹具完整发送/回读已通过。首个交付schema为2，旧未发布schema1明确拒绝而不覆盖。
- 当前仍在最终复验及审查收尾，真实模型调用0、真实发送0、实机用例未执行、P5未启动。

## 最终复审的根因调整

- 点击门禁的同根晚挂处理器复现促使调整提交策略：在一个浏览器同步任务中最终核验、重挂目标门禁并对已绑定元素DOM click。原late-handler复现现在CONFIRMED且只有一次准确A会话/批准文本提交；document capture篡改仍阻断。没有物理点击或私有接口回退。实际抖音是否接受该UI路径仍待校准。
- 回执补严格晚于持久意图的可核验绝对发送时间，隐藏旧同文回读红测转为UNCERTAIN。首次基线和推进水位分开，迟到新消息保留在人工队列。
- 安全、架构和独立adversarial复审均已关闭本轮可复现发现，未遗留已知阻断代码缺陷；真实验收仍全部未验证。
- 最终全套验证通过：pnpm frozen install、typecheck、6单元、34集成、15浏览器e2e、build；另普通Node构建后两通道冒烟在Node24/26均通过，Edge进程资源统计实测有值。隐私扫描器已用known-good/known-bad自测。最终审查与远程交接证据记录于REVIEW.md。
- 最终实现提交`6845d55c03409edfe704695094bcfb86c4fbd80e`。启动说明、完整实机清单、L/N/D/S/H/M及C01—C06对应表已准备；推送完成并核对远程后再集中邀请用户进入实机阶段。目标继续有效，不能把此交接记作完成。
- 首次干净检出补验发现pnpm误触发v13 SQLite隐式node-gyp，因无VS编译链失败；已从包实际loader与官方源码确认自带Windows Node-API二进制，项目策略禁止这项不必要构建，仅保留esbuild安装脚本。不安装全局编译器、不跳过SQLite运行检查；全新检出继续复验。
- 独立干净检出`b1447a0`已实测：frozen首次安装550ms成功，typecheck、6单元、34集成、15浏览器、build、compiled双通道冒烟、全部历史隐私扫描均通过，结束时无跟踪文件变化。原失败检出保留本机证据，未删除用户文件。
- Win32_OperatingSystem实际报告Windows10专业版x64（10.0.19045），原方案Windows11仍未验证；不会擅自替换验收基线，实机交接时集中核对。
