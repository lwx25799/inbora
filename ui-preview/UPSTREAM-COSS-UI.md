# Upstream Notice: `ui-preview/`

本目录包含阶段 5 桌面前端的视觉与交互参考实现（完全独立于当前 `0.3.5` 生产代码 `src/` 与 `desktop/`）。以下外部开源组件与离线字体资产已核对许可并登记进仓库根 `UPSTREAM.md`：

| 上游来源 | 固定版本 / Commit | 许可 | 归档与采用范围 |
|---|---|---|---|
| [cosscom/ui](https://github.com/cosscom/ui) | `11f4620946e5fb0e2c12a815388ccdf5b3120dd0` | MIT | 许可证存档于 `../third_party/coss-ui-MIT.txt`；采用其 Base UI + Tailwind v4 原语组件组织与状态样式，落地于 `src/components/ui/*` 与 `src/lib/utils.ts`，并套用 inbora 暖白纸感 + 深松青令牌（`src/styles/globals.css`） |
| `@base-ui/react` | `1.9.0` | MIT | 无样式可访问性交互原语（Dialog、Switch、Tabs、Tooltip、ScrollArea 等），通过 `package-lock.json` 锁定 |
| `misans` | `^5.0.0` (锁定于 `package-lock.json`) | Apache-2.0 | 小米官方 MiSans VF 频度切片可变中文字体，全本地打包，零外链 CDN |
| `@fontsource-variable/inter` | `^5.3.0` | OFL-1.1 | 拉丁正文与界面标签可变字体，全本地打包 |
| `@fontsource-variable/plus-jakarta-sans` | `^5.3.0` | OFL-1.1 | 标题与 KPI 数字可变字体，全本地打包 |
| `@fontsource-variable/jetbrains-mono` | `^5.3.0` | OFL-1.1 | 等宽编码、SKU、快捷键与模型标识可变字体，全本地打包 |
| `lucide-react` | `^0.555.0` | ISC | 1.5px 细线桌面图标集 |
| `tailwindcss` / `@tailwindcss/vite` | `^4.1.17` | MIT | Tailwind CSS v4 样式引擎与 `@theme inline` 语义令牌 |

说明：`public/avatars/*.jpg` 为本机生成的合成演示头像，不含任何真实用户或平台数据，仅用于界面原型视觉预览。
