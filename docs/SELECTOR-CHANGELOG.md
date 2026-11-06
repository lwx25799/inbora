# 页面映射变更记录

| 日期 | 范围 | 变化 | 依据 | 真实状态 |
| --- | --- | --- | --- | --- |
| 2026-11-06 | 第二测试者及双会话返回 | 保留A，B按用户提供唯一号码核对主页UID/secUid及私信会话；chatBack仅限定当前chat层，原宽选择器的2匹配拒绝证据保留 | SITE-OBSERVATION；实际映射和身份仅私有目录 | B首次历史基线6f374b63、四轮普通A/B切换通过；新增受控输入及延迟/发送场景待验 |
| 2026-11-04 | 合成夹具 | 集中通知、私信、账号门禁、目标及回执映射 | tests/fixtures/site.ts | 仅离线通过 |
| 2026-11-04 | 真实页面 | 未创建猜测选择器；校准文件只存本机 | SITE-OBSERVATION.md | 未验证 |
| 2026-11-05 | 真实登录/入口 | 观察到我的主页、header通知/消息、通知过滤和覆盖式会话层；记录实际DOM结构与缺失ID | SITE-OBSERVATION.md实机段；本机脱敏L01—L03证据 | 登录/恢复/排他实机通过；业务通道仍校准中 |
| 2026-11-05 | 已授权作品与私信只读 | 新增独立purpose=observation映射；固定渲染组件路径核验UID、会话、服务端消息ID、cid及时间，读取前检查可见性；会话行先核验再点击 | SITE-OBSERVATION / UPSTREAM；只读映射原件仅私有目录 | 源码CLI两通道各五轮及SQLite去重通过，D02证据8b630fae；发送映射仍未校准 |
| 2026-11-05 | 只读会话选择事件 | 映射显式限定click/mousedown，当前真实行校准为mousedown；同任务绑定及目标capture复核后单次派发 | 实际行onMouseDown与合成竞态回归；SITE-OBSERVATION | 两通道各补验一轮，累计每通道6观察；SQLite复核证据bfbc0216，发送仍未校准 |
| 2026-11-05 | 原生私信回复预检 | 独立dm-reply映射，输入区fiber固定路径curConversation与头部绑定，SVG单次DOM事件 | SITE-OBSERVATION / UPSTREAM及原生合成回归 | 实机只读预检303e5833；未输入/审批/发送 |
| 2026-11-05 | 评论读取就绪 | 可见行或显式commentEmpty；最终同步快照重核范围和空态 | 真实loaded0→4阶段证据、延迟行及快照竞态回归 | Headless源码读取及cursor复核926af233；真实空态未校准为null |
| 2026-11-05 | 一级评论直接回复 | 独立comment-reply映射；原评论cid/作品/作者与输入区cid/level绑定，Draft.js单行结构、隐藏发布图标分阶段核验 | SITE-OBSERVATION、UPSTREAM；本地26项评论及source/compiled链 | C03实机通过；单次提交N06为UNCERTAIN并冻结，子回复回读未通过，不由合成测试推定 |
| 2026-11-05 | 安全验证后的真实子回复 | 观察到独立level2/levelOneCid子回复，根replyComment空、child缺status；通过正常页面GET响应交叉校验status1 | SITE-OBSERVATION；原始DOM/响应仅私有目录，未放宽生产映射 | N06/C04/C05补充核验通过；自动回读和短信弹层映射仍未完成，原未知冻结保留 |
| 2026-11-06 | 自动回读/短信门禁/图集列表 | 独立直接child与正常精确GET补证；实际短信标题组件阻断；唯一可见列表、根字段归属及透明菜单ID锚点 | SITE-OBSERVATION；红绿回归、source/compiled及真实只读核验 | 有头源码bbffa1f0/无头编译22c10d29复核既有回复通过；第二作品加载通过，新发送/新测试者/新验证码仍待验 |

后续每次真实 DOM 校准记录观察时间、浏览器完整版本、修改字段、证据摘要和回归结果，不提交私人 HTML、截图、标识或映射原件。映射内容摘要进入审批绑定；修改映射必须重新审批。
