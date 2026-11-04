# 抖音个人号智能客服 Agent
## 单账号双通道 PoC 开发实施方案 V1.0

**编制日期：2026-11-04**  
**实施平台：Windows 11，普通抖音个人号，网页版**  
**验证对象：1 个本人控制的抖音账号，2 条独立业务通道**  
**技术内核：Node.js + TypeScript + Playwright + SQLite**  
**后续产品形态：Tauri v2 + React 工作台**  
**结论：建议立即开展受控 PoC，单号真实收发通过后再进入工作台和多账号开发。**

> 本文件是供开发团队直接执行的工程方案，属于设计与验收规范。文中的命令、接口和项目文件属于拟实现内容，目前没有宣称已在真实账号上跑通。尤其是「网页版通知中指定评论的回复」和「无头模式兼容」仍需实机验证。

---

## 0. 首先确认验证目标

### 0.1 本 PoC 要解决的两个问题

**通道 A，评论通知：** 使用 Playwright 从抖音网页版顶部导航的「通知」入口，获取本人作品收到的新评论通知，确定目标评论，生成 AI 草稿，经人工确认后准确回复到该评论下，并验证结果。

**通道 B，私信：** 从网页版独立的「消息」入口或聊天页面读取新私信，识别正确发送人及会话，生成 AI 草稿，经人工确认后发送并验证结果。

两条通道采用**同一账号的独立浏览器 Profile，分别拥有自己的 Page**。通知页需要跳转原作品定位评论时，允许在评论通道内导航；数据发现的唯一入口仍是顶部通知，PoC 不进行全量视频评论扫描。

### 0.2 明确排除项

1. 不引入抖店、飞鸽、订单、售后和电商店铺接口。
2. 不依赖 `item.comment`、`ma.item.comment`、私有抖音协议或第三方 Cookie 签名服务。
3. 不实施批量主动私信、主动评论陌生人的视频、自动关注、验证码破解和平台访问控制绕过。
4. 不建设完整 Tauri 工作台、30 账号调度、复杂 RAG、语音或视频理解系统。这些留待 PoC 成功后。
5. PoC 不承诺所有类型的通知、全部历史评论和未打开浏览器期间的实时事件均能完整收集。

### 0.3 判定逻辑

| 判定 | 定义 | 后续行动 |
| --- | --- | --- |
| **GO** | 通知目标识别、评论回复、私信回复和发送回读全部通过，连续重启无错发、无重复 | 进入 1 至 3 账号 MVP |
| **CONDITIONAL GO** | 私信可行；评论可读取但无法可靠发送，或 Headless 不稳定 | 保留 AI 草稿、人工跳转回复或可见浏览器模式，先交付辅助客服版 |
| **NO GO** | 页面无法可靠识别账号及目标，或者网页要求停止自动化，发送故障不可控 | 停止自动发送开发，仅保留人工辅助和本地 AI 草稿能力 |

---

## 1. 技术架构与分层

### 1.1 先做纯 Node 内核，后接 Tauri

PoC 先采用命令行执行器及简易本地调试页面。理由：最大风险来自抖音网页版交互，先验证真实收发链路可以缩短问题定位路径。等两条通道通过，再把 Node 内核作为 Tauri sidecar 集成到最终桌面 UI。

```text
                   [本地 CLI / 简易调试页面]
                                |
                        [PoC Controller]
                                |
              +-----------------+------------------+
              |                                    |
      [NotificationAdapter]                [DirectMessageAdapter]
      顶部「通知」入口                     私信「消息」入口
              |                                    |
      [Page: notification]                   [Page: dm]
              +-----------------+------------------+
                                |
                   [Account Actor / UI Mutex]
                                |
                    [Browser Profile Owner]
                                |
              [Playwright Persistent Context]
                                |
                         [www.douyin.com]

                 [SQLite: 观察/事件/草稿/收据]
                                |
                         [AI Draft Service]
                                |
                    [人工审核 + 一次性发送]
```

**设计约束：**

- 一个 `account_id` 对应一份专属 `userDataDir`，同一时刻由一个 Worker 持有。`launchPersistentContext` 创建的持久 Context 关联自己的浏览器实例。
- `notificationPage`、`dmPage` 分开。两个 Page 共享该账号的登录状态，彼此禁止抢占对方导航。
- 所有会改变浏览器状态的操作，包括切会话、点击评论、输入草稿、发送，均经账号级 `AccountActor` 协调；同账号发送并发固定为 1。
- 读取页面可以分时执行，不能假定网站在两个标签之间完全隔离状态。
- 发送与确认必须在单一业务事务内，不能依赖前端按钮状态作为事实来源。

### 1.2 组件职责

| 组件 | 技术 | 职责 |
| --- | --- | --- |
| `BrowserProfileOwner` | Playwright | 启动、关闭和独占登录资料；登录状态、验证码检测 |
| `NotificationAdapter` | Playwright + TS | 打开顶部通知、解析新评论通知、过滤非评论提醒 |
| `DirectMessageAdapter` | Playwright + TS | 读取私信会话、新消息及历史，选择准确的会话 |
| `TargetResolver` | TS | 校验账号、作品、评论或私信会话身份，标记目标可信度 |
| `EventStore` | SQLite | 通知和私信事件持久化、去重、水位及审计 |
| `DraftService` | 模型 API | 生成短文本回复，支持 Mock 和真实供应商两种模式 |
| `ApprovalController` | 本地命令/API | 人工批准、修改或拒绝草稿 |
| `SendCoordinator` | TS + SQLite | 发送前校验、写入点击意图、单次提交、未知结果冻结 |
| `EvidenceRecorder` | Playwright | 按需保留脱敏的页面证据与操作诊断 |

---

## 2. 运行环境与依赖

### 2.1 首选开发环境

- Windows 11，建议使用最新版受支持的 Microsoft Edge，固定一个测试版本并记录完整版本号。
- Node.js 使用安装时仍受支持的 LTS 版本；项目提交锁文件以固定 Playwright、SQLite 驱动和测试工具版本。
- 包管理器 `pnpm`；语言 TypeScript 严格模式，ESM 项目。
- `playwright`：使用 `channel: 'msedge'` 先完成可见模式验证，再测试 `headless: true`。
- `better-sqlite3`：实现 PoC 数据库；后续打包为 sidecar 时需处理原生模块及 Node ABI，作为打包专项验收。
- `zod`：校验采集事件、命令输入和持久化记录。
- `vitest`：纯函数及状态机测试；Playwright 用于页面夹具与实机端到端验证。
- `pino` 或同类 JSON 日志库：记录结构化事件，默认关闭敏感字段。

### 2.2 本机安全目录

建议采用当前 Windows 用户数据目录，PoC 开发时允许临时落在 `.local/`，但**必须写入 `.gitignore`**：

```text
%LOCALAPPDATA%/DouyinAgentPoc/
  profiles/account_001/         # 浏览器登录态，敏感资料
  db/poc.sqlite                 # 任务、草稿、收据
  evidence/                     # 受控采集的调试证据
  logs/                         # 脱敏结构化日志
```

禁止把真实 Cookie、完整 Profile、AI Key 和私人消息原文写入仓库或自动上传外部日志。API Key 放入系统凭据存储或开发机专用安全注入方式，PoC 初期可完全用 Mock 模型避免配置 Key。

---

## 3. 建议项目目录

```text
douyin-agent-poc/
  package.json
  pnpm-lock.yaml
  tsconfig.json
  vitest.config.ts
  .env.example
  .gitignore
  README.md
  docs/
    POC-SPEC.md
    TEST-MATRIX.md
    SITE-OBSERVATION.md
    SELECTOR-CHANGELOG.md
    INCIDENTS.md
  src/
    cli.ts
    config/
      schema.ts
    browser/
      profile-owner.ts
      browser-mode.ts
      login-state.ts
      page-registry.ts
      account-actor.ts
    adapters/
      notification/
        notification-adapter.ts
        notification-locators.ts
        notification-parser.ts
        comment-target-resolver.ts
        comment-reply-executor.ts
      direct-message/
        dm-adapter.ts
        dm-locators.ts
        dm-parser.ts
        conversation-verifier.ts
        dm-reply-executor.ts
    core/
      contracts.ts
      event-normalizer.ts
      dedup.ts
      cursor-store.ts
      task-state-machine.ts
      send-coordinator.ts
      receipt-verifier.ts
    ai/
      draft-service.ts
      mock-provider.ts
      real-provider.ts
      prompt-builder.ts
    storage/
      sqlite.ts
      schema.sql
      repositories.ts
    observability/
      audit.ts
      evidence.ts
      metrics.ts
    ui/
      debug-server.ts           # 可选，本机只读调试页
  tests/
    fixtures/
      notification-example.html
      dm-example.html
    unit/
      notification-parser.test.ts
      dm-parser.test.ts
      dedup.test.ts
      send-coordinator.test.ts
      identity-guard.test.ts
    integration/
      adapter-fixtures.test.ts
      restart-recovery.test.ts
    manual/
      real-account-checklist.md
```

**实现原则：** 解析器、事件规范化、状态机和发送门禁尽量写成纯函数，可通过 HTML 夹具/伪对象测试。真实 Playwright Page 只存在于适配器层，避免把 DOM 选择器散落到业务逻辑中。

---

## 4. 先做登录、Profile 和双 Page

### 4.1 浏览器生命周期

1. 建立专属 Profile 目录与 Owner 锁。
2. `launchPersistentContext(profileDir, { channel: 'msedge', headless: false })`。
3. 创建两个专用 Page，分别标记为 `notification` 与 `dm`。
4. 用通知 Page 打开 `https://www.douyin.com/`，通过顶部「通知」打开弹层；**禁止直接假定 `/notification` 是有效独立路由**。
5. 用 DM Page 按实际网页导航进入私信列表，记录经过验证的路由与页面结构。
6. 人工扫码登录；两个 Page 重新检查当前账号身份和登录状态。
7. 关闭浏览器，再启动相同 Profile，观察是否恢复登录态。
8. 用同一个 Profile 依次测试 Headless，绝不同时启动两个实例占用相同目录。

### 4.2 浏览器入口示意

```ts
import path from 'node:path';
import { chromium } from 'playwright';

const accountId = 'account_001';
const profileDir = path.resolve('.local/profiles', accountId);

const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'msedge',
  headless: false,  // 首轮验证必须可见
  locale: 'zh-CN',
});

const notificationPage = await context.newPage();
const dmPage = await context.newPage();

await notificationPage.goto('https://www.douyin.com/', {
  waitUntil: 'domcontentloaded',
});

// 后续通过页面实际观察结果定位「通知」和「消息」入口。
// 不在 PoC 设计稿里预设尚未证实的 CSS 类名。
```

**注意：** Playwright 的 `launchPersistentContext` 只返回该浏览器的持久 Context，关闭 Context 会结束对应浏览器。Microsoft Edge 新无头模式和默认 Chromium headless shell 存在行为差异，必须分别记录使用的浏览器通道与版本。官方依据：

- https://playwright.dev/docs/api/class-browsertype
- https://playwright.dev/docs/browsers

---

## 5. 通道 A：顶部通知触发的指定评论回复

### 5.1 业务流水线

```text
OPEN_NOTIFICATION_PANEL
  -> READ_VISIBLE_NOTIFICATIONS
  -> FILTER_COMMENT_EVENTS
  -> NORMALIZE_AND_DEDUP
  -> RESOLVE_COMMENT_TARGET
  -> BUILD_DRAFT
  -> HUMAN_APPROVAL
  -> PREFLIGHT_ACCOUNT_AND_TARGET
  -> PERSIST_CLICK_INTENT
  -> CLICK_REPLY_ONCE
  -> VERIFY_ORIGINAL_COMMENT_REPLY
  -> CONFIRMED / UNCERTAIN / FAILED_BEFORE_CLICK
```

### 5.2 核心步骤

**A1. 打开通知：** 通过顶部导航交互打开通知弹层，验证弹层可见且属于当前账号。读取时记录通知总条数、已加载条数、时间范围、加载更多按钮和可见滚动容器。

**A2. 提取候选事件：** 只保留「别人评论我的视频」「别人回复我相关评论」等符合产品目标的事件。点赞、关注、系统消息和自己发布的互动均剔除。通知具体分类以真实网页可见字段为准。

**A3. 保存事件快照：** 把通知文本、可见时间、作品链接、评论跳转链接、作者标识等已观察字段持久化；对于未展示的 ID 保持 `null`，禁止凭昵称或时间推断平台 ID。

**A4. 解析目标身份：** 优先使用网页确实暴露的稳定评论标识、作品标识、账号标识或跳转定位信息。若只有昵称与正文，标记为 `AMBIGUOUS`，禁止自动发送，允许人工查看。

**A5. 回复路径选择：**

- 路径 1：通知弹层有明确指向目标评论的「回复」操作，直接在该通道完成。
- 路径 2：通知弹层只提供跳转。使用评论通道 Page 导航至目标作品的具体评论位置，核对原评论后回复。
- 路径 3：跳转丢失目标或无法核对唯一评论，保留任务并交给人工。

**A6. 发送前核验：** 校验当前登录账号、目标作品、原评论发送者、原评论正文及回复输入框归属。若页面结构不支持可靠确认，就终止操作。

**A7. 发送并确认：** 输入批准后的草稿。点击发送前写入持久化 `CLICK_INTENT`；只执行一次点击；随后读取同一条目标评论下新出现的我方回复，并保存可观察的证据。审核中、页面超时、跳转、内容消失均不可直接记为成功。

### 5.3 这个通道最需要验证的六个事实

| 编号 | 要证实的能力 | 不成立时如何处理 |
| --- | --- | --- |
| C01 | 顶部「通知」能显示评论提醒 | 通知采集 PoC 失败，暂停自动化开发 |
| C02 | 能区分对本人作品的评论与其他互动 | 限制为人工确认通知 |
| C03 | 能打开对应原评论或唯一定位其回复区 | 转为人工跳转，不启用自动发送 |
| C04 | 能在原评论下形成楼中楼回复 | 评论通道只能做 AI 草稿 |
| C05 | 能回读并确认回复属于准确原评论 | 保持 `UNCERTAIN`，禁止自动重发 |
| C06 | 刷新、翻页后仍能恢复未处理任务 | 用 SQLite 水位和本地任务补偿，承认历史回填限制 |

### 5.4 防重复与漏读

- 通知上的红点消失、通知已读，都不得被视作业务任务已完成。
- 对新通知做快照增量处理。第一次采集可以先建立基线，避免历史记录全部触发自动回复。
- 主去重键优先使用 `accountId + channel + platformEventId`；只有弱证据时暂时用复合指纹辅助匹配，遇到碰撞进入人工核对。
- **不同用户发送相同评论、同一用户跨视频发送相同评论，必须形成两个独立任务。**
- 避免每次轮询都滚动全部通知。分页、截断和通知保留期限需要在真实页面中测量并记入验收报告。

---

## 6. 通道 B：私信消息读取及回复

### 6.1 业务流水线

```text
OPEN_DM_PAGE
  -> VERIFY_OWN_ACCOUNT
  -> READ_CONVERSATION_LIST
  -> READ_INCOMING_MESSAGES
  -> ESTABLISH_OR_ADVANCE_CURSOR
  -> NORMALIZE_AND_DEDUP
  -> BUILD_DRAFT_WITH_CONTEXT
  -> HUMAN_APPROVAL
  -> PREFLIGHT_CONVERSATION
  -> PERSIST_CLICK_INTENT
  -> SEND_ONCE
  -> VERIFY_OUTGOING_MESSAGE
  -> CONFIRMED / UNCERTAIN / FAILED_BEFORE_CLICK
```

### 6.2 必须实现的行为

1. **会话身份**：优先取平台稳定会话 ID；缺失时使用多字段交叉验证。不能只靠昵称或头像选择收件人。
2. **历史基线**：第一次启动只读入可见历史并建立水位，测试时用一条真实的新消息触发任务。
3. **发送方区分**：只对对方的新消息生成回复；对我方发出的消息、系统提示、撤回通知和无法确认发送方的条目不发。
4. **连续消息处理**：测试者短时间连发三条消息，PoC 可合并为一条草稿，但必须保留原始三条事件，不能丢失信息。
5. **AI 上下文**：最多读取有限数量的最近已确认消息，按当前会话隔离；网页上的消息内容只是输入数据，不能获得控制浏览器或泄露密钥的权限。
6. **再次核验**：在提交前重新确认左侧活跃会话、右侧标题、历史消息水位和批准文本。任何冲突停止发送。
7. **结果回读**：优先使用可靠的我方新消息标识；如网页只能展示文本，则需要结合点击前历史水位、会话身份和发送后观察进行审慎判断；无法确认就进入 `UNCERTAIN`。
8. **人工接管**：测试人员随时可暂停单个会话发送，同时保留草稿及待处理任务。

### 6.3 禁止简化的危险做法

- 不使用 `昵称包含目标昵称` 作为放行条件。
- 不在仅发现输入框时就认定会话已经切换完成。
- 不在按 Enter 后立即将任务标记为 `CONFIRMED`。
- 不因 AI 超时而清理已经打开的会话数据。
- 不根据同一条消息正文永久去重，否则对方第二天发送相同内容可能被误判。

---

## 7. 统一事件协议与模块接口

### 7.1 统一数据契约

```ts
type Channel = 'COMMENT_NOTIFICATION' | 'DIRECT_MESSAGE';
type TargetTrust = 'STRONG' | 'WEAK' | 'AMBIGUOUS';

type InboundEvent = {
  id: string;                 // 本地 UUID
  accountId: string;          // PoC 固定 account_001
  channel: Channel;
  observedAt: string;
  platformEventId: string | null;
  actorId: string | null;
  actorName: string | null;
  text: string;
  videoId?: string | null;
  commentId?: string | null;
  conversationId?: string | null;
  targetTrust: TargetTrust;
  sourceEvidenceId: string;
};

type ReplyDraft = {
  id: string;
  eventId: string;
  text: string;
  modelId: string;
  status: 'DRAFT' | 'APPROVED' | 'REJECTED';
};

type DeliveryResult =
  | { status: 'CONFIRMED'; receiptId: string }
  | { status: 'FAILED_BEFORE_CLICK'; reason: string }
  | { status: 'UNCERTAIN'; reason: string; receiptId: string };
```

`sourceEvidenceId` 指向本地最小必要记录。PoC 不要求保留所有通知和私信原文，记录期限应可配置。

### 7.2 双通道接口

```ts
interface InboundAdapter {
  observe(): Promise<InboundEvent[]>;
  inspectTarget(event: InboundEvent): Promise<{
    trust: TargetTrust;
    accountVerified: boolean;
    targetVerified: boolean;
    reason?: string;
  }>;
  prepareReply(event: InboundEvent, text: string): Promise<{
    ready: boolean;
    preflightDigest?: string;
    reason?: string;
  }>;
  sendOnce(event: InboundEvent, draft: ReplyDraft): Promise<DeliveryResult>;
}
```

**接口边界：** `sendOnce()` 只接受已经人工批准、通过预检查、持有当前账号发送锁的任务。发送过程中不得悄悄切到其他账号或其他会话。

---

## 8. SQLite 设计和状态机

### 8.1 最小表结构

| 表 | 关键字段 | 用途 |
| --- | --- | --- |
| `accounts` | id、profile_dir、browser_mode、login_state | 唯一测试账号与 Profile 状态 |
| `observations` | id、account_id、channel、observed_at、evidence_ref | 采集轮次和来源证据 |
| `inbound_events` | id、account_id、channel、source_key、target_trust、payload、status | 事件、去重和处理状态 |
| `cursors` | account_id、channel、cursor_data、updated_at | 通知与私信各自独立的水位 |
| `reply_drafts` | id、event_id、text、model、status、approved_at | AI 草稿和人工审批 |
| `send_intents` | id、event_id、draft_id、target_digest、status、attempt_started_at | 唯一发送意图和点击前记录 |
| `delivery_receipts` | id、send_intent_id、result、proof_ref、verified_at | 发送结果核对 |
| `audit_events` | id、time、event_type、entity_id、detail_redacted | 审计与异常诊断 |

建议为 `inbound_events(account_id, channel, source_key)` 设置唯一索引。无平台稳定 ID 的 `source_key` 应带上足够的来源维度并设置冲突审查，不能强行把不同真实事件合并。

### 8.2 任务状态机

```text
OBSERVED
   |
TARGET_RESOLVED
   |
DEDUPE_CHECKED
   |
DRAFT_READY
   |
AWAITING_APPROVAL
   |
APPROVED
   |
PRE_SEND_VERIFIED
   |
CLICK_INTENT_RECORDED
   |
SINGLE_SEND_ATTEMPT
   +------> CONFIRMED
   +------> UNCERTAIN ---> MANUAL_REVIEW
   +------> FAILED_BEFORE_CLICK
```

**写入顺序非常重要：** 真正触发可能外发的点击前，必须先将对应 `CLICK_INTENT_RECORDED` 及目标核验摘要持久化。若程序在点击前后任何时刻崩溃，重启后这条记录一律先进入核对队列，确认没有发出后才能人工决定是否重试。安全性优先于自动恢复速度。

### 8.3 全局约束

- 单个事件同时最多一个有效发送意图。
- 一个账号同一时刻最多一个发送动作。
- 任务处于 `UNCERTAIN` 时，禁止针对同一目标自动再次发送。
- 审核过的草稿若目标消息发生变化，重新要求人工审核。
- SQLite 采用 WAL 与事务；任何文件写入异常均进入阻断状态，不静默重置收据或消息水位。

---

## 9. AI 草稿和 Token 控制

**优先交付 Mock 模型：** 第一轮测试无需实际模型。使用一个确定性的假回复生成器，例如根据评论或私信返回固定短句，先证实页面事件处理、草稿审批、发送和回读可靠。

Mock 通过后接入实际模型 API：

- 评论：输入当前评论、可信作品标题/可见上下文、当前账号简短人设及回复规则。
- 私信：输入本轮新消息、最近少量同会话历史、当前账号规则和最多数条相关知识。
- 回复结果：只接受纯文本、严格长度上限；过滤空串、重复内容、可能涉及敏感数据的输出。
- 涉及投诉、隐私、金钱、身份验证等情形强制人工处理。
- 所有提示词材料采用业务数据隔离，禁止把网页用户消息视为系统或工具指令。

### 9.1 消耗预算

Playwright 的页面读取和交互本身没有模型 Token 费用。PoC 建议限制为最多 **50 次真实模型草稿调用** 和 **20 次受控发送验证**，超限需手动解锁；这只是测试预算，绝不代表平台允许的发送频率。

举例：50 次模型调用，每次 1,200 输入 Token、120 输出 Token，合计约 60,000 输入和 6,000 输出 Token。实际成本按选定 API 账单单价计算。记录 `input_tokens`、`output_tokens`、模型名称、耗时、错误与估算费用，不把网页轮询次数算成 Token。

---

## 10. 具体开发安排与交付验收

### P0：环境与登录隔离

**任务：** 建仓库、严格 TS、pnpm 锁文件、Playwright 浏览器管理、独占 Profile 锁、扫码登录、重启恢复、双 Page 创建、基础诊断。

**交付：** `poc login --headed`、`poc status` 等拟实现 CLI 命令，登录状态报告，浏览器生命周期测试。

**通过标准：** 手动登录一次后重启仍可用；两个 Page 显示同一账户；同一 Profile 第二次启动被阻止；登录过期提示人工处理。

### P1：通知只读 PoC

**任务：** 打开顶部通知弹层、定位通知滚动容器、提取评论候选、过滤其他通知、生成稳定事件记录、保存采集水位。

**交付：** `poc observe notifications`、通知快照摘要、若干脱敏 HTML 夹具、解析器测试。

**通过标准：** 测试者发布真实新评论，工作流能够识别并单独保存；重复读取不产生重复任务；相同正文来自不同目标仍独立。

### P2：私信只读 PoC

**任务：** 独立 DM Page、会话读取、发送方区分、历史基线、增量消息、同会话短消息合并、会话身份防错。

**交付：** `poc observe dm`、会话与消息快照摘要、解析器及状态机测试。

**通过标准：** 测试者发送新私信后可被识别；不会将我方消息当作对方消息；不会把已有历史反复变成待回复任务。

### P3：草稿与发送收据

**任务：** Mock 草稿、人工审批、目标预检查、发送协调器、点击前记录、成功/未知状态核对、重启恢复。

**交付：** `poc draft`、`poc approve`、`poc send-once`、`poc review-uncertain`，以及可审计的发送记录。

**通过标准：** 真实私信和真实评论均能准确回复指定对象；至少一种由真实浏览器中断触发的未知状态能够阻断重复发送。

### P4：Headless A/B 与小规模稳定性

**任务：** 在同一测试账号上串行比较 `headless: false` 和 `headless: true`，测量页面差异、登录复用、通知加载、DM 观察、目标校验、可见模式接管。

**交付：** 浏览器兼容性矩阵、异常截图摘要、内存和 CPU 统计、失败定位报告。

**通过标准：** 可以明确指出 Headless 是否满足两条通道的全部必要操作；无法满足时有可见模式回退，不能通过绕过验证码或改变浏览器身份欺骗安全检查来强行通过。

### P5：Tauri 集成评审

仅在 P0 至 P4 达到 GO 后启动。交付 sidecar 进程协议、前端状态订阅、UI 层调用约定、打包路径和安全权限设计。**本阶段先做接入评审，不建设完整工作台。**

### 推荐工期

| 阶段 | 参考人日 | 主要不确定性 |
| --- | ---: | --- |
| P0 环境、登录、双 Page | 1 至 2 | Profile 和登录恢复 |
| P1 通知只读 | 2 至 4 | 通知 DOM、分页、跳转标识 |
| P2 私信只读 | 1 至 3 | 会话身份与消息结构 |
| P3 两通道发送闭环 | 3 至 6 | 指定评论回复、回读证据 |
| P4 无头对照和稳定性 | 2 至 4 | 浏览器模式差异与平台限制 |
| **合计** | **9 至 19 人日** | **按熟悉 Playwright 的开发者估算，不构成工期保证** |

若 P1 发现无法从通知中定位原评论，立即先做评论发送可行性判断，再决定是否继续 P2 与后续投入。

---

## 11. 人工实机测试矩阵

| ID | 测试场景 | 通过标准 |
| --- | --- | --- |
| L01 | 首次有头扫码登录 | 两个 Page 均能确认对应本人账号 |
| L02 | 关闭浏览器再启动 | 登录资料恢复；若失效给出清晰提示 |
| L03 | 同 Profile 被两个进程同时启动 | 第二个被锁拒绝，不损坏 Profile |
| N01 | 外部测试者对本人视频新增评论 | 顶部通知中产生一个正确的新评论任务 |
| N02 | 同一评论被轮询 5 次 | 仅一个业务任务，保留多次观察记录 |
| N03 | 两人发表相同正文 | 两个任务，不错合并 |
| N04 | 点赞、关注和系统通知同时出现 | 被正确过滤，不触发评论回复 |
| N05 | 通知只能跳转视频 | 能定位唯一原评论，否则标为待人工 |
| N06 | 回复原评论 | 回复显示在准确原评论下，不误发为独立顶层评论 |
| N07 | 回复延迟显示或待审核 | 状态为未知或待核验，不立刻记成功 |
| D01 | 新私信到达 | 识别为对方发出的新消息，创建一个任务 |
| D02 | 三条短私信连续到达 | 允许合并草稿，完整保留三条消息 |
| D03 | 同一正文次日再次发送 | 新事件仍能正常处理 |
| D04 | 私信从 A 会话切换到 B 时延迟 | 目标核验不通过则禁止发送 |
| D05 | 私信发送 | 出现在准确会话中，读回后记为已确认 |
| S01 | 点击前模拟崩溃 | 有持久化意图，恢复后先核对再决定是否发送 |
| S02 | 点击后模拟页面超时 | 标为 `UNCERTAIN`，严禁自动重发 |
| S03 | 已审批草稿期间目标改变 | 重新预检查，必要时要求二次审核 |
| S04 | 收据 SQLite 损坏或不可写 | 停止发送，不重新初始化覆盖记录 |
| H01 | Headless 读取通知和 DM | 记录通过与失败的具体步骤及错误 |
| H02 | 触发验证码、需要扫码 | 阻断自动发送，切换人工可见模式 |
| H03 | 暂停人工接管 | 当前会话不再发生自动发送 |
| M01 | 关闭应用后恢复 | 待处理、待人工、未知态全部保留 |

### 11.1 必须留存的证据

每一项实机验收至少记录：测试时间、浏览器版本、运行模式、任务 ID、关键动作、结果、可复现步骤及经过脱敏处理的证据。禁止在报告中包含真实 Cookie、访问令牌、API Key 或未经同意的私人聊天正文。

### 11.2 通过标准不能偷换

- `DOM 找到按钮` ≠ `按钮可点击`。
- `点击已执行` ≠ `服务端接收`。
- `页面出现新文本` ≠ `证明发给正确的对象`。
- `通知已经变灰` ≠ `评论已经回复`。
- `单次单元测试通过` ≠ `真实账号长期稳定`。

---

## 12. 开源代码复用的明确范围

已经检查过的候选项目建议按以下顺序参考，避免把 Electron、Python 或非官方协议层完整搬入 PoC。

| 优先级 | 仓库 / 文件 | 当前价值 | 不可以直接假定的能力 |
| --- | --- | --- | --- |
| P0 | [JMY2003/a-skill-to-do-anything-in-douyin](https://github.com/JMY2003/a-skill-to-do-anything-in-douyin) 的 `scripts/douyin_web.mjs` | `notification` 操作展示了通过顶部入口打开面板并生成快照的思路 | 未证明通知触发的指定评论发送闭环 |
| P0 | [LockyBee/dsh-douyin-agent](https://github.com/LockyBee/dsh-douyin-agent) 的 `outbound-send.mjs`、`receipt-baseline.mjs`、`browser-host.mjs` | 发送锁、凭据、浏览器状态和未知结果保全 | 其公开评论逻辑重点针对在作品发表评论，需改造成回复评论 |
| P1 | [LockyBee/dsh-douyin-agent](https://github.com/LockyBee/dsh-douyin-agent) 的 `chat-browser.mjs`、身份相关模块 | 私信观察、身份校验与测试模式 | 需要脱离原项目的 DSH 宿主重构 |
| P1 | [crazyants/douyin-robot](https://github.com/crazyants/douyin-robot) 的 `src/douyin_chat.py`、`src/selectors.py` | 选择器分层、定位和消息读取参考 | Python 需要转换为 TS，真实页面改版可能失效 |
| P2 | [POKMJN/douyin-reply-assistant](https://github.com/POKMJN/douyin-reply-assistant) 的 `conversation-engine.cjs` 和消息队列测试 | 对话轮次、历史水位、防重复思想 | 运行主路径依赖 Electron，不可直接当作 Playwright 模块 |
| P3 | [Agying3/DMShoot](https://github.com/Agying3/DMShoot) 的消息模型与存储层 | 适配器生命周期和 SQLite 设计参考 | 抖音收发路径涉及非官方协议，PoC 不采用 |

**移植要求：** 只搬经过审查的单独函数和测试思路，给每项复用建立 `UPSTREAM.md` 记录仓库、具体源文件、提交 SHA 和移植修改。公开源码涉及许可证、第三方依赖和其他授权要求，准备分发时仍应完成合规检查。

---

## 13. 给开发者的任务分配清单

### 必须第一批完成

1. [ ] 初始化 TS + Node + pnpm 项目，并确保 `pnpm test` 与 `pnpm typecheck` 可执行。
2. [ ] 构建 `BrowserProfileOwner`，包含独占锁与退出资源回收。
3. [ ] 建立通知和私信两个专用 Page，完成人工扫码登录与身份核验。
4. [ ] 为真实网页建立 `SITE-OBSERVATION.md`，标注可证实的页面入口、交互与 DOM 特征。
5. [ ] 完成通知只读解析器和 3 种及以上通知类型的夹具测试。
6. [ ] 完成私信只读解析器、历史基线及发送方测试。
7. [ ] 完成 SQLite 事件库及去重约束。
8. [ ] 使用 Mock AI 生成评论和私信草稿。
9. [ ] 实现人工审批、发送前目标核验、点击前收据和一次性发送。
10. [ ] 完成真实评论和真实私信的发送后回读。
11. [ ] 注入崩溃、超时、登录失效、DOM 变化测试。
12. [ ] 分别执行 Headed 和 Headless 实机验收，输出 GO/NO GO 报告。

### 后续进入 Tauri 的条件

- 通知回复能够明确绑定到原评论。
- 私信发送能够明确绑定到正确会话。
- 任何未知发送状态不自动重发。
- 账号 Profile 不会被两个执行器并发打开。
- 正常登录、需人工重新验证和浏览器异常三个状态都能在运行日志中区分。
- 模型侧无需知道浏览器 DOM 细节，只对统一事件生成草稿。

---

## 14. 最终决策建议

**按这个顺序执行：P0 登录和双 Page → P1 通知读取及评论目标可定位性 → P2 私信读取 → P3 两条发送闭环 → P4 无头兼容测试。**

这个顺序把最大的风险提前暴露。第一阶段不需要完成最终效果图的 UI，也不需要提前为 30 个账号做复杂调度。等一个账号、两条通道、两次真实发送路径都可用，再将已有 Node 内核接入 Tauri 工作台，逐步扩到更多账号。

**最重要的上线门槛：** 从顶部通知准确找到指定原评论，并在人工确认下将回复发到正确评论位置且能够回读证明。这个能力未被真实验证前，不能承诺「评论自动回复已实现」。

---

## 15. 官方技术参考（仅英文网站）

1. Playwright `launchPersistentContext` API：https://playwright.dev/docs/api/class-browsertype
2. Playwright 浏览器渠道与无头模式：https://playwright.dev/docs/browsers
3. Tauri v2 sidecar shell API：https://v2.tauri.app/reference/javascript/shell/
4. Tauri v2 配置与嵌入 sidecar：https://v2.tauri.app/develop/sidecar/
5. SQLite WAL：https://sqlite.org/wal.html

**说明：** 官方技术文档确认了 Playwright 与 Tauri 的底层机制，抖音通知与发送能力仍以测试账号的网页实际表现为准。
