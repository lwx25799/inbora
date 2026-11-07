# Inbora
## 抖音个人号 AI 智能客服工作台 | 正式版架构与实施方案 V2.1

**编制日期：2026 年 11 月 6 日**  
**目标终端：Windows 10 / Windows 11 桌面端（x64）**  
**目标规模：10 至 30 个普通抖音个人号**  
**主要技术：Tauri v2、React、TypeScript、Node.js、Playwright、SQLite**  
**评估状态：有条件可行，正式版开发以单账号双通道 PoC 验收通过为前提**

> **本项目用户修订（2026-11-06）**：正式版与最小客户端均支持Windows 10和Windows 11，不绑定Windows 11。当前开发/PoC实机环境为Windows 10专业版x64 Build19045；两系统的安装、启动及核心链路结果分别记录，不能将支持目标表述为均已实测。按同日最新要求，最小客户端可在现有PoC测试进度上并行开发；其发送能力和真实试用仍按通道分别验收。

> **文档定位**：正式产品的需求基线、架构决策记录、开发任务拆分、风险控制和上线验收依据。这里的功能描述是待实现设计，不代表已完成真实平台实机验证。尤其是网页版通知指定评论回复、无头模式兼容性、浏览器消息发现时效及账号操作许可，应在各阶段通过真实测试确认。

> **本项目用户修订（2026-11-07）**：正式版人工接管采用对话框，正常流程只需输入后点击“发送”，接管续期、草稿保存、发送准备及核实由后台自动完成。日常确认和核实还包括启动连接、身份与目标核验、通道资格检查、发送回读、只读补证和证据归档。正常使用不要求退出重进、运行开发命令、逐步点击核验或提交截图。有限自动模式在预先授权策略内无需逐条批准。具体合同见第 3.4、3.6、17.6 节；本条是待实现要求，不代表当前最小客户端已全部具备。

---

# 01. 执行摘要与最终决策

**建议实施 Inbora V2.1。** 采用本地优先的桌面工作台和独立 Node.js 执行内核，依赖 Playwright 在已登录的抖音网页版执行本人账号的评论回复与被动私信回复。每个账号有独立持久化浏览器 Profile、账号 Actor、双通道页面、网络出口配置、任务进度、知识库覆盖策略与发送审计。React 呈现统一会话和运营面板。系统先用一个账号完成真实收发与异常恢复验证，然后按 3、10、20、30 账号逐级扩容。

**在 V2.0 基础上的完整修订要点：**

1. 增加账号级 `NetworkProfile` 与网络绑定，直连优先，可配置固定代理或独立执行节点；固定代理 IP 并非每个账号的必需采购项。
2. 区分已管理账号、已登录账号、正在运行浏览器、最新成功同步和可实时发现消息的账号，杜绝“30 个账号 = 30 个实时在线浏览器”的统计误导。
3. 明确双入口：评论来自网页顶部「通知」弹层；私信来自独立的「消息」入口。评论回复可以在原评论处完成，但采集不需要遍历所有视频。
4. 补齐执行节点拓扑、Profile 唯一所有权、跨节点任务投递、异常冻结、数据库恢复、操作审计与 IP 故障处理。
5. 将 Headless 作为优先尝试模式，Headed 作为兼容和人工处理模式；两者的真实行为单独验收。
6. 将“任务发出”和“平台确认收到”分离，所有发送在点击前持久化意图，发送结果未知时禁止自动重试。
7. **正式支持工作台内人工输入并发送**：运营人员在 Inbora 处理「待人工」的私信和评论，无需日常切换至抖音网页；所有人工外发也经 Node 发送协调器和 Playwright 统一执行。
8. 引入**会话/评论目标级人工接管、版本化审批和事务型发送门禁**。AI 草稿、人工发送及有限自动发送使用同一个外发协议，确保人工和 AI 不会双发。
9. 明确“待人工”分类：可直接人工发送、需补充核对、账号异常、发送结果未知四种原因，只有已完成目标核验且具备发送能力的任务允许点击「发送」。

## 1.1 产品成功标准

- 一个 Windows 工作台可以统一管理 10 至 30 个本人合法控制的普通个人号。
- 登录后的网页通知与私信可进入同一收件箱，按账号、通道、待办状态筛选。
- AI 生成与账号人设相符的回复草稿，支持人工修改、批准、拒绝和随时接管。
- **人工客服能在 Inbora 内直接编辑并发送**评论或私信；系统在显示“已发送”前必须取得网页可观察的回执。人工回复无需模型 Token。
- 对已确认目标完成最多一次受控发送，随后回读结果。身份不明、内容冲突或发送结果未知时自动停发。
- 账号异常、需要验证、网络故障、网页结构变化和模型失败均可被识别，并在工作台显示真实状态。
- 正式版默认人工审批。开启有限自动回复需要单独满足账号权限、真实平台行为和风险门禁。
- 正常链路的技术核验自动完成，用户只处理业务回复、授权和确需本人参与的异常；有限自动模式在预先授权范围内完成回复与核验，不逐条请求技术确认。

## 1.2 项目边界

**包含**：个人号自有作品的被动评论处理、已有或对方主动发起的私信回复、统一收件箱、知识库、规则、统计、日志、多账号调度与网络配置。

**明确排除**：抖店与飞鸽业务、订单退款与交易承诺、陌生人批量主动私信、其他作者视频的批量营销评论、验证码破解、模拟指纹欺骗、风控限制绕过、私有协议逆向、代理轮换躲避封禁、云端集中存储完整账号 Cookie。若平台规则禁止相应自动化发送，降级为 AI 草稿及人工客服工作台。

---

# 02. 技术选型与整体拓扑

## 2.1 首选架构

```text
                Inbora / Windows
   +------------------------------------------------+
   | Tauri v2 + React + TypeScript                   |
   | 工作台 | 会话中心 | 人工回复 | 知识库 | 运维      |
   +-------------------------+----------------------+
                             | 本机 IPC / 鉴权本地 API
   +-------------------------v----------------------+
   | Node Supervisor Sidecar                        |
   | 账号调度 | 人工接管 | AI 草稿 | 唯一发送协调器 |
   | SQLite WAL | 审计 | 健康监测 | 网络配置管理     |
   +--------------+----------------+----------------+
                  |                |
       +----------v-----+  +-------v---------------+
       | Notification   |  | DirectMessage         |
       | Adapter        |  | Adapter               |
       | 网页顶部「通知」  |  | 网页「消息」入口        |
       +----------+-----+  +-------+---------------+
                  |                |
       +----------v----------------v---------------+
       | Account Actor + Browser Profile Owner      |
       | Persistent Context / 2 independent Pages   |
       | Account Network Binding / Account Lock     |
       +-------------------------+------------------+
                                 |
                  抖音网页版及正常网络出口
```

- **Tauri**：仅管理桌面窗口、托盘、通知、更新与 Sidecar 生命周期；Rust 保持薄壳，不建立第二套调度器。
- **React**：完全自主开发高级工作台 UI，不嵌入抖音网页作为业务界面。
- **Node Supervisor**：唯一的任务、账号与发送决策权威；前端和 AI 模型无法直接驱动发送。
- **Playwright**：只负责浏览器 UI 观察、定位、交互与回读，不作为聊天消息长期数据源。
- **SQLite WAL**：本机持久化账号元信息、消息索引、任务、草稿、回执、模型账单与审计。敏感凭据单独保护。

Tauri v2 支持将 Node 程序打包为 Sidecar。Playwright `launchPersistentContext` 支持用户数据目录、浏览器通道、Headless 选项及代理配置。每个独立持久目录同一时间只允许一个浏览器实例使用。

## 2.2 进程责任与独占约束

1. 一个账号只允许一个 `ProfileOwner`。拥有 `lease_owner`、`profile_generation`、`started_at` 和 `heartbeat_at`。
2. 每个账号至少使用 `notificationPage` 和 `dmPage` 两个逻辑页面，分别处理通知与私信，禁止互相抢占导航。
3. 同账号任何有副作用 UI 操作由 `AccountActor` 串行协调；同账号发送并发恒为 1。
4. 页面观察可按调度窗口执行，但发送前一定要重新核验当前登录账号与目标。
5. 任何失联的 Worker 都必须先确认旧浏览器退出，才能重新获取 Profile 所有权；不得靠租约过期就直接双开。
6. 模型 API 调用独立于浏览器队列，可在等待生成期间释放不必要的 UI 操作槽，但不能释放发送锁后再次复用旧对象。

## 2.3 推荐工程目录

```text
inbora/
  apps/
    desktop/                  # Tauri + React UI
    supervisor/               # Node Sidecar / 本机管理 API
    runner/                   # Playwright 浏览器执行器
  packages/
    contracts/                # Zod + TypeScript 统一契约
    account-core/             # Account Actor、租约与调度
    adapters/
      notification/           # 通知采集、目标定位、评论回复
      direct-message/         # 私信采集、会话校验、发送
    network/                  # NetworkProfile、出口健康检查
    ai/                       # Prompt、提供商、费用计量
    storage/                  # SQLite 迁移、仓储和备份
    policy/                   # 回复规则、人工接管和安全门禁
    human-support/            # 人工工作台命令、接管租约、草稿管理
    delivery/                 # 统一外发、幂等意图、回执核验
    observability/            # 日志、指标、审计和证据
  tests/
    fixtures/                 # HTML / Mock 平台页面
    unit/
    integration/
    e2e-mock/
    live-manual/              # 授权账号实机验收
  docs/
    architecture/
    adr/
    verification/
    runbooks/
    releases/
```

**工程原则**：浏览器适配器只能读取页面并通过规范接口执行操作；账号管理、去重、AI、任务状态机与数据库不能依赖具体 CSS 选择器。

---

# 03. 工作台完整功能规格

## 3.1 主要页面

| 页面 | 关键内容 | 优先级 |
|---|---|---|
| 工作台 | 账号状态、今日新消息、成功回复、待人工、渠道统计、最近同步时间 | P0 |
| 会话中心 | 全部 / 评论 / 私信，账号筛选、未处理、AI 草稿、待人工、发送未知；支持直接手动输入发送 | P0 |
| 账号管理 | 扫码登录、Profile 健康、浏览器模式、网络绑定、运行节点、启停 | P0 |
| 回复规则 | 分账号开关、人工模式、AI 辅助模式、模板、静默时间、人工接管、恢复 AI | P0 |
| 知识库 | 共享知识、账号私有知识、版本、失效日期、冲突检查 | P1 |
| AI 配置 | 供应商、模型、提示词、人设、最大 Token、费用预算 | P1 |
| 任务与调度 | HOT/WARM/COLD 池、账号队列、等待、失败、人工优先级 | P1 |
| 数据统计 | 每账号和渠道的输入量、确认回复率、人工率、Token、成本 | P1 |
| 运行日志 | 审计、浏览器崩溃、目标冲突、网络异常、回执证据 | P0 |
| 系统设置 | 本地存储、备份、更新、隐私、许可、全局急停 | P0 |

## 3.2 消息详情区域

- 私信详情采用聊天时间线，展示最近已观察到的历史消息、对方身份验证状态和当前会话上下文。
- 评论详情展示作品链接或封面、通知事件、父评论和楼中楼上下文，不把评论伪装成一对一私信会话。
- AI 结果同时展示草稿、知识来源、规则命中和建议处置状态。
- **人工接管对话框**包含准确目标、原消息及有限上下文，下方统一回复框支持直接人工输入、引用 AI 草稿、编辑、清空和快捷回复。正常流程只需输入并点击「发送」；接管、续租和草稿保存自动完成，「恢复 AI」作为单独的可选操作。
- 工作台点击「发送」由 Node `SendCoordinator` 调用 Playwright 执行，仍会做账号/目标身份预检，禁止前端直接驱动浏览器。
- 平台发送结果标记需区分 `发送排队中`、`发送前校验`、`发送中`、`已确认`、`结果待核实`、`发送前失败`；不可仅凭本地点击显示已发送。
- 统计卡显示真实核验值。休眠账号显示「最近检查」，禁止显示误导性的「实时在线」。

## 3.3 五种运营工作模式

| 模式 | 自动采集 | AI 草稿 | 工作台人工发送 | AI 自动发送 |
|---|---|---|---|---|
| `OBSERVE` 只读 | 是 | 否 | 否 | 否 |
| `DRAFT_ONLY` 草稿 | 是 | 是 | 否，允许复制和跳转 | 否 |
| `MANUAL` 纯人工 | 是 | 可选，默认不调用 | 是，经统一发送门禁 | 否 |
| `AI_ASSISTED` AI 辅助 | 是 | 是 | 是，人工修改或审批后发送 | 否 |
| `LIMITED_AUTO` 有限自动 | 是 | 是 | 是，人工任务优先 | 仅明确获准且规则命中的任务 |

**推荐默认 `AI_ASSISTED`，首次接入/账号能力尚未验证时强制 `DRAFT_ONLY`。** `MANUAL` 下直接人工输入不调用 AI 模型，Token 费用为零。任何模式都受账号发送能力和平台现行规则约束；不能因为是人工点击工作台按钮就跳过浏览器端身份核验。

## 3.4 工作台人工发送的完整交互规格

| 界面区块 | 用户所见信息 | 关键动作和反馈 |
|---|---|---|
| 左侧账号列表 | 账号别名、授权健康、最后同步、未处理数 | 选中账号，保持其消息和知识库隔离 |
| 中间待办列表 | 评论或私信类型、预览、收到时间、待人工原因 | 过滤、排序、打开任务及人工接管对话框；区分 AI 推荐与真实已发送 |
| 消息详情 | 私信时间线，或作品/父评论/通知证据 | 明确显示账号、接收人或父评论，禁止仅凭昵称辨别目标 |
| 人工接管对话框 | 顶部准确账号及目标、中部原消息和上下文、底部回复框与发送按钮 | 输入后点击发送；自动接管及保存，Ctrl+Enter 与按钮共用发送命令（需明确提示） |
| 右侧操作栏 | AI 建议、匹配知识、回复规则、风险与身份级别 | 生成建议、引用、打开人工对话框、查看原网页；释放接管为可选操作 |
| 发送状态条 | `待验证/排队/发送中/已确认/未知/失败` | 失败原因、只读核验、人工核对入口；不可盲目重试 |

**工作台人工发送步骤：**

1. 运营从带明确归属的「待人工」任务进入人工接管对话框。顶部显示所属账号和准确目标，中部展示原消息及有限上下文，底部为回复框和「发送」。私信采用聊天时间线；评论保留作品、原评论作者、父评论及回复关系。
2. 打开对话框后，系统自动申请接管租约，并在编辑期间续期；正在准备的 AI 自动发送任务失效。运营无需再点击领取或接管。存在他人接管或版本冲突时，在对话框内保留输入并提示处理。
3. 运营直接写回复，或采用并修改 AI 草稿。草稿自动保存，输入和保存均不调用 AI；关闭对话框保留未发草稿，不自动恢复 AI 外发。
4. 对话框持续展示目标摘要及回复全文，运营点击「发送」完成一次业务确认，无需先点保存或再确认一次。后台先持久化本次全文的最新草稿版本，再绑定该版本执行发送，不能使用较早的自动保存稿。目标或版本变化时保留输入并提示冲突，不发送旧内容。
5. Supervisor 校验操作权限、接管租约、草稿版本、目标唯一性、网络健康、账号已登录、通道可发送、无其他进行中的发送意图。
6. 若当前浏览器休眠，任务可以排队且展示过期时间；唤醒后仍须重新完成网页目标预检。无法满足时直接退回待人工，不在错误目标上发送。
7. 落库唯一 `send_intent` 后执行一次网页发送动作，并回读对应私信/评论的我方回复。
8. 系统自动回读并显示结果。暂未取得证明时自动安排有界只读补证，冻结同目标再次外发；仍不能核实时显示具体异常和所需人工动作。只读核验按钮作为辅助入口，不是正常流程的必经步骤。

**发送按钮启用条件：** `accountVerified && targetTrust === 'STRONG' && sendCapability === 'AVAILABLE' && operatorCanSend && leaseValid && !existingUncertainIntent && !accountPaused && draftIsCurrent`。如果通知事件只包含昵称和评论文本，按钮应禁用，提示「打开原评论确认目标」；人工接管也不能消除目标歧义。

## 3.5 人工接管和 AI 任务互斥

- 接管粒度优先为 `account_id + channel + thread_or_parent_comment_key`；需要时提供全账号接管。私信会话与评论父对象分别维护控制权。
- 接管采用 `ownership_generation` 代际和 `lease_expires_at`；操作端需要持有当前代际。人工接管、释放、账号暂停均递增控制代际，使旧 AI 任务即刻失效。
- **人工操作优先级高于 AI**：取得接管权后暂停该目标自动回复；AI 可以继续生成只读建议，但不能触发发送。未完成的 AI 已批准草稿失效。
- 人工发送与 AI 自动发送共用 `SendCoordinator` 和账号级 UI 锁。数据库中只能存在一个对同一消息目标的有效外发意图。
- 已经进入网页点击阶段的任务无法通过前端取消来保证撤销；接管发起时若存在点击中的任务，界面展示「待核实」，等回读或人工核对完成后才允许下一条回复。
- 支持「恢复 AI」，由具备权限的人员点击；需确保没有未知发送结果、账号规则仍允许自动发送，并记录审计。
- 两名运营同时编辑同一任务时采用乐观版本检查；第二个过期提交被拒绝并展示最新内容，避免覆盖对方草稿。

## 3.6 日常确认与核实自动完成

正式版在授权账号范围内自动执行以下流程。后台检查只推进当前操作，不产生第二次发送。

| 环节 | 系统自动完成 | 用户参与条件 |
|---|---|---|
| 启动与连接 | 管理 Sidecar 生命周期、连接既有目录、恢复权威状态、检查依赖与数据库 | 首次选择目录、修复不可恢复的环境问题 |
| 账号与通道 | 检查登录身份、映射、浏览器版本和通道资格，按需重新核验 | 登录、扫码、验证码、账号权限冲突 |
| 目标与编辑 | 在人工对话框内定位准确会话或父评论、等待渲染就绪、申请及续期接管、自动保存并绑定最新草稿版本 | 目标持续不明确、接管冲突或业务内容需要修改 |
| 发送准备 | 唤醒浏览器，校验权限、模式、授权、预算和目标，保存唯一意图 | 人工模式的一次发送操作，或新增自动回复策略授权 |
| 回读与补证 | 监听本次提交结果、刷新准确对象、处理已校准时钟偏差、有界只读核验 | 自动核验后仍无完整证明、证据矛盾或平台要求本人处理 |
| 状态与审计 | 自动更新结果和最近成功核验时间，保存脱敏证据及异常历史 | 用户主动查看审计或导出验收记录 |

`MANUAL`和`AI_ASSISTED`下，用户决定回复全文并执行一次业务发送操作，后续预检、网页提交和回读由系统完成。`LIMITED_AUTO`下，用户先授权账号、通道、规则、时段和预算；命中范围的任务自动生成绑定目标、全文及版本的批准，再经同一发送协调器提交和核验，无需逐条人工批准。超出策略范围的任务转待人工。

自动只读补证有次数、时间和目标边界，不能演变为自动重发。旧异常及原收据保留，后续证明作为追加记录，在同一任务显示“后续核验已确认送达”或尚缺的证明，避免把用户留在需要反复点击核验的循环中。验证码、人工输入和用户暂停持续有效，恢复核验不会自动撤销暂停或恢复发送。


---

# 04. 双通道数据采集和回复

## 4.1 通道 A：顶部「通知」

**数据发现入口**：已登录 `www.douyin.com` 顶部导航中的「通知」弹层。不得假设存在稳定可访问的 `/notification` 独立路由。只处理能被确认属于本人作品的被动评论与指定评论回复事件；其他点赞、关注、系统通知过滤掉。

```text
打开通知 → 检查账号身份 → 读取可见通知 → 分类
→ 保存观察证据 → 增量去重 → 解析作品及原评论
→ AI 草稿 → 人工批准 → 发送前再次定位
→ 在目标评论下执行一次回复 → 回读确认
```

**评论目标解析优先级**：网页可观察的稳定评论 ID > 唯一评论跳转链接及作品 ID > 作品、作者、正文、时间等组合证据。仅有昵称或正文的目标标记为 `AMBIGUOUS`，停止自动发送。

**回复方式**：如果通知弹层带目标明确的回复框，直接操作；若只能跳转，则在评论通道页面进入原视频的相应评论位置，核验父评论后进行楼中楼回复。若跳转未定位到唯一原评论，保留草稿交人工处理。**历史评论并不承诺全部可从通知找回**。

**人工发送兼容**：在工作台编辑器点击发送后仍走相同 `CommentReplyExecutor`。若通知已读、顺序变化或跳转 URL 失效，必须重新定位并验证原评论，不能退化为对作品发表顶层评论。目标无法确认时提供打开原网页的人工辅助链接，工作台标记此任务为 `NEEDS_TARGET_REVIEW`，不把人工点击视作技术许可。

## 4.2 通道 B：顶部「消息」

```text
进入消息入口 → 校验本人账号 → 读取会话列表
→ 增量读取新收到的私信 → 核对会话稳定身份
→ 按需聚合连续消息 → AI 草稿 → 审批
→ 再次校验账号、收件人和草稿版本
→ 执行一次回复 → 回读我方新消息
```

不得以昵称包含匹配、头像、输入框存在或按下 Enter 就判定发送正确。遇到同名用户、已撤回消息、未确认发送人、新的安全验证或平台限制，进入人工处理。

**人工发送兼容**：工作台人工输入的文本无需 AI 调用，经 `DirectMessageReplyExecutor` 发送。发送前必须重新核对当前私信会话的稳定身份、账号、最后观察到的消息水位。人工接管后 AI 自动回复通道不得再次发送同一触发事件。

## 4.3 统一事件契约

```ts
type Channel = 'COMMENT_NOTIFICATION' | 'DIRECT_MESSAGE';
type TargetTrust = 'STRONG' | 'WEAK' | 'AMBIGUOUS';

type InboundEvent = {
  id: string;                    // 本地 UUID
  accountId: string;
  channel: Channel;
  observedAt: string;
  platformEventId: string | null;
  actorId: string | null;
  actorName: string | null;
  text: string;
  videoId?: string | null;
  parentCommentId?: string | null;
  conversationId?: string | null;
  targetTrust: TargetTrust;
  evidenceRef: string;
};

type ReplyOrigin = 'HUMAN_TYPED' | 'AI_ASSISTED_APPROVED' | 'AI_AUTO';
type ThreadOwner = 'NONE' | 'HUMAN' | 'AI_ELIGIBLE';

type WorkbenchSendCommand = {
  commandId: string;            // 操作幂等键，双击复用同一命令 ID
  accountId: string;
  eventId: string;
  channel: Channel;
  targetKey: string;
  targetDigest: string;         // 来源对象摘要，点击前还需网页核验
  draftId: string;
  draftVersion: number;
  text: string;
  origin: ReplyOrigin;
  operatorId: string;           // 本机或授权运营身份
  ownershipGeneration: number;
  expectedThreadVersion: number;
};

type DeliveryResult =
  | { status: 'SENT_VERIFIED'; receiptId: string }
  | { status: 'FAILED_BEFORE_CLICK'; reason: string }
  | { status: 'SEND_UNCERTAIN'; reason: string };
```

不同账号、不同作品、不同会话可以出现相同文字，不允许简单以消息正文去重。缺少平台稳定 ID 的消息使用复合指纹辅助候选匹配，但身份级别保持真实，不因猜测提高可信度。

## 4.4 唯一发送协调器和状态机

```text
事件 OBSERVED → NORMALIZED → DEDUPED → 待处理
    ├→ 人工输入 MANUAL_DRAFT
    └→ AI 建议 AI_DRAFT → 人工引用/批准 或 有限自动门禁
             ↓
    CONTROL_OWNERSHIP_CHECK + CONTENT_VERSION_CHECK
             ↓
    TARGET_PREFLIGHT + ACCOUNT/NETWORK/CHANNEL_CHECK
             ↓
    SEND_INTENT_PERSISTED → SENDING (单次网页点击)
        ├→ SENT_VERIFIED → CLOSED
        ├→ FAILED_BEFORE_CLICK → 可修复后重新审批
        └→ SEND_UNCERTAIN → FREEZE + READ_ONLY_RECONCILIATION
```

- 所有 `HUMAN_TYPED`、`AI_ASSISTED_APPROVED`、`AI_AUTO` 发送意图都进入唯一 `SendCoordinator`。React 按钮、快捷键、定时任务和 Agent 均不能直接调用 Playwright 点击。
- SQLite 事务先写入 `send_intent`、操作来源、`operatorId`、`draftVersion`、`ownershipGeneration` 和唯一约束；只有事务提交成功才允许网页发送。
- 对已通过发送门禁、准备执行的任务，先把 `send_attempt` 标记为可能已开始。**最多一次自动尝试**。进程崩溃后即使无法确定是否点击，也按 `SEND_UNCERTAIN` 冻结，避免重复发送。
- `FAILED_BEFORE_CLICK` 只有在有证据表明网页发送动作根本没有发生时才可使用；否则归为 `SEND_UNCERTAIN`。
- 工作台双击「发送」、两名员工同时点击、AI 定时器与人工发送抢占时，按 `(account_id, event_id, action_type)` 的有效意图唯一约束和控制代际拒绝重复动作。
- 在输入框填写内容后，操作人员已接管、已提交新草稿、用户发来新消息、会话切换或通道能力降级，发送协调器必须再次执行提交前检查。
- `SEND_UNCERTAIN` 只可只读核验。经确认未发出后，人工可明确创建新的发送命令；任何重新发送须有新的操作员确认和事件审计，不能自动重试。
- AI 只生成建议，缺乏调用网页发送、系统凭据、网络策略和账号切换的权限。

## 4.5 各通道发送证据与人工状态说明

| 场景 | 可观察的成功依据 | 结果不明时的 UI 行为 |
|---|---|---|
| 人工私信 | 当前账号+正确会话下出现对应我方新消息，并关联点击前水位 | 原输入保留本地，显示「待核实」，禁用重复发送 |
| AI 辅助私信 | 同人工私信，另记录草稿审核人和版本 | 冻结 AI 重发与人工二次点击 |
| 人工评论 | 唯一父评论下出现我方楼中楼回复 | 回到原评论只读核验，不能当作顶层评论重发 |
| 有限自动评论 | 同人工评论，另记录规则批准和版本 | 停止该目标后续自动回复，人工接管 |

`已读`、网页弹层关闭、点击成功、输入框清空和本地任务完成都不足以当作平台送达回执。若平台没有可观察的强回执，必须如实标注“结果待核实”。


---

# 05. 账号级 IP 与网络隔离方案

## 5.1 风险事实与边界

登录 Profile 隔离的是 Cookie、localStorage、缓存等浏览器数据。**如果 30 个独立浏览器都通过一条家庭或办公室宽带上网，对外仍可能共享同一个公网 IP。** 同时，多账号的设备环境、登录行为、内容相似性和自动化特征也可能引起平台审核。没有经过验证的官方资料能给出普通抖音个人号的“一个 IP 允许几个账号”阈值。

因此，在正式版中把账号级网络绑定作为**可靠性、网络归属和安全管理能力**。独立 IP 不保证解除关联，不构成自动化合法性的证明，也不能用来规避验证码、封禁或其他限制。

## 5.2 三种支持的网络模式

| 模式 | 使用场景 | 优点 | 代价与限制 |
|---|---|---|---|
| `DIRECT` 本机直连 | PoC、小团队、同一正常网络环境 | 零代理成本、稳定性最好 | 账号共享出口 IP |
| `FIXED_PROXY` 指定固定代理 | 账号原本使用不同、合规的固定网络出口 | 单机可按账号配置，网络管理直观 | 代理质量、延迟、故障、凭据成本；仍需验证合规性 |
| `REMOTE_RUNNER` 独立节点 | 多个授权运营地点或单机资源不足 | 分散计算和网络出口；节点独立运行 | 部署、安全更新、消息回传、故障复杂度较高 |

**默认策略：** PoC 直连。10 账号灰度期根据实际账号使用环境选直连或固定出口。20 至 30 账号规模时，由真实资源占用、地域归属和稳定性决定是否增加执行节点。没有必要一次性采购 30 个代理。

## 5.3 NetworkProfile 业务字段

```ts
type NetworkMode = 'DIRECT' | 'FIXED_PROXY' | 'REMOTE_RUNNER';

type NetworkProfile = {
  id: string;
  mode: NetworkMode;
  nodeId: string;                 // 本机或已授权远程节点
  proxyRef: string | null;       // 凭据引用，非明文密码
  expectedRegion: string | null;
  observedPublicIp: string | null;
  lastCheckedAt: string | null;
  health: 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'FAILED';
};

type AccountAssignment = {
  accountId: string;
  profileId: string;
  networkProfileId: string;
  nodeId: string;
  assignmentGeneration: number;
};
```

- `proxyRef` 在 Windows Credential Manager / DPAPI 保护的密钥存储中解析，不进入 SQLite 明文列、前端日志或错误提示。
- 每个账号的网络模式、运行节点、预期地域和最后一次核验出口都可在工作台查看。
- NetworkProfile 的账号绑定一经建立，后续变更必须有审批和审计。正在登录或发送时拒绝切换出口。
- 固定代理失效时暂停该账号，不自动切换不明代理，也不悄悄退回本机直连。
- 浏览器启动前对受控的中立检测地址执行出口与连通性检查；检测失败不得启动发送任务。检测地址、使用条款与隐私保留策略单独审查。
- 如原账号通常由不同真实运营者使用，应尊重他们已有的正常网络与授权关系，避免突变登录地域。

## 5.4 浏览器网络配置示例

```ts
import { chromium } from 'playwright';

const browserOptions = {
  channel: 'msedge' as const,
  headless: true,
  ...(network.mode === 'FIXED_PROXY'
    ? {
        proxy: {
          server: proxyConfig.server,
          username: proxyConfig.username,
          password: proxyConfig.password,
        },
      }
    : {}),
};

const context = await chromium.launchPersistentContext(
  profileDirectoryFor(accountId),
  browserOptions,
);
```

这里的代理配置是 Playwright 官方支持的通用网络功能。示例省略凭据读取、租约和状态检查。**网络变更应在正常关闭浏览器后以新配置重新启动**，不可让同一 Profile 被两个进程同时使用。

## 5.5 独立节点扩展拓扑

```text
                     Inbora 控制端
            Tauri + Node Supervisor + SQLite
                             |
                    加密的受控内部连接
                  /          |           \
                 /           |            \
       Runner A / 本机   Runner B / 地点 2   Runner C / 地点 3
        账号 01~08        账号 09~18        账号 19~30
        本地 Profile      本地 Profile       本地 Profile
        本地浏览器        本地浏览器         本地浏览器
        正常网络出口      正常网络出口       正常网络出口
```

**多节点必须额外实现**：节点注册和撤销、双向身份验证、心跳与能力报告、任务交付确认、最小必要消息回传、断线队列、跨节点租约、版本兼容、远程停发。所有浏览器 Profile 留在其节点本地，不复制 Cookie 到中心。网络中断期间节点不接受新发送指令；已开始且结果未知的任务保持冻结。中心 SQLite 仅由本机 Supervisor 读写，**不得把 SQLite WAL 数据库文件挂载到网络共享目录**。正式版优先交付单机，`REMOTE_RUNNER` 作为可选第二期能力。

---

# 06. Headless、浏览器资源池与发现时延

## 6.1 浏览器模式策略

| 阶段 | 模式 | 通过标准 |
|---|---|---|
| 首次扫码登录 | Headed | 账号本人完成登录，Profile 持久化 |
| 兼容性基线 | Headed | 两条通道定位、回复、回读可重现 |
| 无头回归 | Headless | 同样目标、同样回执规则下通过测试 |
| 安全验证 | Headed 人工处理 | 不尝试自动破解验证码 |
| Headless 不兼容 | 降级 Headed 或 Draft | 不改变安全门禁 |

无头浏览器同样运行网页、JavaScript 和 Chromium 进程，不能将 30 个 Profile 估算为一个轻量浏览器。使用 Edge 通道时须锁定受测版本，更新前在一号测试 Profile 上回归。不要通过修改浏览器指纹等手段隐藏自动化。

## 6.2 三态资源池

| 状态 | 账号含义 | 能力 | 限制 |
|---|---|---|---|
| HOT | 浏览器已打开并可执行观察 | 可在允许的调度窗口检查通知与私信 | 内存较高，实时性取决于实际页面 |
| WARM | 浏览器已打开，暂缓观察 | 复用登录环境，较快恢复 | 仍占用内存，不能宣称实时监听 |
| COLD | 登录资料保存在磁盘，浏览器已关闭 | 调度时按需启动检查 | 关闭期间无法保证即时发现新消息 |

建议 **64GB Windows 主机**的起始测试值为：最多管理 30 个账号、同时打开 6 至 8 个 Profile、HOT 3 至 4 个、并行 UI 操作 2 至 3 个、同时启动浏览器 1 个、每账号最多 1 个发送任务。所有数值都是内部容量测试的初始配置，之后由实际 P95 内存与时延调整。

若用户要求 30 个号每个都在几秒内收到新消息，必须实测 30 个常驻会话与平台行为，再匹配硬件与网络资源；仅有冷热轮询架构时不能保证此目标。

## 6.3 容量估算方式

```text
浏览器可用内存 = 总内存 - Windows与其他程序 - Tauri/Node - 安全余量
最大常驻 Profile 数 ≈ 浏览器可用内存 / 单 Profile 实测P95增量内存

发现延迟 = 上一次成功观察至新事件被系统首次识别的时间
处理延迟 = 首次识别至进入草稿/审批的时间
发送确认延迟 = 批准至真实回执确认的时间
```

单 Profile 内存仅用于前期演示的假设为 0.8 至 1.5GB。8 个约为 6.4 至 12GB，30 个约为 24 至 45GB 浏览器预算，另需系统和软件余量。最终必须实测 Chromium 进程树的增量工作集、CPU、内存压力、页面卡顿和崩溃率。默认建议 8 至 12 核级 CPU、64GB RAM、1TB NVMe；需要 30 号长期开启时再评估 96 至 128GB 级别或多节点方案。

---

# 07. 数据库、业务幂等和故障恢复

## 7.1 SQLite 表清单

| 表 | 重要字段 | 用途 |
|---|---|---|
| `accounts` | id、display_name、enabled、mode、status | 账号注册信息 |
| `account_profiles` | account_id、profile_dir、generation、lease_owner | Profile 唯一所有权 |
| `network_profiles` | id、mode、node_id、proxy_ref、health | 网络配置和健康 |
| `worker_nodes` | id、version、capabilities、heartbeat | 本机 / 远程执行节点 |
| `account_assignments` | account_id、node_id、network_profile_id | 账号与运行地点绑定 |
| `channel_cursors` | account_id、channel、cursor、last_success | 双通道读取水位 |
| `inbound_events` | id、account_id、channel、dedup_key、trust | 归一化事件 |
| `message_threads` | id、account_id、channel、target_key | 会话或评论上下文 |
| `reply_drafts` | id、event_id、content_version、model、status、origin | 人工草稿、AI 草稿和版本 |
| `thread_ownership` | account_id、channel、target_key、owner、generation、lease_expiry | 人工接管和 AI 外发互斥 |
| `operator_sessions` | id、role、started_at、expires_at | 操作员身份及其权限范围 |
| `review_decisions` | id、draft_id、version、reviewer、decision | AI 草稿审批历史 |
| `send_intents` | id、event_id、target_digest、command_id、operator_id、origin、status | 人工与 AI 共用的唯一发送意图 |
| `send_attempts` | id、intent_id、started_at、click_state | 实际一次发送尝试 |
| `delivery_receipts` | id、attempt_id、status、evidence_ref | 平台可观察回执 |
| `model_usage` | id、account_id、input_tokens、output_tokens、cost | AI 消耗 |
| `audit_events` | id、actor、event_type、redacted_payload | 不可随意覆盖的审计链 |
| `evidence_objects` | id、storage_path、expires_at、redaction | 受控诊断证据 |

## 7.2 唯一性约束与事务边界

- `channel_cursors` 以 `(account_id, channel)` 为唯一键。
- 确实观测到平台事件 ID 时以 `(account_id, channel, platform_event_id)` 唯一去重。
- `send_intents` 增加 `command_id` 全局唯一键，前端重试 HTTP/IPC 请求时只返回相同结果；同一来源事件及动作不允许存在并发有效外发意图。不要让批准版本变化绕开重复发送门禁。
- `thread_ownership` 使用 `(account_id, channel, target_key)` 唯一键。每次接管/释放均通过数据库事务比较和递增 `generation`；持有旧版本的 AI/运营任务必须失败。
- `reply_drafts` 以 `content_version` 做乐观更新；人工与 AI 内容都保存明确的 `origin`，审批记录绑定准确版本与操作员。
- Worker 发送前核验人工权限或 AI 发送许可、人工接管代际、目标信任等级、文本版本及历史点击记录，再在数据库事务内标记即将发送；事务提交后才执行网页点击。
- 如果在点击后崩溃，启动恢复只做只读回查，绝不基于 `PENDING` 状态重新发送。
- 每次浏览器崩溃、操作超时、Proxy 故障、账号重登都写结构化事故记录和对应的人工处理任务。

## 7.3 备份和数据保留

使用 SQLite WAL、短写入事务、定期 checkpoint 与数据库一致性备份。Profile 不应与数据库一起简单压成未经加密的公共备份包。建议将账号 Profile 与数据库元信息分开备份，备份文件用 Windows 设备加密或受控密钥保护。日志和截图默认短期保存、按需延长，用户可配置敏感内容脱敏与彻底清理流程。明确区分应用退出、浏览器停止和数据删除三个行为。

---

# 08. AI Agent、知识库与 Token 成本

## 8.1 推荐处理流水线

```text
网页采集及去重(0 模型 Token)
→ 规则/关键词分类(优先本地，无模型调用)
→ 选择账号人设、服务政策和相关知识
→ 组合有限历史上下文
→ 按需 AI 生成结构化草稿（纯人工模式跳过）
→ 内容与事实检查
→ 工作台人工撰写/编辑/审批，或有限自动发送门禁
→ Playwright 发送与回读(0 模型 Token)
```

将 Prompt 拆分为共享规范、账号人设、渠道要求、检索到的少量有效知识与最近有限轮次的上下文。评论和私信采用不同模板，避免把评论写成私聊，避免串账号引用。所有知识条目记录来源、版本、生效日期与失效日期；模型遇到价格、售后承诺、敏感交易或信息不足时转人工。

## 8.2 模型路由

- **纯人工发送全链路无需 AI 调用，成本为零 Token**；仅使用浏览器、数据库和本地 UI。
- 简单 FAQ 可先由本地规则匹配并返回待批准模板，无需模型调用。
- 普通评论及短私信使用低成本文本模型，严格限制输入历史与输出上限。
- 多轮复杂语义、知识冲突或情绪明显问题可转高能力模型或人工。
- 图片、语音、视频理解默认关闭，独立计算请求、隐私与成本，后期按需启用。
- 网页消息及附件是**不可信输入**。不可遵循其中要求泄漏密钥、修改系统规则、点击站外链接或跨账号操作的指令。

## 8.3 Token 预算示例

例：30 个账号每天合计 500 条有效待回复消息，按 30 天计算，每条 AI 调用消耗 600 至 3,000 输入 Token 和 100 至 250 输出 Token。则一个月约有 **900 万至 4,500 万输入 Token，以及 150 万至 375 万输出 Token**。具体费用取决于选定模型的实时官方价目、缓存、重试、多轮工具调用与实际命中规则的比例，估算时使用：

```text
月度模型费用 = 输入Token / 1,000,000 × 输入单价
             + 输出Token / 1,000,000 × 输出单价
             + 视觉/音频/工具等额外费用
```

**必须避免**每次网页轮询都发送页面 HTML、全量评论和大量历史聊天给 AI。只在发现新且需要回复的业务事件后触发模型。工作台逐账号展示日消息量、AI 请求数、输入/输出 Token、月预算、异常模型费用。支持月预算达阈值后自动转模板或人工草稿。

## 8.4 私有数据与外部模型

即使应用本地部署，调用第三方云模型仍会按调用策略向供应商传送必要的聊天内容。默认做字段最小化、PII 脱敏和可配置的模型供应商；有更严格隐私需求时可以对接本地模型或仅使用规则模板。严禁把 Cookie、Profile 文件、代理密码、浏览器完整 HAR 或账号凭据传给模型。

---

# 09. 安全、权限与异常治理

## 9.1 三层权限

1. **产品操作权限**：管理员、运营发送员、AI 审核员和只读观察员。每个角色按账号和通道授权，发送、审批、接管、释放、强制结案均留下操作员和时间审计。
2. **账号能力权限**：每账号单独保存 `READ_OK`、`SEND_REVIEW_ONLY`、`SEND_AVAILABLE`、`BLOCKED` 和核验到期时间。
3. **平台实际行为许可**：只有现行规则和真实测试允许的操作才启用。系统能力不等同于平台授权。

## 9.2 必须自动停发的情况

- 账号出现异地异常、平台安全验证、被限制功能、登录过期或身份不一致。
- 指定评论、会话、收件人或回复归属无法唯一确认。
- 浏览器页面改版导致选择器不确定，或通知和私信页面状态冲突。
- 固定出口突然故障、出口不符合预期、节点离线或配置未经批准变化。
- 用户人工接管、全局急停或账号暂停；正在准备的 AI 自动任务必须检测接管代际并立即失效。
- 人工工作台提交了过期草稿、操作员无权限、浏览器身份与工作台所选账号冲突或前次发送结果仍未知。
- 点击发送后无可靠回读，任务状态为 `SEND_UNCERTAIN`。
- 模型输出包含未经确认的价格、个人信息、站外引导或违反自定义规则的承诺。

## 9.3 安全实现

- Tauri 使用最小化权限清单；Sidecar 只绑定本机 IPC 或 `127.0.0.1`，带短期会话认证和 Origin 校验，不暴露公网管理接口。
- 持久 Profile 使用独立目录和 OS 文件权限。不要复用用户日常使用的默认 Chrome/Edge Profile。
- API Key 与 Proxy 密码走 OS 凭据存储；SQLite 的私信正文、诊断截图按敏感数据策略加密与保留。
- 日志默认删除 Cookie、Token、完整代理 URL、个人隐私字段，采样截图严格控制。
- 依赖锁定版本与签名更新，CI 做静态检查、依赖漏洞检查及构建来源审计。
- 自动化遇到账号限制时停止相关操作；没有验证码破解、指纹伪装、批量 IP 轮换或规避封禁策略。

---

# 10. 多账号调度和服务质量

## 10.1 调度器结构

- `AccountScheduler`：按账号优先级、最近观察时间、未处理数量、人工审批等待和健康评分公平分配机会。
- `OperationScheduler`：限制浏览器启动并发、活跃 UI 操作、AI 请求、磁盘 IO 与媒体处理。
- `AccountActor`：本账号内的唯一状态和 UI 操作协调者。
- `SendCoordinator`：人工点击、AI 辅助审批和有限自动发送的唯一外发入口，负责授权、版本一致、身份校验、单次点击和回执。
- `HumanTakeoverManager`：负责人工领取、租约、代际、恢复 AI 和接管冲突的审计。
- `HealthWatcher`：监测最后一次成功检查、登陆失效、代理健康、RAM 和队列积压，必要时降级。

## 10.2 推荐起始配置

| 参数 | 初始值 | 说明 |
|---|---|---|
| `MAX_MANAGED_ACCOUNTS` | 30 | 可配置账号上限 |
| `MAX_OPEN_PROFILES` | 8 | 64GB 主机的测试起点 |
| `MAX_HOT_PROFILES` | 4 | 优先级高的活跃账号 |
| `MAX_CONCURRENT_UI_ACTIONS` | 3 | 全局浏览器操作槽 |
| `MAX_BROWSER_LAUNCHES` | 1 | 避免启动高峰 |
| `MAX_SEND_PER_ACCOUNT` | 1 | 账号级发送互斥，人工与 AI 共用 |
| `MAX_SEND_PER_TARGET` | 1 | 评论父对象 / 私信会话互斥 |
| `HUMAN_TAKEOVER_ENABLED` | true | 已验证可发送通道允许工作台人工接管 |
| `MAX_MODEL_INFLIGHT` | 8 | 取决于模型限额与网络 |
| `AUTO_SEND_DEFAULT` | false | 正式版默认人工审批 |

这些参数属于**内部资源控制**，没有宣称平台允许的轮询频次或消息发送限额。不得通过提高轮询频率来试探或规避平台限制。账户服务时效需以可观察的真实消息发现延迟和可执行频率评估。

## 10.3 指标体系

**可靠性**：身份误匹配、重复外发、未知回执任务数、浏览器崩溃、账号被限制、网络失败、恢复成功率。

**服务质量**：首次发现延迟 P50/P95、AI 草稿 P95、人工首次处理时间、人工审批等待、工作台发送排队时长、平台回读确认 P95、各账号最后成功同步时间。

**人工运营**：待人工任务数、待人工原因分布、人工接管数、人工已确认发送数、AI 建议采纳率、发送结果待核实积压、运营员负载和冲突拒绝次数。

**容量和成本**：每个 Profile 的实际工作集、系统内存压力、CPU、磁盘增长、每账号模型用量和按节点网络成本。

**严禁误导展示**：「已管理 30」「浏览器运行 8」「本小时已成功同步 7」「可实时发现 N」分别统计；展示“已发送”前必须有可核验的确认依据。

---

# 11. 开源复用计划与许可边界

| 项目 | 最适合复用的部分 | 许可与决定 |
|---|---|---|
| LockyBee/dsh-douyin-agent | Playwright 浏览器主机、账号身份预检、DM 回读、发送证据与测试模式 | MIT，优先审查可复用源文件；适配本产品接口 |
| JMY2003/a-skill-to-do-anything-in-douyin | 顶部通知弹层打开、页面快照、浏览器操作脚本 | 浏览器通知流程可参考；未核实项目源码授权前只作设计参考 |
| POKMJN/douyin-reply-assistant | 多账号状态模型、消息队列、会话归并、AI 审批流程 | 公开仓库无明确可复用项目许可证，不能直接照搬业务代码 |
| crazyants/douyin-robot | 私信适配器拆分、选择器分层、审计与测试思路 | 无明确项目许可证时仅参考设计 |
| Agying3/DMShoot | 统一收件箱事件总线、多平台 Adapter 抽象 | MIT，但其抖音私信依赖非官方协议，不作为网页执行内核 |
| cs-lazy-tools/ChatGPT-On-CS | UI 与插件组织思路 | AGPL，且关键后端打包组件不完整，首版不作为代码基础 |

新增第三方源码前执行许可证扫描、依赖来源核查和必要的 NOTICE 归档。即便仓库公开，也不自动等于允许复制或闭源商用。产品前端优先自己实现，复用更适合放在业务内核和测试工具层。

---

# 12. 分阶段研发与 GO 门禁

| 阶段 | 建设内容 | 建议周期* | 必须通过的门禁 |
|---|---|---|---|
| S0 单号双通道 PoC | Headed 登录、通知评论、私信收发、回读、重启 | 1 至 2 周 | 评论和私信分别核验，明确 GO/条件 GO |
| S1 正式内核 | SQLite、统一事件、发送状态机、账号 Actor、网络配置 | 1 至 2 周 | 一号无错发、发送未知态冻结 |
| S2 完整工作台 | Tauri UI、统一收件箱、**人工输入并发送**、AI 辅助、接管、审计 | 2 至 4 周 | 不打开抖音网页即可完成人工私信与评论发送，双通道回读达标 |
| S3 多号本机 | 3 至 10 账号、Profile 池、资源调度、节点健康 | 2 至 3 周 | 24 小时运行、无串号、资源可控 |
| S4 30 号灰度 | 20 至 30 账号、72 小时压测、恢复、打包更新 | 2 至 3 周 | 指标与风险清单全部达标 |
| S5 可选多节点 | Runner enrollment、加密通信、远程租约、掉线补偿 | 视需求另估 | 多节点断线、重连与停发演练通过 |

*周期仅为有经验开发人员及测试人员协作下的计划估算，平台网页不稳定、通知链路无法闭环或出现规则限制时，必须重新评估，不作交付承诺。

## 12.1 双通道独立决策

- `GO-COMMENT`：通知发现、目标身份强校验、楼中楼回复及回读确认全部通过。
- `GO-DM`：私信身份核验、准确发送、回读确认、去重及重启恢复通过。
- `GO-HEADLESS`：无头运行通过同样的回复、回读及登录持续性回归。
- `GO-MULTIACCOUNT`：3 至 10 账号无串号、无未经批准发送，资源与时效测量可信。
- `GO-MANUAL-DM`：工作台人工输入私信，核对目标、执行一次发送、回读、崩溃后不重发全部通过。
- `GO-MANUAL-COMMENT`：工作台对通知触发的唯一原评论执行楼中楼人工回复并回读全部通过。
- `GO-HUMAN-TAKEOVER`：人工与 AI 同时竞争、版本过期、账号暂停和发送未知态下均不会重复发送。
- `GO-AUTO`：仅限已批准规则和符合平台条件的场景，人工审查样本和风险门禁满足要求后开启。

**允许条件 GO**：若评论可读不可发，可先上线评论 AI 草稿 + 人工跳转回复，工作台内该评论发送按钮必须禁用；若 Headless 不稳定，可采用 Headed 后台窗口方案；若 30 账号实时发现不可行，界面清晰展示轮询型服务时效。不能为了“完成所有功能”而放宽身份校验。

---

# 13. 测试用例与正式发布验收

| 编号 | 用例 | 必须满足的结果 |
|---|---|---|
| T01 | 同一条评论通知重复出现 | 仅生成一条有效任务 |
| T02 | 两条不同评论文字完全相同 | 不能被错误去重 |
| T03 | 评论跳转无法定位唯一父评论 | 禁止发送，转人工 |
| T04 | 评论发送后网页超时 | 标记 `SEND_UNCERTAIN`，不自动重发 |
| T05 | 两个账号存在同名私信用户 | 账号与会话身份强校验，零串号 |
| T06 | 私信切换时 UI 仍停留在旧会话 | 阻断发送 |
| T07 | 用户连续发出三条短私信 | 正确归并或有序处理，不重复外发 |
| T08 | AI 生成后用户人工接管 | 旧草稿不得继续发送 |
| T09 | 已批准草稿被修改 | 旧审批立即失效 |
| T10 | 同一 Profile 被两个执行器打开 | 第二个启动拒绝，锁所有权一致 |
| T11 | Headless 登录过期或验证码 | 自动停发并提示人工处理 |
| T12 | 指定 Proxy 故障 | 账号暂停，不隐式直连 |
| T13 | 更换账号 NetworkProfile | 审计记录并要求重启，无进行中发送 |
| T14 | 软件异常退出与重启 | 不重复执行已有点击意图 |
| T15 | 本地数据库异常及备份恢复 | 有可验证的恢复结果与日志 |
| T16 | 10 账号持续运行 24 小时 | 无串号，队列有界，内存可控 |
| T17 | 30 账号持续运行 72 小时 | 真实发现延迟、P95 负载及失败率可量化 |
| T18 | 离线或关闭浏览器的冷账号 | 状态正确展示，不能伪报实时在线 |
| T19 | 平台网页改版造成选择器不确定 | 立即停发并形成诊断记录 |
| T20 | 模型收到恶意提示词式消息 | 不泄漏凭据，不执行未授权动作 |
| T21 | 点击回复后收到二次限制 | 不规避限制，保留证据与人工任务 |
| T22 | 节点失联（可选） | 不重复外发，远程 Profile 不被重复占有 |
| T23 | 工作台人工发送一条私信 | 正确会话出现我方回复，回读后才标记已确认 |
| T24 | 工作台人工回复评论 | 回复在指定父评论下出现，不创建作品顶层评论 |
| T25 | 两名运营同时编辑同一条待人工消息 | 只有当前版本可提交；旧版本提示冲突 |
| T26 | 人工接管时 AI 任务正准备发送 | AI 任务因接管代际变化而被拒绝 |
| T27 | AI 已进入发送点击阶段后人工接管 | UI 显示待核实，避免自动或人工二次点击 |
| T28 | 人工双击发送或网络重复提交 IPC | 相同 `commandId` 仅生成一个发送意图 |
| T29 | 工作台所选账号与浏览器登录账号不一致 | 阻断人工发送，提示账号身份冲突 |
| T30 | 仅有昵称、评论正文的通知触发待人工 | 禁用直接发送，提示先核对原评论 |
| T31 | 人工输入后账号处于 COLD 且唤醒失败 | 保留草稿及操作命令，按过期/失败说明处理，不盲发 |
| T32 | 人工编辑 AI 草稿后点击发送 | 记录人工修改版本，旧 AI 批准失效 |
| T33 | 操作员没有某账号发送权限 | 后台拒绝命令，前端禁用操作，写审计 |
| T34 | 回复按钮显示发送中时全局急停 | 未开始点击的任务停止；已点击的任务进入回读/未知态，不伪报撤销 |
| T35 | 发送失败但不能证明点击是否发生 | `SEND_UNCERTAIN` 冻结，禁止用户一键重试 |
| T36 | 人工处理完成后恢复 AI | 只恢复具备发送许可且无未知态的目标，记录操作员 |
| T37 | UI 从评论切换到私信期间发送 | 当前任务目标摘要/版本失效时立即拒绝，零跨通道误发 |
| T38 | 纯人工模式连续处理 20 条任务 | AI 请求数和 Token 消耗为零，收据与审计完整 |
| T39 | 已配置账号正常启动及重连 | 自动连接和恢复权威状态，不要求 CLI、退出重进或截图，不重放发送 |
| T40 | 人工接管对话框输入后点击一次发送 | 自动接管续期、保存并绑定最新全文版本、唤醒浏览器、预检、单次提交及回读；无单独领取、保存或重复确认，关闭保留未发草稿，冲突保留输入且不发旧稿 |
| T41 | 首次回读暂未取得证明 | 后台有界只读补证并更新结果，零重复提交，不要求点击核验按钮 |
| T42 | 有限自动模式命中已授权规则 | 自动生成准确版本批准、单次提交及核验，无逐条人工批准；超范围不发送 |
| T43 | 自动核验后仍有身份冲突或平台验证 | 自动停发并保留草稿，只请求必要人工动作，不循环索取已确认信息 |
| T44 | 取得后续证明后再次启动或核验 | 原异常和新证据同时保留，界面展示最新结论，无旧任务重发或隐式取消暂停 |

## 13.1 推荐发布硬门槛

**绝对门槛**：身份错发 0、跨账号串号 0、未经授权的人工或 AI 发送 0、结果未知时自动重试 0、人工接管后 AI 双发 0。任何一项出现都禁止上线工作台内外发与自动发送。

**质量门槛**：已验证范围内的事件识别准确率目标不低于 99%，必须有人工标注样本与已知通知遗漏统计；Headless 和 Headed 分别记录测试覆盖；浏览器进程树内存、CPU、队列滞留及回执确认时延均出具实测报告。不能通过简单的“运行了 72 小时”就宣布容量验收通过。

---

# 14. 成本与部署选择

## 14.1 推荐部署路线

**方案 A，单台 Windows 主机**：一台 64GB 主机运行 Tauri、Node Supervisor、SQLite 和受限浏览器池。**运营人员仅使用 Inbora 窗口处理评论与私信，人工发送由本机后台执行。**优势是成本低、故障边界清晰、适合第一期正式产品。规模增长时先增加内存和优化账号调度。

**方案 B，单桌面控制台 + 远程授权节点**：将部分账号放在它们本来正常使用的设备或地点运行，通过受控加密连接回传最小必要消息；适用于需要真实物理地点、不同运营主体或计算资源超出单机预算的场景。额外增加运行环境和工程维护成本。

**方案 C，全部 30 账号常驻**：对服务时效要求较高时才考虑。必须先完成真实内存和平台兼容性压测，可能需要 96 至 128GB 主机，或采用多节点。任何方案都不保证平台允许连续自动化操作。

## 14.2 成本结构

| 类别 | 计算方式 | 控制策略 |
|---|---|---|
| 主机 | CPU / RAM / SSD / 电力 | 先 64GB 压测，必要时扩容 |
| 网络出口 | 固定出口数 × 单出口月费 | 只为真实需要隔离的账号配置 |
| AI 模型 | 输入/输出 Token × 实际价目 | 本地去重、少量上下文、模型路由 |
| 存储 | Profile、SQLite、截图、备份 | 配额、脱敏、过期清理 |
| 工程维护 | 平台兼容更新、测试、异常人工处理 | 选择器监测、灰度发布、回滚 |
| 多节点（可选） | 执行设备、网络、远程维护 | S5 再立项，避免过早分布式 |

对于代理预算，建议先用公式建模，而不要凭公开报价推断平台风险。例如 8 条固定出口、每条月费 X，则月度代理预算为 `8 × X`；若全部 30 条则为 `30 × X`，两者差异显著。购买前先核实提供商合法性、固定性、地域和技术支持，禁止因账号被限制就通过代理轮换重试。

---

# 15. 关键风险登记册与应对顺序

| 风险 | 发生后果 | 缓解与停止条件 | 优先级 |
|---|---|---|---|
| 网页通知不能定位唯一评论 | 评论自动回复不可用 | S0 验证；失败改为人工跳转 | P0 |
| 无头浏览器受限 | 日常后台运行不稳定 | 保留 Headed；不可绕过安全验证 | P0 |
| 私信会话误选 | 串号、误发 | 强身份校验、会话锁、回读 | P0 |
| 点击后结果未知 | 重复回复 | 点击前落库、冻结、人工核查 | P0 |
| 多账号同 IP 关联或环境突变 | 登录异常、额外安全检查 | 稳定正常网络、账号级网络绑定、停发处置 | P0 |
| 代理质量不良 | 消息漏读、登录失效 | 预检、固定绑定、故障停发 | P1 |
| 30 浏览器内存耗尽 | 系统卡顿、数据损坏 | 资源池、压力测试、硬门槛 | P0 |
| 平台服务规则调整 | 工作台人工发送或自动发送可能无法持续 | 能力注册表、及时关闭相关浏览器外发、人工跳转降级 | P0 |
| 人工接管与 AI 并发竞争 | 同一消息双发、错发 | 所有模式共用发送协调器、租约代际、任务冻结 | P0 |
| 工作台点击后结果未知 | 人工误以为未发送而重试 | 待核实状态、阻断重复点击、只读回查 | P0 |
| 开源组件许可不清 | 商业分发侵权 | 许可证审查，必要时重写 | P1 |
| 第三方模型泄漏业务内容 | 隐私与合规问题 | 脱敏、供应商选择、密钥隔离 | P0 |
| 桌面升级破坏浏览器环境 | Profile 或选择器不兼容 | 先测试账号灰度、可回滚、备份 | P0 |
| 远程节点失联 | 任务积压、双重所有权风险 | 中央权威租约、断线冻结、人工确认 | P1（可选） |

---

# 16. 决策记录与下一步工作包

## 16.1 已确定的技术决策

| 决策编号 | 决策 | 状态 |
|---|---|---|
| ADR-001 | Tauri v2 + React 工作台，Rust 薄壳 | 已确定 |
| ADR-002 | Node.js 为账号调度和发送的唯一业务权威 | 已确定 |
| ADR-003 | Playwright UI 自动化，不使用非官方私有协议 | 已确定 |
| ADR-004 | 评论从顶部通知采集，私信从独立消息入口采集 | 已确定 |
| ADR-005 | 每账号持久 Profile、双独立 Page、单账号串行发送 | 已确定 |
| ADR-006 | Headless 优先，Headed 备用，实机验证后选择 | 有条件 |
| ADR-007 | 账号级 NetworkProfile，可选固定出口 | 已确定 |
| ADR-008 | 单机优先，多节点独立为二期扩展 | 已确定 |
| ADR-009 | SQLite WAL，本机权威存储，最少一次观察、最多一次发送尝试 | 已确定 |
| ADR-010 | 所有自动发送默认关闭，首次账号仅开放草稿与已验证的人工发送 | 已确定 |
| ADR-011 | 工作台内原生人工编辑和直接发送，人工与 AI 共用 SendCoordinator | 已确定 |
| ADR-012 | 人工接管使用目标级租约与代际，优先于有限自动回复 | 已确定 |
| ADR-013 | `SEND_UNCERTAIN` 时工作台禁用重复发送；需人工只读核验和结案 | 已确定 |

## 16.2 立即可交付 Codex 的开发包

1. **保存本文件与既有 PoC 方案**至 `/docs/architecture/`，旧架构标记为历史参考，避免与 ADR 冲突。
2. **建立 monorepo 与契约包**，先完成账号、事件、草稿、任务、网络绑定与回执的 Zod 类型和数据库迁移。
3. **先用 MockAdapter 完成发送状态机与故障测试**，覆盖未知结果冻结、崩溃重启、身份错配、Profile Owner 锁。
4. **执行真实 PoC 两通道验收**，将选择器、步骤截图、版本、失败原因和平台行为填写至测试报告。增补“工作台人工发送”的单账号 Mock 流程。
5. **接入 Tauri UI 骨架**，完成账号管理、会话列表、消息详情、原生人工编辑器、人工接管、发送状态、审批和紧急暂停。
6. **增加 NetworkManager**，首轮实现本机直连与固定代理两种配置、凭据引用、启动前检查、失败停发。远程节点仅保留协议接口。
7. **完成 3 / 10 / 20 / 30 账号灰度和资源报告**，按数据决定常驻上限与是否采购额外网络或设备。

## 16.3 最终 GO / NO GO 结论

**GO**：至少一个合法测试账号的通知评论和私信两个入口完成强目标身份核验、真实发送、回读、重启恢复；工作台人工发送和 AI 审批均通过并发互斥、权限与未知结果处理；无头兼容性或有头替代可用；账号操作符合现行平台条件。

**CONDITIONAL GO**：某一通道只读可用，或 Headless 不稳定。交付可明确标示能力边界的 AI 草稿与人工审核工作台，只有通过的通道才可以从工作台人工发送；其余任务提供人工查看原网页入口。

**NO GO**：平台明确禁止该类操作、无法确定回复目标、连续出现未知外发或账号受限且无法安全恢复。停止相关自动发送开发，不通过更换网络或指纹绕过限制。

---

# 17. 工作台人工发送模块的技术合同

本章作为独立研发工作包 `WB-MANUAL-SEND`，对后端、前端、数据库和浏览器适配器明确同一份行为合同。**首次交付必须同时覆盖私信与评论，分别按照 GO 门禁启用。**

## 17.1 安全的前后端职责边界

```text
React 编辑器
  ├ 读取会话/评论详情及身份等级
  ├ 编辑草稿，展示待人工原因和禁用理由
  ├ 打开人工对话框，自动请求接管与草稿保存
  ├ 点击一次「发送」，绑定当前全文及最新版本
  └ 订阅 send_status_updated / takeover_updated
         ↓ IPC（本机鉴权、版本校验）
Node Supervisor
  ├ OperatorAuth：按账号授权
  ├ HumanTakeoverManager：领取/续租/释放
  ├ DraftStore：版本与编辑历史
  ├ SendCoordinator：唯一外发门禁 + SQLite 事务
  └ AccountActor：浏览器状态和串行执行
         ↓
Playwright 适配器
  ├ DmReplyExecutor：验证会话 → 填写 → 发送一次 → 回读
  └ CommentReplyExecutor：验证父评论 → 填写 → 发送一次 → 回读
         ↓
SQLite：原始事件、草稿、发送意图、尝试、回执、审计
```

**不允许的调用**：`React → Playwright page.click()`、`AI Provider → SendExecutor`、`Web UI → Browser Context`。原生 UI 只请求 Supervisor 执行符合授权和数据状态的业务命令。

## 17.2 推荐 IPC 合同

```ts
interface WorkbenchApi {
  getInbox(input: InboxQuery): Promise<InboxPage>;
  getThread(input: {accountId: string; eventId: string}): Promise<ThreadDetail>;
  claimHuman(input: {
    accountId: string; channel: Channel; targetKey: string;
    expectedGeneration: number; operatorId: string;
  }): Promise<{ownershipGeneration: number; leaseExpiresAt: string}>;
  renewHuman(input: {targetKey: string; ownershipGeneration: number}): Promise<void>;
  releaseHuman(input: {targetKey: string; ownershipGeneration: number}): Promise<void>;
  saveDraft(input: {
    draftId: string; expectedVersion: number; text: string;
  }): Promise<{draftVersion: number}>;
  generateSuggestion(input: {eventId: string; draftVersion: number}): Promise<ReplyDraft>;
  submitManualSend(input: WorkbenchSendCommand): Promise<{
    intentId: string;
    state: 'QUEUED' | 'PREFLIGHT' | 'SENDING' | 'BLOCKED' | 'UNCERTAIN';
  }>;
  getSendResult(input: {intentId: string}): Promise<DeliveryResult>;
  reconcileUncertain(input: {
    intentId: string; operatorId: string;
    decision: 'READ_ONLY_VERIFY' | 'MARK_CONFIRMED' | 'MARK_NOT_SENT';
    evidenceRef: string;
  }): Promise<void>;
}
```

说明：以上是产品应用层的拟定协议，代码接口实际落地需结合现有契约包和 Zod Schema；`MARK_NOT_SENT` 需要人为证据支持，绝不能因读取不到历史记录就推定未发送。所有命令必须校验操作员真实会话身份，不能信任前端自行传入的 `operatorId`。

## 17.3 `submitManualSend` 核心伪代码

```ts
async function submitManualSend(command: WorkbenchSendCommand) {
  const operator = requireAuthenticatedOperator();
  assertPermission(operator, command.accountId, 'SEND');
  const existing = await store.findByCommandId(command.commandId);
  if (existing) return existing; // 防客户端重复提交，不重复发送

  const thread = await store.getThread(command.accountId, command.targetKey);
  assertEqual(command.expectedThreadVersion, thread.version);
  assertEqual(command.ownershipGeneration, thread.ownershipGeneration);
  assertHumanOwner(thread, operator.id);
  assertDraftVersion(command.draftId, command.draftVersion, command.text);
  assertAccountAndChannelCapability(command.accountId, command.channel);
  assertNoActiveOrUncertainIntent(command.accountId, command.eventId);

  // 原子创建；唯一性错误代表已提交，不得再次入队。
  const intent = await store.insertSendIntentAtomically(command, operator.id);
  return queue.enqueue(intent.id); // 排队后执行时仍重新校验
}

async function dispatchOnce(intentId: string) {
  const intent = await store.getSendIntent(intentId);
  await accountActor.withExclusiveSendLock(intent.accountId, async () => {
    await verifyOwnerAndVersionsAgain(intent);
    await adapter.verifyAccountAndTargetAgain(intent);
    await store.persistPossibleSendAttempt(intent.id);
    // 一旦写入 possible-attempt，即使进程崩溃也禁止自动再点击。
    await adapter.clickSendOnce(intent);
    await receiptVerifier.verifyOrFreeze(intent.id);
  });
}
```

## 17.4 SQLite 迁移草案

```sql
CREATE TABLE IF NOT EXISTS thread_ownership (
  account_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  target_key TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  operator_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  PRIMARY KEY (account_id, channel, target_key)
);

CREATE TABLE IF NOT EXISTS manual_send_commands (
  command_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  event_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  draft_version INTEGER NOT NULL,
  ownership_generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  intent_id TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_send_intent
ON manual_send_commands (intent_id)
WHERE intent_id IS NOT NULL;
```

与已有 `send_intents`、`send_attempts` 和 `delivery_receipts` 做外键及事务整合；上线前还要实现针对同一来源事件的有效发送意图唯一性约束，确保人工和 AI 之间的冲突被数据库约束兜底。

## 17.5 UI 状态映射

| 事件状态 | 编辑框 | 主按钮 | 辅助动作 |
|---|---|---|---|
| `NEEDS_REPLY`、目标强确认 | 对话框内可编辑，自动接管及保存 | `发送` | AI 建议、关闭并保留草稿 |
| `NEEDS_TARGET_REVIEW` | 可编辑 | 禁用：目标待确认 | 打开原网页，核对目标 |
| `DRAFT_SAVING` | 可编辑 | 禁用：保存中 | 恢复草稿、查看历史 |
| `SENDING_QUEUED` | 只读快照 | 禁用：排队中 | 查看队列和超时 |
| `SENDING` | 只读快照 | 禁用：发送中 | 查看进度，不能重复发送 |
| `SENT_VERIFIED` | 保留历史 | 已确认 | 新事件出现时再开启编辑 |
| `SEND_UNCERTAIN` | 保留历史 | 禁用：待核实 | 只读回查、人工结案 |
| `ACCOUNT_BLOCKED` | 可编辑草稿 | 禁用：账号异常 | 人工验证、查看原网页 |
| `OTHER_OPERATOR_OWNS` | 只读 | 禁用：由他人接管 | 查看接管者、请求移交 |

用户按快捷键与点击按钮共用一次性 `commandId`，前端使用稳定指令 ID 防止重复 IPC。UI 状态只能反映 Supervisor 已确认的业务状态，不能自行推断送达。

## 17.6 自动核验编排合同

Supervisor 负责正常流程的检查、回读和补证，前端展示状态和异常，不承担通过人工点击串联技术步骤的责任。检查任务绑定账号、通道、准确目标、草稿或意图版本，复用 ProfileOwner、AccountActor、适配器和唯一 SendCoordinator。

- 账号连接后自动核验能力；映射或浏览器变化使资格失效时，系统按已授权范围重新检查。成功后更新能力，失败时保留具体原因，不要求用户进入开发者 CLI 或退出工作台完成校准。
- 打开人工接管对话框时自动获取租约，编辑期间自动续期及保存草稿；发送命令先确认本次全文对应的持久版本，再生成绑定批准，不要求前端另弹确认框。切换目标、人工暂停或代际变化立即使旧检查失效；迟到结果不能覆盖新目标或新人稿，自动保存未完成时不能提交旧稿。关闭对话框保留草稿，不隐式恢复 AI 外发。
- 发送命令触发预检和回读。已存意图的命令只可继续观察，不可重新提交。只读补证使用独立、持久的核验任务，绑定原意图与证据边界，设置次数及超时上限。
- 重连和重启自动恢复状态及未完成的只读核验，任何新发送仍经当前授权和唯一意图约束。旧错误保留，后续证据追加；界面读取最新核验结论，不把追加证明伪装成旧回执当时成功。
- 自动模式的策略批准与人工批准分别记录来源，并绑定准确目标、全文和版本。模式切换、规则变化、人工接管及预算耗尽会撤销尚未提交的旧批准。

T39 至 T44 和 W16 是正式版新增验收要求，尚未实现或验证，不能计入本期最小客户端已通过项目。

---

# 18. V2.1 研发任务拆分与交付验收清单

## 18.1 按优先级拆分开发工单

| 编号 | 优先级 | 工单 | 关键交付 |
|---|---|---|---|
| W01 | P0 | 更新产品命名及仓库命名 | `Inbora` 品牌、窗口标题、安装包、配置目录、文档统一 |
| W02 | P0 | 双通道 PoC 验证 | 评论通知及私信各自发送回读，记录平台版本与失败模式 |
| W03 | P0 | 账号和目标强校验 | 当前账号、会话/父评论、作品链接、身份歧义门禁 |
| W04 | P0 | 人工接管管理器 | `thread_ownership`、代际租约、领取/释放/移交 |
| W05 | P0 | 统一草稿存储与版本检查 | 人工输入、AI 建议、编辑历史、冲突保护 |
| W06 | P0 | 唯一发送协调器 | `commandId` 幂等、事务落库、单次点击、回执冻结 |
| W07 | P0 | 会话详情和人工接管对话框 | 私信及评论双布局、准确目标与上下文、输入后发送、自动接管及保存、冲突保稿；按 T40 验收 |
| W08 | P0 | 工作台人工私信发送 | 仅授权账号、正确会话、正确文本、可回读确认 |
| W09 | P0 | 工作台人工评论发送 | 原评论父对象核对，保证楼中楼且可回读 |
| W10 | P0 | 安全与审计 | 发送权限、操作员、草稿版本、接管与未知结果记录 |
| W11 | P1 | AI 辅助交互 | 一键建议、引用修改、审批及人工发送 |
| W12 | P1 | 浏览器池与网络绑定 | HOT/WARM/COLD、固定网络出口、异常停发 |
| W13 | P1 | 运营看板 | 待人工原因、人工已确认、AI 采纳率、Token 与成本 |
| W14 | P1 | 安装包与灾难恢复 | Windows 打包、Sidecar 生命周期、SQLite 备份、异常重启 |
| W15 | P2 | 多节点 Runner | 单机指标达到瓶颈后按需立项 |
| W16 | P0 | 正常流程自动核验编排 | 自动连接与资格检查、编辑接管续期、预检回读、有界只读补证及重启恢复；按 T39 至 T44 验收 |

## 18.2 验收顺序

**阶段 A，Mock 完整交互：** HTML 夹具和伪适配器模拟评论及私信，证明人工领取、输入、点击、排队、发送成功/未知、版本冲突、AI 竞争等状态能从工作台准确呈现。不得使用 Mock 通过来宣称平台实机可用。

**阶段 B，单账号 Headed：** 用本人授权测试账号，对测试者主动发送的私信与本人视频测试评论分别人工回复。记录消息源、账号身份、页面目标、单次点击和发送回读证据，做到无串错目标。

**阶段 C，单账号 Headless：** 在相同浏览器通道、受测版本和正常账号条件下验证；失败则记录原因并采用 Headed 兼容策略，不尝试规避安全措施。

**阶段 D，多账号灰度：** 按 3、10、20、30 账号依次测试工作台人工接管、排队调度、权限隔离、网络绑定、冷账号唤醒及资源压力。

## 18.3 人工工作台的 GO 条件

- 已验证的两条通道分别支持在 Inbora 内完整处理至少一条真实、可唯一定位的新事件，回复实际发送至目标对象且可回读。**评论和私信分别判定 GO，不相互代替。**
- 真实人工发送入口没有绕过账号身份校验、目标强匹配、权限、发送锁和审计。
- 在 T23 至 T38 等测试中，人工与 AI 双发 0、跨账号发送 0、重复指令导致的二次点击 0、未知状态自动重试 0。
- 操作员即使不打开抖音网页，也能准确识别未处理、排队中、已确认、结果待核实；页面无法唯一定位目标时会获得明确的人工跳转指引。
- 工作台对未通过的平台能力不开放实际发送按钮，所有已知限制可从运行日志追溯。

---

# 19. 技术依据与参考链接

以下均为英文域名的官方技术文档或 GitHub 公共代码仓库。平台网页的真实交互能力仍以用户自有测试账号实际操作结果为准，技术文档不等于抖音官方行为授权。

1. Playwright BrowserType，持久化 Context、代理、Edge 浏览器通道：https://playwright.dev/docs/api/class-browsertype
2. Playwright Network，浏览器或 Context 级代理：https://playwright.dev/docs/network
3. Playwright Browsers，Chromium 和新无头模式说明：https://playwright.dev/docs/browsers
4. Tauri v2 Node.js Sidecar 教程：https://v2.tauri.app/learn/sidecar-nodejs/
5. Tauri Shell Plugin API 和 Sidecar 权限：https://v2.tauri.app/reference/javascript/shell/
6. SQLite WAL 官方说明：https://www.sqlite.org/wal.html
7. LockyBee/dsh-douyin-agent：https://github.com/LockyBee/dsh-douyin-agent
8. JMY2003/a-skill-to-do-anything-in-douyin：https://github.com/JMY2003/a-skill-to-do-anything-in-douyin
9. JMY 通知操作说明：https://github.com/JMY2003/a-skill-to-do-anything-in-douyin/blob/main/references/operation-plans.md

---

**文件版本：V2.1 | 编制日期：2026-11-06 | 品牌：Inbora | 增补：工作台人工发送、人工接管、AI 互斥、统一外发与完整验收。**
