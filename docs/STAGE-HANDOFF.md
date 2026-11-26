# 阶段推进状态、交接单与实机待验总表

本表按 [架构决策记录](ARCHITECTURE-DECISIONS.md) ADR-002 与 ADR-005 维护，严格区分「代码与离线/合成验证」与「真实账号/原生 GUI 实机验收」，供跨阶段新会话接棒使用。

---

## 一、全 6 阶段基线总览（当前 HEAD 基线：2026-11-26）

| 阶段 | 基线提交 | 代码与离线/合成验证状态 | 实机验收状态 |
|---|---|---|---|
| **阶段 0：止血与文档唯一化** | `ac6a096` | 已合入，P0 修复与定向回归通过 | 沿用 0.3.5 单账号抖音范围 GO |
| **阶段 1：内核解耦与 `PlatformConnector`** | `4edb238` | 已合入，`src/contracts/`、`src/platform/`、参数化 `accountId` 回归通过 | 单账号抖音兼容链路与阶段 0 基线一致 |
| **阶段 2：多模型提供商接入与切换 V1.0** | `702acd2` | 已合入，9 供应商预设、四协议合成响应、DPAPI/Sidecar 合成宿主、UI 与回归套件通过 | **待本人补验**：自备 Key 真实付费调用 + 原生 GUI 人工交互（见 [MODEL-CONTRACT.md](MODEL-CONTRACT.md)） |
| **阶段 3：`schema4` + 协议 v2 + 隔离 Worker + Win32 桥** | `38e7a2b` | 已合入，`schema4` 迁移、协议 v2、多账号隔离、独立 Browser Worker、Mock 第二平台与 3 页最小账号面板回归通过 | **待本人补验**：真实库私有副本 `schema3 -> schema4` 试升级与恢复实机核验 |
| **阶段 5 前置：品牌与前端视觉/交互基线锁定** | `4659a2c`、`56b12eb`、`ae45288` | 已定稿并固化于 `assets/brand/` 与 `ui-preview/`（Playwright 2x 7 视图与 `tsc`/`vite build` 通过） | 纯离线视觉参考基线，不代表阶段 5 后端接线完成 |
| **阶段 4：多平台分批接入** | **待启动** | 未开始 | 未开始 |
| **阶段 5：9 页正式工作台逐批替换** | **待阶段 4 后启动** | 视觉基线已锁定，生产端 `desktop/src/` 替换未开始 | 未开始 |

---

## 二、当前已验证离线/合成回归入口

新会话接棒开工前，可先按需运行以下命令核对基线健康：

```powershell
pnpm typecheck
pnpm check:source-size
pnpm check:privacy
```

阶段 1 ~ 3 重点自动化测试文件：
- 阶段 1/2：`tests/unit/`、`tests/integration/`（含多模型切换、取消、测速与 `desktop/src` 组件测试）
- 阶段 3：`tests/integration/schema4-migration.test.ts`、`tests/integration/protocol-v2-and-accounts.test.ts`、`tests/integration/browser-worker-isolation.test.ts`、`tests/integration/mock-platform-pluggability.test.ts`、`tests/unit/worker-isolation-boundaries.test.ts`、`desktop/src/AccountPlatformPanel.test.tsx`
- 双链构建烟测：`pnpm build` + `pnpm test:built`（验证源码 `tsx` 链与构建后 Node 链一致）

---

## 三、明确未验证与待本人实机补验清单

以下项目均未获得真实环境实机通过结论，任何交付不得将其表述为已验收：

1. **阶段 2 多模型真实付费调用**：9 家供应商（DeepSeek、OpenAI、Claude、Gemini、通义千问、豆包、硅基流动、OpenRouter、自定义云端）均仅通过离线合成响应与宿主 DPAPI 验证，待用户自备 Key 在原生开发窗口做单次测速、切换与建议实测。
2. **知识库与回复人格本人语料验收**：离线与合成测试已过，待用户在开发窗口导入小份本人真实语料完成采纳、学习与基线试聊对比（见 [KNOWLEDGE-PERSONA.zh-CN.md](KNOWLEDGE-PERSONA.zh-CN.md)）。
3. **真实库 `schema3 -> schema4` 首次升级核验**：须严格执行「退出当前客户端释放锁 -> SQLite 在线备份 -> 私有副本试升级与恢复验证 -> 再升原库」，已发生新外发后禁以旧快照回退。
4. **Windows 11 兼容性与安装包分发**：当前实机基线为 Windows 10 专业版 x64 Build 19045；Windows 11 与 `pnpm desktop:build` 正式安装包均列为正式版发布专项待验。

---

## 四、阶段 4 接棒指引（新会话入口）

### 1. 接入顺序（严格按 ADR-002）

1. **第一批（官方 API 优先）**：企业微信 / 微信客服（Node 侧 `PlatformConnector` 实现，明确账号资质、回调与授权边界）。
2. **第二批（网页连接器）**：小红书 / B站（复用独立 Node Browser Worker，实际页面映射存于私有目录，未校准真实页禁发）。
3. **第三批（前台交互受限通道）**：个人微信（按需挂接无状态 Python UIA Worker，严守 ADR-003 前台通道分域，严禁持有 SQLite 写权或绕过 `SendCoordinator`）。

### 2. 禁止触碰与工程红线

- 未经明确要求禁止执行 `pnpm desktop:build` 打包；禁止改动或重置本机私有真实运行目录与真实数据库。
- 所有新增或修改代码文件严格 `<= 800` 物理行；新引入任何外部开源实现必须先核对许可、固定 commit SHA 并登记进 [UPSTREAM.md](../UPSTREAM.md)。
- 多平台接入期间，若引入头像本地采集缓存，仅存私有目录并走受控 IPC 返回有界 `data:` URL，禁作目标放行依据、禁送模型、禁入 Git。
- 阶段 4 每批完成须走 ADR-005 三轮独立审查（第 1 轮全面审查+修复 -> 第 2 轮增量复核+修复 -> 第 3 轮只读终审零阻塞），再更新本表并开新会话交接进入阶段 5。
