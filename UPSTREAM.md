# 来源与许可

## 2026-11-06：独立子回复回读及短信验证识别前核对

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
