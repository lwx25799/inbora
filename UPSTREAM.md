# 来源与许可

## 2026-11-12：全局急停原因与显式恢复

实施前复读 MIT `Yht20927/douyin-cli` 固定提交 `4073159bea585de6d33a4747a475669440737932` 的 `lib/memory/failures.js:45–65,76–107`、`lib/commands/suggest.js:212–224,326–334` 及 LICENSE，采用稳定故障原因、发生时间与处理建议分离的组织方式；不将累计失败排行当作当前故障，不复制原始错误正文或查询失败放行。另核对 `lib/server/router.js:320–364` 的超时转轮询路线；恢复不采用写操作回退或重投。

本项目独立复用既有 `audit_events`、账号协调器和页面门禁，无新增依赖或数据库迁移。急停开关与固定枚举原因、来源、时间事务保存，二次故障保留首因并更新恢复比较标识；旧急停只显示未知时间及明确标注的诊断提示，不补造历史。显式恢复在仍急停时检查原账号及两个专用页面，并在同一账号任务的最终检查后同步提交比较事务；取消、超时、新急停或页面阻断保留停止。既有意图、收据、草稿、预算和水位不重写，不增加发送或模型授权。适用 MIT 许可继续保留于 `third_party/douyin-cli/LICENSE`。合成、源码及构建链证据与真实界面验收分别记录。

## 2026-11-11：本机 inbora MCP

采用官方 [TypeScript SDK v2.4.0](https://github.com/modelcontextprotocol/typescript-sdk/tree/951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5)，固定提交 `951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5`；直接依赖 `@modelcontextprotocol/server` 精确 `2.4.0`，传递依赖 `@modelcontextprotocol/core` 同为 `2.4.0`，包完整性由 `pnpm-lock.yaml` 固定。核对源码 `packages/server/src/server/{mcp,stdio,serveStdio}.ts`、`docs/serving/stdio.md`、`docs/servers/tools.md` 和 `docs/migration/support-2026-07-28.md`，使用官方 `McpServer.registerTool`、Zod 4 输入/输出校验、`StdioServerTransport` 和 `serveStdio`；由 SDK 选择旧 `initialize` 或新发现协议，没有自制 MCP 服务端协议。

保留包内 Apache-2.0 及所含 MIT 过渡声明于 `third_party/modelcontextprotocol/LICENSE`，文件 SHA256 `0382b0057770ca05e9c350a50aa3b1c1fea84da0bc81d723bf00b9aa841be58a`。SDK 包声明 Node >=20、Zod ^4.2.0；本项目使用 Node 26.13.0、Zod 4.6.7、TypeScript 7.0.2。新增依赖只有上述 server 及其 core 传递包，不引入模型 SDK、浏览器持有者或第三方云服务。

依照 [pnpm 官方设置说明](https://pnpm.io/settings)，11.x 的缓存与 store 设置写入 `pnpm-workspace.yaml`，本项目使用 `.local/pnpm-cache`、`.local/pnpm-store`；保留现有原生包安装脚本限制。干净依赖安装、实际 Windows Node-API SQLite 写入及关闭重开验证在隔离检出完成，普通开发入口继续复用这些项目内缓存。

MCP stdio 只做严格工具适配，通过随机凭据访问现 Sidecar 的回环入口。凭据与模型 Key、桌面管道 nonce 分离，以 Windows CurrentUser DPAPI 加密，绑定真实运行目录、实例和进程；不会放入 Codex 配置或命令行。业务仍走现 `ClientService`、账号队列、持久命令/意图、单次发送协调器与回读，`LOCAL_ASSISTANT` 独立解析授权，不修改历史 MODEL/AUTO_REPLY 摘要。草稿来源 `MCP_ASSISTED` 不取得人工媒体资格。连接协议复用不代表页面字段、真实账号发送或 GUI 视觉已经验收。

Codex 安装字段依据[官方 MCP 配置文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)：绝对 Node 路径、stdio 参数、cwd、非必需服务及启动/工具超时。安装只变更 `mcp_servers.inbora`，先保留相关原配置。按用户最终要求，可信本机连接直接控制当前客户端，不另设分项权限或独立额度/期限；首次鉴权后持久绑定当前本人账号与既有收取范围，GUI 只保留启停，停用不得由重连恢复。模型许可及应用累计额度保持。

## 2026-11-11：完整审查后的草稿恢复与补证轮转

修复前复读既有 MIT Expat Chatwoot 固定 `625d5964e3cb3f1d917b43c3b8332219e525a4b8` 的 `conversations/actions.js:235–279` 和许可，以及 MIT DSH 固定 `7989640e340f0fd79e2de9874880d5197546e755` 的 `tree/message-tracker.mjs:36–96` 和许可。沿用显示状态与人工草稿分离、按准确身份推进的组织方式，独立修复纯分享会话的已存人工草稿恢复；无需自动回复的分类不再阻断人工续写。

旧补证先截取最旧 100 条再判断资格，不合格记录会永久遮住后续项。当前每个 Store 保留瞬态 rowid 扫描位置，每轮至多检查 100 条，向后并环绕；跳过不消费资格，后续证据齐全时仍可再检查。持久 V6 claim、批准全文、准确目标及异步再核验均保留，重启只复扫，不重放已消费补证。没有增加依赖、数据库迁移、发送路线或安装包。两项正式回归在原实现下分别失败、修复后通过；详细证据与本地诊断日志脱敏边界保存在私有运行目录的本轮修复报告。

## 2026-11-11：跨会话回执补证与评论分页证据

修复前复读 MIT `Yht20927/douyin-cli` 固定 `4073159bea585de6d33a4747a475669440737932` 的 `lib/commands/get.js:107–119,150–194` 及 LICENSE：根评论分页与具体父评论的子回复分页分别定位。独立修改本项目被动响应观察器，正常同作品分页未包含目标父评论时不覆盖已有准确子回复证据；尚未归属的请求先隐藏证据，准确空响应、反证、请求失败、导航和目标变化仍撤销。未复制 Bridge 或主动接口调用。

补证与状态显示复读 MIT DSH 固定 `7989640e340f0fd79e2de9874880d5197546e755` 的 `receipt-baseline.mjs:62–91`、`comment-browser.mjs:344–373`，以及 Chatwoot 非 enterprise MIT Expat 固定 `625d5964e3cb3f1d917b43c3b8332219e525a4b8` 的 `app/models/message.rb:104`、`conversations/actions.js:406–435` 及各自许可。采用保持原基线、结果与处理状态分离的原则；本项目独立实现按每条意图的一次有界只读补证，继续使用准确账号、目标、批准全文、原生 ID 和现有回读证明。没有重建点击前基线、改写原收据或新增提交路线。

实机根评论正文中的 SVG 路径图标暴露原有 DOM 正文重建限制。沿用既有 MIT 适配来源，独立支持准确正文内无文字、无外链、至多八个 g/path、尺寸不超过 32px 的 SVG；正常命名空间不作为资源 URL。带文字、标签、外部引用、未知元素和正文不一致仍拒绝。收取与发送前核验采用相同规则，源码 tsx 和构建 Node 各九项浏览器断言通过。实机只读补证共恢复七条记录；原业务账本摘要保持。详细证据与剩余边界见 [回执差异验收](docs/REPLY-RECEIPT-FIX-2026-11-11.zh-CN.md)。无新增依赖、版本号或安装包。

## 2026-11-11：表情预览、分享待办分类与全部已读

修复前复读 MIT DSH 固定 `7989640e340f0fd79e2de9874880d5197546e755` 的 `chat-browser.mjs:398–459,1110–1140`、`message-tracker.mjs:37–124` 与许可，采用准确原生消息、媒体与文字分离及完整身份绑定的原则。旧弱媒体与当前已证实文字的展示兼容只允许同一完整身份元组，采图前后仍核对当前完整绑定，不改存量事件、审批或发送资格。旧实现新载体回归 4 失败／9 通过，修复后 13 项通过。

图片绘制顺序另核对 [CSS2.2](https://www.w3.org/TR/CSS22/zindex.html) 和 [Flexbox](https://www.w3.org/TR/css-flexbox-1/#painting)：共享 block 父节点下独立原子层的内部或共有祖先 flex/grid 布局不改变其兄弟树顺序。独立修正误判，保留直接 flex/grid 排序、3D、顶层和前景遮挡门禁；真实浏览器像素对照旧码 5 失败／7 通过，新码 12 通过。合成证明不代表全部历史 OBSCURED 或裁切图片已经恢复。

展示标签继续核对 MIT UniEmoji 固定 `57568e94124772d5a4802f3e42d9c93c1fc5690d` 的 `emoji.json`、`docs/archive/EMOJI_KEYS.md` 与许可，独立扩充明确的 Unicode 近似显示，保留原标签说明、未知原文及原业务文本。没有复制平台图片；本机 Segoe UI Emoji 缺 U+1FAF6，故比心采用兼容爱心近似图形。新增三项静态渲染旧二失败／一通过，新三通过；本机字体 cmap 核对新增字符无缺失，不能据此冒称全部实屏效果通过。

已读和会话展示复读 Chatwoot 非 enterprise MIT Expat 固定 `625d5964e3cb3f1d917b43c3b8332219e525a4b8` 的 `conversations/actions.js:235–279`。采用阅读状态、消息显示和送达状态分离；独立实现既有 audit 中的事务读取边界、UNREAD 筛选和原生白名单命令，不复制上游网络调用。已读不改草稿、任务、意图或收据，新入站重新未读。默认评论详情补全未确认提交全文，不伪造成功。

用户明确分享视频／图集不应作为待回复任务后，复用本项目已校准分享 manifest／固定已识别外壳原因：正常启动、收取及展示更新仅持久记录准确事件 binding 的分享类型，缓存过期不让其重新变待办。已回文字后仅有分享保持已回复，纯分享显示无需自动回复；准确绑定但不能自动处理的其它媒体显示需人工查看，有未回文字仍保留文字待办。身份碰撞、会话身份矛盾和未知提交继续等待；不新增模型或提交路线。分类三项与分享投影八项均有有效旧码红测，媒体另有五项目标红测和两项草稿续写红测，安全反例保留。私信会话保留最后确认之后的未提交人稿续写入口，分享不遮住已存草稿。首次夹具失败另存而不计为产品红测。

当前运行差异、用户确认及剩余范围记在本机 `docs/INBOX-EMOJI-FIX-2026-11-11.zh-CN.md` 和当前验收总表；沿用已有许可文件，无新增依赖、安装包或版本号。

后续回归复读同一 DSH 固定提交 `tree/message-tracker.mjs:36–96`、`tree/outbound-send.mjs:70–96` 与 MIT 许可，采用入站及已确认出站分离的原则。本项目人工追加回复经既有统一协调器确认后，按完整审批、全文、准确账号／会话／事件、原生收据和时间核验纳入会话显示覆盖，保留逐事件原账本；只覆盖点击前已观察的无意图消息，新增文字与未知提交继续等待。独立“需人工查看”筛选沿用上述 Chatwoot 投影组织方式，已读后仍可查阅。评论补证回归覆盖最新结果、刷新通知及同根新增留言，保留准确父评论边界。

## 2026-11-10：手动私信同步复用持久收取器

处理“评论同步完成；私信同步失败：私信正文正在加载，后台已保留收取进度”前，再读MIT固定 `4073159bea585de6d33a4747a475669440737932` 的 `lib/commands/get.js:26–76`（逐项组织、事务保存）及现有候选记录。上游没有本应用的准确会话DOM、首次起点和公平续查合同，本轮直接复用本项目已有 `InboxCollector` 与 `CollectionScheduler`，不另写宽松正文解析或照搬上游接口/ID转换。

合成实测旧手动静态映射遇首条正文晚挂便中断后续会话，而持久收取器会保留对象退避并推进正常会话。现已启用来源的手动同步与后台共享有界调度、取消和持久水位，未启用来源保留有限映射；已保存的对象退避显示“后台继续收取”，成功只说明本轮。账号/平台门禁、网页人稿和未知不重发不变。红绿与实机边界见 私信同步修复记录（本机开发文档：`docs/DM-SYNC-FIX-2026-11-10.zh-CN.md`）。

## 2026-11-10：优化实施与直接复用

本次已将固定 MIT 提交 `4073159bea585de6d33a4747a475669440737932` 的响应分类、回复指令、累计统计和有界维护组织适配到业务源码。对应文件为 `src/adapters/normal-response-reader.ts`、`src/ai/reply-style.ts`、`src/app/diagnostics.ts` 和 `src/app/evidence-maintenance.ts`；完整版权许可保存在 `third_party/douyin-cli/LICENSE`，统计来源补充见 [复用说明](docs/UPSTREAM-REUSE-DIAGNOSTICS.md)。不复制损失大整数精度的转换、混排提前结束、私有协议、重复提交回退或无依据价格。

复审澄清：本版没有复制上游 `context-scope.js:39–49` 的 `dedupeByText` 函数。该函数用于成功示例语料，本版不新增这类额外示例，也不按去空白/忽略大小写合并真实对话；现有同目标准确上下文和重复出站拒绝保留。上游 `failures.js:76–102` 是累计历史失败排名，不能直接当当前阻塞；本项目诊断按准确事件最新持久补证及最新命令只读投影，不改写历史账本。

查询批量投影、六个兼容索引、事件刷新和引用保护为本项目适配实现，沿用准确目标、全文、持久意图和未知不重发合同。共享响应按具体 Response 只解析一次，再由消费者核验账号、页面代际、请求顺序和准确目标；2 MiB 限制是接受与 JSON 解析上限，Playwright 的正文缓冲及超时后底层读取不因此获得硬内存或取消保证。

实施结果、可复现基准、离线与实机证据边界、差异人工检查和回退方式见 优化交付记录（本机开发文档：`docs/OPTIMIZATION-DELIVERY-2026-11-10.zh-CN.md`）。下文保留审查时点的历史结论，不将过去“尚未复制”解释为当前实施状态。

## 2026-11-10：douyin-cli 关键链路完整审查与直接复用计划

用户要求审查 [`Yht20927/douyin-cli`](https://github.com/Yht20927/douyin-cli/tree/4073159bea585de6d33a4747a475669440737932)，并明确允许确认可复用的源码直接复制、移植或改造；已同步项目规则。固定SHA仍为 `4073159bea585de6d33a4747a475669440737932`，核对根LICENSE及package声明为MIT（Copyright 2026 Yht20927）。此前下文只覆盖评论增量，本次扩展Bridge、账号、IM、SQLite、ReplyEngine、模型、统计和保留维护。

- 计划直接适配 `lib/reply-engine/prompt-builder.js:100–131` 成功参考/avoid片段、`context-scope.js:39–49` 去重纯函数、`lib/memory/llm-usage.js:56–82` 及 `failures.js:76–102` 聚合查询；接本项目既有准确目标上下文、model_calls及固定枚举，不另建全局语料或重复账本。复制时保留MIT许可及来源；本轮尚未复制到业务源码。
- `lib/shared/parseResponse.js:23–64` 分类分支与合成用例可复用，但须先改安全ID与固定原因码；上游reviver无法恢复已损精度的19位ID。`get.js:161–166`混排提前break已实际复现漏后页；不替换本应用已实现的晚到、根子独立分页与持久续查。
- `lib/server/router.js:320–364` 的WS超时转轮询可重复派发写表达式；`scripts/douyin.user.js:63–93`强制探测为空可保留旧账号缓存；三项本机纯合成probe验证ID失真、旧身份缓存与WS重投。当前油猴默认HTTP，不能把WS支持路径缺陷泛化为默认HTTP必重发。另有WS握手无token/origin校验、静态token、任意eval与公开账号状态等静态发现，原样Bridge不进入可信控制链。
- 本地合成100/1k/10k事件、5次热运行中位数已量化全库查询与N+1成本；优先优化四条热读取、查询索引、已有Tauri事件，再按需适配上游模块。仅合成结论，不触真实库/Profile、GUI、模型或发送；未安装上游依赖或运行上游全套测试。

详细候选/文件/固定链接、采用与不采用原因、实测基准、分批变更、验证及回滚见 douyin-cli 源码审查与优化计划（本机开发文档：`docs/DOUYIN-CLI-OPTIMIZATION-PLAN.zh-CN.md`）。只读检出保留于忽略的 `.local/douyin-cli`；最小复现及脱敏基准留于 `.local/tests/source-audit-20261110`。历史“未复制/未采用”记录保留原时点含义，不构成当前禁止源码复用的规则。

## 2026-11-10：按用户要求追加核对评论增量候选

- MIT [`Yht20927/douyin-cli`](https://github.com/Yht20927/douyin-cli/tree/4073159bea585de6d33a4747a475669440737932)，固定`4073159bea585de6d33a4747a475669440737932`：读`lib/commands/get.js:26–76,107–119,150–194`、`lib/memory/comments.js:77–95`和`scripts/douyin.user.js:1083–1089`，核对其LICENSE。采用原生cid去重、原评论与子评论分别分页、每批持久保存的结论。它的`--new`在同批出现较旧评论时提前停止，并不证明后页没有晚到新评论；当前混排场景不照搬该提前结束。油猴bridge直接接口及其并行请求不引入现有客户端；既有单账号队列、正常网页读取及意图账本继续使用。
- [`NanmiCoder/MediaCrawler`](https://github.com/NanmiCoder/MediaCrawler/tree/306ab4ca26c0e44fb87ede0e40e98748752815a6)，固定`306ab4ca26c0e44fb87ede0e40e98748752815a6`：读`media_platform/douyin/client.py:248–275,277–334`及LICENSE，一级和子评论各自使用cursor/has_more循环；仅作结构对照，不直接复制。其许可证为NON-COMMERCIAL LEARNING LICENSE 1.1，且直接请求与签名组织不属于本项目当前网页收取实现。
- [`hycarbon-b/crawl-douyin`](https://github.com/hycarbon-b/crawl-douyin/tree/cdde8d7bfec3b018454705240fa0df6550ece6db)，固定`cdde8d7bfec3b018454705240fa0df6550ece6db`：读`reply_comment.js:61–103`，按固定评论容器滚动800像素、固定等1500ms，最多10次；仓库树未发现明确LICENSE，代码不复制。它不提供本机第7层容器、渲染帧或跨导航持久恢复的证明。
- MIT [`pcmxiao/dsh-douyin-bridge`](https://github.com/pcmxiao/dsh-douyin-bridge/tree/6e4bb7fb312ca980f500ce5eff9a714c2c78b560)，固定`6e4bb7fb312ca980f500ce5eff9a714c2c78b560`：读`lib/bridge.mjs:682–706,717–785`、`lib/state.mjs:139–174`与`lib/comment.mjs:417–478`及LICENSE/NOTICE。采用持久去重和首次基线的组织原则，保留本项目原生ID与全号持久起点；不采用仅显示名/方向/前80字指纹（会合并不同原生同文消息）、最多20条窗口、off连收取都停或超时后仍在运行的Promise.race组织。该候选评论读取只返回当前DOM索引/摘要，不提供本机所需的cid/时间/分页/根子定位证明，不能直接代替现有准确评论定位。

上述具体源码和索引只保留于忽略的`.local/upstream-review/comments-20261110`，没有运行候选、安装依赖或把真实账号/Profile交给候选。采用结论落实到本轮持久未完分页、逐窗保存和混排回归；实机闭合单列，不把候选自述当本机已通过。

## 2026-11-10：主评论分页与原生滚动恢复

实施前复用已核对MIT watch固定`177810c1f1858b529e78531f837ac9677fb9f9a9`，复读`tools/work-comments.mjs:110–119`对`has_more/cursor`与当前批条数分别处理的源码。采用“当前可见批不等于读取结束”的判断，不复制其私有接口请求、签名或并发请求器。本项目只监听正常网页GET的有界计数，仍由准确作品的原生滚动推进；最近可滚动祖先、持久未完页及公平两窗为独立实现。实际第7层与未完分页诊断、新红绿和源码tsx/构建Node序列化结果分别记录，不将上游可用声明冒充本机通过。

有界渲染等待实施前另读Apache-2.0 Playwright固定`cfe490d941f992655948eee8fd4fd94e1c4234bf`的[`packages/injected/src/injectedScript.ts:653–696`](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/packages/injected/src/injectedScript.ts#L653-L696)，其稳定检查在原生动画帧中读几何；并核对[HTML渲染更新阶段](https://html.spec.whatwg.org/multipage/webappapis.html#update-the-rendering)。采用按真实渲染帧让步的原则，独立实现限时等待，不复制上游轮询器或将两帧等同平台数据已完整。纯capture合成对照中，原150ms及追加500ms仍未收到末端滚动事件，正常两帧后才收到；无头双Page两帧耗时5.5/1026.2/1756.6ms，激活同一Page后16.9/28.4/19.9ms，两者visibility均visible。因此保留原无头两Page，仅在原账号队列激活对应Page，并采用最多5秒、受整体30秒约束的实际帧资格等待。原地赋值取消事件的假设经单差对照否定，不用它解释实机故障。

## 2026-11-09：会话回复投影与根评论上下文

复读MIT Chatwoot固定`625d5964e3cb3f1d917b43c3b8332219e525a4b8`的会话actions与消息状态分离，以及MIT DSH固定`7989640e340f0fd79e2de9874880d5197546e755`的`chat-message.mjs:36–62`。独立修正只读会话投影：按可信批准、意图及最新确认结果覆盖准确派发前观察，历史未知保留其账本/门禁，不能永远推翻后来已回复的会话；原生我方观察不单独充当送达证据。

根上下文实施前核对MIT watch固定`177810c1f1858b529e78531f837ac9677fb9f9a9`的`tools/work-comments.mjs:175–243`，采用根/子身份、原生链与时序区别。复用既有SQLite入站及确认意图/补证/显式重试记录，无新迁移；根固定保留、同账号/作品/根隔离、旧未知不冒充我方已发送。模型从根开始且保有限后续上下文，界面分页不改变发送目标；缺根在付费预占前阻断。未复制私有接口、猜造缺失父级或未保存的我方历史。

## 2026-11-09：晚到强入站的后台资格

复读上述MIT watch固定`177810c1f1858b529e78531f837ac9677fb9f9a9`的`tools/work-comments.mjs:144–203`与`tools/comment-api.mjs:207–210`，采用按独立原生子ID发现隐藏回复的结论，不复制私有请求。本项目独立复用已有observations与audit：准确启用收取范围内、严格晚于运行起点及不可变scope基线的强事件，两次不同证据且相隔至少1秒的稳定绑定读取后，才将无碰撞/草稿/意图/自动任务的晚到记录转待处理。普通PoC水位分类及历史不变；新资格不包含模型或发送批准，后续仍走新鲜目标检查、当前策略与唯一协调器。无新依赖或迁移。

## 2026-11-09：已加载图片的有界预览与只读上下文补证

继续核对MIT DSH固定`7989640e340f0fd79e2de9874880d5197546e755`的`chat-browser.mjs:411–425,1166–1183`、`chat-message.mjs:36–62`及`receipt-baseline.mjs:62–83`：采用准确消息范围、连续原生上下文及保留旧收据的结论，未复制宿主或放宽身份。结合[Canvas图像源及安全规则](https://html.spec.whatwg.org/multipage/canvas.html#security-with-canvas-elements)，独立使用脱离文档的canvas缩小已经加载的准确正文图像，最大512边/160KiB；前后核账号、会话、原生消息、作者、时间、源指纹和尺寸。无fetch、新页面或DOM插入；跨源污染只返回固定原因并走原严格截图，不绕过浏览器限制。下文不使用canvas的记录描述初版截图方案；当前允许本段限定的安全解码预览。

只读DM补证使用持久批准摘要核对一次新鲜DOM中的唯一完整/前缀/后缀窗口；只可裁去有可靠原生ID且早于目标的旧边界，最多两次正常窗口候选，不拼接存量tuple。新合同在核验前持久消费一次，限定自动策略产生、已耗尽原两次核验、存在唯一两秒内我方同文原生候选的未知意图；原意图、收据、预算及旧核验行不重置。候选原生ID摘要绑定最终结果，后续仅追加证据与送达关联；不提供再次提交能力。固定阶段诊断不含正文、ID、URL或异常原文。

## 2026-11-09：楼中楼评论开关与准确子评论关系

实现前核对MIT `miqian-nomad/dsh-douyin-watch`固定`177810c1f1858b529e78531f837ac9677fb9f9a9`的`tools/work-comments.mjs:144–203`及`tools/comment-api.mjs:207–210`：采用根评论reply_id与准确被回复子评论reply_to_reply_id的不同关系，禁止把二者合并或用回复根代替回复本条。未运行或复制私有接口提交路线；仍只通过正常网页操作和唯一SendCoordinator。另复读MIT DSH固定`7989640e340f0fd79e2de9874880d5197546e755`的`comment-browser.mjs`已知输入归属核验，它本身不证明本机子评论可发送。

新可选rootCommentId/replyToCommentId只用于已证明的REPLY，旧一级事件绑定字节不变，缺父级关系保COMMENT_PARENT_UNVERIFIED。已挂载子行与根cid/level/作品/本号及作者/全文/时间交叉核验；父级未校准不猜。策略开关可选字段不注入旧scope默认值，effective默认开，关闭只作用楼中楼自动回复。收取展开续查、准确子输入与回读、新实机差异仍独立记录，不能凭开关宣称全闭环。

## 2026-11-09：无上限额度与预览圆角差异

复读MIT DSH固定`7989640e340f0fd79e2de9874880d5197546e755`的`video-limits.mjs:24–34,100–132`：采用明确null表示不限、实际请求继续累计的表示原则，不复制其宿主或请求器。本项目同时覆盖持久策略额度和全局累计门禁，automation附加schema3的budget_limits默认复制原有限值；GUI明确保存才改无限，原budgets.used、旧预占及所有意图/收据不重建。恢复有限按实际累计及策略剩余量计算，默认配置保存不扩张原有限上限。超过原50/20、两连接竞争、撤销/急停、升级恢复和GUI未保存不生效取得定向红绿。

同固定MIT来源的`chat-browser.mjs:1166–1183`采用准确消息、截图前后来源/矩形核验原则；其单点contains命中不直接满足本项目遮挡约束。实机新增body-free诊断证明图片中心命中IMG，而10px圆角外角点命中自己的DIV；独立适配仅豁免准确消息祖先中可数学证明的统一像素圆角裁去区域，保全DOM窄遮罩、生成伪元素、身份/来源/位置变化拒绝。24px/10px形态旧码实际RED，24项预览回归及源码tsx/构建Node各28断言通过；实机显示另列，不能用合成代替。

## 2026-11-09：增量旧缺口、取消与发送准备清理

复用MIT DSH固定SHA的`message-tracker.mjs:37–124`原生身份/最新端重叠和`chat-service.mjs:1003–1006`取消维护区别真实来源错误的结论。原生窗口完整覆盖仅在收取partial路径提供，未挂载正文的整段时间区间须在持久起点以前才排除；新未知/时间不明/边界重叠不跳过。POST_ORIGIN完成标记不冒称旧附件正文已读取。活动优先后强制正常轮，成功及失败都持久让出；平台/账号停止不被列表恢复错误覆盖。正常取消或有界处理超时不记成功或新增指数退避，不改水位/原错误/预算。

发送准备沿用同来源单一outbound账本原则及本项目唯一SendCoordinator：只有未持久意图时才可尝试清理本次仍持有token、准确编辑器和全文、无后续人工输入的程序预填；旧重载失token、人工改动和意图后不清理。上下文诊断只记录阶段、行增删/重排和字段变化计数，不落私人正文或消息标识。历史正文晚挂载的摘要使用已准确绑定原生全文，可见原目标/收据仍逐字核验；未知结果不借此重发。

## 2026-11-09：未提交策略草稿续办与评论回复投影

实施前沿用并复读MIT DSH固定`7989640e340f0fd79e2de9874880d5197546e755`的`outbound-send.mjs:73–96`及许可：仅一次持久提交、未知不重发。上游无本项目版本化草稿续办实现，独立复用原HumanReplyWorkflow和SendCoordinator：未有intent、AUTO_POLICY原版本/上下文，点击前CLIENT_CLOSING、TARGET_CHANGED_REAPPROVE、NATIVE_REPLY_EXISTING_DRAFT或恢复中断时可后台重新资格检查，保付费原稿、不再调用模型，总恢复审计最多两次。预算/到期修订可在其余可信规则与范围完全一致时绑定当前grant重新批准；原未知/人稿变更/撤销/关闭/上下文变化均拒。不从界面伪造确认或降低回读。评论正文展示沿用现有时间线已确认投影，不修改旧收据。实际缺口、合成红绿与真实恢复结果见验收表。

## 2026-11-09：历史反复扫描、旧展示重复与全入站回复

实现前复读MIT DSH固定`7989640e340f0fd79e2de9874880d5197546e755`的`message-tracker.mjs:98–124`及许可：采用已核最新端、可信原生重叠与新尾部的结论；不采用相对位置/文本指纹作永久身份。本项目独立在原持久cursor附加完成检查点，原补收完成后在已核最新物理端与准确原生ID重叠时结束常规读取，缺重叠仍补收，未完成不伪造成功。完整补收后又开历史sweep已实际红绿，重启/新增/高度变化及公平调度单列验证，不扩账号或重置起点。

Chatwoot固定非enterprise MIT Expat `625d5964e3cb3f1d917b43c3b8332219e525a4b8`的原生消息归属/排序原则继续使用。旧confirmed无native关联的额外发送注释按同会话、准确全文和有界时段仅作显示抑制，所有实际原生气泡仍逐ID保留，不能将显示关系写为receipt或chat_delivery_link；不同时间及同文多ID反例保留。上游不提供本项目旧账本恢复证明，未照搬其乐观确认。

用户明确只保留屏蔽词后，新保存策略清空兼容字段containsAny，旧grant读取及digest不改；新版本继承已消费MODEL/SEND预占，普通开关不新建版本。DeepSeek仍用既有协议与唯一生成入口，提示词明确当前原文/同目标上下文和自然简短回复，不将固定Mock词作为真实模型模板。未增加模型重试、依赖或另一发送路线，真实新范围仍经GUI一次保存。

## 2026-11-09：区分入站身份与既往外发结果、统一自动开关

修复前复读MIT DSH固定`7989640e340f0fd79e2de9874880d5197546e755`的`message-tracker.mjs:37–96`、`outbound-send.mjs:73–96`及LICENSE：原生消息身份与发送账本是不同对象，未知提交不重发，但不能把较晚独立消息当成同一次提交。独立适配既有SQLite和唯一SendCoordinator，不复制宿主、协议或新发送路径。本机用户明确纠正了此前会话永久冻结的产品代价；上游源码本身不证明本机可安全放行。

新私信须本人/准确会话/对方一致、有不同原生ID、可靠时间晚于旧持久意图并越过既有2秒时钟容差，且无身份碰撞；在途意图、原消息、媒体弱质量、时间歧义及原评论目标继续阻断。所有人工、策略、提交事务及界面共用同一判断。旧意图/收据/预算不改；后台只读补证为旧未知补登记持久任务，最多两次且重启不重置。实际红测分别复现TARGET_FROZEN、两通道仅评论完成、旧未知未登记和交回后仍普通暂停；相关合成发送/自动闭环及负例修复后通过。

用户进一步要求统一开关，沿用现有账号策略开关，移除逐会话长期交接。查看与实际编辑分开，活动编辑租约/已保存人工稿保护继续；统一启用只恢复无人工稿的闲置对象，急停与原消息未知不解除。无新依赖、schema或密钥存储方式变化，实机结论另列当前验收表。

## 2026-11-09：同一巡回的批量隔离修复

批量诊断证明多种未挂载内容会阻断整窗、无关会话行缺原生ID会中止准确定位，并出现作品类型68而is_slides=false的真实卡片。复用已核MIT DSH固定`7989640e340f0fd79e2de9874880d5197546e755`的有界逐行读取、准确会话身份及metadata-only原则，以及Apache-2.0 F2固定`f6be8c0ffba9a127075bbeafe4838716650b6325`的`dl.py:22–38,203–213`中68图集分类，独立修正既有读取器；不复制下载/宿主、不将IM类型77/110猜为某种附件。

只为后台收取提供显式partial窗口：每行先核原生会话、唯一对方、方向、消息ID及可靠时间；无法识别的内容保留未完成标记，其他已核消息可落库，原窗口仍退避且不推进成功/完成时间。普通读取和发送适配器默认仍完整核验；缺窗内容通过既有持久deferred阻止相关AI建议/策略任务，完整补收后恢复。准确目标自身缺元数据、冲突别名或多发送者继续拒绝，不以跳过掩盖身份异常。

图集68独立于可选slides标记生成note；同一会话展示资料实际改变时追加固定审计摘要，使展开旧页失效，重复未变收取不触发新显示版本。预览state/reason变化纳入读取依赖，无头模式移除虚假可见查看入口。列表/partial、图集、缓存版本及预览恢复均取得实际红绿，合成与相关旧回归分别通过；源码tsx/构建Node各30条实际页面断言通过，未增加新依赖或schema。

## 2026-11-09：原生分享外壳缺失与准确窗口诊断

17:31正常产品诊断已证明准确业务窗口中的原生kind8消息有完整消息ID/本人/对方/会话/时间及share字段，却没有正文/缩略图/卡片DOM，旧读取器因此拒绝整窗。实施前复读MIT DSH固定`7989640e340f0fd79e2de9874880d5197546e755`的`chat-browser.mjs:398–400,440–452,503–524`及许可：采用准确原生itemId/消息引用和metadata-only保留原则，不采用统一video路由或附件下载。kind8是本机实际组合证据，未冒称上游公布协议枚举；0/55及note继续沿用前节已核有限路由。

仅零正文节点/零可见媒体时，以准确正数字消息/作品ID、kind8、可靠时间和已核路由保留原IMAGE弱质量事件，辅助链接优先展示；缩略图有无、迁移和重启不改payload/binding、零collision。明确人工分支用同一SHARED_WORK稳定摘要，卡片显示不改变证明，仍走后端人工资格及唯一协调器；正文冲突/普通未挂载文字不兜底，AI/策略不消费元数据。新收取21与人工10项、旧相关26/12项分别通过，根新组合31项通过；两条序列化链各18条读取及12条人工真实合成提交回读断言通过，未新增真实外发。

诊断与业务共用窗口/缺文及唯一非本人sender推导，避免窗口外空行或未校准peer遮蔽真实字段；安全类型数值、布尔和路由枚举不含正文/ID值。未知peer及kind77仅测量均先红后绿，仍不据未知type放行。17:54正常无头批次4条分享全部linked，其中1条无外壳，形成真实读取差异证据；剩余kind77/其它会话未宣称恢复。

## 2026-11-09：普通无头与显式登录恢复

落实用户持续无头要求前，复读MIT DSH固定`7989640e340f0fd79e2de9874880d5197546e755`的`browser-host.mjs:113–156`及许可。保留单Profile持有者组织，不采用其固定有头及移除静音参数的默认。另核对Apache-2.0 Playwright固定`cfe490d941f992655948eee8fd4fd94e1c4234bf`的`packages/playwright-core/src/server/chromium/chromium.ts:380–387,419–423`：无头参数与显式msedge通道是独立配置，沿用本机Edge、locale及静音，不切另一个浏览器产品。

普通应用/CLI启动均无头，只有显式登录恢复或CLI login可有头；旧模式比较循环已停用。登录期只临时悬停原调度，不撤销持续范围或清额度；两Page本人及空输入核验后回无头。两个实证生命周期缺陷分别加最小代际和无头重开：旧完成不能解封新登录，扫码后关窗口仍可无头核验恢复；未完成登录不解封。三项实际红绿、新模式6项/UI1项、根最终23项与CLI7项通过；源码tsx/构建Node各22条实际DOM断言及CLI各8条入口断言通过。无原生重建或真实外发，旧有头证据不追认为无头全通过。

## 2026-11-09：补齐视频类型及可选标记、刷新有界阶段证据

真实只读字段证明漏识别卡片含`awemeType=55/is_slides=false`及`awemeType=0`而无图集标记。修复前读取Apache-2.0的Johnserf-Seed/f2固定`f6be8c0ffba9a127075bbeafe4838716650b6325`的`f2/apps/douyin/dl.py:22–38,203–219`和`tests/test_douyin_download_dispatch.py:37–45,59–76`，许可全文已复核。其抖音实现将0/55记录为视频，但未确认55的细分含义；分派按媒体资源，不要求is_slides必有。采用有限已知视频分支，未冒称平台官方枚举；不复制下载、签名、Cookie或宿主代码。[实现](https://github.com/Johnserf-Seed/f2/blob/f6be8c0ffba9a127075bbeafe4838716650b6325/f2/apps/douyin/dl.py#L22)、[对应测试](https://github.com/Johnserf-Seed/f2/blob/f6be8c0ffba9a127075bbeafe4838716650b6325/tests/test_douyin_download_dispatch.py#L59)

图集显式true保持note；false或缺失仅0/55生成video。无效标记只阻断原生字段推断，不推翻独立准确href，原生ID冲突及多候选仍拒绝。新组合与独立href均实际红绿，分享21项、源码tsx/构建Node各7场景21断言通过。重复附件状态由本项目三个组件的重复渲染复现，按既有MIT DSH已核内容分类原则仅去重中性提示，保真实文字/可用图像，不猜未知类别。

诊断修复前复读MIT DSH固定`7989640e340f0fd79e2de9874880d5197546e755`的`diagnostics.mjs:15–38`及许可，有界检查、固定失败代码原则独立适配。原每通道一次使旧META覆盖后续CONTENT证据，现按source/phase/code区分、每通道最多6次并覆盖固定文件；只存有界计数/布尔/字段形态，安全一层继承与getter拒绝保持。13项定向及两条序列化链通过，未改变实际采集映射或把无正文行猜成分享。

## 2026-11-09：媒体及分享消息的一次人工回复

实现前复读MIT DSH固定`7989640e340f0fd79e2de9874880d5197546e755`的`chat-browser.mjs:411–425,505–525`，核对媒体类别与原生消息绑定；适配器另核对`:400–467,1332–1345,1381–1390,1420–1450`的稳定资源、网页人稿及发送前上下文检查。Chatwoot非enterprise MIT Expat固定`625d5964e3cb3f1d917b43c3b8332219e525a4b8`的会话actions与attachment来源沿用上节核验。没有可直接复用的本项目媒体人工资格合同，因此独立扩展既有人工命令/修订/审批，不复制宿主、上传、鼠标回退或另一发送路线。[媒体源码](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/chat-browser.mjs#L411-L425)

只有当前明确人工请求及HUMAN_TYPED修订可申请新鲜准确消息证明；后端将账号、原生目标/作者/时间/类型、稳定媒体摘要、上下文、浏览器身份、全文及版本一起审批，意图事务重核选择、接管代际、有效期和预算。源向量临时总限1MiB，审批/审计仅存摘要；GIF不比较像素，非原始历史媒体不要求解码。通用isStrong、AI和策略质量门禁不放宽，旧绑定不改，仍走唯一SendCoordinator及原同步单次点击/严格刷新回读。

新增DOM12项、旧DM关键8项、应用服务13项及UI6项通过，批次有重叠不相加。源码tsx实际捕获局部箭头`__name`依赖，改为对象方法后与构建Node各11条真实合成单次发送闭环通过；未使用真实模型/外发或将合成媒体能力写成平台实测。

## 2026-11-09：分享作品链接与后台补齐诊断

用户明确大量媒体私信其实是分享视频后，复读MIT DSH固定`7989640e340f0fd79e2de9874880d5197546e755`的`chat-browser.mjs:427–459`：先识别分享卡片、核对正常DOM链接与原生`_parsedContent.itemId`，并在原生消息绑定后形成作品链接。采用分享优先和冲突拒绝；不照搬所有作品一律video、封面截图或打开卡片路线。当前本机正常收取的固定无正文诊断已证明分享DIV无anchor，但有唯一卡片、准确原生itemId及`aweType=800/awemeType=0/is_slides=false`。两个类型字段语义不同，不因数值不相等误判冲突；本机这组视频证据生成video链接，明确slides生成note链接，其他未核验组合不猜。

分享辅助资料单独按本人/会话/原生消息/发送者/方向/时间保存，旧IMAGE事件及绑定不重写；新旧链接与原生itemId冲突则不显示链接，固定字段不依赖诊断前32键的采样顺序。前端仅提供可选择链接和显式复制，不新增外部窗口、自动导航、下载或AI理解。实际已生成分享链接，未将单份成功写成所有历史卡片完成。

预览模块一开始仅读自有descriptor而原读取器允许一层安全继承数据，真实ID阶段诊断和原型红测确认了差异；现统一为原合同，getter与自有/继承冲突仍拒绝。选中缺少展示资料的媒体只给下一正常轮询一次窗口优先，120秒同目标冷却并插入正常轮次，保留原游标/水位及列表位置。诊断只保存固定枚举、计数与有界字段形态，固定文件覆盖，不把私人正文、原生ID、URL或异常文本写入日志。无新依赖、schema、模型或发送路线。

## 2026-11-09：原生会话聊天与本机图片预览

实施前复读非enterprise MIT Expat的Chatwoot固定提交`625d5964e3cb3f1d917b43c3b8332219e525a4b8`：`app/javascript/dashboard/store/modules/conversations/actions.js:235–279`按conversation/native ID增量去重及排序，`app/models/attachment.rb:38–40,62–68,115–124`按账号/消息绑定附件和有界缩略信息。另复读MIT DSH固定提交`7989640e340f0fd79e2de9874880d5197546e755`的`chat-browser.mjs:303–337,411–425,461–467`，采用准确原生会话身份、正文owned媒体、加载完成及最多4图的结论。不复制Vue/Rails/宿主、外链媒体请求、乐观发送或吞错处理，不新增依赖。

本项目在SQLite全量原生分组后分页，消息流独立于AI上下文；正常窗口观察的我方消息仅作展示，不建入站任务或发送收据。schema2是schema3的附加扩展，真实库一致私有副本已试升级/恢复，原业务表和预算保留。已确认回复与观察我方消息仅按准确native ID关联去重，同文不同ID不合并；后续只读补证保存准确ID摘要，原未知/收据不改。会话投影版本在反证或原生关联变化时撤销旧页面缓存，不保留过时“已回复”气泡。

图片预览使用现有Playwright 1.64.1的Page.screenshot clip/scale选项；不采用会自动滚动的元素截图，不fetch媒体URL、不改DOM/用canvas规避跨源。准确本人/会话/消息ID/发送者/时间、可见正文图像和源指纹在截图前后核验；源仅在页面内散列。私有PNG以消息绑定的opaque ID经READ接口读取，前端不访问Profile或任意文件。复用运行目录保留期（默认14天），最多500清单/80MiB，每消息4图、单图512×512/160KiB。窄遮挡漏收及正常背景/可点击包装误拒均先红后绿，源码tsx和构建Node分别实际执行13条预览断言；实际平台媒体仍须另列差异证据，合成图不冒称实机图片已显示。

## 2026-11-09：开发模式重载及私信返回控件修复

先读取本机固定副本`.local/upstream-review/dev-reload-20261109`的具体源码与许可：tsx 4.23.15固定提交`ca66105a17a2a4c6503fe3a12b5b9ec408286011`的`src/cli/run.ts`、`src/cli/watch/index.ts`及MIT许可；Tauri固定提交`993038c49185307dfc895ab7657d77ca0d5ed7c7`的`crates/tauri-cli/src/dev.rs`，文件声明MIT/Apache-2.0；Tauri文档固定提交`4bfa8a6162db1478aa10c3205f20ef0f25fa2e3b`的开发章节及MIT许可。采用Tauri已有devUrl、前端开发服务器和Rust变更重编译路线，不新增依赖。前端改动热更新或自动刷新，Node源码改动只重载后台，不为小修升版、重打安装包或要求退出当前客户端。

tsx的run继承stdin，watch又将stdin data作为手动重启触发；watch重启先发SIGTERM，默认5秒后SIGKILL，等待退出期间再次触发也会强杀。它不能直接承载本项目的JSON业务管道或在途意图收尾。本项目只使用现有tsx加载器，独立实现开发专用监督进程：新请求在重载期间立即拒绝，不排队；关闭旧stdin后等待旧Sidecar安全退出且退出码为0，才创建新代际。仅重连之前成功连接的规范运行目录，不重放Key、保存、模型或发送命令；旧代际输出不回送，已就绪异常退出不盲目循环。未ready的新子进程尚不能接受运行目录，语法错误修正后允许恢复，不继承上代持有者身份；此点由已连接场景实际红绿及异常退出负例补强。默认内存Key随后台退出丢失，持续授权、累计预算、持久意图及未知记录仍在原库保留。EOF与初始化竞争、重载中再次保存、草稿保留及不重放分别有定向回归；实际原生开发QA的进程/权威版本、CSS更新及正常退出证明另见验收表。

本机开发入口随后按用户纠正固定原已授权运行目录，提供根目录`启动inbora.cmd`，不要求开发WebView首次重复填写。先复读同MIT固定提交`7989640e340f0fd79e2de9874880d5197546e755`的`browser-host.mjs:109–124,152–156`及许可：采用启动入口明确绑定Profile的思路，不复制其CDP、目录创建或独立宿主。Tauri边界沿用上述已核源码；本项目仅debug的desktop_info读取绝对INBORA_DEV_RUNTIME，release返回null。前端先读当前权威连接，明确未连接时才按原生指定目录优先于WebView记忆自动连接，initialize固定false；RESTARTING仅有界重读状态，connect及业务不重试。新增真实原生冷启动及正负回归已独立验证目录、ready竞争和不初始化，未将旧重载QA或上游实现冒称本机这项通过。

另复读MIT DSH固定提交`7989640e340f0fd79e2de9874880d5197546e755`的`chat-browser.mjs:1023–1028`及许可：上游使用具体backBtn的Playwright click，本项目不直接复制选择器或调用网页处理器。0.3.5实机无正文诊断已证明：映射返回DIV自身无onClick，中心命中的子SVG有onClick，旧wrapper.click后聊天未隐藏。源码据此在原账号、来源、唯一聊天/返回控件及空编辑器门禁内，只向未遮挡的中心命中元素提交一次click；HTML用click，SVG派发一次冒泡MouseEvent，保留原隐藏等待，无第二次点击回退。新增合成回归和源码tsx/构建Node冒烟通过，尚未在真实账号加载该修复，不将它写成私信已恢复。

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

用户要求查看开源方案如何处理本轮时间矛盾。已联网核对六个候选的当前HEAD，下载并读固定源码与相关测试；详细文件、SHA、许可、采用/不采用原因、纯函数实测和后续验证方向见专项比较（本机开发文档：`docs/UPSTREAM-COMPARISON.md#2026-11-06发送时间矛盾与刷新误确认专项`）。LockyBee/dsh-douyin-agent仍为MIT `7989640e340f0fd79e2de9874880d5197546e755`；watch当前MIT `b3d5e36ed4ef9b8c1a7006ca2770309f820ffa46`；DouAi公开源码`f751fde0202a53c96cb14905e620ad5982d1be8f`未核准可复制许可，仅阅读，不复制或执行宿主代码。另重读crazyants、POKMJN、DMShoot原固定SHA的确认入口；未引入依赖、SDK、签名、原生hook或其他提交方式。

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

同提交`chat-browser.mjs:1023–1028`的返回动作选择更具体backBtn并使用Playwright click；本项目历史实机A/B切换亦走locator click，而新后台走映射wrapper的DOM click。加入诊断时的实机证据仅证明后者点击后聊天未隐藏，尚无子控件/事件归属证明，因此当时未猜改选择器或派发事件。独立补充唯一已映射返回控件的有界无正文诊断：最多12节点、固定标签/中心命中枚举/尺寸/事件函数存在布尔，仅own data descriptor，accessor及多props拒绝，不执行处理器或getter。源码及编译Node均执行该诊断冒烟；后续0.3.5取得归属证据及修复取舍见本文顶部本轮记录。[上游返回实现](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/chat-browser.mjs#L1023-L1028)

## 2026-11-09：持续入站下的会话轮转与原生ID续查

修复前再次读取同MIT固定SHA的`chat-browser.mjs:864–876`及`:386–393`。采用其准确列表容器下的正常滚动、有界让步及方向识别结论；该源码没有多会话消息历史续查，不将其有界联系人遍历冒称现成公平补收实现。本项目独立在既有私有cursor_json保存逐会话checkpoint、FIFO及两轮额度，无新schema或依赖。[有界列表滚动](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/chat-browser.mjs#L864-L876)

实际合成红测证明：一会话每轮增长时，原单active续查10轮不让出另一可读会话；改为两轮后先持久停放，再正常推进列表。持续增长并重新打开最新窗时，丢弃旧高度偏移又使原第三窗积压永远缺失；续查因此绑定已持久窗的原生ID与实际top。最多两个物理偏移只作定位候选，逐窗保存，先恢复候选位置再比原生ID，选择锚ID命中最多的窗口，从其实际位置小步继续；不按ID数值猜时间顺序，不以高度差单独作证明。每轮最多当前窗、两个候选及一个前进窗，维持整体取消时限、两轮额度和人工队列优先。

正/负原生滚动持续追加用例保持16轮，要求原24条全部收齐；不能仅收到末两窗就通过。sticky列表相同ID跨多个位置的完成循环、负方向首候选仅部分ID命中、以及错把MAX捕获标成MIN导致过早完成均已取得独立红测，再修复。高度变化清除旧端点稳定证明并保留实际物理phase；缺锚、错peer、滚动或新鲜捕获失败保留旧checkpoint，不推进成功水位。此批源码尚未进入已交付0.3.4包，不据合成证据宣称实机闭环通过。

## 2026-11-09：非文本私信保留与正文就绪

修复前读取同MIT固定提交`chat-browser.mjs:411–425`、`:505–525`和`:531–570`：上游区分可见文本/表情/媒体与metadata-only附件，并绑定原生ID和时间。采用保留明确内容类别而不伪造理解的结论；不复制未校准的媒体/卡片选择器、URL提取、下载、宿主或视觉处理能力。[可见内容类型](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/chat-browser.mjs#L411-L425)

独立浏览器+SQLite红测证明准确起点后的图片/表情、视频、音频及内嵌图片被原unsupported分支直接跳过，后台仍写成功时间；另一红测证明原生文本非空但正文未挂载也被当空成功。修复仅在已映射消息行内识别其拥有的可见IMG/VIDEO/AUDIO，保留原生ID/会话/作者/时间及固定说明，不读媒体URL、alt或假造完整正文。以DM_CONTENT_UNVERIFIED保留待人工消息，模型及发送门禁不把固定说明当实际全文。无媒体且正文未就绪继续有界等待，不能据容器存在宣布成功；旧历史仍按原起点排除，不因新增类型字段改写既有绑定或意图。

## 2026-11-10：人工发送反馈、评论串显示与通道颜色

实施前复读本机已审查 MIT 提交 `Yht20927/douyin-cli@4073159bea585de6d33a4747a475669440737932`：`lib/server/router.js:310–343` 的关联请求生命周期，以及 `lib/memory/comments.js:4–5,27–35,78–109,271–291` 的原生评论实体、父关系和已回复查询。它没有本应用 Tauri／React 的人工命令持久化握手与未知补证合同，不能直接替换发送结果或把多个子评论当一次发送。此次没有复制新的上游代码；复用本地已验证的 `comment-thread-context` 准确根串身份和现有发送协调器，新增只读列表投影与前端反馈修复。颜色样式复用本项目布局与组件，不引入界面库或新导航。

确认后草稿退役前再次核对同提交 `lib/memory/comments.js:114–128` 的 `markReplied`：上游标记回复并保留评论实体，没有本应用React编辑器及重连缓存实现。本次独立复用本地权威回复状态、准确事件与建议来源；仅清理已确认内容对应的前端编辑状态，不删除支撑意图／收据的草稿修订，也不复制新的上游代码。

人工编辑／清空显示问题沿用上述固定提交与本地空草稿合同核对结果。上游没有对应接管输入框可直接移植；本次只区分已提交只读正文与本地新输入，复用既有空修订保存与发送门禁，不引入新宿主、删除API或数据库结构。

连续人工回复实施前复读同 MIT 固定提交 `lib/commands/post.js:116–148`：其每次发出的原生评论独立保存，并把准确父评论关系传入回复。采用独立保存每次发出内容的组织原则，未复制其直接平台请求或重写原评论回复标记；本应用通过独立后续回复账本与既有网页发送协调器实现，准确目标、一次点击、未知不重发和预算事务仍由本地服务核验。前端输入框始终保留，发送后只清内容；不再沿用上次隐藏输入框的误实现。

设置页手动打开有头浏览器前核对同固定提交的 `lib/server/router.js:310–343` 请求路由：该上游没有本应用专属Profile模式切换和网页人稿保护，可直接复用的是本地既有登录恢复管道。此次增加手动停留标志与返回入口，不复制新上游代码、不另开Profile或浏览器持有者；真正登录恢复仍可自动返回无头。

## 2026-11-10：PoC 收尾的列表范围、取消和未知边界

修复前重新读取 MIT 上游 `LockyBee/dsh-douyin-agent@7989640e340f0fd79e2de9874880d5197546e755` 的固定源码及保留许可：`comment-browser.mjs:169` 的正常列表显露，`chat-browser.mjs:16,851–869` 的取消检查和准确列表滚动，`tree/chat-service.mjs:1003–1006` 的取消与失败区分。采用正常 DOM 范围及取消传递原则，独立实现列表尾部有效终点与采集信号接线；保留本人/准确作品/空编辑器核验、原分页终末证明、两窗轮转和旧检查点。未复制宿主、选择器、私有接口或宽松送达判断。源码 tsx 与构建 Node 两链均实际检查新增几何和人稿负例。

人工后续未知修复前重新读取同 MIT 固定提交的 `message-tracker.mjs:36–96`、`outbound-send.mjs:70–96`，沿用原生入站身份与外发账本分离原则。直接复用本项目既有 `EventStore.sendFrozen` 精确边界，不为后续账本增加永久会话冻结；原锚点、两秒歧义、身份不明、来源碰撞及在途提交继续冻结，显式暂停不动。没有复制新上游源码、增加依赖或迁移，现有许可与来源记录保留。隔离红绿和旧记录保留断言支持本机实现，不把上游声明或合成发送算作实机通过。

原生命令白名单补齐前复读本机锁定 Tauri 2.12.5 的 `.cargo_vcs_info.json`，固定 SHA `993038c49185307dfc895ab7657d77ca0d5ed7c7`、MIT 全文与 MIT/Apache-2.0 声明，以及 `crates/tauri/src/ipc/command.rs:79–119` 和 `ipc/mod.rs` 的 JSON 参数转交边界。仅精确增加已经存在的两个人工后续回复命令，保留窗口校验、90KB 限制、随机 nonce 管道和后端 strict schema/权限，不复制上游源码、增加通配或放宽鉴权。原白名单合同红测后 2/2 通过，`cargo check --locked --offline` 通过；随后开发原生重编译并恢复原目录，但未据启动记录宣称连续回复入口已实机验收。

楼中楼前置瞬态失败的有界恢复前，再读同 DSH MIT 固定提交的 `receipt-baseline.mjs` 准确操作/全文绑定与不覆盖检查、`outbound-send.mjs:70–96` 账本/未知保留，并对照 MIT `douyin-cli@4073159bea585de6d33a4747a475669440737932` 的请求生命周期；未采用其超时写入回退。复用本项目既有一次恢复标记，未付费 ROOT 先取得准确只读证明，已付费 CLOCK 复用原稿和原模型预占，均排除任何旧意图和发送预占。新增每轮最多一个旧目标的公平回归，旧次数不重置。没有新上游复制、依赖或发送路线；有效红绿与源码/构建两链记录在本轮私有证据中。

GET_NONE 的被动关系校准前复读 MIT `miqian-nomad/dsh-douyin-watch@177810c1f1858b529e78531f837ac9677fb9f9a9` 的 `tools/work-comments.mjs:1–30,113–139,144–203` 和保留的 MIT 许可。采用其“内嵌回复可能缺失，不能以缺失决定跳过”的观察，未复制直接请求。新增输出只记录原正常根 GET 的内嵌字段计数，以及已验证可见子行两个固定描述符的类型和同根关系布尔；总计最多 100 内嵌子记录、3 个 DOM 样本，不调用 getter、不输出标识或正文、不提供发送证明。四文件 30 项及独立三文件 28 项、类型/构建和源码/构建读取冒烟通过；真实字段仅由正常轮询取得，不续签已耗尽补证。

准确根列表内嵌回读修复前，复读同 watch MIT 固定 SHA 的 `tools/work-comments.mjs:124–153`：根 `reply_id` 与实际被回复子评论 `reply_to_reply_id` 含义分别核对。实机正常 GET 已证明当前纳入作品具有完整关系后，独立扩展现有被动 `CommentResponses`，只解析最多 100 个根中唯一准确根的最多 100 个子记录；子记录仍严格绑定作品、根、准确被回复子评论及原生身份。没有复制上游请求、增加主动取证或替代提交。原 DOM 全字段交叉、意图时间及两次一致回读保持；根与子列表共用失效序列，时钟单独采样。旧实现两个正例实际失败，最终相关五文件 147 项及源码 tsx／构建 Node 各六项冒烟通过；不将合成通过或已观察字段写成旧未知送达，不续签补证。

线程失败检查点修复前，复读上述 DSH MIT 固定 `7989640e340f0fd79e2de9874880d5197546e755` 的 `chat-browser.mjs:851–869` 和 `tree/chat-service.mjs:1003–1006`，核对正常列表滚动、取消与对象失败的边界。本项目独立把已捕获子窗口、轮转和对象退避先事务保存，再执行原清理滚动；第二次普通滚动失败沿用已持久对象退避，身份、平台、关闭及取消保持停止语义。未复制宿主、错误正文或发送维护实现，未改库结构或成功水位。三项旧实现红测及一项调度组合红测后，最终六文件 36 项、类型和构建通过，包含 SQLite 关闭重开及下一作品轮转。

## 2026-11-10：准确图片的绘制层被动诊断

实施前复读同 DSH MIT 固定 `7989640e340f0fd79e2de9874880d5197546e755` 的 `tree/chat-browser.mjs:1166–1183` 及许可，复用准确消息和截图前后核验的原则，不复制上游单点命中即通过的判断。本项目独立扩展原正常采集中的最多 8 条遮挡诊断：Node 端附既有事件绑定摘要和图片序号；浏览器只读两条有界祖先路径的共同前缀、首分歧绘制原因、层级比较、顺序、布局及三维标记，每侧最多 256 层。没有增加请求、页面动作或截图，不输出私人正文、原生 ID、图片来源或样式原文，诊断不作预览或送达证明。

新诊断旧实现实际 3 项失败；最终直接两文件 9 项、类型和构建通过，源码 tsx／构建 Node 各 19 条真实 Page 断言通过。源码链首轮暴露局部箭头辅助名无法随函数序列化，改为函数内对象方法后通过；首次失败只留工具记录和私有说明，未伪造单独原日志。现有预览门禁在本诊断切片中逐字保持，后续正常采集用于核对真实形态，不能据合成诊断成功宣称真实图片已恢复。

绘制顺序修复另核对 [CSS2 Appendix E](https://www.w3.org/TR/CSS22/zindex.html)、[Transforms 绘制规则](https://www.w3.org/TR/css-transforms-1/#transform-rendering)、[Flex](https://www.w3.org/TR/css-flexbox-1/#painting)／[Grid](https://www.w3.org/TR/css-grid-1/#z-order) 的重排例外及 [top layer](https://drafts.csswg.org/css-position-4/#top-layer)。正常实机采集已绑定两条既有媒体的前置、同父 isolation 零层级背景误拒形态；独立实现仅在首分歧上下文同父、层级相等、准确树序且到公共上下文均为普通块布局时证明前置背景在后绘图像下方。重排、三维、顶层及未能证明的路径继续拒绝，原较低层级分支及准确消息前后核验保持。没有复制新的上游代码或增加依赖；固定 DSH 来源及 MIT 许可沿用上述记录。

隔离旧实现 14 个像素对照中 2 项有效失败、12 项通过；修复后相关四文件 88 项通过，再补与实机一致的 isolation 前后对照至 16 项，源码 tsx 和构建 Node 均实际通过这 16 种形态。颜色像素只证明这些夹具的绘制结果，不冒称任意图片全部像素已验证；真实缓存和界面显示另列。

## 2026-11-10：多条分享及行内表情的准确校准

用户指出多条分享或含表情的消息仍显示不可预览后，再读 DSH MIT 固定 `7989640e340f0fd79e2de9874880d5197546e755` 的 `tree/chat-browser.mjs:398–459,494–508` 及许可。复用准确原生消息、作品 ID 与可见链接交叉核验原则，不采用一律 video、打开卡片或猜测未知类别的行为；该源码未提供已校准的 `related_share_video` 解析，本轮该字段仅测量形态。诊断附准确事件摘要，保留原每批最多 8 项；仅在原身份门禁后读取有界类型、固定路由拒绝原因、六个字段及固定关联对象两层／共 16 字段形态，未执行 getter、解析字段 JSON 或输出字段值。

进一步复读同固定源码的 `:259–271,406–425`，采用正文与独立媒体分离的原则：独立正文全文匹配与整体行内候选分开测量，媒体归属最多四项、六层固定标签路径，不以正文匹配证明外部图片可忽略。现代分享另核对 [TeamBreakerr/douyin-chat-export 固定 9e39afa980945737270ee88f8e33da470742cd9b 的 getShareInfo](https://github.com/TeamBreakerr/douyin-chat-export/blob/9e39afa980945737270ee88f8e33da470742cd9b/frontend/src/lib/douyinMessage.js#L224-L257)，源码实际同时读取 itemId、item_id、aweme_info.item_id；README 声明 MIT，但固定树无独立许可全文，本轮只研究字段组织，未复制代码。新增 schema、snake ID 和固定 aweme_info 字段的形态及一致性诊断，`AWEME_DETAIL` 不推断 video/note，kind110 和单一 ID 不用于生成路由。八项旧实现失败；新组合十二项、类型／构建及源码／构建两链各二十六条实际浏览器断言通过。

准确正常样本证明一条旧媒体消息的唯一正文可逐字匹配原生全文，因此复用本项目原私有预览 manifest，附可选 displayText，不迁移数据库、不改变旧事件绑定、质量、模型或发送资格。仅在准确本人／会话／原生消息／作者／时间／方向门禁后产生非空完整文字见证；缺挂载、空正文及缺证不撤销，准确非空反证才撤销文字，图片保持。文字限制 10,000 字符、保留有效原空白，manifest 限 64KiB，沿用保留期及 500 条／80MiB 清理；前端经原鉴权查询读取转义文本，原展示摘要纳入文字以刷新已展开历史页。存储及 UI 四项旧失败转绿，联合直接七文件四十四项、最后投影／空正文两项、父组件三文件二十项及类型／Node／Web 构建通过；正文见证源码 tsx／构建 Node 各七条实际断言通过。首次联合类型检查的夹具 Element.hidden 错误保留，修正夹具类型后通过，未改产品断言。

展示表情前核对 [hellodigua/UniEmoji 固定 57568e94124772d5a4802f3e42d9c93c1fc5690d](https://github.com/hellodigua/UniEmoji/tree/57568e94124772d5a4802f3e42d9c93c1fc5690d) 的 emoji.json、docs/archive/EMOJI_KEYS.md、LICENSE 和 THIRD_PARTY_NOTICES。代码／文档为 MIT，平台图片不在授权内；只独立适配 `[赞]→👍`、`[微笑]→🙂` 两种 Unicode 展示等价，保留原标签作可访问说明，未知原样。许可全文保留 `third_party/UniEmoji-MIT.txt`，未复制平台图片、增加媒体请求或依赖。组件只包只读正文，不改编辑器、原文、摘要或批准。原纯文字基线三失败／一通过，新四项通过，含 900×640、1240×800、顺序、重复和恶意文字转义；其通过不代替原生窗口视觉验收。

首轮 16:20 被动校准时，行内表情仅诊断唯一正文、全部媒体归属及与原生全文逐字相等的结果，最多 180 节点、8 图、10,000 字符；原生类型 7 只计数，不授予模型或发送资格。分享结果、旧绑定和采集门禁保持。新校准旧实现 4 项全失败，新增及既有分享共 27 项、类型／构建和源码／构建各 20 断言通过；首次私有冒烟夹具解析失败保留，修正夹具后两条真实运行链通过，不将其记成产品序列化问题。校准覆盖现有正常范围，两条已定位消息是锚点，不能替代用户所说的其它条目。

### 2026-11-10：原生文字内表情的收取与发送前合同

再读同 MIT DSH 固定 `7989640e340f0fd79e2de9874880d5197546e755` 的 `chat-browser.mjs:259–271,411–425` 及 `message-tracker.mjs:37–124`，采用准确正文／行内媒体和稳定原生身份、重复 ID 拒绝原则。上游文字清理、未知标签回退及发送宿主未复制；本项目在两条序列化函数内独立复用相同有界重建规则。已校准文字类型、唯一可见归属正文、全部可见媒体为正文内 1 至 8 张图片、安全短标签与来源、180 节点／10,000 字符和原生全文逐字相等须同时成立；否则仍为弱媒体。收取与发送前采用同一规则，防止先付费生成后在准确原文门禁失败。原 13 项旧实现四失败／九通过，新 13 项通过。

为保留旧已存弱事件及审批，在正常 collector 内独立实现 22 行载体兼容：仅同批唯一、同账号／原生 ID／作者／会话／方向／种类／时间及精度／全部评论目标字段相等、原绑定有效、原固定 IMAGE/MIXED 占位的旧弱事件继续持原载体作展示丰富化。新 ID 可按完整文字证明建正常任务，真实身份差异、非固定旧正文和重复 ID 保留原碰撞路径；EventStore.observe 未改。普通收取红测及重复原生 ID 对抗红测分别转绿，五个相关文件 36 项、类型／构建及源码 tsx／构建 Node 各 19 断言通过，包含普通 collector 两次收取、旧 UNKNOWN 意图／草稿／绑定不变、新 ID 强文字、零重放和零新增模型／发送。首次测试 SQL 占位及未用导入错误分别保留，修夹具后通过。旧弱事件图片仍可能因新全文绑定不同保持不可预览，准确展示文字不等于全部附件已恢复，不重置预览次数或旧未知。

### 2026-11-10：准确预览定位和显式旧消息选择

再读同 MIT DSH 固定 `7989640e340f0fd79e2de9874880d5197546e755` 的 `chat-browser.mjs:1110–1140,1150–1166` 及保留许可，采用稳定原生消息后才按准确 messageId 处理媒体的原则，不复制注入标记、宿主、未校准选择器或发送能力。旧预览已记录准确事件却只传会话，因而在不含目标的当前窗口消耗自动资格。有效红测后，现将准确事件贯穿优先读取，以当前窗、最多两个锚点／高度候选和一个前进窗为上限；每窗先核完整身份和唯一性再保存。高度只是候选，FOUND 只证明目标出现，不能代替 READY 或送达。结果以自动／显式选择及命中／未找到／取消／身份变化／中断分别记录，包含返回／保存窗口数；每轮让出正常采集、会话 120 秒冷却和空编辑器门禁保持。原两次自动资格不退款、不重置；显式选择是一次授权只读，不是未知发送补证续期。三文件 24 项、类型／构建和源码／构建真实虚拟滚动调用各七断言通过。

旧消息入口核对 MIT Expat Chatwoot 固定 `625d5964e3cb3f1d917b43c3b8332219e525a4b8` 的 `app/javascript/dashboard/store/modules/conversations/actions.js:235–279` 及检出 LICENSE，采用准确实体选择原则，没有复制 Vue/store/API。直接复用本项目 CommentThreadContext 普通查看操作和 App.choose 的保稿／保存／准确选择流程，只给非历史、入站、弱 IMAGE/MIXED、有效存量 UUID 且不是当前对象的气泡提供“查看这条消息”，标出当前回复对象。我方和历史不暗选，详情轮询不触发定位。新界面旧实现红测后，与两项既有同会话／切页保稿回归共三项通过，另十五项未选；类型／Web 构建和本地合成截图核对通过，独立审查 CLEAN。

同轮修复两个经有效反例证明的边界：展示撤销前将原生正文可用性与现有缓存 schema 对齐，空／空白／超限／禁止 C0 或 DEL 不产生 null，五失败转为六项通过，连同原见证／存储九项和两链各七断言通过；发送前普通文字 fallback 要求准确消息行无可见自有媒体，避免收取判媒体但预检或我方 proof 仍当完整纯文本。两项成对反例旧实现均失败，四文件 37 项、类型／构建和两链各九断言通过，严格行内表情及显式人工媒体路线保留。首轮出站 latest-index、unknown[] 类型夹具失败保留并修正，未删断言或改原生数据；独立复审 CLEAN。没有新依赖、迁移、平台请求、自动次数清理或安装包。

### 2026-11-10：独立展示更新和现代分享链接

继续复读上述固定 MIT DSH 的 `chat-browser.mjs:398–459,494–508` 和 `message-tracker.mjs:37–124`。预览更新复用鉴权命令的互斥参数和唯一 owner，只在准确本人／会话／原生消息／作者／方向／时间全元组成立后丰富原载体缓存；不建任务、不推进水位、不改回复选择或自动资格。当前、历史和我方消息均可独立“更新预览”，调度接收不等于取得图片。DISPLAY 三文件 24 项及源码／构建实际调用链各 11 条通过，合成历史我方 kind8 不冒称真实现代分享恢复。

旧我方弱媒体被重新识别为文字时，原 ChatMessageStore 会因绑定变化标冲突。兼容层只复用同批唯一 ID、固定媒体占位、完整身份／时间／目标元组相同且经原 ChatMessageStore.get 核验的非冲突本人记录；错误本人、坏绑定、已冲突或重复 ID 仍走原冲突合同，不改旧 payload／质量或 schema。有效红测后四文件 31 项通过，原正文只供展示，不变成入站任务。

现代路由另复读 Apache-2.0 F2 固定 `f6be8c0ffba9a127075bbeafe4838716650b6325` 的 `f2/apps/douyin/dl.py:22–38,203–219` 及许可，采用有限 0／55 视频、68 图集分支；TeamBreakerr 固定 `9e39afa980945737270ee88f8e33da470742cd9b` 的 `frontend/src/lib/douyinMessage.js:224–257` 只用于核对固定 ID 组织，因缺独立许可全文不复制代码。kind110 仅识别分享外壳，官方 WEB_VIDEO／WEB_NOTE 路径与固定原生 ID 共识才生成规范链接，AWEME_DETAIL 还须 nested aweme_type 的已知路由；多链接、ID／路由冲突、未知类型、getter 或非法图集标记拒绝，不解析标题、正文或嵌套跳转，不下载视频。未知分享显示“分享作品链接暂未取得”，不误称图片预览失败。十二项旧失败、追加多链接反例和修复后相关四十项、最终现代／schema 二十一项及两链各二十四条通过，旧 nativeUsable 保护保持；实机恢复仍按准确目标另列。

### 2026-11-10：人工提交确认、清空和后续队列

复读同固定 MIT DSH 的 `desktop/ui-api/src/use-auto-save.jsx:9–32`、`main.jsx:71–83`，独立适配编辑版本确认原则，未复制框架或依赖。只有准确命令的持久接收或意图，且事件、选择、编辑代际、全文和来源仍一致，才清除那次输入；后续人稿保留，失败只恢复同一未改空修订，accepted 不代表送达。后端独立人工命令持久排队并串行执行，稳定上下文只排除已登记准确我方前缀；新入站、楼中楼根／兄弟、其它输出及身份／平台反证继续阻断，旧未知和收据不改。后端最终 39 项和源码／构建业务链各 12 条通过。

UI 较早十一项通过保留为当时结果。后续独立审查取得晚接收确认后同状态轮询丢失 cleared 标记的有效红测，最小修复保留同命令的更新后修订；17:49 完整十二项为十通过／二失败，原日志保留。修复及夹具时序校准后，17:51:13 只补两项受影响检查通过，另十项未选，不写最终十二项或 HEAD 全量全绿。主目录 17:48 七文件 Node 集成 83 项通过；末次 UI 修订准确合入后，17:54 主目录类型及 Web 构建通过，独立复审关闭该竞态发现。三次较早真实人工确认不替代新清空／排队流程现场反馈。

用户随后明确无法抓取的预览不再反复处理；以上源码、失败与已证明能力保留，未恢复项显示明确不可用，不再以全部预览恢复作为 GO 必要门槛。显式查看实现后，本人已确认打开准确会话即可满足需求，不再要求具体消息行定位；实现和证据见下节。普通后台仍无头，只有本人显式查看为新增例外，不引入视频下载、视觉理解或安装包。

### 2026-11-10：本人显式有头查看准确会话

实现前复读 MIT DSH 固定 `7989640e340f0fd79e2de9874880d5197546e755` 的 `desktop/ui-api/src/main.jsx:315,345`，显式浏览器操作独立于消息发送且有自身等待状态；另复读非 enterprise、MIT Expat Chatwoot 固定 `625d5964e3cb3f1d917b43c3b8332219e525a4b8` 的 `app/javascript/dashboard/store/modules/conversations/actions.js:235–279` 和保留 LICENSE，采用准确会话／原生消息身份处理与迟到回调失效原则。未复制上游宿主、接口、选择器、乐观送达或消息写入实现，无新增依赖。

本项目通过已鉴权 `openTarget` 的显式 visible 参数，先按原存量绑定解析当前、历史及观察到的我方 DM；单 Profile 旧 owner 在已提交 actor 读回完成、所有网页人稿为空后释放，再以静音有头模式打开。CONTROL、急停、取消、准确身份、请求代际及 owner epoch 全程核验，非法目标不先暂停，人稿拒绝回滚本次暂态。查看只暂停新补证并等待已开始的补证正常完成，保留有界次数，旧默认登录取消语义不变；关闭有头窗口后按既有生命周期恢复无头。准确原生消息的可见身份可在正文／媒体未就绪时证明纯定位，最多当前窗、两个候选及一个前进窗；未找到返回 located:false，不能冒称准确命中。仅固定无正文结果审计，不写任务、水位、预算、资格、回复选择或人稿。

UI 独立按准确存量 eventId 查看 IMAGE／MIXED／VIDEO／AUDIO，不扩大图片刷新或模型准入；当前、历史和我方弱媒体均有入口，合成发送注释及不可信标识排除。组件防重复，打开与定位分开反馈，换目标或离页使迟到结果失效，不调用 choose、同步、预览补抓、模型或发送。隔离六文件最终 54/54、类型／构建和源码 tsx／构建 Node 各 17 条实际断言通过，较早 32/34、夹具错误及补证取消有效红测分别保留。UI 初始两文件 2/2；VIDEO／AUDIO 最小差异取得五个入口实际三个的红测后，仅受影响文件 1/1 通过。十三文件冻结摘要准确合入，18:18:52 同目录开发后端重载，原生窗口及九组账本保持；主目录类型、Node／Web 构建、302 个代码文件最大 795 行通过，未重复隔离套件或构建安装包，根与独立审查 CLEAN。

本人随后确认有头浏览器可打开准确会话且已满足需求，不要求具体消息行定位，因此会话打开记实机通过，精确行实现和隔离证据作为历史能力保留，不再作为 GO 门槛或继续追验。18:21:33.868 固定无正文审计与原存量载体匹配，记录准确会话、有头、一个窗口及原生消息命中，不输出私人标识。反馈打开稍慢，已登记后续优化计划第八节，无端到端实测毫秒，本轮不追加基准或性能修复。反馈当时有头仍开；本人后来确认关闭，系统核对原专属 Profile 已恢复静音无头，关闭恢复差异得到实机支持，不将正常恢复扩为停机新增入站已补收。

按最新范围仅将 UI 合法 opened 的反馈统一为“已在浏览器打开会话”，仍验证 located 是布尔、保失败与迟到结果处理；后端定位／模式合同不改，无新上游代码或依赖。最终三文件冻结摘要准确合入，18:25:10 单 UI 文件 1/1 与桌面类型通过，旧入口测试只同步断言未重跑；18:25 主目录类型／Web 再通过。没有 Node 改动、真实浏览器关闭重启、额外模型／发送或安装包，不将文案验证扩大为生命周期实机通过。

### 2026-11-10：人工 AI 建议继承准确持续授权

修复前复读 MIT DSH 固定 `7989640e340f0fd79e2de9874880d5197546e755` 的 `chat-service.mjs:457–479`、`contact-authorization.mjs:18–39` 及保留 LICENSE，另核非 enterprise、MIT Expat Chatwoot 固定 `625d5964e3cb3f1d917b43c3b8332219e525a4b8` 的 `app/javascript/dashboard/store/modules/conversations/actions.js:235–279` 和许可。采用稳定身份、持久准确范围与调度分离原则，不复制宿主、名称回退、模型传输、选择器或第二发送路线，无新依赖。

从原 policyMatches 提取同一 policyScopeMatches，保留全部自动调度守卫；显式人工建议可在自动回复关闭后使用准确 AUTO_REPLY 的 MODEL 额度，仍核账号、模型、通道、对象、规则、时段、楼中楼和有效版本。独立 MODEL 优先，范围不符不回退宽策略。仅一次唯一建议 ID 的 MODEL 事务预占，不查耗 SEND；末次已付费额度回包不额外要求一次剩余额度，迟到撤销、更替、到期、Key／模型／账号等反证阻止可用候选，不退款或重试。完整规则只取已批准 policy.instructions，有限上下文剔除旧弱媒体及准确 source 碰撞；当前媒体保持拒绝，已提交／后续人工对象不新增 AI 工作流。候选绑定原版本／上下文，晚到人稿不覆盖。Key 仅内存 accessor，界面根据准确事件资格给固定原因，有头本人操作不误解释为扫码。

最终十文件冻结摘要及 service 委托差异独立复审 CLEAN，当前查看合同保留，服务 795 行降为 730 行。原两项有效业务红测、组件／范围红测、夹具错误及性能失败统计修订分别保留；最终隔离两文件 40/40、原自动范围／预算／楼中楼 17 项、legacy 所选一项及旧 UI 迟到回调一项分别通过。18:43:48 安全载入开发版，18:43:59 主目录相关 40/40、类型、Node／Web 构建及 306 文件／最大 767 行通过。九组持久摘要保持，MODEL25／SEND41 null、旧意图／补证／人工确认不变，没有新增真实模型或外发、迁移或安装包；不把定向通过写成完整 HEAD 全绿，也不把 Node 重载当停机新增补收证据。

载入后 18:48:08.436–18:49:58.518 有限只读恢复观察 110.082 秒、12 样本，两通道各两调度轮即结束。私信一次 DOM 未就绪保原成功水位，约 60 秒后下一轮成功且一个既有会话水位／轮转推进；作品发现／评论游标及 headPending 推进，三个作品水位与 17 线程 seen22 未变。parked4／completed12／deferred21、25／41 null、模型／意图／人工账本及零在途保持，不将恢复进展当新评论、新会话、停机新增补收或全部旧失败已解决；没有新实现、真实模型／外发、重置或延长等待。

### 2026-11-10：Windows 双击开发入口的环境继承

修复前核对既有 Tauri 固定提交 `993038c49185307dfc895ab7657d77ca0d5ed7c7` 的 `tauri-dev.rs:150–180` 及 MIT／Apache-2.0 声明：Windows 的 beforeDevCommand 通过 `cmd /S /C` 并继承传入环境启动。文件 SHA256 为 `58fce9328970b12d085cfe06e0f579ddc574e22796ed5ab19eaa2b753bfd8a1f`。实际锁定的 npm CLI 2.12.4 另核 `tauri.js`、`main.js` 和随包双许可证，前两文件 SHA256 分别为 `d06dd9b4585c22d61af175b5a02fd7c8553ca1ac0bba2c76f25fa6e85054b8ac`、`49df414a16784e3711d5582d55c5c9e537aceb1108c5ecfc6a17cdc2f5259b4d`；不把 Rust 提交冒充 npm 包的源码 SHA。现有 pnpm 11.25.0 与其 MIT 许可一并核对，未下载、复制上游代码或新增依赖。

真实 Windows 用户／系统 PATH 找不到 pnpm，Codex 开发终端却有本进程注入路径；因此原入口在双击环境失败，而开发终端曾成功。只修根启动脚本：保留已有 pnpm 优先级，缺失时为本次启动及子进程加入本机已存在、已核版本的 shim 目录，供 Tauri 与其前端命令继承；不改全局 PATH，不改业务范围、Key、库或 Profile。失败保留说明与退出码，窗口不再静默消失。最终隔离夹具在旧脚本两项有效失败／一项正例通过，修复后同组 3/3、类型、307 文件行数及差异检查通过；本人再次双击后已确认原生启动。正常开发启动重编的原生外壳与旧外壳分别记哈希，没有构建安装包或把定向检查写成完整全绿。

### 2026-11-11：媒体人工回复边界与双向最新预览

修复前复读本地已核对 MIT DSH 固定提交 7989640e340f0fd79e2de9874880d5197546e755 的 message-tracker.mjs:36–96、outbound-send.mjs:70–96、chat-service.mjs:65–69、desktop/ui-api/src/use-auto-save.jsx:9–32 及 LICENSE；另复读非 enterprise、MIT Expat Chatwoot 固定提交 625d5964e3cb3f1d917b43c3b8332219e525a4b8 的 app/javascript/dashboard/store/modules/conversations/actions.js:235–279 及 LICENSE。采用原生消息身份与内容能力分离、持久账本不覆盖、双方消息按 created_at 合并排序、后台保存只反馈实际进展的原则。DSH 的 unansweredPreview 仅取入站待办，不能直接承担本项目双向会话预览；不复制上游宿主、乐观成功、请求或发送实现，无新依赖。

本机只读确认旧媒体发送已有独立补证，但 sendFrozen 对新旧两端使用 isStrong，误把内容不能供 AI 理解当成原生身份不可靠。复用既有 isManualMediaCandidate 只扩展独立消息时间边界；同原消息、在途提交、两秒重叠、身份缺失、来源冲突及暂停继续阻断，准确媒体人工证明和唯一发送协调器不变，自动模型仍拒绝弱媒体。旧意图、收据和补证不修改。

收件箱复用同一 timelinePage，合并准确原生我方消息与已确认原始／后续发送，预览、时间和排序取双方最后一条；点击和草稿仍绑定原入站。未确认提交、变更草稿及反证不成为已发预览，未读只由入站推进。MCP 的入站任务合同保持原入站正文／时间，防止 GUI 我方预览被当成待回复来信。分享消息显示“可人工回复”，当前分享详情不借较早文字的等待状态描述；保留实际较早文字待办。删除“正在准备回复输入”，保留真实保存／发送状态。

隔离原实现先出现17项有效失败、14项通过；自动文字恢复及 MCP 入站合同分别补一项有效红测。最终定向33/33、既有相关11文件112/112、另6文件92/92分别通过（集合有重叠，不累加）；会话UI按双方新预览调整定位后17/17，人工发送反馈18项通过。首次UI 13项失败为旧入站预览定位及既有评论按钮名称失配，保留日志；未删除业务断言。主目录类型、Node／Web构建及371代码文件行数通过，最大772行。开发版原生进程保留并安全重载，准确原事件 frozen:false、人工资格true；六表原有245条逐行摘要不变，MODEL37／SEND53保持，没有代理真实模型或发送。真实点击发送由本人继续操作，不能以合成确认冒称本轮实机送达。精简证据位于本机私有运行目录 evidence/inbox-reply-fix-20261111。

推送前的完整集成检查发现，双向预览逐会话调用 timelinePage 破坏了既有批量读取约束：100 个会话实际执行 1017 条 SQL。复用既有查询索引和投影快照，并对照上述 Chatwoot 按双方消息时间排序原则，独立改为一次批量候选查询；私有媒体仅为当前页读取，原生身份、绑定、全文摘要和确认状态不放宽。合并同快照中重复的账号／意图补证／后续回复查询。保留15条查询上限，新增原生我方消息与已确认发送混合的40会话两页断言，实际查询均为15；完整集成最初896通过／2失败中的另一处为既有媒体状态筛选旧断言，按MANUAL_ONLY验证并保留“不进入PENDING”正反断言。相关88项、额外投影62项与类型检查通过，不修改数据库或授权。

### 2026-11-13：无头业务页的媒体暂停与浏览器资源监测

复读已核对的 MIT `LockyBee/dsh-douyin-agent@7989640e340f0fd79e2de9874880d5197546e755` 的 `browser-launcher.mjs:37–63`（https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/browser-launcher.mjs#L37-L63），采用安装、捕获播放事件、原生暂停、Observer 和释放机制；完整许可保留在 `third_party/LockyBee-dsh-douyin-agent-MIT.txt`。本项目只给无头 Owner 的两个业务 Page 在首次导航前注册脚本，限制当前可信入口 origin 的主 Frame。增量检查 addedNodes 及其媒体后代，跳过已暂停元素，不保存节点列表，Document 幂等，pagehide 停止监听和观察并在 pageshow 恢复。未复制上游宿主、接管或观看逻辑，不更改媒体源、预加载、位置、DOM、输入或媒体原型，不拦截网络。

监测沿用本项目 OS 指标入口，独立实现 Sidecar 后代与父子创建时间归属、唯一 Edge 根、实际 Context 页数、单飞取消及隐藏子进程收尾。指标不进入账号队列、不调用页面或平台，诊断只读有界缓存；版本1可选资源块及严格 MCP 投影均不含 PID、命令行、URL 或消息正文。一个固定报告与一个临时文件原子替换，保留最近24小时和最多1440个样本。来源适配不改变单账号专属 Profile、单持有者、双 Page、30秒当前配置、单次提交和未知不重发合同，无新增依赖、数据库表或迁移。

播放、释放、动态媒体、导航、Frame/origin 排除、人稿和预览 DOM、空媒体与节点回收以本地合成 Edge 验证；媒体函数分别经默认 tsx 源码链和编译后 Node 链实际运行。暂停能停止播放，不证明浏览器已释放缓冲、MSE 或网页堆；实际内存收益、自然波动及长期趋势另以分实例的私有数值报告核对，合成验证不冒称真实账号送达或24小时稳定。
