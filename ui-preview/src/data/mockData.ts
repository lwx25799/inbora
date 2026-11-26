export type PlatformId =
  | "douyin"
  | "wecom"
  | "wxkf"
  | "xiaohongshu"
  | "bilibili"
  | "wechat_personal";

export type PageId =
  | "overview"
  | "inbox"
  | "accounts"
  | "automation"
  | "knowledge"
  | "models"
  | "runtime"
  | "analytics"
  | "settings";

export type ScenarioMode = "normal" | "security_hold" | "emergency_stop";

export interface AccountItem {
  id: string;
  platform: PlatformId;
  label: string;
  handle: string;
  avatarUrl: string;
  avatarCapturedAt: string;
  syncCustomerAvatars: boolean;
  status: "ACTIVE" | "CHANNEL_HELD" | "FOREGROUND_LIMITED";
  serviceTier: "常驻在线" | "队列轮转" | "官方接口" | "前台按需";
  channels: Array<"DIRECT_MESSAGE" | "COMMENT_NOTIFICATION">;
  heldChannels: Array<"DIRECT_MESSAGE" | "COMMENT_NOTIFICATION">;
  autoReply: boolean;
  lastSync: string;
  ramMb: number;
  todayAuto: number;
  todayHuman: number;
  dailyQuota: number;
  ownerLock: string;
  uptime24h: Array<"ok" | "warn" | "idle">;
}

export interface ChatMsg {
  id: string;
  dir: "in" | "out" | "sys";
  time: string;
  text: string;
  uncertain?: boolean;
  delivered?: boolean;
  shareCard?: { title: string; subtitle: string; url: string; duration: string };
  imageCard?: { label: string; dimensions: string };
  productCard?: { name: string; sku: string; price: string; stock: string; thumbUrl: string };
}

export interface CommentNode {
  level: 1 | 2;
  author: string;
  time: string;
  text: string;
  own?: boolean;
  isTarget?: boolean;
}

export interface ThreadItem {
  id: string;
  accountId: string;
  channel: "DIRECT_MESSAGE" | "COMMENT_NOTIFICATION";
  author: string;
  authorTag: string;
  avatarUrl: string;
  avatarSource: string;
  unreadCount?: number;
  intentChip: string;
  avatarTone: number;
  targetId: string;
  workTitle?: string;
  customerStats: { visits: number; orders: number; city: string; note: string };
  relatedItem?: { name: string; sku: string; price: string; stock: string; swatch: string; thumbUrl?: string };
  status: "WAITING" | "MANUAL_ONLY" | "UNCERTAIN" | "CONFIRMED";
  unread: boolean;
  updatedAt: string;
  leaseNote: string;
  leaseGen: number;
  knowledgeHits: string[];
  personaLabel: string;
  suggestion: string | null;
  altSuggestions?: { warm: string; concise: string; pro: string };
  mcpConflict?: string | null;
  mediaNotice?: string;
  channelHeld?: boolean;
  intent: null | {
    intentId: string;
    commandId: string;
    status: "CONFIRMED" | "UNCERTAIN";
    submittedAt: string;
    rechecks: string;
    reason: string | null;
  };
  messages: ChatMsg[];
  commentChain?: CommentNode[];
}

export interface KnowledgeDoc {
  id: string;
  topic: string;
  title: string;
  channel: string;
  status: "ENABLED" | "DISABLED" | "CONFLICT";
  validUntil: string;
  updatedAt: string;
  hits7d: number;
  content: string;
}

export interface ChatSample {
  id: string;
  source: string;
  question: string;
  reply: string;
  adopted: boolean;
}

export interface PersonaVersion {
  version: string;
  name: string;
  status: "PUBLISHED" | "ARCHIVED";
  createdAt: string;
  batches: string;
  summary: string;
}

export interface ModelConnection {
  id: string;
  name: string;
  protocol: "OpenAI Chat" | "OpenAI Responses" | "Anthropic Messages" | "Gemini";
  baseUrl: string;
  region: string;
  storage: "DPAPI" | "MEMORY";
  keyPresent: boolean;
  models: string[];
  version: number;
  callsToday: number;
  lastTest: null | { ok: boolean; elapsedMs: number; modelId: string; tokens: string };
}

export interface AuditRow {
  time: string;
  type: string;
  scope: string;
  entity: string;
  detail: string;
}

export interface LiveFeedItem {
  id: string;
  time: string;
  platform: PlatformId;
  account: string;
  customer: string;
  avatarUrl: string;
  mode: "AUTO" | "HUMAN";
  latency: string;
  excerpt: string;
  docCited: string;
}

const OK24: Array<"ok" | "warn" | "idle"> = Array.from({ length: 16 }, () => "ok");
const ROTATE24: Array<"ok" | "warn" | "idle"> = ["ok","idle","ok","ok","idle","ok","ok","idle","ok","ok","idle","ok","ok","ok","idle","ok"];
const UIA24: Array<"ok" | "warn" | "idle"> = ["idle","idle","idle","ok","ok","ok","idle","ok","ok","ok","ok","idle","ok","ok","idle","ok"];
const WARN24: Array<"ok" | "warn" | "idle"> = ["ok","ok","ok","ok","ok","ok","ok","ok","ok","ok","ok","ok","ok","ok","warn","ok"];

export const INITIAL_ACCOUNTS: AccountItem[] = [
  {
    id: "acc_dy_main", platform: "douyin", label: "禾木手作旗舰号", handle: "@hemu_ceramics",
    avatarUrl: "/avatars/acc-flagship.jpg", avatarCapturedAt: "采集自抖音主页 · 今日 18:10", syncCustomerAvatars: true,
    status: "ACTIVE", serviceTier: "常驻在线", channels: ["DIRECT_MESSAGE", "COMMENT_NOTIFICATION"],
    heldChannels: [], autoReply: true, lastSync: "刚刚", ramMb: 312, todayAuto: 118, todayHuman: 29,
    dailyQuota: 200, ownerLock: "主无头进程 · 单持有者锁", uptime24h: OK24,
  },
  {
    id: "acc_wecom", platform: "wecom", label: "禾木企业客服", handle: "禾木陶瓷工作室",
    avatarUrl: "/avatars/acc-wecom.jpg", avatarCapturedAt: "同步自企微接口 · 今日 18:05", syncCustomerAvatars: true,
    status: "ACTIVE", serviceTier: "官方接口", channels: ["DIRECT_MESSAGE"],
    heldChannels: [], autoReply: true, lastSync: "刚刚", ramMb: 0, todayAuto: 94, todayHuman: 17,
    dailyQuota: 150, ownerLock: "官方 API 连接池", uptime24h: OK24,
  },
  {
    id: "acc_wxkf", platform: "wxkf", label: "售后保障专线", handle: "微信客服 · 售后组",
    avatarUrl: "/avatars/acc-wxkf.jpg", avatarCapturedAt: "同步自微信客服 · 今日 17:50", syncCustomerAvatars: true,
    status: "ACTIVE", serviceTier: "官方接口", channels: ["DIRECT_MESSAGE"],
    heldChannels: [], autoReply: true, lastSync: "1 分钟前", ramMb: 0, todayAuto: 68, todayHuman: 21,
    dailyQuota: 120, ownerLock: "官方 API 连接池", uptime24h: OK24,
  },
  {
    id: "acc_dy_sub", platform: "douyin", label: "禾木设计精选号", handle: "@hemu_studio",
    avatarUrl: "/avatars/acc-studio.jpg", avatarCapturedAt: "采集自抖音主页 · 今日 17:40", syncCustomerAvatars: true,
    status: "ACTIVE", serviceTier: "常驻在线", channels: ["DIRECT_MESSAGE", "COMMENT_NOTIFICATION"],
    heldChannels: [], autoReply: true, lastSync: "2 分钟前", ramMb: 278, todayAuto: 51, todayHuman: 14,
    dailyQuota: 100, ownerLock: "独立浏览器工作进程 #2", uptime24h: WARN24,
  },
  {
    id: "acc_xhs", platform: "xiaohongshu", label: "禾木器物志", handle: "小红书号 6489102",
    avatarUrl: "/avatars/acc-xhs.jpg", avatarCapturedAt: "采集自小红书创作者端 · 今日 17:22", syncCustomerAvatars: true,
    status: "ACTIVE", serviceTier: "队列轮转", channels: ["DIRECT_MESSAGE", "COMMENT_NOTIFICATION"],
    heldChannels: [], autoReply: false, lastSync: "3 分钟前", ramMb: 262, todayAuto: 0, todayHuman: 19,
    dailyQuota: 80, ownerLock: "多号轮转工作进程 #3", uptime24h: ROTATE24,
  },
  {
    id: "acc_wx_personal", platform: "wechat_personal", label: "主理人私域号", handle: "桌面微信客户端",
    avatarUrl: "/avatars/acc-personal.jpg", avatarCapturedAt: "采集自桌面端资料 · 今日 16:48", syncCustomerAvatars: true,
    status: "FOREGROUND_LIMITED", serviceTier: "前台按需", channels: ["DIRECT_MESSAGE"],
    heldChannels: [], autoReply: false, lastSync: "6 分钟前", ramMb: 138, todayAuto: 0, todayHuman: 9,
    dailyQuota: 50, ownerLock: "按需前台协助（需保持桌面亮屏）", uptime24h: UIA24,
  },
];

export const LIVE_FEED: LiveFeedItem[] = [
  { id: "lf1", time: "18:40", platform: "wecom", account: "禾木企业客服", customer: "徐知微", avatarUrl: "/avatars/cust-song.jpg", mode: "AUTO", latency: "3.1s", excerpt: "已答复 30 只起订定制周期与底款刻章说明", docCited: "企业定制起订量" },
  { id: "lf2", time: "18:34", platform: "douyin", account: "禾木手作旗舰号", customer: "苏沐川", avatarUrl: "/avatars/cust-zhou.jpg", mode: "AUTO", latency: "4.6s", excerpt: "已答复柴烧青灰釉 115ml 容量及实拍选货方式", docCited: "窑变釉色差异" },
  { id: "lf3", time: "18:27", platform: "wxkf", account: "售后保障专线", customer: "温景行", avatarUrl: "/avatars/cust-chen.jpg", mode: "AUTO", latency: "2.8s", excerpt: "已引导上传签收破损照片并登记免费顺丰补发", docCited: "7天无理由与补发" },
  { id: "lf4", time: "18:19", platform: "douyin", account: "禾木设计精选号", customer: "江枕月", avatarUrl: "/avatars/cust-lin.jpg", mode: "HUMAN", latency: "14.2s", excerpt: "人工确认发送礼盒手写贺卡内容核对信息", docCited: "礼盒与手写卡" },
];

export const INITIAL_THREADS: ThreadItem[] = [
  {
    id: "thr_dy_dm_01", accountId: "acc_dy_main", channel: "DIRECT_MESSAGE",
    author: "林晚晴", authorTag: "复购老客 · 杭州",
    avatarUrl: "/avatars/cust-lin.jpg", avatarSource: "采集自抖音私信 · 本机受限缓存", unreadCount: 2,
    intentChip: "礼赠咨询", avatarTone: 0,
    targetId: "conv_dy_772019481", status: "WAITING", unread: true, updatedAt: "18:41",
    leaseNote: "你正在编辑 · 已自动保稿", leaseGen: 14,
    customerStats: { visits: 4, orders: 2, city: "浙江 · 杭州", note: "偏好素雅青灰釉，上次购买过主人杯礼盒" },
    relatedItem: { name: "景德镇柴烧手捏粗陶杯（青灰釉）", sku: "HM-CS-115", price: "¥228", stock: "现货 14 只 · 17:00 截单", swatch: "#3d5952", thumbUrl: "/avatars/acc-flagship.jpg" },
    knowledgeHits: ["顺丰发货与截单时间", "礼盒与手写贺卡服务"],
    personaLabel: "温和手作主理人 v2",
    suggestion: "您好，手捏粗陶杯现货今天 17:00 前下单可当天发顺丰；礼盒标配加厚防震内托和免费手写卡，您把想写的祝福语发我就行。",
    altSuggestions: {
      warm: "您好，手捏粗陶杯现货今天 17:00 前下单可当天发顺丰；礼盒标配加厚防震内托和免费手写卡，您把想写的祝福语发我就行。",
      concise: "有现货，17:00 前下单当天顺丰发出，含防震原木礼盒与免费手写贺卡，祝福语直接发我就好。",
      pro: "您好，该款柴烧粗陶杯目前有 14 只现货。每日 17:00 前付款当日顺丰标快寄出，标配原木天地盖礼盒、加厚珍珠棉内托及免费代写贺卡服务，如需代写请在此留言内容。",
    },
    intent: null,
    messages: [
      { id: "m0", dir: "in", time: "18:31", text: "你好，上次在你们家买过一只青灰釉主人杯，朋友特别喜欢。" },
      { id: "m0b", dir: "out", time: "18:33", delivered: true, text: "谢谢您一直喜欢我们的器物！这次是想再挑一只同色系的还是看看新款礼盒装呢？" },
      {
        id: "m1", dir: "in", time: "18:36", text: "看中你们主页这款柴烧手捏粗陶杯，想送朋友当生日礼物。",
        productCard: { name: "景德镇柴烧手捏粗陶杯（青灰釉）", sku: "HM-CS-115", price: "¥228", stock: "现货 14 只 · 17:00 截单", thumbUrl: "/avatars/acc-flagship.jpg" },
      },
      { id: "m2", dir: "in", time: "18:41", text: "请问明天能发出吗？礼盒有没有防震包装和手写贺卡？" },
      { id: "ms1", dir: "sys", time: "18:41", text: "已参考「顺丰发货」「礼盒贺卡」生成建议草稿" },
    ],
  },
  {
    id: "thr_dy_cmt_02", accountId: "acc_dy_main", channel: "COMMENT_NOTIFICATION",
    author: "周明远", authorTag: "作品评论 · 楼中楼",
    avatarUrl: "/avatars/cust-zhou.jpg", avatarSource: "采集自抖音评论 · 本机受限缓存", unreadCount: 1,
    intentChip: "库存挑货", avatarTone: 1,
    targetId: "cmt_root_90182 / child_90219", workTitle: "景德镇柴烧主人杯开窑实拍（11月第3窑）",
    status: "WAITING", unread: true, updatedAt: "18:37", leaseNote: "打开回复框时自动锁定目标", leaseGen: 3,
    customerStats: { visits: 2, orders: 0, city: "江苏 · 苏州", note: "关注柴烧落灰纹理与挑货服务" },
    relatedItem: { name: "11月第3窑 · 柴烧主人杯 115ml", sku: "HM-K3-115", price: "¥268", stock: "余 6 只 · 可实拍挑货", swatch: "#6d746e", thumbUrl: "/avatars/acc-studio.jpg" },
    knowledgeHits: ["窑变釉色差异说明"], personaLabel: "温和手作主理人 v2",
    suggestion: "这窑青灰釉目前还剩 6 只，柴烧落灰每只釉面结晶都略有不同，下单前可以私信发您实拍图挑一只合眼缘的。",
    intent: null, messages: [],
    commentChain: [
      { level: 1, author: "沈知行", time: "17:12", text: "这一窑的青灰釉色真干净，实测容量大概多少毫升？" },
      { level: 2, author: "禾木手作旗舰号（已确认送达）", time: "17:19", text: "谢谢喜欢，这批主人杯满水约 115ml，胎体略厚实，拿在手里比较压手。", own: true },
      { level: 2, author: "周明远", time: "18:37", text: "@禾木手作旗舰号 请问这一窑青灰釉还有现货吗？能不能挑一下纹理？", isTarget: true },
    ],
  },
  {
    id: "thr_wxkf_07", accountId: "acc_wxkf", channel: "DIRECT_MESSAGE",
    author: "宋微澜", authorTag: "售后订单 #6842",
    avatarUrl: "/avatars/cust-song.jpg", avatarSource: "同步自微信客服 · 本机受限缓存", unreadCount: 1,
    intentChip: "破损补发", avatarTone: 2,
    targetId: "wk_ext_usr_330182", status: "WAITING", unread: true, updatedAt: "18:32",
    leaseNote: "官方通道就绪", leaseGen: 1,
    customerStats: { visits: 3, orders: 1, city: "上海 · 徐汇", note: "签收 12 小时内反馈杯盖轻微磕碰" },
    relatedItem: { name: "草木灰釉三才盖碗 130ml", sku: "HM-GW-130", price: "¥318", stock: "单盖可顺丰免费补发", swatch: "#7f8d7c", thumbUrl: "/avatars/acc-wecom.jpg" },
    knowledgeHits: ["7天无理由与破损补发"], personaLabel: "温和手作主理人 v2",
    suggestion: "抱歉让您收到磕碰的杯盖了，麻烦方便时拍张细节图发这里，核对订单 6842 后直接免费给您顺丰补发一只新盖子，原件不用寄回。",
    intent: null,
    messages: [
      { id: "m71", dir: "in", time: "18:32", text: "刚签收的盖碗，杯盖边缘有一点磕碰，可以单独补发一个盖子吗？订单尾号 6842。" },
    ],
  },
  {
    id: "thr_dy_media_03", accountId: "acc_dy_main", channel: "DIRECT_MESSAGE",
    author: "陈思齐", authorTag: "含视频分享与图片",
    avatarUrl: "/avatars/cust-chen.jpg", avatarSource: "采集自抖音私信 · 本机受限缓存", unreadCount: 1,
    intentChip: "媒体待人工", avatarTone: 3,
    targetId: "conv_dy_651004298", status: "MANUAL_ONLY", unread: true, updatedAt: "18:24",
    leaseNote: "支持人工查看后直接回复", leaseGen: 2,
    customerStats: { visits: 1, orders: 0, city: "广东 · 深圳", note: "通过短视频分享询问侧把壶同款" },
    relatedItem: { name: "柴烧黑泥侧把壶 180ml", sku: "HM-CB-180", price: "¥580", stock: "现货 3 把 · 需人工核对款式", swatch: "#2c2b29", thumbUrl: "/avatars/acc-personal.jpg" },
    knowledgeHits: [], personaLabel: "媒体消息不交 AI 猜测", suggestion: null,
    mediaNotice: "该消息包含原生作品分享与本机受限图片预览，按规则不送 AI 猜测，可直接人工回复。",
    intent: null,
    messages: [
      {
        id: "m31", dir: "in", time: "18:23", text: "老板帮我看看这个视频里同款手抓壶还有吗？",
        shareCard: { title: "柴烧黑泥侧把壶 · 断水与出水实测", subtitle: "抖音分享视频", url: "https://www.douyin.com/video/7429084112051", duration: "00:46" },
      },
      { id: "m32", dir: "in", time: "18:24", text: "", imageCard: { label: "客户发送的图片", dimensions: "420 × 560 PNG" } },
    ],
  },
  {
    id: "thr_xhs_mcp_05", accountId: "acc_xhs", channel: "DIRECT_MESSAGE",
    author: "栖山咖啡器具", authorTag: "商业合作 · 杭州",
    avatarUrl: "/avatars/cust-qishan.jpg", avatarSource: "采集自小红书私信 · 本机受限缓存",
    intentChip: "企业定制", avatarTone: 4,
    targetId: "xhs_conv_992014", status: "WAITING", unread: false, updatedAt: "18:09",
    leaseNote: "检测到本机助手草稿更新", leaseGen: 7,
    customerStats: { visits: 5, orders: 1, city: "浙江 · 杭州", note: "精品咖啡馆主理人，询问 30+ 套联名定制" },
    relatedItem: { name: "手冲分享壶与品鉴杯定制方案", sku: "HM-B2B-01", price: "30 只起订", stock: "打样周期 10 天 · 支持专票", swatch: "#8a6d4b", thumbUrl: "/avatars/acc-xhs.jpg" },
    mcpConflict: "本机助手（MCP）于 18:08 写入了新版建议草稿，已完整保留你的本地输入，请核对后再发送。",
    knowledgeHits: ["联名与企业定制起订量"], personaLabel: "温和手作主理人 v2",
    suggestion: "您好，咖啡空间定制支持 30 只起订，可做底部落款印章与礼盒烫印，打样周期约 10 天，可开 13% 增值税专票。",
    intent: null,
    messages: [
      { id: "m51", dir: "in", time: "18:04", text: "你好，我们是杭州独立咖啡馆，想定制一批手冲分享壶和品鉴杯，请问起订量和打样周期怎么算？" },
    ],
  },
  {
    id: "thr_dy_uncertain_04", accountId: "acc_dy_main", channel: "DIRECT_MESSAGE",
    author: "顾清舟", authorTag: "结果未知 · 已冻结",
    avatarUrl: "/avatars/cust-gu.jpg", avatarSource: "采集自抖音私信 · 本机受限缓存",
    intentChip: "冻结待查", avatarTone: 2,
    targetId: "conv_dy_580912344", status: "UNCERTAIN", unread: false, updatedAt: "17:58",
    leaseNote: "已冻结 · 禁止重发", leaseGen: 9,
    customerStats: { visits: 3, orders: 1, city: "北京 · 朝阳", note: "售后补发单号通知回读超时" },
    knowledgeHits: ["7天无理由与破损补发"], personaLabel: "温和手作主理人 v2", suggestion: null,
    intent: {
      intentId: "int_01JDB9X4K2M", commandId: "cmd_88f2a9c1-440e", status: "UNCERTAIN",
      submittedAt: "17:58:06", rechecks: "已完成 2 次只读补证，暂未读到平台落库回执",
      reason: "消息已提交一次但回读超时，为防重复打扰客户已自动冻结本条发送，仅提供只读查证。",
    },
    messages: [
      { id: "m41", dir: "in", time: "17:55", text: "破损照片刚发过了，麻烦确认下什么时候能补发？" },
      { id: "m42", dir: "out", uncertain: true, time: "17:58", text: "您好，已为您登记补发地址，明天上午打包后会同步顺丰单号给您。" },
    ],
  },
  {
    id: "thr_wecom_08", accountId: "acc_wecom", channel: "DIRECT_MESSAGE",
    author: "陆景川 · 茶空间采购", authorTag: "企业客户 · 已确认",
    avatarUrl: "/avatars/cust-gu.jpg", avatarSource: "同步自企微接口 · 本机受限缓存",
    intentChip: "专票报价", avatarTone: 0,
    targetId: "wecom_ext_91042", status: "CONFIRMED", unread: false, updatedAt: "17:42",
    leaseNote: "已收到平台送达回执", leaseGen: 4,
    customerStats: { visits: 8, orders: 3, city: "四川 · 成都", note: "茶空间长期采购客户，需 13% 增值税专票" },
    knowledgeHits: ["联名与企业定制起订量"], personaLabel: "温和手作主理人 v2", suggestion: null,
    intent: {
      intentId: "int_01JDB7M19QX", commandId: "cmd_41a9c7d2-081b", status: "CONFIRMED",
      submittedAt: "17:41:42", rechecks: "企业微信官方回执确认（17:41:43）", reason: null,
    },
    messages: [
      { id: "m81", dir: "in", time: "17:38", text: "上次聊的 50 套茶席定制能开 13% 专票吗？" },
      { id: "m82", dir: "out", time: "17:41", delivered: true, text: "陆总您好，50 套起订支持开具 13% 增值税专票，报价单和釉色样卡已整理好发您参考。" },
    ],
  },
];

export const INITIAL_DOCS: KnowledgeDoc[] = [
  { id: "K-01", topic: "物流发货", title: "顺丰发货与截单时间", channel: "全通道", status: "ENABLED", validUntil: "长期有效", updatedAt: "11-22", hits7d: 146, content: "现货每日 17:00 前付款当日顺丰标快发出；定制件按排窑周期 10-14 天发货。偏远地区补差价说明见商品详情页。" },
  { id: "K-02", topic: "产品工艺", title: "窑变釉色差异说明", channel: "评论 / 私信", status: "ENABLED", validUntil: "长期有效", updatedAt: "11-20", hits7d: 112, content: "手工拉坯与柴烧落灰每只器型与釉面结晶均独一无二，发货前可应要求提供自然光实拍挑货。" },
  { id: "K-03", topic: "包装赠礼", title: "礼盒与手写贺卡服务", channel: "全通道", status: "ENABLED", validUntil: "长期有效", updatedAt: "11-18", hits7d: 89, content: "标配原木色天地盖礼盒与加厚珍珠棉内托，支持免费代写手写卡，下单备注或私信告知祝福语即可。" },
  { id: "K-04", topic: "售后服务", title: "7天无理由与破损补发", channel: "全通道", status: "ENABLED", validUntil: "长期有效", updatedAt: "11-24", hits7d: 134, content: "运输破损凭签收 48 小时内照片免费顺丰补发，破损件无需寄回；完好未使用支持 7 天无理由退换。" },
  { id: "K-05", topic: "企业定制", title: "联名与企业定制起订量", channel: "私信", status: "ENABLED", validUntil: "2026-12-31", updatedAt: "11-15", hits7d: 64, content: "企业礼赠或商业空间定制 30 只起订，支持底款刻章与礼盒烫印，打样周期约 10 天，可开具 13% 增值税专票。" },
  { id: "K-06", topic: "物流发货", title: "大促期间发货时效（同主题冲突）", channel: "全通道", status: "CONFLICT", validUntil: "2026-11-30", updatedAt: "11-24", hits7d: 0, content: "大促期间 72 小时内按顺序发出。与 K-01 同主题命中冲突，系统已自动阻断直接生成，请停用其一或拆分主题。" },
];

export const INITIAL_SAMPLES: ChatSample[] = [
  { id: "S-101", source: "自动收录 · 抖音私信", question: "杯子有磕碰怎么处理？", reply: "抱歉让您收到有磕碰的杯子了，拍张细节图发这里，核对订单直接顺丰补发一只新的，破损件不用寄回。", adopted: true },
  { id: "S-102", source: "自动收录 · 抖音评论", question: "这批主人杯多重？烫手吗？", reply: "单只约 145g，胎体略厚实，冲泡沸水持握杯沿不会明显烫手。", adopted: true },
  { id: "S-103", source: "导入 · CSV 历史记录", question: "多买两只能便宜点吗？", reply: "手工器物成本比较透明，两只以上可以帮您叠加店铺满减券并升级顺丰保价礼盒。", adopted: true },
  { id: "S-104", source: "自动收录 · 企业微信", question: "可以加你私人微信发图吗？", reply: "（含外部联系方式候选，规则已隔离待人工核查，默认未采纳）", adopted: false },
];

export const INITIAL_PERSONAS: PersonaVersion[] = [
  { version: "v2", name: "温和手作主理人", status: "PUBLISHED", createdAt: "2026-11-21 14:20", batches: "单批提炼 · 34 组样本", summary: "句式克制真诚，先致谢或致歉再给可执行方案；少用营销套话，对釉色差异、工期与补发保持透明。" },
  { version: "v1", name: "标准礼貌客服（初版）", status: "ARCHIVED", createdAt: "2026-11-12 10:05", batches: "单批提炼 · 18 组样本", summary: "中性礼貌书面口吻，保留作为随时可回退的基线版本。" },
];

export const INITIAL_MODELS: ModelConnection[] = [
  { id: "conn_deepseek", name: "DeepSeek 官方直连", protocol: "OpenAI Chat", baseUrl: "https://api.deepseek.com/v1", region: "CN-Global", storage: "DPAPI", keyPresent: true, models: ["deepseek-chat", "deepseek-reasoner"], version: 4, callsToday: 492, lastTest: { ok: true, elapsedMs: 618, modelId: "deepseek-chat", tokens: "in 18 / out 12" } },
  { id: "conn_qwen", name: "通义千问（百炼）", protocol: "OpenAI Chat", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", region: "北京", storage: "DPAPI", keyPresent: true, models: ["qwen-plus", "qwen-max"], version: 2, callsToday: 148, lastTest: { ok: true, elapsedMs: 492, modelId: "qwen-plus", tokens: "in 18 / out 14" } },
  { id: "conn_openai", name: "OpenAI Responses", protocol: "OpenAI Responses", baseUrl: "https://api.openai.com/v1", region: "US", storage: "MEMORY", keyPresent: true, models: ["gpt-4.1-mini", "gpt-4.1"], version: 1, callsToday: 44, lastTest: { ok: true, elapsedMs: 842, modelId: "gpt-4.1-mini", tokens: "in 20 / out 11" } },
  { id: "conn_anthropic", name: "Anthropic Claude", protocol: "Anthropic Messages", baseUrl: "https://api.anthropic.com/v1", region: "US", storage: "DPAPI", keyPresent: false, models: ["claude-sonnet-4-5", "claude-haiku-4-5"], version: 1, callsToday: 0, lastTest: null },
];

export const INITIAL_AUDIT: AuditRow[] = [
  { time: "18:41:08", type: "草稿自动保存", scope: "禾木手作旗舰号", entity: "conv_dy_772019481", detail: "本地人稿自动保存并锁定接管代际，旧待审状态已失效" },
  { time: "18:08:11", type: "MCP 草稿更新", scope: "禾木器物志", entity: "xhs_conv_992014", detail: "本机助手写入新版建议草稿，已保留界面未保存人稿未覆盖" },
  { time: "17:58:52", type: "结果未知冻结", scope: "禾木手作旗舰号", entity: "int_01JDB9X4K2M", detail: "2 次只读补证未获平台回执，已冻结该发送并严禁重发" },
  { time: "17:41:43", type: "确认送达", scope: "禾木企业客服", entity: "int_01JDB7M19QX", detail: "唯一发送协调器单次提交，官方回执核验通过" },
  { time: "16:30:02", type: "模型路由切换", scope: "全局配置", entity: "deepseek-chat", detail: "已切换生效模型并绑定本机 DPAPI 加密凭据" },
  { time: "14:22:15", type: "人格版本发布", scope: "禾木手作旗舰号", entity: "温和手作主理人 v2", detail: "基于 34 组已采纳样本发布新版本并绑定指纹" },
];

export const ANALYTICS_SERIES = {
  "7d": [
    { label: "11-19", auto: 248, human: 82, avgSec: 19.2 },
    { label: "11-20", auto: 274, human: 91, avgSec: 18.4 },
    { label: "11-21", auto: 302, human: 76, avgSec: 17.5 },
    { label: "11-22", auto: 339, human: 94, avgSec: 16.8 },
    { label: "11-23", auto: 296, human: 88, avgSec: 17.9 },
    { label: "11-24", auto: 358, human: 102, avgSec: 16.2 },
    { label: "11-25", auto: 331, human: 109, avgSec: 16.9 },
  ],
  "14d": [
    { label: "11-12", auto: 182, human: 94, avgSec: 22.1 },
    { label: "11-14", auto: 215, human: 89, avgSec: 20.6 },
    { label: "11-16", auto: 236, human: 85, avgSec: 19.7 },
    { label: "11-18", auto: 264, human: 79, avgSec: 18.8 },
    { label: "11-20", auto: 274, human: 91, avgSec: 18.4 },
    { label: "11-22", auto: 339, human: 94, avgSec: 16.8 },
    { label: "11-25", auto: 331, human: 109, avgSec: 16.9 },
  ],
  "30d": [
    { label: "第 1 周", auto: 1120, human: 486, avgSec: 22.9 },
    { label: "第 2 周", auto: 1468, human: 512, avgSec: 20.1 },
    { label: "第 3 周", auto: 1842, human: 590, avgSec: 18.0 },
    { label: "第 4 周", auto: 2196, human: 638, avgSec: 16.9 },
  ],
};

export const MCP_TOOLS: Array<[string, string]> = [
  ["inbora_get_status", "只读运行状态、浏览器模式、同步进度与额度摘要"],
  ["inbora_list_inbox", "按状态筛选分页查询已收取消息（每页 20 条）"],
  ["inbora_get_thread", "按准确目标读取有限详情与消息时间线"],
  ["inbora_get_diagnostics", "脱敏聚合指标与安全原因码，不含正文与原日志"],
  ["inbora_inspect_preview", "查询受限媒体预览状态与尺寸，不暴露外链"],
  ["inbora_sync_inbox", "触发一次增量同步并返回任务编号"],
  ["inbora_mark_all_read", "仅标记当前范围已存在记录为已读"],
  ["inbora_set_automatic_reply", "开关既有自动回复策略，不提额或新建规则"],
  ["inbora_refresh_preview", "为指定媒体消息排队刷新本机受限预览"],
  ["inbora_emergency_stop", "触发持久全局急停（助手不具备恢复急停权限）"],
  ["inbora_open_reply", "取得准确文字目标的接管代际与草稿版本"],
  ["inbora_save_draft", "按版本校验写入助手草稿，不覆盖人工输入"],
  ["inbora_generate_suggestion", "复用既有模型授权与额度生成一次回复建议"],
  ["inbora_send_reply", "经唯一发送协调器单次提交并独立回读"],
  ["inbora_get_operation", "按原 UUID 查询结果，断线绝不重放发送"],
  ["inbora_close_reply", "释放助手自身接管并保留草稿"],
];

export const HOURLY_TRAFFIC: Array<{ hour: string; auto: number; human: number }> = [
  { hour: "09", auto: 14, human: 5 },
  { hour: "10", auto: 28, human: 9 },
  { hour: "11", auto: 36, human: 11 },
  { hour: "12", auto: 22, human: 6 },
  { hour: "13", auto: 19, human: 7 },
  { hour: "14", auto: 34, human: 12 },
  { hour: "15", auto: 41, human: 14 },
  { hour: "16", auto: 46, human: 13 },
  { hour: "17", auto: 32, human: 9 },
  { hour: "18", auto: 38, human: 15 },
  { hour: "19", auto: 21, human: 8 },
];

export const TOP_INTENTS: Array<{ label: string; count: number; pct: number; tone: string }> = [
  { label: "礼赠包装与手写贺卡", count: 149, pct: 34, tone: "var(--chart-1)" },
  { label: "顺丰截单与发货时效", count: 123, pct: 28, tone: "var(--chart-3)" },
  { label: "签收磕碰与破损补发", count: 84, pct: 19, tone: "var(--chart-2)" },
  { label: "企业定制与 13% 专票", count: 53, pct: 12, tone: "var(--chart-4)" },
  { label: "窑变釉色实拍挑货", count: 31, pct: 7, tone: "var(--chart-5)" },
];

export const PERSONA_RADAR_AXES: Array<{ label: string; value: number; baseline: number }> = [
  { label: "亲和温度", value: 84, baseline: 56 },
  { label: "事实严谨", value: 96, baseline: 62 },
  { label: "句式精炼", value: 78, baseline: 68 },
  { label: "售后担当", value: 92, baseline: 55 },
  { label: "主动引导", value: 70, baseline: 42 },
];

export const TASK_ROUTING_ROWS: Array<{
  task: string;
  desc: string;
  usesActiveModel: boolean;
  fixedBadge?: string;
  calls: number;
  guard: string;
}> = [
  { task: "自动回复与草稿生成", desc: "结合店铺知识与温和主理人风格生成回复建议", usesActiveModel: true, calls: 492, guard: "不重复扣费" },
  { task: "知识冲突检查与提炼", desc: "自动识别同主题冲突条款并提炼核心回复要点", usesActiveModel: true, calls: 148, guard: "仅整理知识" },
  { task: "试聊效果对比", desc: "上线前预览新风格回复效果，不会发给真实客户", usesActiveModel: true, calls: 44, guard: "试聊不外发" },
  { task: "敏感词与联系方式保护", desc: "发送前自动拦截敏感词、手机号和外部链接", usesActiveModel: false, fixedBadge: "本地规则", calls: 684, guard: "实时拦截" },
];

export const THREAD_CRM_EXTRA: Record<
  string,
  {
    intentScore: number;
    sentiment: string;
    tags: string[];
    orders: Array<{ id: string; date: string; title: string; amount: string; status: string }>;
  }
> = {
  thr_dy_dm_01: {
    intentScore: 92,
    sentiment: "积极 · 高复购转化",
    tags: ["青灰釉偏好", "礼赠高意向", "顺丰加急", "老客复购"],
    orders: [
      { id: "#8821", date: "10-14", title: "青灰釉柴烧主人杯（礼盒装）", amount: "¥268", status: "已签收 · 好评" },
      { id: "#7409", date: "08-29", title: "草木灰釉闻香杯对杯", amount: "¥196", status: "已签收" },
    ],
  },
  thr_dy_cmt_02: {
    intentScore: 78,
    sentiment: "好奇 · 关注品相",
    tags: ["关注柴烧", "实拍挑货", "评论区引流"],
    orders: [],
  },
  thr_wxkf_07: {
    intentScore: 64,
    sentiment: "焦急 · 售后优先",
    tags: ["售后补发", "优先安抚", "订单 #6842"],
    orders: [
      { id: "#6842", date: "11-23", title: "草木灰釉三才盖碗 130ml", amount: "¥318", status: "已签收 · 售后中" },
    ],
  },
  thr_dy_media_03: {
    intentScore: 81,
    sentiment: "明确求购 · 需人工核对",
    tags: ["视频同款", "媒体拦截", "高客单壶类"],
    orders: [],
  },
  thr_xhs_mcp_05: {
    intentScore: 88,
    sentiment: "商业询盘 · B2B 定制",
    tags: ["独立咖啡馆", "30套起订", "需13%专票"],
    orders: [
      { id: "#B102", date: "09-10", title: "样品试喝品鉴杯 4 只装", amount: "¥392", status: "已签收" },
    ],
  },
};

