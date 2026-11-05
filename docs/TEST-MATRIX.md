# 需求—实现—测试—证据对应表

最终判定：**未验证**。没有真实账号证据，不得判定 GO / CONDITIONAL GO / NO GO。下表“离线”仅指合成数据、SQLite 或本地 Edge 页面门禁，不代表原文真实场景通过。

环境基线：2026-11-05用户明确调整为当前Windows10专业版x64 Build19045，按本机完整验收；不要求本期另测Windows11，也不声称其已通过。

| 原文 ID | 目标 | 实现/离线验证位置 | 离线 | 实机 |
| --- | --- | --- | --- | --- |
| L01 | 首次扫码、两个 Page 同本人账号 | profile-owner；dual-channel 的双 Page/账号门禁 | 离线通过（机制） | 阻塞：普通抖音入口待校准，尚未核验账号 |
| L02 | 关闭重启、登录恢复或提示过期 | 本地Profile跨双Page共享与关闭后复用Cookie；登录门禁 | 离线通过（机制） | 未验证 |
| L03 | 双进程排他 | owner-lock.test：真实子进程争用、强制退出后释放 | 离线通过 | 未验证：现场第二持有者均被拒，重启资料完整性待核验 |
| N01 | 顶部通知产生准确新任务 | dom-adapter / store；dual-channel 两模式 | 离线通过 | 未验证 |
| N02 | 5次观察只有一任务、保留观察 | store.test | 离线通过 | 未验证 |
| N03 | 同文不同人、跨作品分别处理 | contracts/store.test | 离线通过 | 未验证 |
| N04 | 过滤点赞、关注、系统、自发 | contracts.test / store.test | 离线通过 | 未验证 |
| N05 | 通知跳转唯一原评论，否则人工 | dom-adapter.locateComment/matchingRoot；dual-channel | 离线通过（合成跳转） | 未验证 |
| N06 | 原评论楼中楼，不能独立顶层 | 精确 root 范围回读；dual-channel | 离线通过 | 未验证 |
| N07 | 延迟/审核不能立即确认 | send.test / 浏览器 pending 回读 | 离线通过 | 未验证 |
| D01 | 新入站消息成任务，自发不触发 | store.test / dual-channel | 离线通过 | 未验证 |
| D02 | 三短消息完整保留 | store.test，逐条草稿（允许但不强制合并） | 离线通过 | 未验证 |
| D03 | 同文次日不误去重 | store.test：稳定消息ID与日期 | 离线通过 | 未验证 |
| D04 | A/B切换延迟阻止误绑 | dual-channel：延迟切换/错误peer阻断 | 离线通过 | 未验证 |
| D05 | 发送到准确会话并回读 | dual-channel两模式，send.test错目标收据 | 离线通过 | 未验证 |
| S01 | 点击前崩溃留意图、恢复先核对 | hard-crash子进程直接退出86；重开SQLite恢复 | 离线通过 | 未验证 |
| S02 | 点击后超时未知，禁止重发 | send.test；dual-channel关闭实际Page | 离线通过 | 未验证 |
| S03 | 审批期间目标变化需重新批准 | store/send/dual-channel/review-regressions：文本版本、来源碰撞、新消息、人工回复、实际点击事件竞态 | 离线通过 | 未验证 |
| S04 | SQLite损坏/不可写停止 | store.test；send.test断言零点击 | 离线通过 | 未验证 |
| H01 | Headless读取通知和DM | dual-channel两模式；compare-modes实机只读入口 | 离线通过 | 未验证 |
| H02 | 验证码/扫码阻断、可见接管 | dual-channel challenge/login guards；login仅有头 | 离线通过 | 未验证 |
| H03 | 暂停会话停止后续发送 | store.test持久暂停；AccountActor串行 | 离线通过 | 未验证 |
| M01 | 重启保留各类任务/未知态 | store.test重开；cli.test初始化/状态/重启 | 离线通过 | 未验证 |
| C01 | 顶部通知显示评论提醒 | 合成顶部入口/弹层；真实未观察 | 离线通过（机制） | 未验证 |
| C02 | 区分本人作品评论及其他互动 | kind/direction分类；实际类别需校准 | 离线通过（枚举过滤） | 未验证 |
| C03 | 唯一定位原评论与回复区 | 稳定ID及原事件全文绑定 | 离线通过 | 未验证 |
| C04 | 形成楼中楼回复 | 原评论范围收据 | 离线通过 | 未验证 |
| C05 | 回读证明准确父评论 | 新回复ID、我方ID、目标、正文、确认状态、意图之后的绝对发送时间；隐藏旧同文回归 | 离线通过 | 未验证 |
| C06 | 刷新/翻页恢复未处理任务 | SQLite持久任务与独立cursor | 离线通过（本地恢复） | 未验证 |

额外门禁：send.test 的发送串行、重复命令、旧ID/错误对象/待审核/无证明；model-contract 的授权、预算、无重试；cli.test 的真实入口权限；check-privacy 的历史和暂存区扫描。真实模型供应商契约尚未验证，默认 Mock 不影响浏览器发送路径验收。

首次推送前的审查发现、回归增加及最终检查数记录于 REVIEW.md / PROGRESS.md；这里按原需求逐项维护，不删除未通过项。

真实证据保存在本机私有目录：时间、完整浏览器版本、模式、任务UUID、动作、结果、脱敏诊断和证据摘要。人工声明 source=MANUAL_ATTESTATION；真实自动回执 source=AUTOMATED_REAL；合成夹具不能混用。

GO 必须同时满足原文必要真实用例、C01—C06、准确双通道回读、连续重启无错发/重复、可靠未知冻结和明确 Headless 结论。Headless不稳定只能 CONDITIONAL GO；无法可靠身份核验或平台要求停止按 NO GO 停止受影响动作。只有 GO 后才做 P5 评审。
