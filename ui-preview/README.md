# inbora 阶段 5 桌面界面交互基线（`ui-preview`）

本目录保存已确认定稿的 **inbora 阶段 5 前端视觉与交互基线**，采用暖白纸感 + 深松青主题、`cosscom/ui` + `@base-ui/react@1.9.0` + Tailwind CSS v4 组件体系，以及全离线打包的可变字体栈（`MiSans VF` + `Plus Jakarta Sans Variable` + `Inter Variable` + `JetBrains Mono Variable`）。

- 完整品牌、色彩、字体、用户体验边界与阶段 5 迁移规范见 [BRAND-AND-UI-SPEC.md](../assets/brand/BRAND-AND-UI-SPEC.md)。
- 7 张 2x 高清参考图见 `../assets/brand/screenshots/`。
- 上游组件与字体许可明细见 [UPSTREAM-COSS-UI.md](./UPSTREAM-COSS-UI.md) 与根目录 [UPSTREAM.md](../UPSTREAM.md)。

## 本地预览

本目录与仓库根 `0.3.5` 生产代码（`src/`、`desktop/`）完全隔离，独立运行即可浏览与交互：

```powershell
cd ui-preview
npm.cmd install
npm.cmd run dev
```

启动后在浏览器访问 `http://127.0.0.1:4173`。类型检查与生产打包校验命令：

```powershell
cd ui-preview
npm.cmd run typecheck
npm.cmd run build
```

## 目录结构

- `public/avatars/`：12 张合成演示头像（6 张店铺值守账号头像 + 6 张客户头像，仅用于预览演示）
- `src/styles/globals.css`：浅色暖白纸感与深色深松墨语义令牌（Tailwind v4 `@theme inline`）
- `src/components/ui/`：基于 `cosscom/ui` 与 `@base-ui/react` 的 18 个可复用 UI 原语（阶段 5 可直接迁入 `desktop/src/components/ui/`）
- `src/components/`：桌面壳层与业务组件（`AppSidebar`、`TopBar`、`AppOverlays`、`InboxQueuePanel`、`InboxRightPanel`、`RichVisuals`、`DataWidgets` 等）
- `src/views/`：全部 9 个工作区主视图（总览、会话中心、账号管理、自动回复规则、知识库与人设、模型管理、数据统计、运行状态、系统设置）
- `src/data/mockData.ts`：离线演示数据（零真实用户数据、零真实凭据）
