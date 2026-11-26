# 多模型提供商 V1.0 路由契约

当前模型以 SQLite `m_selection` 为准。桌面 CONTROL 会话通过 `modelProviders` 管理连接修订和 Key。保存只更新待应用修订，应用才切换业务路由。MCP 继续使用 16 个业务工具。Key 保存在后端内存或 Windows CurrentUser DPAPI。

人工建议、自动回复、知识分析和试答携带固定的连接、凭据、选择修订和授权版本，经 `ModelClient` 发起一次 HTTPS 请求。短回复和试答上限 512 tokens，知识分析和合并为 2048 tokens。生成请求限时 30 秒，响应上限 64,000 字节，拒绝重定向。

业务生成在事务内预占一份持续授权和一次全局 MODEL 预算。切换继承有效授权的各自额度和已消费记录，并使旧路由的未提交自动任务失效。已有发送意图继续按原回读合同处理。连接测试只发固定测试消息，按命令 ID 去重并消费一次全局 MODEL 预算。

历史完整施工设计底稿已归档至本机忽略目录 `docs/archive/planning-2026-11/Inbora_多模型提供商接入与切换_施工文档_V1.0_2026-11-16.md`。

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

四协议列记录 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Gemini generateContent 的合成响应覆盖。DPAPI 与 Sidecar 列记录各供应商共用的 Windows 宿主验证。所有供应商的付费调用与原生 GUI 人工交互均待用户本人提供 Key，并在原开发窗口操作验收。

---

## 已废弃的 schema2 CLI 契约（仅作审计留档）

下面的 `HttpDraftProvider` 和 `authorize-model` 契约仅用于历史 schema2 CLI。schema3 客户端拒绝该入口并返回 `CLIENT_USE_VERSIONED_DRAFT_SERVICE`。

当前默认 Mock；没有真实供应商调用，也没有费用。HTTP 适配器是待供应商接入验证的明确契约，不宣称兼容 OpenAI 或任何特定供应商 API。

用户明确授权之后，在本机交互终端执行：

```powershell
pnpm inbora authorize-model --endpoint https://YOUR_APPROVED_HOST/draft --model YOUR_APPROVED_MODEL
```

实际 endpoint 和 model 必须由用户确认；以上是命令格式，不能直接运行。进程通过 `INBORA_MODEL_KEY` 获取 Bearer Key，不存入项目或运行配置。默认禁止 HTTP、URL 内嵌凭据、重定向和自动重试。请求超时 15 秒，先持久化预占一次预算；失败和进程中断也计入 50 次硬上限。

POST JSON：`{ model, system, businessData: { channel, message, history: [{ text, direction }] } }`。system 固定规则与不可信消息分开，history 限制在准确目标最近六条，敏感请求不出站。

响应 JSON：`{ text, model, usage: { inputTokens, outputTokens }, estimatedCost }`。Token 为非负整数，estimatedCost 是供应商明示的非负估算值或 null，不把估算写成实际账单。只接收同一批准模型、500 字以内非空纯文本，屏蔽链接、邮箱和长数字等敏感输出。此契约需由已批准供应商或其受控适配层真实支持，不能随意替换协议后声称验收通过。

离线契约测试通过注入 transport 校验请求、授权门禁、返回验证和持久化预算，真实网络调用为零。
