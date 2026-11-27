# 多模型提供商路由契约（V1.0 基线与 ADR-007 四槽位演进）

当前主模型默认以 SQLite `m_selection` 为准。桌面 CONTROL 会话通过 `modelProviders` 管理连接修订和 Key。保存只更新待应用修订，应用才切换业务路由。MCP 继续使用 16 个业务工具。Key 保存在后端内存或 Windows CurrentUser DPAPI。

人工建议、自动回复、知识分析和试答携带固定的连接、凭据、选择修订和授权版本，经 `ModelClient` 发起一次云端公网 HTTPS 请求。端点必须为公网 HTTPS 地址，拒绝 `localhost`、Ollama 及私有/保留内网网段，守住 SSRF 边界。短回复和试答上限 512 tokens，知识分析和合并为 2048 tokens。生成请求限时 30 秒，响应上限 64,000 字节，拒绝重定向，禁止自动重试（`maxRetries: 0`）。

业务生成在事务内预占一份持续授权和一次全局 MODEL 预算。切换继承有效授权的各自额度和已消费记录，并使旧路由的未提交自动任务失效。已有发送意图继续按原回读合同处理。连接测试只发固定测试消息，按命令 ID 去重并消费一次全局 MODEL 预算。

历史完整施工设计底稿已归档至本机忽略目录 `docs/archive/planning-2026-11/Inbora_多模型提供商接入与切换_施工文档_V1.0_2026-11-16.md`。

## 渐进四槽位逻辑路由（ADR-007）

底层模型路由契约扩展为四个逻辑槽位，默认保持零额外配置门槛。当前版本已完成四槽位配置存储（非 `m_` 惰性表 `model_slot_routes`）、路由器 `resolveSlotRoute`、多模态看图隔离、本地素材库与只读业务工具的离线/合成实现与测试验证；真实供应商 Key 的付费调用仍待用户本人实测：

| 逻辑槽位 | 职责范围 | 是否必填 | 当前版本实施状态 | 未配置或未就绪时的自动降级规则 |
| --- | --- | --- | --- | --- |
| `primary` | 对话主模型（人工建议、自动回复、试答与默认推理） | 必填 | 已接入运行（沿用 `m_selection`） | 无降级；直接沿用既有 SQLite `m_selection` 配置，完全向后兼容 |
| `vision` | 视觉理解（客户发来的截图或图片内容解析） | 可选 | 已完成槽位存储、路由、4 协议多模态请求与隔离校验（离线/合成已验证，付费调用待实测） | 账号未开启 `visionEnabled`（默认关）或 `vision` 槽位未配置时返回转人工（`VISION_DISABLED_OR_UNCONFIGURED`），不降级臆测图片内容 |
| `utility` | 后台轻任务（意图分类、候选 FAQ 提炼等非实时辅助任务） | 可选 | 已完成槽位存储与降级路由器 `resolveSlotRoute`（离线/合成已验证） | 配置 `utility` 时走 `utility` 槽位；未配置时自动回退至 `local_or_primary`（优先本地规则，需模型时复用 `primary`，受同一授权与全局 MODEL 预算约束） |
| `embedding` | 云端备用文本向量（知识检索辅助嵌入） | 可选 | 已完成槽位存储与降级路由器 `resolveSlotRoute`（离线/合成已验证） | 优先使用已就绪的本机 ONNX 向量引擎；未就绪且配置 `embedding` 时走云端备用槽位；均未就绪时无缝降级为纯增强版 SQLite FTS5，不阻塞主流程 |

### 跨槽位共享硬边界

- **零门槛兼容**：仅配置 `primary` 即可运行现有全部基础功能，现有单选 `m_selection` 数据与操作流程不退化。
- **统一网络与重试红线**：四个槽位均强制公网 HTTPS 端点（禁 `localhost` / Ollama / 私有网段）、拒绝重定向、`maxRetries: 0` 及事务内预占授权与预算。
- **多模态与只读工具边界**：多模态看图按账号默认关闭（`account_ai_features.vision_enabled = false`），仅允许 `sourceKind === 'CUSTOMER_MESSAGE_IMAGE'` 且 ≤ 4 MiB、经 PNG/JPEG/WEBP 魔数校验的图片在显式开启后送入具备视觉能力的云端模型；固定说明、本地缓存头像（含 `avatars` 路径）与未授权预览一律拒绝（`VISION_INPUT_FORBIDDEN`）。本地素材库回复（`local_media_assets`）须显式开启 `mediaReplyEnabled` 并经 `SendCoordinator` + `prepareMedia` 校验，未适配通道直接失败（`MEDIA_SEND_NOT_SUPPORTED`）且不记录意图。外部业务工具调用仅开放白名单只读查询（`query_order_status`、`query_logistics_trace`、`query_inventory_stock`），强制 GET、公网 HTTPS + DNS SSRF 校验、拒绝重定向、10 秒超时、`maxRetries: 0`、32 KiB 响应上限与字段脱敏，严禁写操作、凭据访问、浏览器直控或绕过 `SendCoordinator` 的发送路径。

## 分供应商验证矩阵

| 供应商 | 配置与目录合成验证 | 四协议合成响应验证 | 真实 Windows DPAPI 往返与 Sidecar 断连重连 | 真实供应商 API Key 付费调用与原生 GUI 人工交互 |
| --- | --- | --- | --- | --- |
| DeepSeek | 已通过 | 已通过 | 离线合成宿主已通过 | 未实测 |
| OpenAI | 已通过 | 已通过 | 离线合成宿主已通过 | 未实测 |
| Claude | 已通过 | 已通过 | 离线合成宿主已通过 | 未实测 |
| Gemini | 已通过 | 已通过 | 离线合成宿主已通过 | 未实测 |
| 通义千问 | 已通过 | 已通过 | 离线合成宿主已通过 | 未实测 |
| 豆包 | 已通过 | 已通过 | 离线合成宿主已通过 | 未实测 |
| 硅基流动 | 已通过 | 已通过 | 离线合成宿主已通过 | 未实测 |
| OpenRouter | 已通过 | 已通过 | 离线合成宿主已通过 | 未实测 |
| 自定义云端 | 已通过 | 已通过 | 离线合成宿主已通过 | 未实测 |

四协议列覆盖 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Gemini generateContent 的合成响应验证；DPAPI 与 Sidecar 列覆盖各供应商共用的 Windows 宿主验证。所有供应商的付费调用与原生 GUI 人工交互均待用户本人提供 Key 并在原开发窗口验收。

## 历史兼容说明

早期 schema2 CLI 的 `HttpDraftProvider` 与 `authorize-model` 入口已彻底废弃，现行客户端直接拒绝并返回 `CLIENT_USE_VERSIONED_DRAFT_SERVICE`。
