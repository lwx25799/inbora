# 原型来源与复用记录

## 视觉来源

本项目的 `Inbora_UI_效果图合集/01_工作台总览.png` 至 `10_系统设置.png`。其中 README 明确这些图片是视觉概念效果图，文字、数值、状态均为演示。使用图片观察布局和配色；未直接嵌入、裁切或复制图片像素作为界面。

## 开源图标

- 候选与采用： [feathericons/feather](https://github.com/feathericons/feather)。24 × 24 的描边图标与参考图一致，纯 SVG 可以离线使用，无需运行时依赖。
- 固定 SHA：`3dc050d97405062eba78aa57115c0a15c63abdaa`。
- 核对源码：[icons/home.svg](https://github.com/feathericons/feather/blob/3dc050d97405062eba78aa57115c0a15c63abdaa/icons/home.svg)、`icons/message-circle.svg`、`icons/users.svg`、`icons/settings.svg` 等 `vendor/feather-icons.js` 中列出的 75 项。
- 许可证：MIT，完整声明保存在 `vendor/feather-LICENSE.txt`，版权为 Cole Bemis。
- 采用方式：固定提交的 SVG 原文打包为本地 JavaScript 字典；运行时只统一图标尺寸、描边宽度及装饰性无障碍属性。
- 必要调整：`core.js` 提供少量语义别名；不引入 CDN、npm 依赖或上游 JavaScript 宿主。
- 合同兼容：图标不执行脚本，不读取账号、密钥、Profile 或数据库，不发起模型调用和发送。原型脚本与现有应用完全独立。
- 验证：取得全部图标与许可文件后核对内容；在独立 Edge 无头上下文验证所有页面，未观察到 HTTP(S) 请求。

布局、交互及演示数据使用本项目独立原生 HTML/CSS/JavaScript 实现。复用图标不表示真实业务功能或真实账号验收通过。
