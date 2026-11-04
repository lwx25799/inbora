# 可选模型 HTTP 契约

当前默认 Mock；没有真实供应商调用，也没有费用。HTTP 适配器是待供应商接入验证的明确契约，不宣称兼容 OpenAI 或任何特定供应商 API。

用户明确授权之后，在本机交互终端执行：

```powershell
pnpm inbora authorize-model --endpoint https://YOUR_APPROVED_HOST/draft --model YOUR_APPROVED_MODEL
```

实际 endpoint 和 model 必须由用户确认；以上是命令格式，不能直接运行。进程通过 `INBORA_MODEL_KEY` 获取 Bearer Key，不存入项目或运行配置。默认禁止 HTTP、URL 内嵌凭据、重定向和自动重试。请求超时 15 秒，先持久化预占一次预算；失败和进程中断也计入 50 次硬上限。

POST JSON：`{ model, system, businessData: { channel, message, history: [{ text, direction }] } }`。system 固定规则与不可信消息分开，history 限制在准确目标最近六条，敏感请求不出站。

响应 JSON：`{ text, model, usage: { inputTokens, outputTokens }, estimatedCost }`。Token 为非负整数，estimatedCost 是供应商明示的非负估算值或 null，不把估算写成实际账单。只接收同一批准模型、500 字以内非空纯文本，屏蔽链接、邮箱和长数字等敏感输出。此契约需由已批准供应商或其受控适配层真实支持，不能随意替换协议后声称验收通过。

离线契约测试通过注入 transport 校验请求、授权门禁、返回验证和持久化预算，真实网络调用为零。
