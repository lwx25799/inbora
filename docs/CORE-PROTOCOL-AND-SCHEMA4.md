# 核心契约、协议 v2、单库 `schema4` 与进程隔离规范

本文档固化阶段 1（`4edb238`）与阶段 3（`38e7a2b`）已合入代码库的底层技术契约，对应 [架构决策记录](ARCHITECTURE-DECISIONS.md) ADR-001 ~ ADR-004，所有类型、表名与约束均直接对应仓库源码。

---

## 一、纯共享契约与 `PlatformConnector`（阶段 1）

### 1. 纯契约层（`src/contracts/`）

桌面前端（`desktop/src/`）与 Node 核心之间共享的纯数据与协议契约集中在 `src/contracts/`（16 个模块，不引入后端数据库或浏览器实现）：
- 身份与协议：`account.ts`、`client.ts`、`protocol-v2.ts`、`events.ts`
- 业务与能力：`automation.ts`、`inbox.ts`、`model-providers.ts`、`knowledge.ts`、`knowledge-commands.ts`、`knowledge-import.ts`、`local-assistant.ts`、`manual-recovery.ts`、`diagnostics.ts`、`browser-resources.ts`
- 进程边界：`browser-worker.ts`、`native-bridge.ts`

关键身份标识约束（`src/contracts/account.ts`）：
- `DEFAULT_ACCOUNT_ID = 'account_001'`，`DOUYIN_PLATFORM_ID = 'douyin'`，`MOCK_PLATFORM_ID = 'mock-platform'`。
- `accountRef` 与 `accountId` 采用 `^[A-Za-z0-9][A-Za-z0-9_-]*$`（1-128 字符）；`platformId` 采用 `^[a-z][a-z0-9-]{0,63}$`；`targetRef` 最长 256 字符。
- `AccountStatus` 枚举：`ACTIVE`、`DISCONNECTED`、`PAUSED`、`ERROR`。

### 2. 平台连接器边界（`src/platform/`）

- 核心接口：`PlatformConnector`（`src/platform/platform-connector.ts`），现已落地抖音实现 `douyin-platform-connector.ts`、合成第二平台 `mock-platform-connector.ts` 及注册表 `platform-connector-registry.ts`。
- 职责边界：连接器负责单账号下的通道打开/关闭、身份校验（`identity` / `refreshIdentity`）、原无头页内安全恢复（`securityRecovery` / `recoverSecurityHolds`）、采集与观察（`observe` / `collect`）、媒体预览优先级、以及准备/回读适配器（`adapter` / `verifyExisting` / `verifyExistingFollowup`）。
- 账号级串行约束：每个连接器持有唯一 `AccountSerialExecutor`（`actor.run(op, 'interactive' | 'background')`），同账号采集、恢复、发送准备、提交与回读共用单队列（并发 = 1，人工交互优先）。业务授权、预算与发送意图账本始终保留在 Node 核心与唯一 `SendCoordinator`。

---

## 二、鉴权 stdio 协议 v2（`src/contracts/protocol-v2.ts`）

- **信封与帧上限**：`PROTOCOL_V2` 单帧 UTF-8 字节上限 `MAX_PROTOCOL_V2_FRAME_BYTES = 1_048_576`（1 MiB），请求信封严格校验 `protocol`、`requestId`（UUID）、64 位 `secret`、`scope`、可选幂等 `commandId`（UUID）与 `body`。
- **显式作用域隔离（`requiredScopeForCommand`）**：
  - `GLOBAL` 作用域：`connect`、`disconnect`、`emergencyStop`、`modelProviders`，以及 `accounts` 下的 `listAccounts`、`registerAccount`。
  - `ACCOUNT` 作用域（必须携带 `accountRef`）：`accounts` 下的 `getAccountStatus`、`disconnectAccount`，以及全部收件箱、会话、草稿、规则、知识、安全恢复、诊断和发送命令。
- **读写分类与幂等账本**：`isMutatingClientCommand` 区分只读查询与业务写命令；持久写命令经 `protocol_v2_commands` 表记录 `command_id`、`scope_kind`、`account_ref`、`request_digest`、`status` 与结果，断连重试或重连绝不静默重放已接收写命令。
- **账号管理命令族（`accountsCommandSchema`）**：`listAccounts`、`registerAccount`（带 `commandId`）、`getAccountStatus`、`disconnectAccount`（带 `commandId` 与 `confirmed: true`；解绑保留历史档案与审计）。

---

## 三、单库显式 `schema4` 迁移与 `legacy_target_aliases`（`src/storage/schema4-migration.ts`）

### 1. 数据结构升级内容

- 解除旧 `schema3` `accounts` 表 `CHECK(id='account_001')` 单行约束，重建为多账号结构（含 `platform`、`connector`、`display_label`、`status`、`profile_ref`、`created_at`、`updated_at`），并建立部分唯一索引 `accounts_platform_own_id`（同一平台下非空 `own_id` 唯一）。
- 新增 15 张多账号作用域与兼容表：
  - 兼容映射：`legacy_target_aliases`（保存原单账号 `(account_id, channel, legacy_target_key)` 到 `target_ref` 的一对一映射，历史事件、意图、收据、上下文与批准摘要原字节保留、零重算）
  - 账号作用域表：`account_pauses`、`account_cursors`、`account_observations`、`account_channel_capabilities`、`account_grant_bindings`、`account_operator_sessions`、`account_client_state`、`account_collection_config`、`account_audit_links`（配索引 `account_audit_links_account`）、`account_budget_ledger`、`account_model_routes`、`account_knowledge_scopes`（`PRIVATE` / `SHARED`，旧知识默认 `PRIVATE` 不自动共享）
  - 协议与迁移元表：`protocol_v2_commands`、`schema4_migration_meta`（单行 `CHECK(id=1)`，记录 `from_version`、`upgraded_at`、`pre_inventory_sha256`、`preserved_tables_sha256`、`fts_rebuilt`）。
- 知识检索重建：若存在 `k_chunks` 与 FTS 虚表（`k_search`、`k_terms`），自动重建索引并通过 `ftsSearchDigest` 比对重建前后全部词项与短语位置匹配一致性。

### 2. 四步原子迁移流程（`migrateToSchema4`）

1. **源库预检与基线快照**：要求 `user_version === 3`、`foreign_keys = ON`、无未知表/持久触发器、`quick_check = ok`；采集表清单摘要 `exactInventory` 与 FTS 摘要 `ftsSearchDigest`。
2. **独占在线备份**：以 `wx` 方式预占新备份文件路径（防覆盖活库或旧备份），经 SQLite 在线 `db.backup(backupFile)` 备份并只读复核备份库与源快照完全一致。
3. **私有副本试升级与恢复核验**：在临时目录复制备份执行 `schema4` 事务升级并调用 `assertSchema4Complete` 验证列结构、外键、唯一约束、`CHECK` 与摘要；随后再用备份覆盖临时文件验证精确恢复到原始 `schema3` 状态，结束后清理临时目录。
4. **原库原子发布**：比对 `counters(db)` 与源快照确认迁移期间无并发写入，随后在同一 `IMMEDIATE` 事务内完成升级并置 `user_version = 4`、写入 `SCHEMA4_UPGRADED` 审计事件。
- **回退红线**：迁移失败自动回滚并保留原库；升级后若已产生新的外发意图、收据或预算消费，严禁以旧 `schema3` 备份覆盖导致发送事实丢失。

---

## 四、独立 Node Browser Worker 隔离协议（`src/contracts/browser-worker.ts`、`src/workers/`）

- **进程边界**：独立子进程执行 Playwright 浏览器观察、准备、发送与回读，**严禁直连 SQLite**；子进程环境变量限定系统最小白名单（`workerEnvironment`），不透传 API Key 或无关秘密；请求超时 15 秒，退出等待 5 秒。
- **传输与分帧（`worker-protocol.ts`）**：UTF-8 换行分隔 JSON，单帧上限 `MAX_WORKER_FRAME_BYTES = 1_048_576`（1 MiB），所有请求与响应均绑定 `id`、`sessionId` 与 `ownerEpoch`。
- **单次发送强绑定（`WorkerSendBindingSchema`）**：`executeSend` 必须携带 `intentId`、单次 `nonce`、`sessionId`、`ownerEpoch`、`notBefore`、`textDigest`、`targetDigest`（可选 `permitExpiresAt` / `sendEpoch`）。
- **反向实时门禁（`permitCheck` / `permitResult`）**：Worker 在最终点击前向 Core 发起反向许可复核，Core 实时检查急停与许可状态（返回 `EMERGENCY_STOPPED` 或 `WORKER_SEND_PERMIT_EXPIRED` 即阻断）。
- **崩溃不重发**：`WorkerDispatchLedger` 登记已派发 `intentId`；Worker 异常退出或失联后严禁向新会话重放旧 `executeSend`，仅按原意图执行只读 `readback`。

---

## 五、Tauri Rust 原生 Win32 能力桥（`src/contracts/native-bridge.ts`、`src/native/win32-bridge.ts`）

- **定位与启用条件**：在 Tauri 宿主中注入 `INBORA_NATIVE_BRIDGE=1` 与 64 位共享 `secret` 启用，用于替代高频冷启 `powershell.exe` 的 DPAPI 加解密与进程资源采样。
- **协议限额**：协议版本 `NATIVE_BRIDGE_PROTOCOL = 1`，单帧上限 `MAX_NATIVE_BRIDGE_BYTES = 262_144`（256 KiB），明文上限 12,000 字节、密文上限 16,000 字节、并发在途上限 `MAX_IN_FLIGHT = 16`、单次请求超时 5,000 ms。
- **四项原子操作**：
  1. `dpapiProtect`：Windows CurrentUser DPAPI 加密。
  2. `dpapiUnprotect`：DPAPI 解密（支持按 `cacheKey` 与 `mtimeMs` 在宿主内存缓存，避免重复解密）。
  3. `clearDpapiCache`：凭据删除或变更时显式清空缓存，确保已删 Key 不可被旧缓存复活。
  4. `sampleProcessTree`：按 `rootPid` 与可选 `targetExe`、`maxAgeMs`（上限 30,000 ms）采集受控进程树（工作集、私有字节、CPU 秒数，最多 16,384 行）。
