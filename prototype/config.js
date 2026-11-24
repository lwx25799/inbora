(function () {
  'use strict';
  const P = window.P;
  const E = P.esc;
  const I = (name, size = 20) => P.icon(name, size);
  const B = (text, action, kind = '', icon = '') => P.btn(text, action, kind, icon);
  const tag = (text, tone = 'blue') => P.badge(text, tone);
  const STORE = 'inbora-html-prototype-settings-v1';
  const PROFILE_PATH = String.raw`C:\Users\<用户名>\AppData\Local\inbora\demo-profile`;
  const defaultSettings = {
    startup: true, backup: true, updates: true, notifications: true,
    network: '智能选择（推荐）', retention: '30 天', evidence: '90 天',
    frequency: '每天', copies: '30 份', channel: '稳定版（推荐）',
    install: '提示并手动安装', stopped: false
  };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (_) { /* Local storage is optional. */ }
  P.state.config = {
    ruleGroup: 0, ruleChannel: '评论', ruleEnabled: true, ruleAction: 0,
    rulePreview: false, ruleScope: '全部演示账号', ruleConfidence: '中等信任',
    ruleTime: '工作时间（周一至周五 09:00–18:00）',
    keywords: '怎么用、使用方法、教程、操作步骤',
    simulation: '这个怎么用呀？有详细的使用方法吗？',
    reply: '您好，产品的使用方法很简单，您可以参考这个快速教程：\n1）打开产品包装，核对配件是否齐全；\n2）按照说明书完成首次设置；\n3）如有任何使用问题，随时告诉我，我来帮您解答。',
    aiTab: 'prompt', provider: 'OpenAI', model: 'GPT-4o',
    prompt: '你是抖音个人号「@小橙子」的 AI 客服助手，负责在评论区与私信中和用户友好互动、解答问题、提供建议。请严格遵循账号人设、回复风格与禁答边界；基于知识库内容进行回复。当遇到不确定或超出权限的请求时，先礼貌说明，并在必要时转交人工处理。',
    persona: '小橙子好物店客服。亲切、耐心、了解产品，不做未经确认的承诺。',
    tone: '亲切友好', length: '适中', language: '自然口语',
    assist: true, auto: true, human: true, testText: '',
    testQuestion: '你们这个课程适合零基础吗？大概需要多久能学会？有服务保障吗？',
    testReply: '您好～我们的课程适合零基础的同学。课程从入门到实操循序渐进，配有案例和练习，您可以按自己的节奏学习。同时提供学习答疑、作业点评与社群支持，有具体问题也可以随时告诉我。',
    aiScenario: '私信场景', testCount: 1,
    settingsTab: 'general', settings: { ...defaultSettings, ...saved },
    lastBackup: '今天 02:30', networkTested: false, updated: false
  };
  const S = P.state.config;
  const groups = [
    ['常见问题自动回复', '产品介绍、使用方法、价格等高频问题', 'FAQ', 5],
    ['低风险自动回复', '礼貌性、正向互动、表情与感谢', 'message', 3],
    ['人工审核回复', '涉及售后、投诉、退款等复杂问题', 'users', 3],
    ['黑名单与拦截', '广告引流、恶意骚扰、违规内容', 'shield', 2],
    ['安静时段', '非工作时间的自动回复策略', 'moon', 1],
    ['工作时间', '工作时段的优先响应与分发策略', 'calendar', 2]
  ];
  const ruleFields = ['ruleChannel', 'ruleEnabled', 'ruleAction', 'rulePreview', 'ruleScope', 'ruleConfidence', 'ruleTime', 'keywords', 'simulation', 'reply'];
  const initialRule = Object.fromEntries(ruleFields.map(field => [field, S[field]]));
  const keywordPresets = ['怎么用、使用方法、教程、操作步骤', '谢谢、喜欢、不错、好看', '退款、投诉、售后、坏了', '加微信、广告、刷单', '下班、晚上、休息', '营业、几点、工作时间'];
  const simulationPresets = ['这个怎么用呀？有详细的使用方法吗？', '好看，谢谢你的推荐！', '商品坏了，可以申请退款吗？', '加微信，帮你刷单', '晚上还有客服吗？', '你们几点开始营业？'];
  const replyPresets = [initialRule.reply, '感谢您的喜欢与支持，有任何产品问题都可以告诉我。', '您好，我已记录您的售后诉求，将由人工客服进一步核对并协助处理。', '该内容已标记，由人工核对后决定后续处理。', '您好，已收到您的消息。当前非工作时间，我们将在工作时段尽快回复。', '您好，我们的服务时间是周一至周五 09:00–18:00，欢迎在工作时段咨询。'];
  function ruleDefaults(index) {
    return {
      ...initialRule,
      ruleAction: index === 2 ? 1 : index === 3 ? 3 : 0,
      keywords: keywordPresets[index] || '咨询',
      simulation: simulationPresets[index] || '您好，我想咨询一下。',
      reply: replyPresets[index] || '您好，已收到您的咨询，请告诉我具体问题。'
    };
  }
  const ruleDrafts = groups.map((_, index) => ruleDefaults(index));
  function selectRuleGroup(index) {
    ruleDrafts[S.ruleGroup] = Object.fromEntries(ruleFields.map(field => [field, S[field]]));
    S.ruleGroup = index;
    Object.assign(S, ruleDrafts[index] || ruleDefaults(index));
  }
  const actions = [
    ['自动回复', '直接使用预设回复', 'message'],
    ['生成人工草稿', '生成回复等待编辑', 'file'],
    ['仅标记', '标记会话，不自动回复', 'tag'],
    ['暂停并告警', '暂停处理并提醒', 'alert']
  ];
  function toggle(scope, field, value, label) {
    return `<button class="cfg-switch ${value ? 'on' : ''}" role="switch" aria-checked="${value}" aria-label="${E(label)}" data-action="cfg-toggle" data-scope="${scope}" data-field="${field}"><span></span></button>`;
  }
  function select(field, values, selected = S[field], scope = 'config') {
    return `<select class="input cfg-select" aria-label="${E(field)}" data-change="cfg-select" data-scope="${scope}" data-field="${field}">${values.map(v => `<option${v === selected ? ' selected' : ''}>${E(v)}</option>`).join('')}</select>`;
  }
  function metric(label, number, note, icon, tone) {
    return `<div class="panel cfg-metric"><div class="cfg-metric-icon ${tone}">${I(icon, 26)}</div><div><div class="cfg-metric-label">${label}</div><div class="cfg-metric-value">${number}</div><div class="muted cfg-metric-note">${note}</div></div></div>`;
  }
  function head(icon, title, right = '') {
    return `<div class="section-head cfg-head"><h2>${I(icon)}${title}</h2>${right}</div>`;
  }
  function settingRow(label, content, sub = '') {
    return `<div class="cfg-setting-row"><div class="cfg-setting-label">${label}${sub ? `<small>${sub}</small>` : ''}</div><div class="cfg-setting-control">${content}</div></div>`;
  }
  function choices(field, values) {
    return `<div class="cfg-choices">${values.map(v => `<button class="cfg-choice ${S[field] === v ? 'selected' : ''}" data-action="cfg-choice" data-field="${field}" data-value="${E(v)}">${E(v)}${S[field] === v ? '<span>✓</span>' : ''}</button>`).join('')}</div>`;
  }
  function ruleName() { return S.ruleGroup === 0 ? 'FAQ · 使用方法' : groups[S.ruleGroup][0]; }
  function ruleMatch() {
    const words = S.keywords.split(/[、,，\s]+/).filter(Boolean);
    return S.ruleEnabled && words.some(word => S.simulation.includes(word));
  }
  P.pages.rules = function () {
    const matched = ruleMatch();
    return `<div class="cfg-page cfg-rules">
      <div class="cfg-rule-top"><div class="cfg-segments">${['评论', '私信'].map(ch => `<button class="${S.ruleChannel === ch ? 'active' : ''}" data-action="cfg-rule-channel" data-channel="${ch}">${I(ch === '评论' ? 'message' : 'send', 18)}${ch}规则</button>`).join('')}</div><span class="muted">规则仅在此原型中模拟</span></div>
      <div class="cfg-metrics three">
        ${metric('已启用规则', S.ruleEnabled ? '12' : '11', '<span class="cfg-dot green"></span>自动运行中 · 覆盖常见场景', 'shield', 'green')}
        ${metric('需人工审核的规则', '3', '<span class="cfg-dot amber"></span>复杂诉求由人工处理', 'clock', 'amber')}
        ${metric('已阻止的场景', '7', '<span class="cfg-dot red"></span>涉及违规、争议或高风险内容', 'shield', 'red')}
      </div>
      <div class="cfg-rule-grid">
        <section class="panel cfg-rule-nav">${head('layers', '规则分组', B('管理', 'cfg-manage-groups', 'ghost small'))}
          <div class="cfg-rule-groups">${groups.map((g, n) => `<button class="cfg-rule-group ${n === S.ruleGroup ? 'selected' : ''}" data-action="cfg-rule-group" data-index="${n}"><span class="cfg-group-icon">${g[2] === 'FAQ' ? 'FAQ' : I(g[2], 23)}</span><span><strong>${E(g[0])}</strong><small>${E(g[1])}</small></span><span class="cfg-count">${g[3]}</span></button>`).join('')}</div>
          ${B('新建规则分组', 'cfg-new-group', 'cfg-add-group', 'plus')}
        </section>
        <section class="panel cfg-rule-builder">${head('file', `规则构建：${E(ruleName())}`, `<span class="cfg-inline-label">启用规则 ${toggle('config', 'ruleEnabled', S.ruleEnabled, '启用当前规则')}</span>`)}
          <div class="cfg-pad"><p class="muted cfg-intro">${S.ruleGroup === 0 ? '用户询问产品使用方法时，自动回复标准指引，优先安全、准确、可控。' : groups[S.ruleGroup][1] + '。设置触发条件与处理动作。'}</p>
            <div class="cfg-tags">${tag('Headless 优先', 'green')}${tag('人工接管优先', 'purple')}${tag('单会话单次发送', 'blue')}</div>
            <h3 class="cfg-step"><b>1</b>触发条件 <span>满足以下所有条件时生效</span></h3>
            ${settingRow(`${I('message', 17)}消息类型`, `<label class="cfg-check"><input type="radio" name="rule-channel" data-change="cfg-rule-type" value="评论" ${S.ruleChannel === '评论' ? 'checked' : ''}>评论</label><label class="cfg-check"><input type="radio" name="rule-channel" data-change="cfg-rule-type" value="私信" ${S.ruleChannel === '私信' ? 'checked' : ''}>私信</label>`)}
            ${settingRow(`${I('tag', 17)}关键词`, `<input class="input" aria-label="规则关键词" data-change="cfg-text" data-field="keywords" value="${E(S.keywords)}">`)}
            ${settingRow(`${I('send', 17)}来源渠道`, `<div class="cfg-readonly">♫ 抖音</div>`)}
            ${settingRow(`${I('shield', 17)}目标信任度`, select('ruleConfidence', ['中等信任', '高信任', '全部已确认用户']))}
            ${settingRow(`${I('users', 17)}账号范围`, select('ruleScope', ['全部演示账号', '@好物优选_01', '@穿搭日记_03']))}
            ${settingRow(`${I('calendar', 17)}工作时段`, select('ruleTime', ['工作时间（周一至周五 09:00–18:00）', '每天 09:00–22:00', '全天']))}
            <h3 class="cfg-step"><b>2</b>执行动作 <span>满足条件时的处理结果</span></h3>
            <div class="cfg-action-cards">${actions.map((a, n) => `<button class="cfg-action-card ${S.ruleAction === n ? 'selected' : ''}" data-action="cfg-rule-action" data-index="${n}"><span class="cfg-action-top">${I(a[2], 22)}<i>${S.ruleAction === n ? '●' : '○'}</i></span><strong>${a[0]}</strong><small>${a[1]}</small></button>`).join('')}</div>
          </div>
        </section>
        <section class="panel cfg-rule-preview">${head('play', '预览与模拟', `<div class="cfg-mini-tabs"><button class="${!S.rulePreview ? 'active' : ''}" data-action="cfg-preview-mode" data-value="false">规则预览</button><button class="${S.rulePreview ? 'active' : ''}" data-action="cfg-preview-mode" data-value="true">模拟测试</button></div>`)}
          <div class="cfg-pad cfg-preview-body"><div class="cfg-simulation"><div class="cfg-sim-title"><strong>♫ 模拟用户消息（${S.ruleChannel}）</strong><span class="muted">来自抖音</span></div><div class="cfg-sim-message">${P.avatar('星河漫漫', 1)}<div><strong>@星河漫漫 <small class="muted">1 分钟前</small></strong>${S.rulePreview ? `<textarea class="input cfg-sim-input" aria-label="模拟用户消息" data-change="cfg-text" data-field="simulation">${E(S.simulation)}</textarea>` : `<p>${E(S.simulation)}</p>`}</div></div></div>
            <div class="cfg-match ${matched ? '' : 'unmatched'}"><div class="cfg-match-title"><strong>${I(matched ? 'check' : 'info', 18)}规则匹配结果</strong>${tag(matched ? '符合触发条件' : (S.ruleEnabled ? '未匹配关键词' : '规则已关闭'), matched ? 'green' : 'amber')}</div><dl><dt>匹配规则</dt><dd>${E(ruleName())}</dd><dt>触发条件</dt><dd>${matched ? '✓ ' + S.ruleChannel + ' · 命中关键词 · 演示账号' : '本次模拟不执行回复'}</dd><dt>执行动作</dt><dd>${tag(matched ? actions[S.ruleAction][0] : '保持等待回复', matched ? 'green' : 'gray')}</dd></dl></div>
            <div class="cfg-reply-preview"><div class="cfg-sim-title"><strong>${I('edit', 17)}回复内容预览</strong><span class="muted">可编辑</span></div><textarea class="input" maxlength="500" aria-label="规则回复内容" data-change="cfg-text" data-field="reply">${E(S.reply)}</textarea><div class="cfg-char-note">最多 500 字</div></div>
            <div class="cfg-bottom-actions">${B('重置模拟', 'cfg-reset-rule', '', 'refresh')}${B('运行模拟', 'cfg-test-rule', 'primary', 'play')}</div>
          </div>
        </section>
      </div>
    </div>`;
  };
  const aiTabs = [['prompt', '系统提示词', 'file'], ['persona', '账号人设', 'user'], ['style', '回复风格', 'message'], ['safety', '禁答与边界', 'shield'], ['history', '测试回放', 'play']];
  function aiEditor() {
    if (S.aiTab === 'persona') return `<div class="cfg-editor-title"><h3>${I('user')}账号人设</h3>${tag('演示账号：小橙子')}</div><label class="cfg-field-label" for="cfg-persona">身份、表达习惯与服务范围</label><textarea id="cfg-persona" class="input cfg-prompt" data-change="cfg-text" data-field="persona">${E(S.persona)}</textarea><div class="cfg-note">同一账号的私信与评论使用同一份人设，保持一致的服务体验。</div>`;
    if (S.aiTab === 'safety') return `<div class="cfg-editor-title"><h3>${I('shield')}禁答与安全边界</h3>${tag('优先转交人工', 'green')}</div><div class="cfg-boundary-list">${[['拒绝违规内容', '不生成违法、骚扰或诱导性回复'], ['保护用户隐私', '不透露用户联系方式、账号或私人消息'], ['避免虚假承诺', '只使用知识库中确认的信息'], ['不提供专业诊断', '医疗、法律问题提示咨询专业人员'], ['超出范围转人工', '无法确认的信息由人工继续处理']].map(x => `<div>${I('check', 18)}<span><strong>${x[0]}</strong><small>${x[1]}</small></span>${tag('已启用', 'green')}</div>`).join('')}</div>`;
    if (S.aiTab === 'history') return `<div class="cfg-editor-title"><h3>${I('clock')}测试回放</h3>${tag('仅本次原型')}</div><div class="cfg-history"><span class="cfg-dot green"></span><div><strong>${S.aiScenario} · ${S.model}</strong><p>${E(S.testQuestion)}</p><small class="muted">已完成 ${S.testCount} 次本地模拟 · 未调用模型</small></div>${B('重新模拟', 'cfg-ai-test', 'small')}</div>`;
    if (S.aiTab === 'style') return `<div class="cfg-editor-title"><h3>${I('message')}表达预览</h3>${tag(S.tone, 'blue')}</div><div class="cfg-style-preview">${S.tone === '专业可靠' ? '您好，感谢您的咨询。根据产品说明，该款商品支持七天无理由退货，具体条件以商品详情页为准。' : S.tone === '简洁高效' ? '您好，这款支持七天无理由退货，具体条件可查看商品详情。' : '您好～这款商品支持七天无理由退货，具体条件可以查看商品详情。有其他问题也欢迎告诉我。'}</div><p class="muted">下方调整语气、长度和语言风格，测试沙盒将使用当前选项。</p>`;
    return `<div class="cfg-editor-title"><h3>${I('file')}系统提示词（核心指令）</h3><div class="row">${B('模板中心', 'cfg-template', 'small', 'layers')}${B('优化提示词', 'cfg-optimize', 'small cfg-purple', 'sparkles')}</div></div><textarea class="input cfg-prompt" maxlength="2000" aria-label="系统提示词" data-change="cfg-text" data-field="prompt">${E(S.prompt)}</textarea><div class="cfg-char-note">最多 2,000 字 · 本地演示配置</div>`;
  }
  P.pages.ai = function () {
    return `<div class="cfg-page cfg-ai">
      <div class="cfg-metrics four">${metric('模型服务商', `<button class="cfg-provider" data-action="cfg-provider">${S.provider}${I('chevron-down', 16)}</button>`, '仅演示配置 · 点击切换', 'layers', 'blue')}${metric('默认模型', S.model, '模型选项演示 · 未连接服务', 'cpu', 'green')}${metric('平均响应时长', '410 <small>ms</small>', '<span class="cfg-positive">↓ 12.8%</span> 较昨日 470 ms', 'zap', 'blue')}${metric('今日 Token 成本', '<small>¥</small> 12.36', '<span class="cfg-positive">↓ 18.4%</span> 较昨日 ¥15.15', 'database', 'amber')}</div>
      <div class="cfg-ai-grid"><section class="panel cfg-ai-editor"><div class="cfg-ai-tabs">${aiTabs.map(t => `<button class="${S.aiTab === t[0] ? 'active' : ''}" data-action="cfg-ai-tab" data-tab="${t[0]}">${I(t[2], 19)}${t[1]}</button>`).join('')}</div><div class="cfg-pad">${aiEditor()}
        <div class="cfg-ai-options"><div class="cfg-option-panel"><h3>${I('message', 19)}语气风格</h3>${choices('tone', ['亲切友好', '专业可靠', '简洁高效', '活泼有趣'])}</div><div class="cfg-option-panel"><h3>${I('sliders', 19)}回复长度</h3>${choices('length', ['简短', '适中', '详细', '自定义'])}</div><div class="cfg-option-panel"><h3>${I('globe', 19)}语言风格</h3>${choices('language', ['自然口语', '专业正式', '轻松幽默', '含 Emoji'])}</div><div class="cfg-option-panel"><h3>${I('shield', 19)}安全与守护</h3><div class="cfg-safety-checks"><span>✓ 拒绝违规内容</span><span>✓ 保护用户隐私</span><span>✓ 避免虚假承诺</span><span>✓ 超出范围转人工</span></div></div></div>
        <div class="cfg-ai-toggles">${[['assist', 'AI 辅助', '生成回复建议、改写优化及语气润色。', 'sparkles'], ['auto', '有限自动回复', '高信任、低风险问题按已保存规则处理。', 'send'], ['human', '人工接管优先', '识别复杂诉求或用户要求时转交人工。', 'headphones']].map(t => `<div class="cfg-option-panel"><h3>${I(t[3], 19)}${t[1]}${toggle('config', t[0], S[t[0]], t[1])}</h3><p>${t[2]}</p></div>`).join('')}</div>
        <div class="cfg-save-row"><span class="muted">所有开关仅影响此原型</span>${B('保存配置', 'cfg-save-ai', 'primary', 'check')}</div>
      </div></section>
      <section class="panel cfg-sandbox">${head('flask', '实时测试沙盒', select('aiScenario', ['私信场景', '评论场景']))}<div class="cfg-pad cfg-sandbox-body"><div class="cfg-chat-entry">${P.avatar('星河漫漫', 1)}<div><div class="cfg-chat-caption">用户 @星河漫漫 <span>· ${S.aiScenario} · 刚刚</span></div><div class="cfg-chat-bubble">${E(S.testQuestion)}</div></div></div><div class="cfg-chat-entry"><div class="cfg-bot-avatar">${I('sparkles', 24)}</div><div><div class="cfg-chat-caption">AI 回复 <span>· ${S.model} · 模拟结果</span></div><div class="cfg-chat-bubble bot">${E(S.testReply)}</div></div></div>
        <div class="cfg-evaluation"><h3>${I('chart', 18)}回复评估</h3><div><section><strong>语气风格 ${tag('匹配', 'green')}</strong><small>${S.tone}</small></section><section><strong>合规性 ${tag('通过', 'green')}</strong><small>无违规、无夸大</small></section><section><strong>置信度 ${tag('0.93', 'green')}</strong><small>演示评分</small></section></div></div>
        <div class="cfg-test-composer"><textarea class="input" maxlength="500" aria-label="AI 测试消息" placeholder="输入测试消息（模拟评论或私信）…" data-change="cfg-text" data-field="testText">${E(S.testText)}</textarea><div class="cfg-bottom-actions">${B('填入示例', 'cfg-example', '', 'plus')}${B('发送测试', 'cfg-ai-test', 'primary', 'send')}</div><small class="muted">本地模拟，不联网、不消耗模型额度。</small></div>
      </div></section></div>
    </div>`;
  };
  const settingsTabs = [
    ['general', '常规', '基础运行与启动设置', 'settings'],
    ['browser', '浏览器与登录', '浏览器模式、账号配置与存储', 'monitor'],
    ['network', '网络配置', '网络模式、代理与连通性', 'wifi'],
    ['data', '数据与备份', '本地数据、备份与恢复', 'database'],
    ['security', '安全与权限', '访问控制、数据与操作安全', 'shield'],
    ['logs', '日志与诊断', '运行日志、问题排查与导出', 'file'],
    ['update', '更新', '版本更新、渠道与升级策略', 'refresh']
  ];
  function generalCard() {
    return `<section class="panel cfg-general-card">${head('settings', '常规设置')}<div class="cfg-pad">${settingRow('默认浏览器模式', `<div class="cfg-readonly">${I('monitor', 18)}Headless 无头模式 <span class="muted">无界面运行，保持专属 Profile</span></div>`)}${settingRow('个人资料存储路径', `<div class="cfg-readonly cfg-path">${I('folder', 18)}${E(PROFILE_PATH)}</div>`, '路径展示，不读取本机资料')}${settingRow('开机自动启动后台服务', `${toggle('settings', 'startup', S.settings.startup, '开机自动启动后台服务')}<span>${S.settings.startup ? '已启用' : '已关闭'}</span><small class="muted">仅保存演示偏好</small>`)}</div></section>`;
  }
  function networkCards() {
    return `<section class="panel">${head('wifi', '网络配置')}<div class="cfg-pad">${settingRow('网络模式模板', select('network', ['智能选择（推荐）', '直接连接', '固定代理'], S.settings.network, 'settings'))}<div class="cfg-note">${I('info', 16)}根据演示模板显示网络策略，实际网络不受影响。</div><div class="cfg-card-actions">${B('模板说明', 'cfg-network-template', 'small', 'settings')}</div></div></section><section class="panel">${head('shield', '代理测试')}<div class="cfg-pad"><div class="cfg-proxy-row"><div class="cfg-readonly">http://127.0.0.1:7890</div>${B('测试连通性', 'cfg-network-test', 'primary small', 'play')}</div><div class="cfg-network-result"><strong>${I('check', 21)}${S.networkTested ? '模拟测试完成' : '代理可用（演示）'}</strong><div>延迟 <b>128 ms</b><span>下载 <b>82.4 MB/s</b></span><span>上传 <b>36.7 MB/s</b></span></div></div></div></section>`;
  }
  function dataCard() {
    return `<section class="panel">${head('database', '数据与备份')}<div class="cfg-pad">${settingRow('本地数据库备份', `<span class="cfg-positive">✓</span><small>上次演示：${S.lastBackup}</small>${B('立即备份', 'cfg-backup', 'primary small')}`)}${settingRow('自动备份', `${toggle('settings', 'backup', S.settings.backup, '自动备份')}<span>${S.settings.backup ? '已启用' : '已关闭'}</span>${select('frequency', ['每天', '每周'], S.settings.frequency, 'settings')}${select('copies', ['7 份', '30 份', '90 份'], S.settings.copies, 'settings')}`)}</div></section>`;
  }
  function logCard() {
    return `<section class="panel">${head('file', '日志与截屏')}<div class="cfg-pad">${settingRow('运行日志保留时长', select('retention', ['7 天', '30 天', '90 天'], S.settings.retention, 'settings'))}${settingRow('操作截图证据保留时长', select('evidence', ['30 天', '90 天', '180 天'], S.settings.evidence, 'settings'))}</div></section>`;
  }
  function securityCard() {
    return `<section class="panel">${head('shield', '安全与权限')}<div class="cfg-pad cfg-security-actions">${[['导出演示诊断信息', '查看脱敏的原型环境与配置说明', 'cfg-diagnostics', 'download'], ['清理会话缓存', '仅重置原型中的临时演示状态', 'cfg-clear-cache', 'trash'], ['测试网络连通性', '模拟检查网络与关键服务的连通状态', 'cfg-network-test', 'wifi']].map(a => `<button data-action="${a[2]}">${I(a[3], 23)}<span><strong>${a[0]}</strong><small>${a[1]}</small></span></button>`).join('')}</div></section>`;
  }
  function updateCard() {
    return `<section class="panel">${head('refresh', '更新')}<div class="cfg-pad">${settingRow('更新渠道', select('channel', ['稳定版（推荐）', '预览版'], S.settings.channel, 'settings'))}${settingRow('自动检查更新', `${toggle('settings', 'updates', S.settings.updates, '自动检查更新')}<span>${S.settings.updates ? '已启用' : '已关闭'}</span><small class="muted">演示更新偏好</small>`)}${settingRow('有新版本时', select('install', ['提示并手动安装', '仅通知'], S.settings.install, 'settings'))}<div class="cfg-version"><span>原型版本：v1.0 <span class="cfg-positive">${S.updated ? '✓ 已完成模拟检查' : '独立 HTML 演示'}</span></span>${B('检查更新', 'cfg-update', 'small', 'refresh')}</div></div></section>`;
  }
  function emergencyCard() {
    return `<section class="panel cfg-emergency">${head('alert', '故障处理')}<div class="cfg-pad">${settingRow('全局急停（演示）', `${toggle('settings', 'stopped', S.settings.stopped, '全局急停（演示）')}<span>${S.settings.stopped ? '演示已停止' : '演示运行中'}</span>`)}<p class="muted">原型中仅改变此开关的展示状态，不控制真实采集、模型或发送。</p></div></section>`;
  }
  function settingsContent() {
    switch (S.settingsTab) {
      case 'browser': return `${generalCard()}<section class="panel cfg-wide">${head('shield', '登录与账号隔离')}<div class="cfg-pad cfg-boundary-list"><div>${I('check')}<span><strong>一个账号，一个专属 Profile</strong><small>浏览器由单一持有者管理，登录状态保持隔离。</small></span>${tag('已配置', 'green')}</div><div>${I('monitor')}<span><strong>日常任务使用无头模式</strong><small>正常收取、后台重连与重启延续无头设置。</small></span>${tag('Headless', 'blue')}</div><div>${I('user')}<span><strong>人工处理登录与验证</strong><small>此 HTML 原型不启动浏览器、不访问账号。</small></span></div></div></section>`;
      case 'network': return networkCards();
      case 'data': return `${dataCard()}<section class="panel">${head('folder', '数据保留范围')}<div class="cfg-pad"><p>真实数据库、账号 Profile 与私人消息由应用的私有运行目录管理。</p><div class="cfg-note">本原型只保存界面偏好，不读取、不复制或删除这些资料。</div></div></section>`;
      case 'security': return `${securityCard()}${emergencyCard()}`;
      case 'logs': return `${logCard()}<section class="panel">${head('clock', '最近演示事件')}<div class="cfg-pad cfg-log"><p><span>10:24:16</span>${tag('INFO', 'blue')}原型页面加载完成</p><p><span>10:24:17</span>${tag('INFO', 'blue')}演示数据已准备</p><p><span>10:24:18</span>${tag('INFO', 'blue')}网络请求：0</p>${B('查看诊断说明', 'cfg-diagnostics', 'small')}</div></section>`;
      case 'update': return `${updateCard()}<section class="panel">${head('info', '关于此原型')}<div class="cfg-pad"><h3>inbora HTML 原型</h3><p class="muted">根据项目效果图重建的可交互页面。显示的数值、账号和操作结果都是演示内容。</p><div class="cfg-note">独立于正在运行的 inbora 开发版本，不生成或安装应用包。</div></div></section>`;
      default: return `${generalCard()}${networkCards()}${dataCard()}${logCard()}${securityCard()}${updateCard()}`;
    }
  }
  P.pages.settings = function () {
    return `<div class="cfg-settings-grid"><nav class="panel cfg-settings-nav" aria-label="设置分类">${settingsTabs.map(t => `<button class="${S.settingsTab === t[0] ? 'selected' : ''}" data-action="cfg-settings-tab" data-tab="${t[0]}">${I(t[3], 23)}<span><strong>${t[1]}</strong><small>${t[2]}</small></span>${I('chevron-right', 17)}</button>`).join('')}</nav><div class="cfg-settings-content"><div class="cfg-settings-cards">${settingsContent()}</div><div class="cfg-save-row"><span class="muted">设置仅保存在此浏览器的演示原型中</span>${B('保存设置', 'cfg-save-settings', 'primary', 'check')}</div></div></div>`;
  };
  P.actions['cfg-toggle'] = function (el) {
    const target = el.dataset.scope === 'settings' ? S.settings : S;
    target[el.dataset.field] = !target[el.dataset.field];
    P.render();
  };
  P.changes['cfg-select'] = function (el) {
    const target = el.dataset.scope === 'settings' ? S.settings : S;
    target[el.dataset.field] = el.value;
    if (el.dataset.field === 'aiScenario') P.render();
  };
  P.changes['cfg-text'] = el => { S[el.dataset.field] = el.value; };
  P.changes['cfg-rule-type'] = el => { if (el.checked) { S.ruleChannel = el.value; P.render(); } };
  P.actions['cfg-rule-channel'] = el => { S.ruleChannel = el.dataset.channel; P.render(); };
  P.actions['cfg-rule-group'] = function (el) {
    selectRuleGroup(Number(el.dataset.index));
    P.render();
  };
  P.actions['cfg-rule-action'] = el => { S.ruleAction = Number(el.dataset.index); P.render(); };
  P.actions['cfg-preview-mode'] = el => { S.rulePreview = el.dataset.value === 'true'; P.render(); };
  P.actions['cfg-test-rule'] = function () {
    S.rulePreview = true;
    P.render();
    P.toast(ruleMatch() ? `模拟匹配成功：${actions[S.ruleAction][0]}，未执行真实发送` : '模拟未触发：请检查关键词或启用状态');
  };
  P.actions['cfg-reset-rule'] = function () {
    S.simulation = ruleDefaults(S.ruleGroup).simulation;
    S.rulePreview = false;
    P.render();
    P.toast('模拟消息已重置');
  };
  P.actions['cfg-manage-groups'] = () => P.modal('规则分组说明', '<p>选择左侧分组可编辑触发条件、消息类型和执行动作。所有修改只作用于这份原型。</p><p>点击“新建规则分组”可以在当前演示中添加分组。</p>');
  P.actions['cfg-new-group'] = () => P.modal('新建规则分组', '<label class="cfg-field-label" for="cfg-group-name">分组名称</label><input id="cfg-group-name" class="input" maxlength="24" placeholder="例如：物流进度咨询"><p class="muted">创建后可编辑此分组的触发条件。</p>', B('创建分组', 'cfg-create-group', 'primary'));
  P.actions['cfg-create-group'] = function () {
    const input = document.getElementById('cfg-group-name');
    const name = input.value.trim();
    input.setCustomValidity('');
    if (!name) { input.setCustomValidity('请输入分组名称'); input.reportValidity(); return; }
    groups.push([name, '自定义演示规则', 'file', 1]);
    selectRuleGroup(groups.length - 1);
    P.closeModal(); P.render(); P.toast('已创建演示规则分组');
  };
  P.actions['cfg-choice'] = el => { S[el.dataset.field] = el.dataset.value; P.render(); };
  P.actions['cfg-ai-tab'] = el => { S.aiTab = el.dataset.tab; P.render(); };
  P.actions['cfg-example'] = function () { S.testText = '这款有现货吗？发到杭州要多久？'; P.render(); };
  P.actions['cfg-ai-test'] = function () {
    const question = S.testText.trim() || S.testQuestion;
    S.testQuestion = question;
    S.testCount++;
    if (/退款|退货|售后/.test(question)) S.testReply = '您好，我来帮您了解售后流程。请先查看订单页面的售后入口，具体可退条件以商品详情为准；如果遇到复杂问题，我会转交人工继续处理。';
    else if (/现货|发货|多久|杭州|物流/.test(question)) S.testReply = '您好～这款商品在演示库存中有现货，通常会在下单后 24 小时内发出。杭州地区预计 1–2 天送达，实际时间以物流更新为准。有其他问题欢迎告诉我。';
    else if (/价格|多少|优惠/.test(question)) S.testReply = '您好，具体价格和优惠以商品详情页的实时展示为准。您可以告诉我感兴趣的款式，我帮您整理选购信息。';
    else S.testReply = '您好，收到您的问题了。我会优先查阅相关产品说明与知识库；目前无法确认的内容不做承诺，您也可以选择由人工客服继续协助。';
    if (S.length === '简短') S.testReply = S.testReply.split('。')[0] + '。';
    S.testText = '';
    P.render(); P.toast('本地模拟已完成，未调用真实模型');
  };
  P.actions['cfg-provider'] = () => P.modal('模型服务商（演示）', `<div class="cfg-provider-form"><label>服务商<select id="cfg-provider-select" class="input">${['OpenAI', 'DeepSeek', '通义千问'].map(x => `<option${S.provider === x ? ' selected' : ''}>${x}</option>`).join('')}</select></label><div class="cfg-note">此处只切换界面示例，无需 API Key，不会连接服务商。</div></div>`, `${B('模拟连接', 'cfg-provider-test')}${B('应用示例', 'cfg-provider-save', 'primary')}`);
  P.actions['cfg-provider-test'] = () => P.toast('模拟连接成功，未发送网络请求');
  P.actions['cfg-provider-save'] = function () {
    S.provider = document.getElementById('cfg-provider-select').value;
    S.model = { OpenAI: 'GPT-4o', DeepSeek: 'DeepSeek Chat', '通义千问': 'Qwen Plus' }[S.provider];
    P.closeModal(); P.render(); P.toast('已切换模型演示配置');
  };
  P.actions['cfg-template'] = () => P.modal('客服提示词模板', '<div class="cfg-template-preview"><h3>商品咨询客服</h3><p>亲切回答产品、库存、物流与售后问题。优先引用知识库，未知信息转交人工。保护用户隐私，避免夸大宣传和虚假承诺。</p></div>', B('使用此模板', 'cfg-use-template', 'primary'));
  P.actions['cfg-use-template'] = function () {
    S.prompt = '你是小橙子好物店的客服助手。请亲切回答产品、库存、物流与售后问题，优先引用知识库中的确认信息。对未知信息明确说明并转交人工。保护用户隐私，不夸大宣传、不承诺未经确认的优惠与时效。';
    P.closeModal(); P.render(); P.toast('已应用演示模板');
  };
  P.actions['cfg-optimize'] = function () {
    const addition = '\n回复时先回应用户的核心问题，再给出一个明确的下一步；避免重复问候与冗长解释。';
    if (!S.prompt.includes('先回应用户的核心问题')) S.prompt += addition;
    P.render(); P.toast('已应用本地提示词建议，未调用模型');
  };
  P.actions['cfg-save-ai'] = () => P.toast('AI 配置已保留在本次原型会话中');
  P.actions['cfg-settings-tab'] = el => { S.settingsTab = el.dataset.tab; P.render(); };
  P.actions['cfg-save-settings'] = function () {
    try { localStorage.setItem(STORE, JSON.stringify(S.settings)); P.toast('演示设置已保存，刷新页面后仍保留'); }
    catch (_) { P.toast('浏览器未允许本地存储，设置保留至本页关闭'); }
  };
  P.actions['cfg-network-test'] = function () { S.networkTested = true; P.render(); P.toast('模拟连通性测试完成，未访问代理或网络'); };
  P.actions['cfg-network-template'] = () => P.modal('网络模式模板', '<p><strong>智能选择：</strong>按账号已保存的配置选择网络。</p><p><strong>直接连接：</strong>使用设备当前连接。</p><p><strong>固定代理：</strong>使用账号绑定的代理配置。</p><p class="muted">本页只展示配置结构，不改变系统网络。</p>');
  P.actions['cfg-backup'] = function () { S.lastBackup = '刚刚（模拟成功）'; P.render(); P.toast('备份流程演示完成，未读取或复制真实数据库'); };
  P.actions['cfg-update'] = function () { S.updated = true; P.render(); P.toast('模拟检查完成，不下载或安装软件'); };
  P.actions['cfg-diagnostics'] = () => P.modal('原型诊断信息', '<div class="cfg-diagnostic"><p>运行方式：独立 HTML 页面</p><p>数据来源：本地演示样本</p><p>真实账号连接：无</p><p>模型调用与真实发送：无</p><p>本地保存范围：原型设置偏好</p></div>', B('导出说明', 'cfg-download-diagnostics', 'primary', 'download'));
  P.actions['cfg-download-diagnostics'] = function () {
    const blob = new Blob(['inbora HTML 原型诊断\n运行方式：独立 HTML\n数据：合成演示数据\n真实账号、模型调用、发送：未连接\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'inbora-prototype-diagnostics.txt'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    P.toast('已导出演示诊断说明');
  };
  P.actions['cfg-clear-cache'] = () => P.modal('重置原型临时状态', '<p>将清空 AI 沙盒输入并还原规则测试消息。已保存的设置、真实应用资料和账号数据不会被修改。</p>', B('重置演示状态', 'cfg-confirm-clear', 'primary'));
  P.actions['cfg-confirm-clear'] = function () { S.testText = ''; S.simulation = ruleDefaults(S.ruleGroup).simulation; S.networkTested = false; P.closeModal(); P.render(); P.toast('原型临时状态已重置'); };
}());
