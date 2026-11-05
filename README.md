# inbora

Windows 单账号、评论通知与私信双通道的受控浏览器 PoC。当前提供 Node.js / TypeScript / Playwright / SQLite 内核和 CLI；真实抖音页面及真实收发尚未验收，最终 GO 尚未判定。

2026-11-05用户允许两个已授权本人作品的有界评论读取作为补充发现源。正式源码CLI已完成受控私信、首个作品评论各五轮只读采集及SQLite去重；D02三条私信独立保留已实机通过，其余逐项见测试矩阵。顶部通知原用例仍单列，补充来源不冒称通知通过。当前使用原生有头Edge，无UA覆写；真实发送、可信回执及最终GO仍未完成。

当前实现使用独立 Edge Profile、两个专用 Page 和账号级串行队列。草稿默认使用确定性 Mock。每条真实回复必须在本机交互终端核对目标及完整文本后批准；点击意图先写入 SQLite，提交一次后读取准确原评论或准确会话的新回执。未知结果冻结目标，不提供自动重发。

本项目浏览器从启动时即静音，覆盖有头、无头、两个专用Page及重启；浏览器级静音参数在加载抖音页面之前生效。

提交在同一浏览器同步任务内核对批准状态，随后对已绑定元素执行一次 DOM click；原生私信的SVG控件只派发一个click事件，避免鼠标事件链中的状态变化。平台是否接受此网页交互须实机确认；拒绝或无法回读时保留未知态，不自动换成另一种点击或私有请求重试。

## 环境与启动

已在 Windows、Node 26.13.0、pnpm 11.25.0、Microsoft Edge 156.0.4314.58 验证本地夹具。pnpm 启动器内置 Node 24.22.1，项目命令实际使用 PATH 中的 Node 26.13.0；项目允许这两个受支持 LTS 系列。使用独立 Profile，不使用日常浏览器资料，不改全局浏览器或 Git 配置。

实际开发机为Windows 10专业版x64（10.0.19045）。2026-11-05用户已明确将本期完整验收调整为当前Windows 10，原Windows 11环境不再是本期门槛；不宣称Windows 11已实测。

better-sqlite3 13.0.3自带Windows x64/arm64的Node-API二进制；本项目明确禁止其不必要的隐式node-gyp构建，使用包内预编译文件，esbuild仍允许自身安装脚本。不需要为此安装Visual Studio全局编译环境；SQLite实际加载、事务、持久化和恢复仍由集成测试验证。

```powershell
Set-Location D:\Inbora
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm test:built
pnpm inbora --help
pnpm inbora init
pnpm inbora status
```

`init` 仅首次执行；已有运行目录不会覆盖初始化。默认数据位于 `%LOCALAPPDATA%\inbora`，开发可用 `--runtime D:\Inbora\.local\manual`。数据库丢失、损坏或无法写入时停止操作；不要删除数据库后重新初始化来清除发送记录。

首个交付使用数据库 schema 2。此前未发布开发提交的 schema 1 会明确拒绝，不自动覆盖或重建；开发者应保留旧目录供核对，在另一个私有目录运行当前版本。真实账号首次测试从当前 schema 创建，不丢弃任何已产生的真实收据。

构建后的 CLI 也可直接运行：`node D:\Inbora\dist\cli.js --help`。源码、CLI、项目和应用统一命名为 `inbora`；原方案中的 `poc` 命令只是设计稿名称。

## 完整实机测试入口

实机测试需要用户本人扫码、明确授权读取受控评论/私信，并由协作测试者提供测试事件。完成离线审查和远程同步后统一进入此阶段。详细步骤见 [实机清单](tests/manual/real-account-checklist.md)、[测试对应表](docs/TEST-MATRIX.md) 和 [页面观察记录](docs/SITE-OBSERVATION.md)。

```powershell
pnpm inbora login --headed --real-account --private-access
# 扫码后由开发者校准实际网页映射；不向用户要求编写选择器。
pnpm inbora install-mapping --file D:\Inbora\.local\site-mapping.json --real-account --private-access
pnpm inbora observe notifications --real-account --private-access
pnpm inbora observe dm --real-account --private-access
# 可先安装 purpose=observation 的已校准只读映射（由开发者生成，含最多两名测试者/两个作品）：
pnpm inbora install-mapping --file D:\Inbora\.local\observation-mapping.json --real-account --private-access
pnpm inbora observe works --real-account --private-access
# 私信回复另需开发者校准的 purpose=dm-reply 映射；不会授权任何一条发送：
pnpm inbora install-mapping --file D:\Inbora\.local\dm-reply-mapping.json --real-account --private-access
# 对现有一级评论的直接回复另需 purpose=comment-reply 映射：
pnpm inbora install-mapping --file D:\Inbora\.local\comment-reply-mapping.json --real-account --private-access
```

首次采集以观察时刻和已见时间建立该通道/会话的可见历史基线。此后由测试者发送新事件，再采集获得任务 ID。只对可核验绝对时间严格晚于高水位的事件建新任务；首次基线前的迟加载旧历史保留为历史，首次基线后但早于高水位的迟到事件、同一时间精度或相对时间无法排序时转人工且仍出现在tasks。通知只读取当前加载的可见记录，不承诺全部历史回填；私信逐个打开已加载的可见会话。无法证明稳定账号、来源和目标身份的条目阻断或转人工。

只读校准映射保存为私有`observation-mapping.json`，安装它不会启用批准或发送。私信回复另需完整`dm-reply-mapping.json`或原完整`site-mapping.json`；一级评论回复可用`comment-reply-mapping.json`，其他评论路径仍需完整`site-mapping.json`。`observe dm`只打开映射中已授权会话，先核验列表行原生身份，再核对当前头部与消息绑定；隐藏气泡或正文不读取，非纯文字消息只记未支持计数。`observe works`仅打开映射中的两个授权作品，核对作品、作者主页、稳定评论ID及正文；必须等可见评论或显式校准的空态，不把加载中的空列表记成完成。两种发现源命中同一作品/原评论只保留一个任务；身份或正文冲突进入人工核对。每个新作品scope首次读取同样建基线。

原生私信回复还交叉核对输入区`curConversation`与聊天头部，要求最新端可验证、原消息和有界收发上下文不变。已有人工草稿会阻断；聚焦后再次核验，再在同一任务执行一次原生纯文本编辑。准备后的编辑器结构及批准全文同时绑定，变化时不继续点击。草稿在保存、展示审批之前统一CRLF/CR为LF，其余空格与首尾/连续换行保留；已有批准不会被静默改写。

一级评论适配器核对原评论cid、作品、作者、正文和level1，再核对其专属输入区的cid/作品/层级；来源通知ID与原评论cid分别保留。当前只接受单行纯文本Draft.js结构；非空BR、额外块或已有人工草稿阻断。输入以一次准确元素textInput事件交给网页正常编辑器，先取消默认插字，不伪造可信事件或使用全Page键盘；完成后重核原评论、全文及结构。空态发布图标可隐藏，准备后有限等待其显示，最终仍须可见、可用。回读必须在同一个直接子回复内核验原生ID、父ID、作品、作者、全文、状态及绝对时间，不能拼借兄弟节点；字段不足保持未知，不退化为独立顶层评论。

```powershell
pnpm inbora draft EVENT_ID
pnpm inbora show EVENT_ID
# 如需修改，先在本机私有目录写 UTF-8 文本：
pnpm inbora edit DRAFT_ID --file D:\Inbora\.local\reply.txt
pnpm inbora approve DRAFT_ID --real-account --private-access
# 本机逐条核对并输入本次专属确认短语；不接受非交互式批量批准。
pnpm inbora send-once DRAFT_ID --real-account --private-access
pnpm inbora review-uncertain
pnpm inbora pause EVENT_ID
pnpm inbora resume EVENT_ID
pnpm inbora compare-modes --real-account --private-access
pnpm test:real --case L01 --real-account --private-access
```

`EVENT_ID` / `DRAFT_ID` 是命令输出的本地标识，重启后可从 `status` 的 tasks 找回。`show` 和审批原文只在本机交互终端显示；不要把终端原文、数据库、Profile、页面证据上传仓库。审批绑定账号、原事件、收发上下文、输入框归属、页面映射和完整文本版本；任何变化都需要重新核对。`pause` 可从另一个终端发出且不会恢复其他进程的在途意图；暂停使未点击任务的旧批准失效。已提交的在途发送可能已经发生，暂停不能撤回已外发的消息。未知任务保持冻结；人工核对记录与后续处理需由开发者在实机阶段核验，CLI 不提供清空意图或重发开关。

`compare-modes`目前使用完整`site-mapping`串行测量两通道；仅安装只读/native私信映射时，分别用`observe dm`和`observe works`的`--headed`/`--headless`入口复核。真实原生Headless已有受控私信及首个许可作品的有限读取证据，完整发送仍未验证，详见模式对照记录。发送对照分别逐条批准；区分输出 Node 的 RSS/CPU 与当前 Worker 所有 Edge 子进程统计，统计不可用则为null。人工 `real-test` 声明仍需完整映射，不能替代自动绑定回执。

确认回执需要准确目标内的新稳定消息/回复ID、我方身份、完整批准文本、明确确认状态，以及严格晚于持久化点击意图的可核验绝对发送时间。缺时间、只有低精度/相对时间、时钟无法核对或只看到旧同文消息时保留UNCERTAIN，不能拿新显示的历史记录冒充本次发送成功。

## 模型与隐私

默认 Mock 无需 Key，无外部模型请求。可选 HTTP 适配器实现 [明确 JSON/HTTPS 契约](docs/MODEL-CONTRACT.md)，尚未验证任何真实供应商。用户另行明确授权后才能执行 `authorize-model`；Key 只从当前进程 `INBORA_MODEL_KEY` 注入。模型输入只包含有限业务数据，没有浏览器控制权。投诉、隐私、金钱和身份验证类请求转人工处理。

真实模型最多 50 次，真实发送意图最多 20 次；计数持久化且崩溃/超时不退还。上限是测试约束，不能替代付费授权或逐条发送批准。代码没有自动解锁预算的入口。

脱敏 JSON 证据位于私有运行目录 `evidence`，默认保留 14 天，可在本机 `runtime.json` 配置 1—365 天，使用 `prune-evidence` 清理。CLI 不采集原始截图、HTML、HAR 或 Cookie；必要的实机原始证据由用户明确许可后仅本机受控留存。SQLite 私人事件原文用于恢复与去重，不能随证据清理删除；PoC 结束后在确认无需继续运行时按账号整体退役，不能边运行边删除历史以绕过去重。

## 开发与交付约定

`pnpm test:e2e` 只运行本地合成 HTML 页面，实际启动 Edge 并操作 DOM。`pnpm test:real` 是独立且需要显式私有访问权限的实机入口。源码和测试位于 `src/`、`tests/`；运行数据、构建与依赖均已忽略。

`test:integration` 另用默认 `tsx` 的真实子进程走通浏览器链，`test:built` 用普通 Node 运行构建后的两通道完整夹具链，防止测试转换器掩盖序列化问题。

每个可验证切片提交；推送前审查所有待推送提交，运行全部检查及 `pnpm check:privacy`，推送后核对远程 SHA。历史和暂存区隐私扫描是补充检查，仍需审查夹具是否包含私人数据。审查记录见 [REVIEW.md](docs/REVIEW.md)，进度见 [PROGRESS.md](docs/PROGRESS.md)。

只有原方案全部必要实机证据支持 GO，才开始 P5 Tauri 接入评审；本期不建设完整工作台或多账号系统。
