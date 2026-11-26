# 第三方来源与许可台账

本文件登记仓库实际采用的第三方开源依赖、固定上游源码核对记录与许可证归档位置。2026-11 早期 PoC 开发期的 72 段逐日过程记录已归档至本机忽略目录 `docs/archive/poc-2026-11/UPSTREAM-LOG-2026-11.md` 供历史审计回查。

---

## 一、生产核心依赖（根目录 `package.json` + `pnpm-lock.yaml` 锁定）

| 类别 | npm / Rust 依赖 | 锁定版本 | 许可 | 采用范围与约束 |
|---|---|---|---|---|
| 桌面壳与前端 | `@tauri-apps/api` / `@tauri-apps/cli`、`react` / `react-dom`、`vite` / `@vitejs/plugin-react`、`typescript` | `2.12.4` / `19.3.1` / `8.3.6` / `6.3.0` / `7.0.2` | Apache-2.0 OR MIT / MIT | 桌面原生壳、React 工作台与热更新；Rust 依赖许可由构建 notices 脚本汇总 |
| 设计系统与离线字体 | `@base-ui/react`、`tailwindcss` / `@tailwindcss/vite`、`lucide-react`、`class-variance-authority`、`clsx`、`tailwind-merge`、`misans`、`@fontsource-variable/inter` / `plus-jakarta-sans` / `jetbrains-mono` | `1.9.0` / `4.3.5` / `0.555.0` / `0.7.1` / `2.1.1` / `3.7.1` / `5.0.0` / `5.3.0` | MIT / ISC / Apache-2.0 / OFL-1.1 | 阶段 5 桌面前端基线（`desktop/src/components/ui/`、`desktop/src/lib/utils.ts`、`desktop/src/styles/globals.css`），全本地打包可变字体零外链 |
| 浏览器与存储 | `playwright`、`better-sqlite3`、`zod`、`pino` | `1.64.1` / `13.0.3` / `4.6.7` / `10.4.0` | Apache-2.0 / MIT | 无头静音 Edge 自动化、单库 SQLite WAL（固定预编译 Node-API 包，禁隐式 `node-gyp`）、契约校验与脱敏日志 |
| 本机 MCP 服务 | `@modelcontextprotocol/server` | `2.4.0` | MIT | 本地 stdio 16 工具受控入口；许可证存档于 `third_party/modelcontextprotocol/LICENSE` |
| 本地文档解析 | `mammoth`、`pdfjs-dist`、`exceljs` | `1.13.0` / `6.5.438` / `4.4.0` | BSD-2-Clause / Apache-2.0 / MIT | 知识库与样本纯文本解析（DOCX / 文字 PDF / CSV / XLSX）；无 OCR、宏或外链下载 |
| 阶段 2 多模型 AI SDK | `ai`、`@ai-sdk/openai`、`@ai-sdk/anthropic`、`@ai-sdk/google`、`@ai-sdk/openai-compatible`、`@ai-sdk/deepseek` | `7.0.173` / `4.0.118` / `4.0.105` / `4.0.121` / `3.0.92` / `3.0.87` | Apache-2.0 | 上游 [vercel/ai](https://github.com/vercel/ai)；单次文本生成、四协议传输与统一结果，禁止自动重试（`maxRetries: 0`） |

---

## 二、阶段 5 品牌与前端视觉基线（根目录与 `ui-preview/` 同步锁定）

根目录 `package.json` + `pnpm-lock.yaml` 已按精确版本同步落地至 `desktop/`；`ui-preview/` 保留独立交互参考基线：

| 来源 / npm 包 | 锁定版本 / Commit | 许可 | 采用范围与归档 |
|---|---|---|---|
| [cosscom/ui](https://github.com/cosscom/ui) | `11f4620946e5fb0e2c12a815388ccdf5b3120dd0` | MIT | 许可证存档于 `third_party/coss-ui-MIT.txt`；采用其 Base UI + Tailwind v4 原语组件落地至 `desktop/src/components/ui/`、`desktop/src/lib/utils.ts`（同步 `ui-preview/`），套用暖白纸感 + 深松青令牌 |
| `@base-ui/react` | `1.9.0` | MIT | 无样式可访问性交互原语（Dialog / Sheet / Tabs / Switch / Tooltip 等） |
| `class-variance-authority`、`clsx`、`tailwind-merge` | `0.7.1` / `2.1.1` / `3.7.1` | Apache-2.0 / MIT | 组件变体声明与 Tailwind 类名合并工具 |
| `misans` | `5.0.0` | Apache-2.0 | 小米官方 MiSans VF 频度切片可变中文字体，全本地打包零外链 |
| `@fontsource-variable/inter`、`plus-jakarta-sans`、`jetbrains-mono` | `5.3.0` | OFL-1.1 | 拉丁正文、标题数字与等宽编码可变字体，全本地打包 |
| `lucide-react`、`tailwindcss` / `@tailwindcss/vite`、`@vitejs/plugin-react` | `0.555.0` / `4.3.5` / `6.3.0` | ISC / MIT | 1.5px 细线桌面图标、Tailwind CSS v4 样式编译与 Vite 8 React 插件 |

说明：`ui-preview/public/avatars/` 仅包含 12 张合成演示头像，不含真实平台或用户数据。

---

## 三、上游开源源码核对与局部机制适配

所有外部参考均先核对许可与固定 commit SHA，仅提取符合本项目安全红线的机制并独立实现，不复制无许可代码、绕过反爬/签名伪造或私有接口回退。

| 上游仓库 | 固定 Commit SHA | 许可与归档 | 采用的机制 / 范围 | 明确不采用项 |
|---|---|---|---|---|
| [Yht20927/douyin-cli](https://github.com/Yht20927/douyin-cli) | `4073159bea585de6d33a4747a475669440737932` | MIT（`third_party/douyin-cli/LICENSE`） | 响应分类、回复指令、累计用量聚合查询（`lib/memory/llm-usage.js:56-74` -> `src/app/diagnostics.ts`）与有界清理预演组织（`lib/commands/cleanup.js` -> `src/app/evidence-maintenance.ts`） | 损失大整数精度的转换、私有协议、硬编码价格、数据库删除或重复提交回退 |
| [LockyBee/dsh-douyin-agent](https://github.com/LockyBee/dsh-douyin-agent) | `7989640e340f0fd79e2de9874880d5197546e755` | MIT（`third_party/LockyBee-dsh-douyin-agent-MIT.txt`） | 作品页先核验再读取、元素与视口求交检测、播放捕获与无头静音暂停、本地评论/私信被动读取思路 | 任何无意图事务的直接发送、UA 覆写或反检测伪装 |
| [miqian-nomad/dsh-douyin-watch](https://github.com/miqian-nomad/dsh-douyin-watch) | `d1a14e3fc8d7a18089d412ae3479365974c069df` / `177810c1f1858b529e78531f837ac9677fb9f9a9` | MIT（已核对原仓 LICENSE） | 同刻状态快照（URL + 标题 + 检测结果）与同作品避免重复导航思路 | 直接请求绕过页面 DOM 合同、UA 覆写与有头常驻 |
| [hellodigua/UniEmoji](https://github.com/hellodigua/UniEmoji) | `57568e94124772d5a4802f3e42d9c93c1fc5690d` | MIT（`third_party/UniEmoji-MIT.txt`） | 常用抖音表情标签到 Unicode 近似展示映射（保留原标签与原业务文本） | 复制平台专有图片素材 |
| [tauri-apps/tauri-docs](https://github.com/tauri-apps/tauri-docs) / `tauri` | `5e49cc6e48597060f1618e0b62cb91b071b1b4a9` / `993038c49185307dfc895ab7657d77ca0d5ed7c7` | MIT / Apache-2.0（`third_party/Tauri-docs-MIT.txt`） | Node Sidecar 生命周期、原生退出触发后端管道 EOF 与进程收尾路径 | 放宽原生命令白名单或开放公网端口 |
| [microsoft/playwright](https://github.com/microsoft/playwright) | `cfe490d941f992655948eee8fd4fd94e1c4234bf` | Apache-2.0 | `gracefullyClose` 持久上下文关闭、DOM 视口/样式可见性判断、`Mouse`/`Keyboard`/`Page.screenshot` 公开接口用于原无头页内人工安全核验 | 复制内部源码函数或自动求解验证码 |
| [Mintplex-Labs/anything-llm](https://github.com/Mintplex-Labs/anything-llm) | `1626d971c73d70a68602a662e3baf52e160c62ff` | MIT | 知识来源可撤销与纯文本分块组织思路（`collector/processRawText/index.js`） | 其宿主架构、向量库或发送代码 |
| [langchain-ai/langchainjs](https://github.com/langchain-ai/langchainjs) | `c266deb5c9afee8253dab0f1e92aec5727159150` | MIT | 少量相关回复样例选择边界（`semantic_similarity.ts`） | 引入重型链式编排框架或自动重试 |
| [chatwoot/chatwoot](https://github.com/chatwoot/chatwoot) | `625d5964e3cb3f1d917b43c3b8332219e525a4b8` | MIT | 会话列表与消息状态同步交互对照（`conversations/actions.js`） | 服务端多租户或后端代码 |
| [TeamBreakerr/douyin-chat-export](https://github.com/TeamBreakerr/douyin-chat-export) | `9e39afa980945737270ee88f8e33da470742cd9b` | 仅结构核对（未复制源码） | 抖音私信消息结构与类型字段核对 | 批量导出或绕过平台边界的脚本 |
| [Johnserf-Seed/f2](https://github.com/Johnserf-Seed/f2) | `f6be8c0ffba9a127075bbeafe4838716650b6325` | Apache-2.0（仅结构核对） | 分享链接作品类型与引用格式核对 | 下载器、签名算法或反爬模块 |

---

## 四、已核对并明确排除的候选仓

以下仓库仅在调研期核对过许可或技术边界，**未复制或采用任何代码**：
- `hycarbon-b/crawl-douyin`（`cdde8d7bfec3b018454705240fa0df6550ece6db`）、`JMY2003/a-skill-to-do-anything-in-douyin`（`d5211b3d687ddab0d5efc32b915a636aba764423`）、`NanmiCoder/MediaCrawler`、`pcmxiao/dsh-douyin-bridge`：涉及非官方签名、激进抓取或不符合本项目本地合规边界，全部排除。
