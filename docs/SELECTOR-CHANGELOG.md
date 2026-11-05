# 页面映射变更记录

| 日期 | 范围 | 变化 | 依据 | 真实状态 |
| --- | --- | --- | --- | --- |
| 2026-11-04 | 合成夹具 | 集中通知、私信、账号门禁、目标及回执映射 | tests/fixtures/site.ts | 仅离线通过 |
| 2026-11-04 | 真实页面 | 未创建猜测选择器；校准文件只存本机 | SITE-OBSERVATION.md | 未验证 |
| 2026-11-05 | 真实登录/入口 | 观察到我的主页、header通知/消息、通知过滤和覆盖式会话层；记录实际DOM结构与缺失ID | SITE-OBSERVATION.md实机段；本机脱敏L01—L03证据 | 登录/恢复/排他实机通过；业务通道仍校准中 |
| 2026-11-05 | 已授权作品与私信只读 | 新增独立purpose=observation映射；固定渲染组件路径核验UID、会话、服务端消息ID、cid及时间，读取前检查可见性；会话行先核验再点击 | SITE-OBSERVATION / UPSTREAM；只读映射原件仅私有目录 | 源码CLI两通道各五轮及SQLite去重通过，D02证据8b630fae；发送映射仍未校准 |
| 2026-11-05 | 只读会话选择事件 | 映射显式限定click/mousedown，当前真实行校准为mousedown；同任务绑定及目标capture复核后单次派发 | 实际行onMouseDown与合成竞态回归；SITE-OBSERVATION | 两通道各补验一轮，累计每通道6观察；SQLite复核证据bfbc0216，发送仍未校准 |
| 2026-11-05 | 原生私信回复预检 | 独立dm-reply映射，输入区fiber固定路径curConversation与头部绑定，SVG单次DOM事件 | SITE-OBSERVATION / UPSTREAM及原生合成回归 | 实机只读预检303e5833；未输入/审批/发送 |
| 2026-11-05 | 评论读取就绪 | 可见行或显式commentEmpty；最终同步快照重核范围和空态 | 真实loaded0→4阶段证据、延迟行及快照竞态回归 | Headless源码读取及cursor复核926af233；真实空态未校准为null |
| 2026-11-05 | 一级评论直接回复 | 独立comment-reply映射；原评论cid/作品/作者与输入区cid/level绑定，Draft.js单行结构、隐藏发布图标分阶段核验 | SITE-OBSERVATION、UPSTREAM；本地26项评论及source/compiled链 | C03实机通过；单次提交N06为UNCERTAIN并冻结，子回复回读未通过，不由合成测试推定 |

后续每次真实 DOM 校准记录观察时间、浏览器完整版本、修改字段、证据摘要和回归结果，不提交私人 HTML、截图、标识或映射原件。映射内容摘要进入审批绑定；修改映射必须重新审批。
