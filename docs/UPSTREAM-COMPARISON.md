# 相关开源实现核对

## 2026-11-06：发送时间矛盾与刷新误确认专项

本次只读研究，不修改适配器、审批、未知状态或真实数据库，不打开账号页面，不发送消息。查询GitHub当前HEAD并固定SHA：LockyBee、crazyants、POKMJN、DMShoot均与前次相同；watch更新为`b3d5e36ed4ef9b8c1a7006ca2770309f820ffa46`，另补查公开源码DouAi的`f751fde0202a53c96cb14905e620ad5982d1be8f`。源码保存在忽略的`.local/upstream-review`，本轮下载索引含来源URL与文件SHA256。

**结论：所核对的相关实现没有直接提供“平台时间严格晚于本机意图，且刷新后仍可靠”的现成解法。** 较完整的方案采用发送前基线、新ID、准确目标和回读，原生方案采用具体请求的业务回调；部分简单方案仅看气泡或输入框清空。依据这些判据推断，多数实现不会在平台/本机时间比较处拒绝，因为没有设置同样的门槛；这不能证明消除了旧消息误认或临时渲染状态的风险。

| 固定来源 | 实际成功判据 | 对当前问题的结论 |
| --- | --- | --- |
| LockyBee/dsh-douyin-agent `7989640`（MIT） | `chat-browser.mjs:1614–1630`要求准确会话、新尾部、未见ID、我方全文及非失败/非pending；第4轮尚未完成且空草稿时重新挂载一次会话，但此前轮次可直接成功。`chat-message.mjs:24`指纹有意排除时间；`comment-browser.mjs:488–497`及`receipt-baseline.mjs:87–104`用两次同新ID/我方/作品/全文/发出状态，不比较平台时间与本机意图。评论执行器拒绝回复他人的状态。 | 可借鉴不重发、固定基线、准确目标及只读恢复。上游没有通过强制刷新排除临时createdAt，也没有解决跨时钟比较；不能照搬为本项目可信楼中楼收据。[私信回读](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/chat-browser.mjs#L1614-L1630)、[评论基线](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/receipt-baseline.mjs#L87-L104) |
| miqian-nomad/dsh-douyin-watch `b3d5e3`（MIT） | `comment-api.mjs:218–266`解析内部发布响应的cid，再按cid在目标线程有限翻页；未看到只记落点未知。`304–344`记录HTTP200无cid后重发重复的历史，增加同文/近15分钟找回cid；具体实现归一化并截取60字，缺时间也未直接排除。`im-send.mjs:457–480`以我方同文或20字前缀的气泡计数增加且编辑器清空为成功，有Enter/按钮兜底。 | 精确发布返回ID与随后同ID线程核对值得参考；文本时间窗、气泡计数及多种提交兜底不足以满足本项目。内部发布、签名直连不接入当前网页交互路径。[评论源码](https://github.com/miqian-nomad/dsh-douyin-watch/blob/b3d5e36ed4ef9b8c1a7006ca2770309f820ffa46/tools/comment-api.mjs#L218-L266)、[私信源码](https://github.com/miqian-nomad/dsh-douyin-watch/blob/b3d5e36ed4ef9b8c1a7006ca2770309f820ffa46/tools/im-send.mjs#L457-L480) |
| yudigaga/DouAi `f751fde`（公开源码，GitHub未识别许可且树中未见根LICENSE，不复制） | `NativeCommentPublisher.java:268–316`关联具体原生请求对象和回调，接受提交不等于业务成功；30秒未回执保留submitted/unknown。`607–619`要求业务状态0、非空cid、准确作品/root/direct回复关系。相应测试覆盖错作品/父评论/直接目标。[源码](https://github.com/yudigaga/DouAi/blob/f751fde0202a53c96cb14905e620ad5982d1be8f/app/src/main/java/com/douai/module/feature/NativeCommentPublisher.java#L607-L619) | 通过“本次请求→业务回执→精确返回ID”建立归因，不依赖平台时间大于本机时间。它是Android宿主hook，不能移植到Windows网页；只参考证据分层和回调关联思路，不把原生成功声明当浏览器实测。 |
| crazyants/douyin-robot `b8eef83`（未核准可复用许可） | `douyin_chat.py:720–769`在最新3条气泡内，以左右坐标判我方，归一化并匹配前60字，超时不自动重试。[源码](https://github.com/crazyants/douyin-robot/blob/b8eef83c3db7dcb4534f6ce6de93e3b092416403/src/douyin_chat.py#L720-L769) | 无稳定消息ID及发送前时间因果证明，未解决同文旧消息误认，不采用其收据判据。 |
| POKMJN/douyin-reply-assistant `3e215be`（未核准可复用许可） | `automation.cjs:2406–2458`以输入框清空为发送完成，未清空时重复Enter/鼠标兜底。[源码](https://github.com/POKMJN/douyin-reply-assistant/blob/3e215be1a5cd4950225a19f2bc490c5be0f0086a/app-source/electron/automation.cjs#L2406-L2458) | 本轮已证明清空或短暂本地气泡不足以确认服务端回执，不采用。 |
| Agying3/DMShoot `4c792ea`（MIT） | `douyin_sdk.py:217–243`创建会话后使用第三方SDK的send_msg布尔结果；该包装器不暴露本次返回消息ID或刷新全绑定证明。[源码](https://github.com/Agying3/DMShoot/blob/4c792ea89c36b80a90db32615b67490126ed440f/dmshoot/utils/douyin_sdk.py#L217-L243) | 第三方协议路线不同，包装器也未证明本轮问题的解法，不接入。 |

### 本机最小验证与适用边界

直接导入固定版本的上游`createCommentReceiptBaseline/matchCommentReceiptBaseline`，全部使用合成输入：准确新ID可确认；同一个基线未见ID即使附加昨天的sentAt也确认；错误全文、pending及基线已有ID均拒绝。5项断言实际通过，零浏览器/外发。此结果只证明该匹配器不校验新旧时间，不能单独判定整个上游应用会在所有历史场景误发或误确认；其调用者另有读取/身份约束。它足以否定“直接移植此函数便解决隐藏旧同文及两个时钟问题”。

### inbora的取舍

1. 继续保留单次提交、原意图和未知冻结；刷新后的服务端状态比发送当刻的渲染状态更有参考价值。当前私信刷新门禁已实现，不把这一源码研究当成新的真实发送验收。
2. 平台绝对时间和本机墙钟来自不同来源，直接比较会有误拒绝。若维持现有规则，应证明所用通道的时钟边界并保守等待，私信不能直接假定作品评论服务的时差也适用于IM服务。缺证据继续未知，不能随意加几秒容差或改写旧意图。
3. 更值得验证的下一条路线是**被动观察正常单次网页提交所产生的准确业务响应**，将持久意图、具体请求/回执、服务器返回消息ID和刷新后的同ID全字段证明串起来；不生成额外写请求、不调用SDK或签名服务。当前评论曾遇空响应，私信具体回执关联字段也未校准，不能宣称已有可用实现。上游出现clientId只说明值得核对，不能声称本机已有该字段或已可关联服务端ID。
4. 若以后以充分的请求级因果证明替代“平台时间严格大于本机意图”，会改变当前AGENTS/SPEC验收规则，需先形成具体证据与修订方案；本次研究没有实施该变化，也不重判旧收据。

本节更新下列2026-11-05比较的时效和适用范围；下文保留历史记录。

核对时间：2026-11-05。范围为 POC-SPEC 第 12 节的五个仓库、六项参考方向。本次通过 GitHub 读取固定提交的相关源码、测试和说明；没有安装或运行上游应用，没有采用上游自动发送授权，也没有把源码声明当成本项目的实机验收。下列路线只在现有单账号、网页交互及逐条审批范围内评估。

## 当前最有用的结论

DSH 的私信读取路线直接对应本轮问题：消息 ID、会话 ID 和绝对创建时间不一定是 HTML 属性，而可能绑定在当前已渲染消息的 React props 中。源码只沿固定组件路径读取数据属性，不执行 getter，并要求消息的会话 ID 与当前会话一致。它同时区分 DOM 窗口位置和永久消息身份。[消息读取实现](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/chat-browser.mjs#L337-L402)

本项目已据此独立编写有界只读探针，只检查当前已授权会话和三条约定文字气泡：三条均实际暴露服务端消息 ID、绝对创建时间及会话 ID；正文与气泡一致，会话 ID 与当前头部一致。原始字段只留本机私有目录。此前“DOM 属性未找到”仍是当时观察，但不再据此推定网页整体缺失这些字段；这次探针不代表 CLI 适配器、审批和发送回读已经接通。

## 对照结果

| 方案与固定提交 | 源码怎样处理 | 对 inbora 的意义与限制 |
| --- | --- | --- |
| JMY2003/a-skill-to-do-anything-in-douyin，`d5211b3d687ddab0d5efc32b915a636aba764423` | 通知动作回首页、点击顶部入口，等待后生成页面快照；评论输入使用可见输入框候选。 | 可参考入口和观察步骤；所核对路径没有证明“新通知→唯一原评论→楼中楼→准确父评论回读”。无法据此解决当前通知未出现，也不能直接采用宽泛输入框选择作为发送门禁。[通知动作](https://github.com/JMY2003/a-skill-to-do-anything-in-douyin/blob/d5211b3d687ddab0d5efc32b915a636aba764423/scripts/douyin_web.mjs#L1130-L1139) |
| LockyBee/dsh-douyin-agent，`7989640e340f0fd79e2de9874880d5197546e755` | 当前会话头部与气泡渲染模型交叉绑定；提取原生服务端 ID 和创建时间；识别独立表情、图片与引用；利用 CSS 翻转判断消息顺序。无原生 ID 时使用唯一窗口重叠和本地出现序号，无法区分时保留歧义。 | 最适合本轮私信校准。它明确不把 data-index 当永久 ID；本地分配 ID 也不能改称平台 ID。可借鉴固定路径与绑定校验，需在本机逐项验证。[消息字段和顺序](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/chat-browser.mjs#L530-L583)、[窗口身份跟踪](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/message-tracker.mjs#L37-L159) |
| crazyants/douyin-robot，`b8eef83c3db7dcb4534f6ce6de93e3b092416403` | 以气泡屏幕纵坐标排序、左右位置判断收发；图片单独分类；文本指纹防重复。发送确认检查最近气泡中的我方文本，超时不重试。 | 可参考图片/非文字分类和无结果不重试；坐标和文本相似匹配不足以证明准确目标与新发送，本项目不能降低回执要求。其文本处理以最近正文指纹为主，也不能满足本项目同文多次独立事件的全部要求。[读取](https://github.com/crazyants/douyin-robot/blob/b8eef83c3db7dcb4534f6ce6de93e3b092416403/src/douyin_chat.py#L552-L643)、[处理指纹](https://github.com/crazyants/douyin-robot/blob/b8eef83c3db7dcb4534f6ce6de93e3b092416403/src/reply_engine.py#L137-L152) |
| POKMJN/douyin-reply-assistant，`3e215be1a5cd4950225a19f2bc490c5be0f0086a` | 文本键含收到日期，同一天相同预览会合并；媒体键优先稳定标识或资源路径，否则加本地序号；发送方不确定则不回复。 | 可参考轮次门禁、消息队列和媒体分类。按日预览去重会合并本项目需要保留的同文独立消息；相对时间推定不能作为点击后新收据的绝对时间证明。[每日文本键](https://github.com/POKMJN/douyin-reply-assistant/blob/3e215be1a5cd4950225a19f2bc490c5be0f0086a/app-source/electron/conversation-engine.cjs#L35-L59)、[媒体指纹](https://github.com/POKMJN/douyin-reply-assistant/blob/3e215be1a5cd4950225a19f2bc490c5be0f0086a/app-source/electron/automation.cjs#L524-L547) |
| Agying3/DMShoot，`4c792ea89c36b80a90db32615b67490126ed440f` | 服务端消息 ID 优先，其次会话 ID 与消息序号，数据库唯一键去重；消息归属使用对方 UID 映射。抖音收发来自 SDK、WebSocket 和非官方协议组件。 | 可参考消息模型、会话归属及持久去重思路；其抖音收发路线超出本项目网页交互边界，不接入 Cookie、ticket 或签名协议。源码存在时间缺失时使用本机当前时间的回退，本项目不把这种值作为平台发送时间。[消息归属与去重](https://github.com/Agying3/DMShoot/blob/4c792ea89c36b80a90db32615b67490126ed440f/dmshoot/plugins/douyin/adapter.py#L278-L309)、[SDK 边界](https://github.com/Agying3/DMShoot/blob/4c792ea89c36b80a90db32615b67490126ed440f/dmshoot/plugins/douyin/douyin_client.py#L1-L24) |

## 发送收据与评论边界

DSH 对发送使用共同本机锁及持久账本；结果不明或收据保存失败时禁止自动重发。其评论收据保存点击前已知 ID、我方身份和文本摘要，发送后要求两次相同新评论证据；该评论执行器明确拒绝当前输入处于回复他人的状态，目标是作品下的公开评论，不能当作本项目楼中楼回复的现成实现。[共同发送协调](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/outbound-send.mjs#L73-L96)、[评论执行边界](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/comment-browser.mjs#L416-L456)、[收据基线](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/receipt-baseline.mjs#L75-L96)

inbora 保留更严格的要求：回执必须属于准确会话或父评论、我方身份、批准全文和已确认状态，并有严格晚于持久点击意图的可靠绝对发送时间。不能只凭点击前未见的 ID 或出现同文就确认成功。源码参考没有消除本轮“测试者可见评论，当前网页通知未匹配”的待核验项，也没有替代本项目的 Headless 实机结论；DSH 当前浏览器启动路径固定为有头 Edge。[上游启动配置](https://github.com/LockyBee/dsh-douyin-agent/blob/7989640e340f0fd79e2de9874880d5197546e755/browser-host.mjs#L120-L130)

## 补查：有类似评论补偿方案，但路线不同

用户追问通知未出现的具体解法后，补查上述JMY与LockyBee两个固定提交的完整公开源码、通知相关文档及GitHub issue检索。JMY的已记录工作流仍是首页顶部通知→评论筛选→提取当前可见状态，没有查到通知未出现后的补偿实现。LockyBee的通知唤醒是私信未读数变化，不是本轮作品新评论通知的补偿；其公开评论实现边界如上，不能把“能发评论”泛化成“已解决通知回复”。[JMY操作说明](https://github.com/JMY2003/a-skill-to-do-anything-in-douyin/blob/d5211b3d687ddab0d5efc32b915a636aba764423/references/operation-plans.md#L80-L109)

检索另发现不同作者的`miqian-nomad/dsh-douyin-watch`，固定提交`177810c1f1858b529e78531f837ac9677fb9f9a9`。它不在原方案候选表中，不能与`LockyBee/dsh-douyin-agent`混为同一项目。它确实实现类似处理：自己的作品评论由评论列表补充发现，通知只补回评和@；回复前读取子评论判断作者是否已答。这是绕开通知不可靠的发现路线，不是修复顶部面板的显示。[评论发现设计](https://github.com/miqian-nomad/dsh-douyin-watch/blob/177810c1f1858b529e78531f837ac9677fb9f9a9/README.md#L259-L275)、[实际评论读取](https://github.com/miqian-nomad/dsh-douyin-watch/blob/177810c1f1858b529e78531f837ac9677fb9f9a9/tools/work-comments.mjs#L100-L115)

该项目的通知读取直接请求网页内部通知接口，替换UA中的Headless标识，使用Cookie发请求；回评走内部发布接口，楼中楼还有签名直连及页面路径。它超出inbora当前的顶部通知唯一发现源、网页点击和不伪装浏览器身份要求，因此本轮只读其源码，不运行、不接入或宣称在当前账号验证成功。[通知读取实现](https://github.com/miqian-nomad/dsh-douyin-watch/blob/177810c1f1858b529e78531f837ac9677fb9f9a9/tools/notice-read.mjs#L129-L145)、[回评提交实现](https://github.com/miqian-nomad/dsh-douyin-watch/blob/177810c1f1858b529e78531f837ac9677fb9f9a9/tools/comment-api.mjs#L201-L225)

补查时尚未获得来源变更授权；随后2026-11-05用户明确答复可以放宽约束，现已同步AGENTS/Goal/SPEC，采用两个已授权作品的有界网页读取作补充来源。没有直接运行watch的接口/UA方案；原生有头Edge已通过正式源码CLI首个作品和许可私信各5轮只读及SQLite核验，准确发送与回读仍待验证。该修订不把原顶部通知用例改写为通过，也不将上游声明当作GO。

## 本项目后续校准

1. 有界渲染元数据已接入正式ObservedReader和只读CLI，固定账号、会话和气泡路径，拒绝 getter、冲突字段与模型会话错绑。实际网页映射和账号字段仍只存私有运行目录；下一步校准基线后增量与完整发送映射。
2. 已按原生消息 ID 保存三条受控文字，表情仅保留出现证据和未支持计数。无可靠身份或时间时保留 null 和人工核对；相同弱指纹多次出现保留计数，不能凭本地序号将其提升为已证实的独立平台事件。
3. 从顶部通知继续核对准确评论事件；没有原评论定位证据不启用评论发送。任何真实发送仍逐条审批，先存意图，单次提交，回读不足则冻结。

以上是源码核对和本机只读校准的结论，P1—P4 完整验收及 GO 仍未完成；没有真实模型请求或真实发送。许可与借鉴记录见根目录 UPSTREAM.md。
