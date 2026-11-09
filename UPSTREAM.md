# 来源与许可

## 2026-11-07：单会话失败让步与评论续读渲染

修复前复读MIT LockyBee/dsh-douyin-agent固定提交`7989640e340f0fd79e2de9874880d5197546e755`的`autonomous-watch.mjs:125-154`持久运行/停止、`chat-browser.mjs:303-337`身份绑定及`:854-896`有界列表读取。上游没有可直接移植到本项目SQLite会话调度的失败退避合同，因此独立复用已有`collection_progress.cursor_json`保存单会话120秒退避，不新增表/框架或模型重试；`last_read`仅成功后更新，账号/平台阻断继续透传全局门禁。许可已在本机候选副本复核，不复制上游宿主或放宽原生身份。

原评论虚拟列表续读回归暴露异步渲染间隙：隔离阶段探针显示原生scroll已到达、滚动位置已前进，但新行尚未重挂，下一次同步capture仍读旧行。对照同固定提交`chat-browser.mjs:864-869`的滚动后150毫秒让步，并核对[HTML标准的渲染更新顺序](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering)中scroll steps与动画帧阶段，本项目在恢复评论offset之后让步150毫秒，再进入原有准确可见快照门禁。夹具用两次原生rAF独立延迟挂载，红绿均实际运行。此等待覆盖已复现的帧间隙，不承诺任意负载下页面稳定，也不拿它解释实机正文冲突。未新增依赖或复制源函数。

## 2026-11-07：首个自动化切片，持久合同及收取调度

修改前复读已固定候选的具体源码：MIT LockyBee/dsh-douyin-agent `7989640e340f0fd79e2de9874880d5197546e755` 的 `autonomous-watch.mjs:125-154`、`receipt-baseline.mjs:62-83`，以及 MIT miqian-nomad/dsh-douyin-watch `177810c1f1858b529e78531f837ac9677fb9f9a9` 的 `tools/work-comments.mjs:67-85,110-119`；许可全文在本机上游副本复核。采用持久范围、单个后台操作、不可覆盖基线、有界作品发现和独立水位的组织原则；不采用要求Key才开始采集、只看最近10作品、直连接口/UA覆盖、并行发布或任何上游外发权限。独立扩展既有SQLite/AccountActor，不引入上游宿主或新依赖。

SQLite使用已锁定better-sqlite3 v13.0.3；远程tag解引用提交为 `dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb`。复读安装包 `lib/methods/backup.js:1-70`，并经Context7核对该版本官方 `docs/api.md` 的backup/transaction.immediate：异步备份不放进同步事务，升级前校验一致备份、私有试升级和恢复，额度及意图事务保持同步。沿用其MIT依赖许可，不复制实现源码。

本切片仅落地持久合同、调度器和公平队列，尚未接入产品后台；测试及真实库私有副本迁移结果见 `docs/AUTOMATION-ACCEPTANCE.md`，不把上游能力或合成通过当作新作品/会话实机通过。

## 2026-11-07：自动收取、持续策略、人工单次操作与凭据接入

继续复读上述DSH固定提交的 `chat-browser.mjs:303-337` 原生会话身份、`:337-402` 消息绑定及 `receipt-baseline.mjs:62-83` 不可补造旧基线；watch固定 `177810c1f1858b529e78531f837ac9677fb9f9a9` 的 `tools/work-comments.mjs:67-85` 作品归属/原生发布时间和发现机制。独立实现正常本人主页GET响应与可见原生链接交叉绑定、正常列表滚动、原生会话及消息发送方交叉绑定；不运行上游内部fetch或签名服务。候选字段在夹具验证，实际新本人作品页字段尚须本轮用户原生差异验收，不能把源码候选称作已校准实机能力。

后台一次业务操作复用现有ClientService/WorkbenchAuthority/SendCoordinator，不复制上游发送入口。只读适配器检查准确原文、上下文、本人及输入框归属后才能登记当前映射/浏览器能力；普通读取成功不直接提升。新意图事务同时写入只读核验资格，后续证据追加，旧未知/收据不改写。相关Chatwoot后台权威结果/事件更新的固定MIT文件已在上文记录，本轮沿用该思路，不引入其宿主。

DPAPI先核对[微软官方ProtectedData.Protect文档](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata.protect?view=windowsdesktop-10.0)，随后审查固定.NET MIT源码 `5535e31a712343a63f5d7d796cd874e563e5ac14` 的 `src/libraries/System.Security.Cryptography.ProtectedData/src/System/Security/Cryptography/ProtectedData.cs:1-124`，确认CurrentUser与LocalMachine分支、UI禁止及CryptProtectData/UnprotectData边界。本项目调用Windows已有.NET，不复制实现或添加密码学依赖；合成Key在本机真实DPAPI往返/删除及竞争验证，真实Key不进命令行、环境变量、脚本文件或日志。磁盘只写密文；同目录操作串行，异步完成绑定凭据代际。

DeepSeek继续沿用锁定的官方Chat Completions/choices/usage合同，复核[当前官方接口](https://api-docs.deepseek.com/api/create-chat-completion/)，保持有限上下文、512 Token、30秒及无付费自动重试。模型只提供正文，后端策略独立匹配账号/通道/对象/规则/时段和额度。

原生合成验收复用项目已有QA配置路线，核对官方Tauri配置合并文档及锁定 `tauri-runtime-wry 2.12.3` 的 `src/lib.rs:4982-4986`、`tauri-utils 2.10.2` 的 `src/config.rs:2128-2137`。crate携带Git提交 `993038c49185307dfc895ab7657d77ca0d5ed7c7`，许可沿用锁定crate的MIT/Apache-2.0与随包notice；additionalBrowserArgs通过原生API生效且使用独立dataDirectory。QA覆盖只放忽略目录，正常交付配置不增加调试端口，不将环境变量未打开调试目标归因为产品业务崩溃。

## 2026-11-07：一个入口同步双通道及后台进度

修改前重新核对两仓当前 SHA，读取固定源码，不以旧印象代替比较。MIT DSH [7989640e340f0fd79e2de9874880d5197546e755](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/autonomous-watch.mjs#L125-L154) 的 `autonomous-watch.mjs:125-154` 使用 running/completion 防止重复启动、异步执行并立即返回 state；`:92-93` 暴露 phase，`:422-430` 处理停止。采用“单个后台操作、立即回状态、可查询阶段及完成”的组织方式，独立复用本项目现有 pending/drain 和账号 actor；不引入其自动观看、文件任务系统、AI 调用或发送路线。

Chatwoot 非 enterprise 的 MIT Expat 源码固定 [625d5964e3cb3f1d917b43c3b8332219e525a4b8](https://github.com/chatwoot/chatwoot/blob/625d5964e3cb3f1d917b43c3b8332219e525a4b8/app/javascript/dashboard/store/modules/conversations/actions.js#L235-L279)，`syncActiveConversationMessages` 按会话保留已有记录、补齐消息并在末尾更新同步游标。采用“同步不清空已有收件箱”的交互，不采用其吞掉错误的 catch、客户端直接操作服务端接口或多人/已读流程。两个仓库 SHA 与本次核对一致，许可全文已读，原始源码存 `.local/upstream-review/2026-11-07-sync`，不复制源函数或新增依赖。

本机用户反馈两个按钮互相禁用；源码证明二者共用 busy，act 等 observe 完成后才清理；只读库显示两条通道都留下新观察，不能把用户反馈推断成第二项永久失败。此次将作品补充评论与私信合并为后端一次串行读取，立即返回运行状态、分别保存内存进度及安全错误代码；WebView 重连取状态，不重放任务。普通读取失败按通道/当前浏览器模式隔离，平台停止、账号或安全验证错误停止后续读取；通知独立来源入口保持单列。已有任务与未保存人稿保留，不恢复账号、不启用发送、不调用模型。

审查修复前另读同一 MIT DSH 提交的 `browser-host.mjs:48-68,102`：关闭先失效 active/页面跟踪，迟到异步结果不能恢复 ready 状态。采用持有者生命周期失效原则，正常关闭递增本地代际，后续通道拒绝旧代际；观察结束和异步身份读取只更新仍为当前的 owner。数据库原生 ACCOUNT_CHANGED 同样属于账号级停止，不能因页面与映射一致就继续另一通道。复用现有对象/队列，不引入新的调度层。

验证先在未修复代码运行单入口 UI 及后台立即响应/串行/重复请求/单通道失败/安全停止/急停/重连回归，再运行修复后合成链与双尺寸界面；原生包和真实点击分别记录，不能由 Mock 读取代替实机同步通过。

## 2026-11-07：连接目录错误与只打开现有资料

修改前核对 Node.js v26.13.0 的 tag 对象 `daaa22aeddb87085542376ea1f4854dcea080baf`，解引用固定提交 [18b32a3b1552e199a01f1a8d9fd64aa756d3b75b](https://github.com/nodejs/node/tree/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b)。阅读 MIT 核心源码 `lib/internal/fs/promises.js:1703` 的 mkdir 和 `:2105` 的 realpath，以及 `doc/api/errors.md:599-605` 的 ENOENT/ENOTDIR；官方当前错误/文件系统文档同步核对。采用公开 realpath 的不创建语义，现有 OwnerLock 增加是否允许创建目录参数，桌面入口仅显式初始化传 true，CLI/Profile 默认行为保持；不复制 Node 源码或新增依赖。连接边界仅把目录/配置缺失映射为固定安全代码，不回传原始路径和堆栈，不通过预先 access 判断来替代实际打开。

用户 0.2.7 截图已证实原生窗口正常，首次错误是路径少分隔符，修正后已进入真实设置页；不继续归因为原生崩溃。源码先创建目录再读取 runtime.json 的顺序使未初始化连接也产生空目录，且客户端只得到通用错误。正式回归须先在旧源码失败，再验证不存在目录、既有空目录、文件路径拒绝不变更，以及显式初始化/原目录重连成功；所有夹具留 `.local`，不修改误输的项目外路径或正在使用的真实目录。

## 2026-11-07：延迟评论回执与通道状态取舍

本轮在修改前重新查询三个仓库的实际分支 SHA，读取固定版本具体源码和许可，原始源码仅存 `.local/upstream-review/2026-11-07-receipts`。用户明确要求同时检查本应用是否过严，不能把更多校验等同于更可靠。

| 候选与固定提交 | 具体实现与许可 | 本轮取舍 |
| --- | --- | --- |
| [DSH](https://github.com/LockyBee/dsh-douyin-agent/tree/7989640e340f0fd79e2de9874880d5197546e755) `7989640e340f0fd79e2de9874880d5197546e755` | MIT；`chat-browser.mjs:1613-1625` 在单次提交后空框时重挂原会话一次；`comment-browser.mjs:488-500` 用新本人 ID、正文及两轮稳定读取确认 | 采用有限轮询和一次原对象正常重挂；本项目旧分支仅在缺 status 且无意图后 GET 时补读，GET 存在并不能证明新状态已渲染，这两个前提是冗余限制。正常补读仍同步保护所有可见人稿，不复制物理鼠标提交或把无状态推定为成功。上游评论发布与本项目准确父评论回复不同，不能当本机已通过。 |
| [Chatwoot](https://github.com/chatwoot/chatwoot/tree/625d5964e3cb3f1d917b43c3b8332219e525a4b8) `625d5964e3cb3f1d917b43c3b8332219e525a4b8` | 所读非 enterprise 文件为 MIT Expat；`app/models/message.rb:84,104,157` 关联 echo_id，区分 sent/delivered/read/failed；`app/javascript/dashboard/store/modules/conversations/actions.js:406-438` 及 `index.js:246-269` 处理发送回调和事件更新 | 采用后台权威结果与状态分别表达的思路，现有持久 commandId/意图继续承担关联；不引入 Rails/Vue 或第二发送路径。当前代码仍将创建响应硬设 SENT，公开问题 [#16351](https://github.com/chatwoot/chatwoot/issues/16351) 报告覆盖较新状态；不照搬其乐观状态覆盖或自动重试。通道的只读、待校验、已开通和阻断分别显示，不能统一称为禁止发送，更不能与 AI Key 混淆。 |
| [MediaCrawler](https://github.com/NanmiCoder/MediaCrawler/tree/54a3d92412f4b20c06b45f1d542b78dd92049d6d) `54a3d92412f4b20c06b45f1d542b78dd92049d6d` | `NON-COMMERCIAL LEARNING LICENSE 1.1`，不是无限制商业许可；`media_platform/douyin/client.py:260-279` 按作品/父评论分批读取；`store/douyin/__init__.py:135-150` 保存原生 ID/父 ID/时间 | 仅比较读取与父子评论的数据关系；不复制代码、引入依赖、直接请求其私有接口或沿用正文日志。采集能力不能替代发送确认。 |

路线结论为调整现有适配器，不替换统一发送架构。即时缺证明时统一尝试一次受保护的正常刷新，无需先证明缺哪个字段或先判断是否发生过 GET；刷新后仍核对同一新原生 ID、准确父评论、我方身份、全文、原生确认状态和两轮一致性。秒级跨时钟条件不能单独代表发送失败，本条后续只读证明的时间晚于原意图，未复现原回读缺失字段，不能把本次错误归因于毫秒差，也不补造请求关联。既有未知收据保留，只追加补充证据。

验证先以合成 pending 状态、缺状态且已有 GET、刷新前尚无子回复三种时序运行未修复源码红测，再覆盖刷新后仍 pending、旧时间、错误父评论/作者/全文、歧义及网页人稿保护。无真实新发送或模型调用。

部分子回复元数据缺失的刷新条件也在旧隔离源码实际红测；最终干净 308 项、source/compiled 冒烟、新目录安装及随包 20 条零 Key 合成任务通过。单次提交后补读由同一适配器完成，不新增通用重试框架、依赖或后台发送路径；后续新版本真实即时回读仍单列待验。

## 2026-11-07：刷新后只等待可见评论

修改前核对 Playwright 1.64.1/Apache-2.0 固定 SHA `cfe490d941f992655948eee8fd4fd94e1c4234bf` 的 `packages/playwright-core/src/client/locator.ts`：`first()` 仅追加 nth=0，不会跳过隐藏节点；`filter({visible:true})` 每次定位时重新过滤。官方对应版本文档同步核对。采用现有可见性过滤，先要求唯一可见评论列表，再在其内部等待可见评论；不引入依赖、放宽准确父评论校验或物理点击。MIT DSH 固定 SHA `7989640e340f0fd79e2de9874880d5197546e755` 的 `chat-browser.mjs:1613-1625` 继续仅参考限定原目标的一次正常重挂，不复用宽松收据。

0.2.5 安装版只读阶段探针在 prepare 刷新后实际超时，错误指向全局 commentRows.first 等待隐藏节点；当前页面两个列表仅一个可见。探针在填字前截断，原业务表逐行不变。三个正式回归在旧代码均失败，分别覆盖隐藏首行、隐藏旧列表和两个可见列表；后者仍须以固定代码阻断。与上一轮时钟缺样本是相邻两个阶段的不同问题，不能把合成单列表通过等同实机重挂通过。

同形扫描还定位到 DomAdapter.locateComment 的全局 first 等待，合成旧节点场景已实际红测；同样先过滤可见根节点，后续 matchingRoot 仍逐字段绑定准确事件，不借可见性替代身份核验。原生评论 helper 的两个调用点（填写前补采及请求关联后的回读）共用本次修复，源码和构建 Node 冒烟都保留隐藏旧列表与首行。

## 2026-11-07：配置模式与评论时钟观察器生命周期

修改前核对 MIT React 19.3.1 固定 SHA `61aa00df822d0eb76d0362eb8b6fdd3527693efe` 的 `packages/react-dom-bindings/src/client/ReactDOMSelect.js`，`updateSelect` 和 `restoreControlledSelectState` 都按传入 value 恢复选项；官方 select 文档同步核对。采用持久配置与有效运行状态分别返回的方式，让设置控件绑定配置，发送门禁继续读取有效状态；不引入新状态库或放宽能力门禁。真实库已保存 MANUAL 而身份为空时有效状态为 DRAFT_ONLY，正式集成和双尺寸界面回归先在旧代码失败。

评论修复前再读 MIT DSH 固定 SHA `7989640e340f0fd79e2de9874880d5197546e755` 的 `chat-browser.mjs:1613-1625`，采用准确对象限定、空编辑器检查和一次正常重挂的思路，不复用物理点击、私有接口或宽松回执。真实有界只读探针对同一原评论证明：首次导航得到有效 extra.now/HTTP Date 样本，新适配器在已打开页面上无请求且样本为空，目标和完整上下文相同；业务表逐行保持。复用本项目现有同步空稿刷新门禁，在填写前补取新观察器自己的样本；刷新后重核上下文，缺样本不填字、不存意图，不共享旧适配器缓存或补造时钟。五个正式场景在修复前执行，四项失败、一项人稿保护通过。

## 2026-11-07：意图后诊断与独立只读核验

修改前重读MIT DSH固定SHA `7989640e340f0fd79e2de9874880d5197546e755`的`chat-browser.mjs:1630—1644`：按dispatch/readback等固定阶段及布尔错误分类保留失败诊断，未知不自动重试。本项目采用阶段和固定代码枚举的思路，不保存原始error.message、不复制其物理点击或宽松收据条件。另核对本项目现有ObservedCommentReply.verifyExisting与DSH刷新后会话核对：DM只读重查不应等待未在本次核验中arm的临时提交ack。诊断与独立核验五项正式回归在修改前已实际失败。

用户随后明确指出几百毫秒不应硬拒绝。调整前再读同一DSH文件`1613—1625`的new-tail/排除旧ID/稳定fingerprint思路：采用多项证据而非单独跨时钟严格比较。独立限制最多2秒偏差，准确新原生ID必须处于最新端，去除该记录后全部上下文摘要与持久批准的发送前摘要一致，刷新后同ID两次确认；不采用上游trim和缺确认状态时的回退。不补造历史ack、不改旧异常收据或冻结，核验结论单独追加。当前私有记录已离线证明去除新记录后前后上下文摘要精确等于批准快照，未读取额外会话。

新版只读复核连续遇到ROW_CHANGED后，改用完整安全描述符探针取得新证据：准确原生会话/对方已经匹配，昵称DOM仍为19字临时值，100毫秒后变成准确10字，500毫秒稳定。先核对同一DSH的等待渲染/再次身份绑定和本项目既有有限ready机制，再将原生身份已吻合而标题未就绪识别为可等待METADATA_NOT_READY；原生身份冲突立即拒绝，点击事件中变化仍不重试。标题延迟正式红测先失败后修，不扩大名单或猜造字段。

## 2026-11-07：虚拟会话列表定位

修改前核对MIT DSH固定SHA `7989640e340f0fd79e2de9874880d5197546e755`的`chat-browser.mjs:849—902`：原生身份匹配、唯一列表作用域、80%视口滚动、150毫秒渲染等待和12秒有界查找。采用该定位思路，独立落实到现有ObservedReader；不导入宿主、枚举联系人名单、读取其他会话正文或直接调用平台接口。已有dataField小段的MIT来源声明保持。Playwright 1.64.1/Apache-2.0固定提交`cfe490d941f992655948eee8fd4fd94e1c4234bf`的`docs/src/api/class-locator.md`明确all立即返回当前列表，不等待动态加载；当前依赖的官方文档已重新核对。

实机私有阶段探针显示首屏11行不含许可目标，已校准列表滚动一次后原生会话/对方身份唯一命中，原只读Reader随即通过。原实现只按首屏标题筛选，误将未挂载目标判为不唯一。修复新增可选私有conversationList映射（旧映射默认null），在账号/页面核验内有界正常滚动，仅返回目标索引；原生会话和对方共同匹配，同名其他会话不阻断正确目标。选择任务再次核验，真实重复原生目标仍阻断。两种首屏缺失回归已在未修复源码实际失败，再执行绿测；源码tsx及编译Node链均纳入虚拟列表冒烟。此次不改发送事务、批准、未知与预算。

0.2.3最终随包内核在同一已授权Profile执行单条有头只读校准成功，未填写或提交，旧数据及累计预算保持。此本机结果支持定位修复，不由上游成功声明代替，也不算GUI发送通过。

## 2026-11-07：历史草稿来源标签

动手前再读已固定MIT React v19.3.1 `61aa00df822d0eb76d0362eb8b6fdd3527693efe`的`packages/react-dom/src/client/ReactDOMRoot.js` render入口及MIT DSH `7989640e340f0fd79e2de9874880d5197546e755`的`native-model-settings.mjs`。上游不提供本项目迁移稿来源合同，不能从当前无Key/未授权反推旧稿来源；采用现有应用的状态映射写法，独立小范围显示映射，不复制上游代码或引入库。后端已准确返回LEGACY，前端旧二分分支误把非AI全部标为人工；修复只按现有来源显示历史/人工/AI，未知来源和无稿明确展示。带schema2旧Mock稿的双尺寸正式UI回归实际先红后绿，数据库及发送资格不随标签变更。

## 2026-11-07：重复急停后的接管详情刷新

动手前复查React v19.3.1固定`61aa00df822d0eb76d0362eb8b6fdd3527693efe`的`packages/react-reconciler/src/ReactFiberHooks.js`：`areHookInputsEqual`逐项比较依赖，`updateEffectImpl`在全部相同时不标记Effect执行；MIT许可与已安装React LICENSE核对。官方useEffect文档经Context7复核。另复读MIT DSH固定`7989640e340f0fd79e2de9874880d5197546e755`的`native-model-settings.mjs`（私有只读源码归档tree目录），其配置/服务身份重核没有可直接复用的React急停刷新实现；不引入宿主、缓存框架或新依赖。

本机后端已清空接管并递增代际，但账号原本paused=true，再次急停仍true，前端不能靠该标志触发详情Effect。采用现有准确目标`refreshThread`在急停确认后主动读取，统一详情读取的请求序号、选择标识和事件检查，只由首次有效读取初始化编辑器；非当前目标在递增序号前即拒绝，避免旧保存回调取消新目标读取。保留人稿，不改发送或暂停门禁。正式双尺寸React/应用服务测试实际先红后绿，覆盖已暂停时急停、较早详情晚到回退接管、跨目标旧保存回调取消新详情、界面只读和人稿保留；初始详情迟到跨显式重连也核验。原生分发包的用户截图复验另列，不以浏览器夹具替代。

## 2026-11-06：最小客户端 M1—M3 实施核对

原生首次测试暴露pnpm11布局差异后，先核对`pnpm/pnpm.io`固定`f9f6057f2cd214c4a0d743d1ba09d898197b55e0`的`docs/settings.md`、`docs/migration.md`和安装命令文档：仅认证/registry/TLS等仍读`.npmrc`，`nodeLinker`应在`pnpm-workspace.yaml`。据此修正暂存构建为hoisted真实目录；验证扩为导入完整ClientService/Playwright及SQLite，随后原生Tauri IPC实际连接、保存及重启通过。未复制pnpm源码或引入宿主。

WebView2调试环境变量在本机提升权限宿主未生效后，核对已安装wry0.57.1的`src/webview2/mod.rs`中AdditionalBrowserArguments路径（crate来源SHA `2446feadae623d6f2ac8d2136e3ccef3d7197e0e`，包内vcs信息标记dirty，以Cargo.lock校验值为实际包依据）及微软[WebView2调试文档](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/debug-visual-studio-code)。单独QA配置通过Tauri公开additionalBrowserArgs API启用本地端口，未修改依赖源码或系统策略；正式包不含该配置。QA与正式包的证据边界见CLIENT-ACCEPTANCE。

- 继续使用官方 Tauri 文档固定 `5e49cc6e48597060f1618e0b62cb91b071b1b4a9` 的 `develop/sidecar.mdx`、`develop/resources.mdx`、`learn/sidecar-nodejs.mdx`，本轮已下载逐项核对，MIT 全文保存在 `third_party/Tauri-docs-MIT.txt`。采用官方允许的“随包 Node + JS 资源”和 stdin/stdout 通信；使用 Rust 私有管道、受限业务命令和独立控制路径，不向前端开放 shell、文件系统或 SQL 插件。Node 原生依赖实际在暂存目录加载成功；这不替代 Tauri 原生启动验证。
- React `v19.3.1` 固定提交 `61aa00df822d0eb76d0362eb8b6fdd3527693efe`，阅读 `packages/react-dom/src/client/ReactDOMRoot.js` 的 createRoot/render 生命周期；受控输入、异步 Effect 清理由官方 React 文档经 Context7 核对。采用标准受控表单和目标绑定的迟到结果丢弃，独立实现客服界面，不复制其他产品 UI。React 为 MIT，使用依赖包并保留其许可。
- better-sqlite3 `v13.0.3` 的 tag 对象为 `0747dc94fb468715974716c6c54106ad6469d31b`，解引用提交为 `dbc2ea1165fef1f599b9be12faea33fa5e9d7ffb`。核对 `lib/methods/backup.js` 的一致性备份和错误处理，文件 SHA256 `ea29d34992bb02e006d0fdeda9675ac5d2bb227aaf57468decd997e9fc9c7dbf` 与已安装包一致。使用公开 backup API，在私有副本先验证恢复及试升级，再进行 schema 2→3 的附加迁移；不复制上游源码，不改写旧业务表/收据。
- 再读既有 MIT DSH 固定 `7989640e340f0fd79e2de9874880d5197546e755` 的 `native-model-settings.mjs`、`tests/native-model-settings.test.mjs` 和 `tests/native-client.test.mjs`。采用配置与调用分离、内核状态权威、明确确认的组织方式；不引入 Cordis、模型目录服务或其发送实现。接管/版本/持久 commandId 按本项目 V2.1 合同独立实现。
- DeepSeek 在本轮重新核对[接入页](https://api-docs.deepseek.com/)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)及[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。独立 fetch 适配官方 messages/choices/usage，固定官方 HTTPS 端点、非流式、max_tokens=512、thinking.disabled、30 秒超时且无自动重试；不复用旧 HttpDraftProvider 自定义请求，也不引入不必要的兼容 SDK。合成协议、错误、usage 和迟到建议测试已实际通过，真实请求仍为零。
- 工具链重新核查后，本轮官方 rustup x64 下载与 SHA256 `38027d51d69a5d05493627a0634dbea52d6cd793c8f072d2373d3f4163eec7db` 一致；Rust 1.99.1 安装在项目 `.local/toolchains`，未改全局 PATH。Microsoft Build Tools 官方安装器 Authenticode 为 Valid / Microsoft Corporation，按最小 MSVC x64 与 Windows 10 SDK 组件准备环境。安装/原生构建的最终结果另记进度，不沿用历史拒绝作为当前结论。

## 2026-11-06：提前实现最小客户端前核对

用户允许基于当前PoC进度先做客户端。再次核对下节固定MIT官方Tauri文档源码的Rust子进程stdin/stdout、资源路径和受限命令，以及已核对MIT上游LockyBee/dsh-douyin-agent固定`7989640e340f0fd79e2de9874880d5197546e755`的`native-model-settings.mjs`和`tests/native-client.test.mjs`。采用“配置与模型调用分离、状态由内核提供、明确确认后操作”的机制，独立实现最小客户端服务；不移植Cordis宿主、目录发现、原生聊天UI或其他账号能力。真实供应商未选定，先接现有显式HTTP契约与Mock，不声称完成任意供应商适配。

官方React createRoot/受控表单/异步Effect清理通过Context7查阅；界面不自动执行发送或调用模型。Tauri编译所需Rust/MSVC本机未找到，自动审批拒绝其下载/安装，原生构建待验证。用户随后提供V2.1并要求优化方案，本轮未完成实现草稿保留在忽略目录，未作为交付代码或已通过验证；计划中的浏览器开发预览不替代Tauri包。

用户选择DeepSeek后核对[官方接入页](https://api-docs.deepseek.com/)及[Chat Completions合同](https://api-docs.deepseek.com/api/create-chat-completion)，确认官方messages/choices/usage合同与当前自定义JSON合同不同。后续实现独立适配，配置默认官方地址和当日列出的deepseek-flash，不将旧模型别名或SDK示例冒充实机兼容。此次只采用官方协议设计，未复制SDK源码、未调用真实模型，供应商适配和实机仍未验证。

## 2026-11-06：GO后最小客户端接入依据

在确认新增P5范围前，通过官方文档与固定源码核对既定Tauri sidecar路线。候选为[tauri-apps/tauri-docs](https://github.com/tauri-apps/tauri-docs)，v2分支固定SHA `5e49cc6e48597060f1618e0b62cb91b071b1b4a9`：

- [develop/sidecar.mdx](https://github.com/tauri-apps/tauri-docs/blob/5e49cc6e48597060f1618e0b62cb91b071b1b4a9/src/content/docs/develop/sidecar.mdx)：核对externalBin、目标平台文件命名、Rust持有子进程、CommandEvent stdout及child.write stdin；采用其官方进程接入机制作为设计依据，界面仅走受限Tauri命令，不直接开放任意shell。
- [learn/sidecar-nodejs.mdx](https://github.com/tauri-apps/tauri-docs/blob/5e49cc6e48597060f1618e0b62cb91b071b1b4a9/src/content/docs/learn/sidecar-nodejs.mdx)：核对Node打包和随包附带运行时两类部署方式，以及stdin/stdout等通信方式。保留既有Node内核，不搬入示例应用或直接照搬示例打包依赖；本项目的Node/ESM/better-sqlite3适配须在P5实测后确定打包配置。
- [LICENSE](https://github.com/tauri-apps/tauri-docs/blob/5e49cc6e48597060f1618e0b62cb91b071b1b4a9/LICENSE)：已读取，MIT。此次仅引用机制并独立编写范围文档，未复制示例代码、引入依赖或构建客户端；后续实际复用及分发仍保留对应许可与来源，核对真实锁定版本的传递依赖。

核对结果支持“React界面 → Tauri受限命令 → Node sidecar共用业务服务”的小范围接入，范围见docs/MINIMAL-CLIENT.md。官方支持不代表本机Windows打包、SQLite原生模块、客户端重启或真实AI试用已通过；当前均未实现/未验证，P5在GO后启动。

## 2026-11-06：将请求关联路线落实前核对

用户要求继续实施，并纠正开源核对必须主动完成。动手前复读MIT LockyBee `7989640e340f0fd79e2de9874880d5197546e755`的不可覆盖基线/未知记录、MIT watch `b3d5e36ed4ef9b8c1a7006ca2770309f820ffa46`的发布cid与父评论，以及仅供阅读的DouAi `f751fde0202a53c96cb14905e620ad5982d1be8f`具体请求回调绑定。原有响应证明评论正常发布返回status_code0、cid、reply_id、全文/我方及create_time，但没有aweme_id；status7不能替代刷新后的status1。故必须绑定同一个Request的准确作品/父评论/全文，随后刷新核对同cid；不单凭响应状态升级。

进一步只读核对cv-cat/DouYin_Spider `d151f9c2980abc304c1ae4918c2272675cd9e4c2`的`static/Request.proto`、`static/Response.proto`、`dy_live/protobuf/proto/default/im_proto.proto`及`builder/proto.py`，GitHub未核准可复制许可，不复制协议生成代码/SDK。较旧Response.proto与当前网页类型不一致；当前网页实际加载的公开IM包同时核对了Request/Response和SendMessageRequestBody/ResponseBody的字段号、sequence/client/server ID、业务status/check_code以及forceHttp发送路径。只独立实现有界被动解码，不生成请求、不读凭证、不调用网页getter/SDK。Playwright 1.64.1官方网络文档确认响应头先于正文完成，必须等待正文并以同一Request对象关联。已授权会话只读探针零发送，数据库状态未变；未观察到真实发送请求前不得将协议匹配宣称实机通过。

落实后typecheck/隔离219项、两通道source/compiled因果链通过。用户另批一条新私信后，真实正常HTTP请求/127字节业务回执匹配，刷新同返回ID证明CONFIRMED（2ed4876f），三重启d01de11a证明摘要一致；平台时间原值仍早于本机意图252ms。只在本机校准DM映射，原有未知/矛盾不升级、会话重新暂停。评论同路线只有离线证据，不以真实DM替代；上游来源只指导机制，实际通过来自本机独立证据。

## 2026-11-06：当前收据问题专项开源比较

用户要求查看开源方案如何处理本轮时间矛盾。已联网核对六个候选的当前HEAD，下载并读固定源码与相关测试；详细文件、SHA、许可、采用/不采用原因、纯函数实测和后续验证方向见[专项比较](docs/UPSTREAM-COMPARISON.md#2026-11-06发送时间矛盾与刷新误确认专项)。LockyBee/dsh-douyin-agent仍为MIT `7989640e340f0fd79e2de9874880d5197546e755`；watch当前MIT `b3d5e36ed4ef9b8c1a7006ca2770309f820ffa46`；DouAi公开源码`f751fde0202a53c96cb14905e620ad5982d1be8f`未核准可复制许可，仅阅读，不复制或执行宿主代码。另重读crazyants、POKMJN、DMShoot原固定SHA的确认入口；未引入依赖、SDK、签名、原生hook或其他提交方式。

直接运行上游评论基线纯函数的5项合成断言：正确新ID和基线未见的旧时间ID均确认，错误全文/pending/已知ID拒绝，证明该函数不负责严格时间门禁，而非现成本项目解法。较强可借鉴方向是具体请求业务回执与返回ID的因果关联，结合正常刷新同ID/准确目标核对；网页是否暴露足够字段尚待校准。本轮仅研究与记录，应用行为、旧收据、审批/冻结及发送预算不变，无真实页面/发送/模型请求。

## 2026-11-06：私信刷新后时间变化

重启只读核对发现同一新B私信的首次收据摘要可精确匹配发送当刻createdAt，刷新后同一ID/作者/会话/全文/状态不变，但createdAt回退至平台时间并早于持久意图。修改前重读LockyBee/dsh-douyin-agent固定MIT提交`7989640e340f0fd79e2de9874880d5197546e755`的`chat-browser.mjs:sendMessage`回读及`receipt-baseline.mjs`，并核对保留的LICENSE。上游允许较早回读成功，只在后续轮次重新挂载，不能直接解决临时本地时间误确认；只借鉴空草稿时正常重新挂载准确会话的思路。独立要求一次正常刷新后两次准确平台收据一致才确认，刷新前后均核对空编辑器，原基线与意图不变，无第二次提交。保留旧收据，追加矛盾证据并暂停对应目标；不将已确认历史改写为未发送。合成重载时间回退红测先复现，再收紧产品门禁。

增量复审的人稿竞态修复前再次对照该固定源码的checkPendingInput及回读重挂载：分离快照不能满足本项目同步门禁。新增refresh动作复用现有capture全字段核验，在同一浏览器任务检查空输入并发起原生location.reload，不执行网页处理器或新发送；Node先监听导航。隔离红测先错误CONFIRMED，修复后零导航且人稿保留，source/compiled重载实际验证。

## 2026-11-06：独立子回复回读及短信验证识别前核对

新B作品B的回复框在准确原评论外正常渲染，原root内查询实际DOM_NOT_READY。实施前重读同固定MIT提交`comment-browser.mjs:findCommentSubmit/inspectCommentComposer`的输入唯一性及控件归属；上游明确拒绝回复状态及向上宽搜索不能直接采用。实机固定composerScope的fiber深度2仍提供准确cid/level1/awemeId，levelOneCid未定义，且仅一个可见外置scope。独立扩展映射只列已校准portal作品ID；其他作品默认仍要求行内，外置必须不归属另一评论且唯一可见，完整原生绑定及最终点击复核不减。先补对应根外输入和错误cid回归，再改实现；不引入宿主或网页方法调用。

首次portal预检又由明确新证据发现激活前是level0、无cid且尚无编辑器的可见顶层壳。重读同源码的已有草稿保护后补含该壳的实际失败回归；仅忽略无cid/level0且没有非空编辑器的顶层壳，其他评论portal、重复绑定、非空人稿均阻断，不用宽泛first回退。

新B作品A实际形成子回复，但平台秒级createTime早于本机意图；正常已授权作品GET的extra.now及HTTP Date一致、接收时本机领先约1.1秒，不能假造亚秒时间或放宽收据门槛。修复前重读同固定MIT`receipt-baseline.mjs`的capturedAt边界，确认上游未处理本项目严格绝对时间比较，不能直接移植。独立仅从准确作品的正常GET被动核对extra.now/Date，在新意图提交前要求新鲜有界时钟样本；提交后等待平台时间保守下界越过本机意图的下一完整秒，最终DOM门禁仍重核所有字段，只提交一次。原已未知结果不改写、不重发。先以真实秒级收据夹具复现，再验证时钟样本错误/过期拒绝及源码/编译路径。

本轮新测试者身份校准复用既有固定渲染字段读取，不新增应用功能。双会话返回实机strict2匹配后，实施校准前重读同固定MIT提交`chat-browser.mjs`当前会话身份/有界导航及回到会话列表处理；只修正私有chatBack为准确当前chat层内控件，未复制宽泛回退、整页返回或宿主操作。修正前2匹配实际拒绝，修正后四次A/B切换逐轮核对原生会话；不据此宣称延迟竞态或最终发送通过。

实施前重读LockyBee/dsh-douyin-agent固定MIT提交`7989640e340f0fd79e2de9874880d5197546e755`的`receipt-baseline.mjs:matchCommentReceiptBaseline/preserveReceiptBaseline`、`comment-browser.mjs:readCommentDom`及`chat-browser.mjs:readChatBlockers`，并读取保留的LICENSE。借鉴两次只读快照、不可改写原未知及可见验证阻断原则；上游的仅DOM状态推断、通用文本扫描、物理点击和宿主不能直接满足本项目准确父评论/绝对时间要求，不移植。独立扩展既有精确DOM读取，将正常页面同源GET子回复响应作为缺失确认状态的补证；只监听当前准确原评论，不生成请求、不保存无关响应。短信验证使用上轮已实机观察的固定可见标题组件，覆盖读取及两通道最终发送门禁。Playwright 1.64.1官方network/Page.response文档核对了响应先于body完成及listener移除机制；需要正文读取完成后才能采用证据，目标切换/销毁须失效。红绿回归、源码/编译及真实只读验证另记，不由上游声明推定通过。

本轮实机重复出现OBSERVATION_DOM_NOT_UNIQUE后，先量得父行内正文/菜单各2个且含1个子行，再重读同一MIT固定文件`comment-browser.mjs:readCommentDom`的owned选择。独立采集器对根行的查询未排除子回复；在修改前追加展开子回复回归，采用与本项目发送回读相同的closest(commentRows)归属约束，不放宽唯一性或回退首个元素。

自动回读仍无证明后，精确探针量得子回复正文/身份/层级/状态均正确，仅菜单祖先opacity0；菜单是悬停控件，不代表子回复隐藏。修改前再核上游owned tooltip ID作为身份锚点而以整行/正文可见性判定；追加同形菜单透明回归，只取消菜单本身的可见要求，仍在同一可见直接child中要求唯一原生ID、可见全文/作者及全部状态时间绑定。

组合审查进一步指出采集器父评论菜单沿用了可见要求；同形扩查及红测实际复现OBSERVATION_DOM_NOT_READY。对照上述同固定SHA的owned ID锚点，同样只取消父行菜单的可见要求，父行/作者/正文及准确ID唯一归属不放宽，避免刷新前采集器阻断子回复补证。

第二个已授权作品为图集，正常评论按钮打开可见列表时保留一个隐藏列表。本机只读探针确认仅一可见、授权作者样本尚无。实施前重读同文件visible/owned选择原则，列表只接受唯一可见容器；两个同时可见仍阻断，不取first、不扩大作品/作者范围。修改前以隐藏克隆列表复现失败，适配采集器及回复的列表定位，不放宽行内字段唯一性。

审查指出预检展开线程产生的旧GET会误阻止发送后只读刷新。修复前再次核对同固定MIT收据基线的capturedAt及新旧证据边界；新增回归实际先返回null而失败，再将“已经请求”限定为严格晚于持久意图的当前文档请求，仅允许一次正常刷新，不重发。旧请求不成为本次确认状态的充分凭据。

初始实现依据需求独立编写，没有搬入 POC-SPEC 第12节候选仓库的宿主代码。本轮已开始适配复用经过核对的MIT小段，具体文件、commit SHA、许可证及修改记录在下文；不能据此推定其他候选代码也已获许可或适用于本项目。

当前直接依赖及开发依赖均通过 pnpm 锁文件精确固定，使用其公开包接口；许可证以实际安装包元数据为准。没有把 Electron、Python、DSH 宿主或非官方抖音协议层搬入应用。技术文档来源记录于 docs/PROGRESS.md，设计来源为用户提供的 POC-SPEC.md。

本次核对已安装包元数据：Playwright 1.64.1、TypeScript 7.0.2 为 Apache-2.0；better-sqlite3 13.0.3、zod 4.6.7、pino 10.4.0、Vitest 5.1.0、tsx 4.23.15 为 MIT。没有移除依赖包自带 LICENSE。未发布分发包，后续打包仍须核对全部传递依赖及原生模块许可与ABI。

## 2026-11-05：源码只读核对与字段路径借鉴

按用户要求核对原方案候选源码，固定提交、实际处理方式及局限记录于 `docs/UPSTREAM-COMPARISON.md`。没有整套引入、安装或执行上游应用；其他候选本次仅阅读，不推定它们均有可复用许可。

其中 `LockyBee/dsh-douyin-agent` 的 `chat-browser.mjs` 与 `message-tracker.mjs`，提交 `7989640e340f0fd79e2de9874880d5197546e755`，根 LICENSE 已读取并确认为 MIT。本次借鉴当前已渲染组件的固定字段路径、会话交叉绑定及窗口身份分层思路，独立编写本机有界只读探针；未复制源函数、宿主依赖或发送实现。探针验证服务端 ID、会话 ID、创建时间和可见正文一致，真实值只留私有运行目录。正式适配器接入及后续实际移植应继续记录具体文件、测试与修改范围，不把本地指纹当平台 ID。

补查不同作者的`miqian-nomad/dsh-douyin-watch`，提交`177810c1f1858b529e78531f837ac9677fb9f9a9`，只阅读README及通知、评论列表、楼中楼和回评源码，未复制代码或运行脚本。补查时其评论列表发现、内部接口及UA替换路线不符合当时边界，未接入应用；随后用户允许的两个作品补充发现采用正常网页读取，未采用watch的私有接口或UA替换。不能把它与原方案中的LockyBee仓库混同。

## 正式只读采集器的适配复用

`src/adapters/observed-reader.ts` 的数据描述符读取小段适配自上述MIT提交的 `chat-browser.mjs` 中 `dataField`（337—349行）；保留根许可于 `third_party/LockyBee-dsh-douyin-agent-MIT.txt`。本项目将上游“不可支持时返回缺失”改为明确阻断getter/描述符冲突，采用已经实机核对的固定组件路径，移除群聊、通用树遍历、媒体理解、DSH宿主和发送逻辑。会话行点击前的身份核验、别名冲突检测、可见消息筛选和有限就绪等待也先对照同文件 `readConversationListDom`、`readConversationDom` 及其测试后适配；这些是思路借鉴，不整套复制上游实现。

验证覆盖同名非授权会话零打开、隐藏气泡/正文排除、冲突会话ID拒绝、getter不执行、方向标记在内容祖先及异步渲染就绪；新增路径同时在源码tsx子进程和编译后普通Node执行。真实CLI及SQLite结果单列在进度、矩阵和审查记录，不以这些合成测试代替实机。

本切片最终三项修复实施前，继续核对同一固定MIT提交的`readConversationDom`完整窗口处理、`contactList`行元数据就绪及`select`/`stableConversation`会话切换流程：不沿用本项目初版前20条截断，处理全部不超过100条可见消息；先检查准确当前聊天，必要时正常返回列表。上游多阶段选择操作不能直接解决本机复现的document mousedown变目标间隙，因此沿用inbora已有发送门禁的同步绑定原则，独立编写只读选择的目标capture复核和单事件派发，不复制上游提交流程。真实行已观察到onMouseDown，私有映射明确采用mousedown；只验证该选择事件，不触发发送。对应新增3项红绿回归、第21/22条独立探针、源码及编译冒烟、原生Edge源码CLI补验均通过。

2026-11-05用户要求每个新功能/修复前均先找开源复用候选；已写入AGENTS。后续每项在实施前更新本记录或对照报告，说明直接复用、适配或不采用的依据。

## 下一切片前核对：准确回复输入与回读

实施前再读上述DSH固定MIT提交的`comment-browser.mjs`输入区域/原生发布标记检查、`chat-browser.mjs`的`readConversationDom`和`sendMessage`：可沿用本项目已适配的数据描述符方法，并参考私信服务端ID、创建时间、发送中/失败标记、输入框与按钮归属检查。DSH的公开评论发送明确拒绝回复他人，不能直接复用为楼中楼发送；其完整物理鼠标序列也不取代inbora单次DOM提交门禁。先只读校准本机回复状态与控件，尚未接入真实发送。

同时检查watch固定提交的`tools/comment-thread.mjs`页面回复读取。其无reply_id时把非目标评论先纳入回复集合的回退不足以证明父评论，且全页面div/fiber扫描、签名直连不在本切片采用范围；不复制该代码。准确父评论必须由本机可见层级和已核对的原生绑定证明，字段不足时继续阻断。该源码核对仅指导选择校准路径，不构成C04/C05通过。

恢复后的私信回复切片实施前，再核对DSH同一固定提交`chat-browser.mjs`的发送标记SVG/父元素处理、最新端证据、原生serverId/createdAt、输入区草稿保护及回读循环。选择复用已有MIT数据描述符小段与ObservedReader，独立实现当前会话范围内的最终同步门禁；不采用DSH物理鼠标链、上游缺少serverConfirmed时仍可能放行的回退，也不把窗口index当平台ID。实际UI标记为SVG，只支持一次绑定的DOM click事件派发，不模拟pointerdown/mousedown序列，不调用网页onClick函数、SDK或私有接口，不在失败后切换提交方式。

已核对Playwright 1.64.1固定版本的fill与dispatchEvent官方文档：fill支持contenteditable，单个DOM click事件可直接派发到SVG；本项目仍额外核验可见性、归属、输入全文、账号与上下文，派发必须位于持久意图之后。此路径的合成与实机验证分别记录，不能由文档或上游推定抖音接受。评论楼中楼发入样本按用户要求延至明天，先完成不依赖该样本的私信链路。

输入复审修复前再次核对DSH的readableDraft/innerText及Playwright固定版本的contenteditable `_insertText`：前者保留渲染换行但trim/去除多种字符会改变批准全文，故只采用渲染文本读取，保留本项目逐字比较；后者使用浏览器execCommand insertText。原异步fill在focus后可覆盖刚恢复的人工草稿，改为同一浏览器任务聚焦、重核原输入与原生身份、绑定选区后执行一次原生纯文本编辑，失败不回退也不清理新用户输入。该API有兼容性限制，仅对当前固定Edge实际验证，不推定其他浏览器支持；不调用网页编辑器方法或剪贴板，不复制Playwright源函数。对应焦点复用/人工草稿、多行回归先复现再修复。

布局修复先核对同一DSH文件`readableText`的BR遍历；其trim不能保留本项目批准的首尾换行，因此未直接复制。进一步合成DOM证据显示innerText会多计空段落占位BR，最终独立按有界DIV/P段落与BR重建正文，保留空格和首尾/连续换行。Windows CRLF在保存草稿、展示审批之前统一为LF；已有审批不自动改写，批准后仍逐字比较。夹具以实际input事件建立独立文本模型，未使用产品DOM解析器生成成功回执。原生编辑路径实测未触发beforeinput，因此移除未生效的监听，不把它算作输入前防线。

后续全文复审发现行内BR不能套用段落caret规则；先补实际错误点击红测并扩查行内包裹块，再按上游明确保留BR的思路限制占位规则仅用于DIV/P，未知行内/块混合直接阻断。不依据未校准的Slate属性丢弃非空编辑器片段；仅整个编辑器实际为空或单一零宽哨兵时视为空。批准后新增任何换行须在点击前阻断，不能等错误正文回读后才冻结。

进一步对照上游发送见证绑定思路，DOM段落与BR混合可能对应不同编辑语义，不能只靠重建字符串检测准备后的变化。本项目独立把同步写入后的准确编辑器结构保存在当前准备见证中，arming与最终点击均核对同一结构和全文；不允许后来重新排版借用原批准。两种同文不同DOM结构的错误点击红测先失败再修复，未知结构变化保守阻断，不让回读承担发送前全文门禁。

同形回执复查先对照DSH的失败/发送中图标检测，额外以本项目映射契约核对容器本身的状态标记：只查子节点会漏掉消息外框上的pending/failed。两项实际红测复现错误CONFIRMED后，采用范围内“容器及其子节点”一并核验；不照搬上游仅查后代节点的表达式，也不改松原生ID、时间或批准全文要求。

真实Headless源码CLI额外暴露列表容器先可见、评论行稍后挂载的读取时序。修复前核对DSH `waitCommentState` 的有限状态等待，实际阶段探针显示首次loaded0、约500毫秒后4行；延迟行夹具在原版确实返回空批次。现等待可见行或开发者已校准的空状态选择器，默认空状态为null，无法确认时阻断，不把加载中的空容器记为完成。旧映射按null兼容；没有猜测真实空文案或冒称第二作品已校准。

复审补充验证等待成功后行仍可能卸载，因此最终同步capture也必须在准确commentList内核验可见根评论或唯一已映射空态；无映射/空态消失时抛可等待NOT_READY。补充原子快照红测后修复，外层等待不作为单独的完成凭据。

## 直接回复已有一级评论：实施前核对

2026-11-05用户明确先测现有一级评论回复，不等待测试者先发子回复。实施前重读DSH固定MIT提交`7989640e340f0fd79e2de9874880d5197546e755`的`comment-browser.mjs`编辑器/原生发布标记、`readCommentDom`及草稿保护；它明确拒绝回复状态，不能直接复用为原评论回复。复用本项目已适配MIT数据描述符读取与持久发送协调器，不搬入其物理鼠标链或宽泛控件回退。

同时重读watch固定提交`177810c1f1858b529e78531f837ac9677fb9f9a9`的`tools/comment-thread.mjs`：原生回复ID、作者、时间与reply_id可作为核对方向，但缺父ID的默认归根、全页fiber遍历、注入XHR/fetch与直连接口不采用。仅检查本轮已授权原评论及其实际回复组件的固定渲染路径，观察正常网页操作产生的只读响应可作补证；未经实机校准的字段保持缺失，不用猜测或上游声明代替回读。

首条已批准私信在点击前因editor-kit行尾占位符被误算正文而阻断，意图/发送仍0。修复前再读DSH同SHA的`chat-browser.mjs:51 readableDraft`及调用点；其全局剥除零宽/方向字符并trim会改变真实正文，不能采用。实机固定DOM证据显示data-slate-editor/data-zone-container下的直接ace-line末端span带data-enter/data-string/data-leaf且仅含一个U+200B；仅将该完整结构识别为占位符，其他字符保留，形态不符直接阻断。对应真实结构合成红测先失败，再覆盖普通正文零宽字符及错误标记负例，不引入新依赖或网页函数调用。

复审发现嵌套可编辑根会借用同样标记属性，修复前再核对DSH `comment-browser.mjs findCommentSubmit`的唯一编辑器范围检查；本项目保留实际绑定根作为解析参数，并拒绝嵌套contenteditable，而不以最近的同属性祖先代替绑定根。嵌套根完整链红测先复现CONFIRMED，再收紧为零意图/点击。

一级评论适配的源码tsx子进程实际发现命名箭头带入模块__name辅助；再次核对本项目已修复的ObservedReader/DM对象方法及DSH页面函数序列化形式，改为函数内对象方法，不注入全局helper。源码与编译路径各自运行原评论夹具闭环；DOM元素只在浏览器任务内持有，各分支仅返回纯数据。

独立复审的BR单行、跨子回复拼接和外站同路径作者反例修复前，再对照DSH `readCommentDom`的owned范围与BR处理。单行Draft.js输入只接受已观察的一条contents/block/default-block结构；非空BR、额外块、隐藏内容及innerText不一致均在意图前阻断。收据必须先按cid定位一个直接子回复，再在该行交叉核对原生cid/父id/作品/level/作者/全文/时间/状态、准确同源作者链接及DOM正文；不拼用整个root的独立字段。通知平台来源ID与原评论cid分别绑定，沿现有跨源去重语义，不再要求二者相等。对应反例红测已实际失败。

实机预检两次DOM_NOT_READY后取得控件rect/style新证据：准确回复区空白时发布span为display:none，并非元素缺失。修复前核对DSH `readCommentInputState/findCommentSubmit`的归属及enabled阶段；不照搬其空态即要求可见的限制。本项目空态只核验唯一已连接的准确归属，arming有限等待图标显示，每轮重核全文/结构/原评论，最终click门禁仍强制可见/可用。异步图标红测先失败，未放宽最终提交条件。

随后受控时序探针证明另有Draft.js兼容问题：execCommand产生input而未触发beforeinput，14字正确DOM在约43毫秒后重渲染为28字并卸载，无新click记录。此问题与用户先前手动收起面板分别记录。修改前重读DSH同固定MIT SHA `comment-browser.mjs`的真实文字输入路径（pressSequentially）与当前Playwright 1.64.1固定源码/官方Keyboard.insertText文档。曾在合成阶段评估一次keyboard.insertText加beforeinput门禁，受控编辑器红测后通过本地文本链；该候选因下述iframe反例被否决，不属于最终实现，也未在真实编辑器执行。发送始终保留后续持久意图和单次DOM click，不以文档说明代替实际事件验证。

该原生键盘候选在进入真实填写前被独立iframe反例否定：Page级输入可以在异步间隙写入子文档人稿，顶层beforeinput不能保护，故不作为最终路线。进一步核对MIT的React v18.3.1（固定SHA f1338f8080abd1386454a10bbf93d67bfe37ce85）`packages/react-dom/src/events/plugins/BeforeInputEventPlugin.js`及Draft.js v0.11.7（固定SHA f55fa0f8da080fea74ae3fa98860c41db85cbeea）`src/component/handlers/edit/editOnBeforeInput.js`：React输入插件可从textInput事件取data，Draft在叶起点可采用受控渲染。先只在当前授权空编辑器做一次准确元素DOM事件探针，取消浏览器默认插字、不伪造isTrusted、不调用页面方法或内部EditorState，避免全Page键盘焦点写入。上游版本仅作机制参考，不宣称当前网页采用这些具体版本；未复制其实现或新增依赖，真实是否接受由本机探针决定。

本机准确元素探针实际通过：defaultPrevented=true、isTrusted=false，立即DOM仍空、1秒后准确14字全文且panel仍在，无意图/点击。最终输入实现采用此已验证DOM事件路线，事件对象只创建并派发一次，window及准确editor的capture门禁必须见到同一个事件；同步聚焦、原输入、目标、上下文和选区再次核验。完成阶段只等待原空态到批准全文，最多1秒；上下文或其他输入变化立即拒绝，准备后全文和DOM结构仍在最终发送门禁核对。iframe、人工草稿恢复、伪造其他事件及旧同文结构反例由合成探针独立验证，不以该输入探针冒充真实发送回读通过。

用户手机端未见回复后的排查，先再读DSH同固定提交的comment-browser控件几何、findCommentSubmit、enabled和发送后双轮回执；上游的物理输入及回复拒绝限制仍使其不能直接替换本项目路径。当前准确控件实机只读观察到onClick处理器，原评论仍无子回复；没有采用替代事件或源码修复，不能由上游成功声明推断本次平台结果。

用户明确再次批准该条评论重试后，实施前重读DSH固定MIT提交的`receipt-baseline.mjs preserveReceiptBaseline/matchCommentReceiptBaseline`及`comment-browser.mjs`未知收据保全。可复用保留原点击前基线、未知不重写的原则，但上游无可直接移植的本项目逐条人工重试事务；不复制宿主、文件收据或物理点击。独立使用现有SQLite WAL/FULL及账号协调器，在audit_events内追加独立授权/重试意图/结果记录，绑定旧意图、本地任务、文本/目标摘要和预算，不改schema或删除旧记录。仅显式人工入口允许本期每个旧未知评论意图一次重试；普通send与重启继续冻结，回读要求不降低。

重试复审发现preflight变化或来源碰撞后旧grant仍可复用，修复前对照DSH收据基线不可覆盖及本项目普通SendCoordinator审批失效流程；不沿用候选重试授权的宽松行为。以两条实际错误CONFIRMED红测确认后，任何准备阶段变化追加撤销记录，观察来源冲突同样撤销关联grant；新意图事务再次核验撤销状态，原未知及审计不删除。

本轮迟到子回复补证前再次核对同一MIT固定SHA的`receipt-baseline.mjs`不可补造/覆盖旧基线及两次只读快照比对、`comment-browser.mjs`的readCommentDom。上游只读DOM的缺状态推断不足以满足本项目绝对时间/准确父评论/原生确认状态要求，不直接复用为成功收据。仅在本机私有诊断探针中将正常页面GET响应与准确可见直接child交叉核验，追加独立补证，不修改生产适配器或原未知收据。原始响应与探针均不提交仓库。

## 启动即静音的源码先核对

用户新增静音要求后，先核对LockyBee固定MIT提交的`browser-host.mjs` 125—127行；上游显式移除`--mute-audio`，与本次要求相反，未采用。再核对Playwright 1.64.1（Apache-2.0，提交`cfe490d941f992655948eee8fd4fd94e1c4234bf`）的Chromium启动参数：默认仅在headless分支添加该参数，因此本项目通过公开args选项对所有模式显式添加，未复制源函数或引入依赖。安装包`lib/coreBundle.js`和官方固定版本参数文档均已核对；Chromium的`media/base/media_switches.cc`说明该参数在设备输出端静音。启动参数在导航前生效，覆盖同进程所有标签页。

来源：[Playwright固定提交的args文档](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/docs/src/api/params.md#browser-option-args)、[Chromium静音开关说明](https://chromium.googlesource.com/chromium/src/+/ea1b3b85f6f7d729e484568979294afc1b1249a4/media/base/media_switches.cc)。仅使用公开启动参数，没有复制Chromium源代码；Chromium源文件标注BSD许可，DSH与Playwright许可如上。

验证只检查本项目专属Profile进程，不读取其他浏览器资料；不为读取命令行而追加enable-automation或改动浏览器身份。原生有头启动缺少静音参数已由本机进程探针复现，修复后对源码/编译、有头/无头和关闭重启逐项复验。

## 2026-11-09：评论表情正文、单行隔离与付费门禁

用户提供已加载评论区截图并要求查开源方案后，先保留私有截图，使用合成页面复现IMG表情、纯表情、BR与单行冲突阻断整页读取；未把截图当作已取得网页DOM字段。修改前联网重新核对三个仓库HEAD并下载固定版本的具体源码/许可；文件SHA256索引只留`.local/upstream-review/collection-20261109/index.json`。

| 候选及固定SHA | 具体实现与许可 | 采用结论 |
| --- | --- | --- |
| LockyBee/dsh-douyin-agent `7989640e340f0fd79e2de9874880d5197546e755`，仍为当前HEAD | MIT；`comment-browser.mjs:344–375`的`readOwnedCommentText`按owned正文遍历文本、BR及IMG alt，限制节点/图片/协议；`tests/comment-browser.test.mjs:405–489`覆盖表情、缺alt、隐藏、嵌套、换行、确认与旧编号 | 适配该小段至两份序列化捕获函数，保留MIT许可于`third_party/LockyBee-dsh-douyin-agent-MIT.txt`。不trim空白，将长度上限与现有入站10000字符合同一致，fixture仅允许同源HTTP资源；真实页面仍要求HTTPS且无URL凭据。收取和发送前均与原生全文逐字比较，不借metadata补造DOM全文或成功收据。[源码](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/comment-browser.mjs#L344-L375)、[测试](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/tests/comment-browser.test.mjs#L405-L489) |
| miqian-nomad/dsh-douyin-watch `d1a14e3fc8d7a18089d412ae3479365974c069df`，本轮当前HEAD | MIT；`tools/work-comments.mjs:65–130`直接jget本人作品和评论接口；`tools/im-send.mjs:408–454`派发Enter并有点击事件链回退 | 只读比较，不复制接口/提交路线。它不能直接证明本机owned正文/准确父评论和单次点击合同。[收取源码](https://github.com/miqian-nomad/dsh-douyin-watch/blob/d1a14e3fc8d7a18089d412ae3479365974c069df/tools/work-comments.mjs#L65-L130) |
| JMY2003/a-skill-to-do-anything-in-douyin `d5211b3d687ddab0d5efc32b915a636aba764423`，当前HEAD未变 | `scripts/douyin_web.mjs:502–518`读取innerText/textContent/aria；固定提交根LICENSE返回404，未核准可复制许可 | 只读研究，不复制。没有提供表情全文与原生元数据双向核对、单行隔离或持久质量门禁。[源码](https://github.com/JMY2003/a-skill-to-do-anything-in-douyin/blob/d5211b3d687ddab0d5efc32b915a636aba764423/scripts/douyin_web.mjs#L502-L518) |

inbora独立增加`COMMENT_TEXT_UNVERIFIED`质量标记：对不齐的行保留入站及待核对状态，不能成为强事件，不中断同页其它评论；可靠旧历史仍为BASELINE。未带标记的既有eventBinding保持完全一致，质量变化只追加证据，不改写已存意图、收据或其批准修订。人工AI入口及DeepSeek预算事务同时检查原记录/冲突证据和上下文，未核验正文在策略预占、累计MODEL扣费和请求前拒绝。

六项新浏览器回归已在隔离的旧HEAD `98db895` 实跑全红，再在修复上通过；审查补出的旧基线两个方向、未核验正文付费入口/上下文及既有意图修订保留也先红后绿。源码tsx冒烟实际抓到新增局部箭头的`__name`闭包问题，改成捕获函数内方法后源码与构建路径分别验证。真实GUI由用户手工测试；这些结果不等于当前真实采集恢复或新策略闭环已验收。

## 2026-11-09：多对象失败与通道退避组合

0.3.1真实后台首次读完一个原失败作品，并对另一个会话完成有界读取；随后3个坏会话被暂缓，通道指数退避使旧失败对象的120秒冷却先到期而重新抢占未读对象。4次退避只涉及3个不同会话，不能据单坏会话回归宣称整个收件箱公平。修改前复读MIT DSH固定`7989640e340f0fd79e2de9874880d5197546e755`的`chat-service.mjs:676–681`、`:881–902`、`:982–1010`及保留LICENSE：它按联系人保存下一重试时间，单对象普通错误后仍继续处理其它联系人。采用对象与全局错误分层的思路，不复制其原始error.message落盘、原发送维护流程或更宽的收据判定。[每对象重试](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/chat-service.mjs#L676-L681)、[对象循环与异常](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/chat-service.mjs#L881-L1010)

inbora独立使用`DeferredObjectRead`表示已成功持久化的对象退避：通道保留错误、失败次数及原last_success，下一轮仍按正常间隔服务其它对象；真正列表/全局错误继续指数退避/停止。过期失败记录保留上次尝试顺序，以成功读取时间和失败尝试时间的较大值公平排序；重建collector可恢复，成功后移除该对象失败项，不改变失败对象last_read。作品首次读取失败写last_read=0，已有成功水位保持。固定阶段代码区分选择后聊天未挂载、评论正文/编号组件未就绪，不保存选择器、私人正文或原始异常，也不放宽身份/正文或发送门禁。

4个和10个坏会话后有一个好会话的SQLite+浏览器组合回归在旧隔离代码实际全红，修复后通过，覆盖冷却到期、第3轮重建及游标ID唯一。正文、编号、账号头像、评论列表及根评论/明确空态5个缺失组件诊断先红后绿，首次作品失败的假成功时间也已先红后绿。单对象、全局停止及取消、错误保留和原last_success的直接回归一并验证；新差异不会靠原始0.3.1已运行来冒称已载入现场。

## 2026-11-09：日常自动回复开关、持续在线及无正文诊断

修改前复核同一MIT固定提交`7989640e340f0fd79e2de9874880d5197546e755`：`chat-service.mjs:16`默认未配置允许会话，`:457–479`将本人选择保存为持续范围；`contact-authorization.mjs:18–35`保留授权来源及稳定会话身份；README明确总开关不会自行添加许可会话。采用一次明确范围、范围内后台处理的结论，不引入其逐会话产品上限、DSH宿主或更宽的提交路线。[持续范围源码](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/chat-service.mjs#L457-L479)、[授权身份](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/contact-authorization.mjs#L18-L35)。另一MIT候选watch固定`d1a14e3fc8d7a18089d412ae3479365974c069df`的`tools/im-send.mjs`由调用命令给出目标和正文，没有同样的GUI策略步骤；不将缺少独立弹窗推断为可以无范围外发，也不复制其Enter/点击链回退。

单账号常在线沿用现有BrowserProfileOwner公开生命周期和单持有者。对比DSH同提交`browser-host.mjs:113–143`的独立持久宿主后，不引入另一进程、CDP接管或新调度框架。普通浏览器关闭进入有界重连，身份/验证码/平台停止仍持久阻断；两项相关测试先红后绿。`chat-browser.mjs:1026–1049`在返回列表后让步再定位，为本次会话关闭动画竞争提供具体参考；本项目等待已校准聊天范围隐藏，不照搬固定100ms等待或多次点击回退。延迟返回后再发现/重开会话的浏览器回归已先红后绿。[返回列表源码](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/chat-browser.mjs#L1026-L1049)

`diagnostics.mjs:9–38`使用固定检查代码和有界步骤。采用结构化诊断思路，独立实现失败时的只读组件几何报告：在同任务核对账号及准确作品，限定已映射范围、最多250行计数及6个根行样本，只输出数值/布尔和固定枚举，无正文、输入值、原生编号、选择器或网站状态遍历。每个collector每通道至多一次，保存私有evidence，不改变原错误、意图或成功水位。Playwright固定Apache-2.0提交`cfe490d941f992655948eee8fd4fd94e1c4234bf`的`packages/injected/src/domUtils.ts`另用于核对display:contents可见性语义；未取得实机几何证据前不据此放宽根评论门禁或猜改映射。[诊断源码](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/diagnostics.mjs#L9-L38)

自动开关及一次启用由本项目应用服务事务实现，不复制上游代码。关开竞态覆盖模型资格返回边界、迟到结果、未提交命令及意图后回读；取消状态在请求前和预算预占回调检查。原生指令允许列表与应用合同逐项比对，缺少新命令的旧Rust入口已在隔离检出实际失败。模块按职责拆分以满足800物理行限制，未更改唯一SendCoordinator和历史证据。

## 2026-11-09：私信跨窗口补收与评论进入视口

再次读取已核准MIT固定提交`7989640e340f0fd79e2de9874880d5197546e755`的`chat-browser.mjs:386–393`、`:864–869`和`:1119–1142`。前者识别column-reverse及纵向transform，第二段滚动的是会话列表，最后一段没有消息历史续查；不能将它们冒称现成私信历史分页。采用标准DOM几何、小窗口读取和原生稳定身份的思路，独立实现已映射聊天内唯一消息overflow祖先的滚动；没有复制上游代码、接口或网页函数调用。[方向与渲染](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/chat-browser.mjs#L386-L393)

每个后台回合只收一个窗口，复用私有cursor_json保存准确peer、两物理方向的续查及边界样本，避免凭CSS猜较早消息在哪一端。高度变化丢弃旧偏移；完成前不推进last_read，失败仍退避并让其它对象继续。整窗旧历史判断须覆盖所有行、无unsupported、时间可靠且早于持久起点；原生恢复在旧位置时先有界探测两个端点，不直接宣布收完，也不逐窗归档更旧历史。恢复只在相同本人、会话和原生身份下刷新可变显示名。没有新增模型或发送路径。

0.3.3实机无正文诊断已证明某视频评论列表top818、首根评论top827，而viewportHeight720；五条根评论及其正文已加载，读取失败因列表在视口下方。复读同MIT提交`comment-browser.mjs:169`的正常scrollIntoView用途后，采用标准DOM滚入视口，不复制其输入/鼠标见证路线。新commentReveal及续查滚动均在同一任务验证账号、准确作品、唯一已映射列表和空编辑器；正文/原生ID校验不变。[正常滚入视口](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/comment-browser.mjs#L169)

旧55f3047的两窗口补收回归实际只收到104/105而漏102/103；恢复旧窗及显示名变化另有独立红测，修复后通过。评论视口用例在有效夹具上以ROOTS_DOM_NOT_READY先红后绿，网页人稿仍拒绝滚动并保留。源码tsx与构建Node分别执行新增滚动/进入视口冒烟。合成通过不代表现有0.3.3进程已加载这些源码修复。

同提交`chat-browser.mjs:1023–1028`的返回动作选择更具体backBtn并使用Playwright click；本项目历史实机A/B切换亦走locator click，而新后台走映射wrapper的DOM click。当前实机证据仅证明后者点击后聊天未隐藏，未证明子控件/事件归属，不猜改选择器或派发事件。独立补充唯一已映射返回控件的有界无正文诊断：最多12节点、固定标签/中心命中枚举/尺寸/事件函数存在布尔，仅own data descriptor，accessor及多props拒绝，不执行处理器或getter。先取得归属证据再选择修复；源码及编译Node均执行该诊断冒烟。[上游返回实现](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/chat-browser.mjs#L1023-L1028)
