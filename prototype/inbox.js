(function () {
  'use strict';
  const P = window.P;
  const esc = P.esc;
  const seed = [
    { id: 'orange', name: '小橙子', account: '好物优选_01', channel: '私信', time: '10:24', unread: true, status: 'waiting', text: '好的，麻烦帮我查一下到杭州大概什么时候能到？', topic: '高颜值通勤包｜轻便大容量', suggestion: '您好！杭州地区预计 1–2 天送达，具体以物流更新为准。现在下单可以帮您备注加急发货，有其他需要也欢迎随时告诉我～', tags: ['物流时效', '现货说明', '加急发货流程'], messages: [
      { side: 'in', text: '你好，这款有现货吗？多久发货？', time: '10:17' },
      { side: 'out', text: '您好！这款目前有现货，今天 16:00 前下单可当天发出，预计 1–3 天送达（以您所在地物流为准）。需要我帮您确认具体到货时间吗？', time: '10:19' },
      { side: 'in', text: '好的，麻烦帮我查一下到杭州大概什么时候能到？', time: '10:24' }
    ] },
    { id: 'galaxy', name: '星河漫漫', account: '穿搭日记_03', channel: '评论', time: '09:57', unread: true, status: 'waiting', text: '这个颜色还有其他尺码吗？', topic: '秋冬的第一件柔软针织开衫', suggestion: '您好，这款目前有 S、M、L 三个尺码。您可以告诉我平时的穿衣尺码，我帮您参考商品尺码表。', tags: ['尺码指南', '商品信息'], messages: [{ side: 'in', text: '这个颜色还有其他尺码吗？', time: '09:57' }] },
    { id: 'abu', name: '阿布', account: '数码玩家_05', channel: '私信', time: '09:36', unread: false, status: 'replied', text: '好的，了解了，谢谢你。', topic: '桌面无线键盘体验', suggestion: '不客气，很高兴能帮到您！后续使用中有问题，可以随时联系我。', tags: ['产品说明', '售后服务'], messages: [
      { side: 'in', text: '用起来会卡吗？适合日常办公吗？', time: '09:31' },
      { side: 'out', text: '您好，这款支持蓝牙与有线连接，日常文档编辑和办公都可以使用。建议根据设备的接口选择合适的连接方式。', time: '09:33' },
      { side: 'in', text: '好的，了解了，谢谢你。', time: '09:36' }
    ] },
    { id: 'qiqi', name: '七七同学', account: '好物优选_01', channel: '评论', time: '08:51', unread: true, status: 'waiting', text: '这个包能放下 14 寸电脑吗？', topic: '高颜值通勤包｜轻便大容量', suggestion: '您好，包内的电脑隔层适合 14 英寸及以下的笔记本电脑。不同机型尺寸会有差异，建议您对照商品详情中的内部尺寸确认。', tags: ['容量说明', '商品信息'], messages: [{ side: 'in', text: '这个包能放下 14 寸电脑吗？', time: '08:51' }] },
    { id: 'travel', name: '旅行喵', account: '户外生活_02', channel: '私信', time: '昨天', unread: false, status: 'replied', text: '收到，我先收藏一下。', topic: '周末出发，轻装徒步', suggestion: '感谢您的喜欢，有任何关于商品的问题都可以随时留言。', tags: ['退换政策', '售后服务'], messages: [
      { side: 'in', text: '支持七天无理由退换吗？', time: '昨天 22:18' },
      { side: 'out', text: '您好，符合条件的商品支持七天无理由退货。请保持商品完好，具体条件可以查看商品页的售后说明。', time: '昨天 22:20' },
      { side: 'in', text: '收到，我先收藏一下。', time: '昨天 22:21' }
    ] },
    { id: 'lin', name: '林间有风', account: '穿搭日记_03', channel: '评论', time: '昨天', unread: false, status: 'waiting', text: '请问这件可以机洗吗？', topic: '秋冬的第一件柔软针织开衫', suggestion: '您好，建议参考衣服内侧的洗护标签。针织材质推荐轻柔手洗并平铺晾干，避免高温烘干。', tags: ['洗护说明', '商品信息'], messages: [{ side: 'in', text: '请问这件可以机洗吗？', time: '昨天 18:42' }] },
    { id: 'nana', name: '娜娜的日常', account: '好物优选_01', channel: '私信', time: '11/14', unread: false, status: 'replied', text: '包包已经收到了，很喜欢。', topic: '高颜值通勤包｜轻便大容量', suggestion: '谢谢您的反馈！很高兴您喜欢这款包包，祝您每天都有好心情。', tags: ['售后服务', '日常问候'], messages: [
      { side: 'in', text: '包包已经收到了，很喜欢。', time: '11/14 16:02' },
      { side: 'out', text: '感谢您的喜欢！期待它陪您度过每一个轻松的通勤日。', time: '11/14 16:03' }
    ] }
  ];
  seed.forEach((conversation, index) => { conversation.activityOrder = seed.length - index; });
  let latestActivityOrder = seed.length;
  let savedDrafts = {};
  try { savedDrafts = JSON.parse(localStorage.getItem('inbora-prototype-inbox-drafts') || '{}'); } catch (_) {}
  if (!savedDrafts || typeof savedDrafts !== 'object' || Array.isArray(savedDrafts)) savedDrafts = {};
  P.state.inbox = {
    conversations: seed, selected: 'orange', channel: 'all', status: 'all', account: 'all',
    range: '7', search: '', quick: 'all', drafts: savedDrafts, saved: {}, infoTab: 'info',
    reversed: false, filterOpen: true, autoReply: false
  };
  const S = () => P.state.inbox;
  const current = () => S().conversations.find(c => c.id === S().selected);
  const icon = name => P.icon(name, 18);
  const tag = (text, tone) => P.badge(text, tone);
  const stat = c => tag(c.status === 'replied' ? '已回复' : '等待回复', c.status === 'replied' ? 'green' : 'red');
  const avatar = c => P.avatar(c.name, seed.findIndex(v => v.id === c.id));
  const draft = c => typeof S().drafts[c.id] === 'string' ? S().drafts[c.id].slice(0, 500) : '';
  const options = (values, selected) => values.map(([value, text]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${esc(text)}</option>`).join('');

  function filtered() {
    const s = S();
    const items = s.conversations.filter(c => {
      return (s.channel === 'all' || c.channel === s.channel)
        && (s.status === 'all' || c.status === s.status)
        && (s.account === 'all' || c.account === s.account)
        && (s.quick !== 'unread' || c.unread)
        && (s.range !== '1' || /^\d\d:\d\d$/.test(c.time))
        && `${c.name} ${c.account} ${c.text} ${c.topic}`.toLowerCase().includes(s.search.toLowerCase().trim());
    });
    return items.sort((a, b) => s.reversed ? a.activityOrder - b.activityOrder : b.activityOrder - a.activityOrder);
  }

  function renderWithFocus(id) {
    const input = id && document.getElementById(id);
    const start = input?.selectionStart;
    const end = input?.selectionEnd;
    P.render();
    const replacement = id && document.getElementById(id);
    if (replacement) {
      replacement.focus();
      if (typeof start === 'number') replacement.setSelectionRange(start, end);
    }
  }

  function applyFilter() {
    const list = filtered();
    if (!list.some(c => c.id === S().selected)) S().selected = list[0]?.id || null;
  }

  function toolbar() {
    const s = S();
    const counts = type => s.conversations.filter(c => type === 'all' || c.channel === type).length;
    return `<div class="inbox-toolbar">
      <div class="inbox-channel-tabs" aria-label="会话通道">
        ${[['all', '全部', ''], ['私信', '私信', 'message'], ['评论', '评论', 'message']].map(([value, label, glyph]) => `<button class="inbox-channel ${s.channel === value ? 'active' : ''}" data-action="inbox-channel" data-value="${value}" aria-pressed="${s.channel === value}">${glyph ? icon(glyph) : ''}${label}<span>${counts(value)}</span></button>`).join('')}
        <button class="inbox-channel ${s.status === 'waiting' ? 'active' : ''}" data-action="inbox-waiting" aria-pressed="${s.status === 'waiting'}">${icon('clock')}等待回复<span>${s.conversations.filter(c => c.status === 'waiting').length}</span></button>
      </div>
      <label class="inbox-search">${icon('search')}<input id="inbox-search" value="${esc(s.search)}" data-change="inbox-search" placeholder="搜索用户、关键词、会话内容…" aria-label="搜索会话"></label>
      <button class="btn inbox-filter-button" data-action="inbox-filter" aria-expanded="${s.filterOpen}">${icon('filter')}筛选</button>
      <button class="btn" data-action="inbox-sort">${icon('clock')}${s.reversed ? '最早优先' : '最新优先'}</button>
      <button class="btn inbox-icon-button" data-action="inbox-sync" aria-label="同步演示收件箱">${icon('refresh')}</button>
    </div>`;
  }

  function conversationList() {
    const s = S();
    const list = filtered();
    return `<aside class="inbox-left">
      ${s.filterOpen ? `<section class="panel inbox-filters">
        <div class="inbox-section-title"><strong>${icon('filter')}会话筛选</strong><button class="inbox-text-button" data-action="inbox-filter">收起 ${icon('chevronDown')}</button></div>
        <label>管理账号<select data-change="inbox-account">${options([['all', '全部账号'], ...Array.from(new Set(seed.map(c => c.account))).map(v => [v, `@${v}`])], s.account)}</select></label>
        <label>会话状态<select data-change="inbox-status">${options([['all', '全部状态'], ['waiting', '等待回复'], ['replied', '已回复']], s.status)}</select></label>
        <label>时间范围<select data-change="inbox-range">${options([['7', '近 7 天'], ['1', '今天']], s.range)}</select></label>
        <div class="inbox-mini-tabs"><button data-action="inbox-quick" data-value="all" class="${s.quick === 'all' ? 'active' : ''}">全部 <span>${seed.length}</span></button><button data-action="inbox-quick" data-value="unread" class="${s.quick === 'unread' ? 'active' : ''}">未读 <span>${seed.filter(c => c.unread).length}</span></button><button data-action="inbox-reset">重置筛选</button></div>
      </section>` : ''}
      <section class="panel inbox-conversations">
        <div class="inbox-section-title"><strong>${icon('message')}会话列表 <span class="inbox-count">(${list.length})</span></strong><span class="muted inbox-demo-label">演示数据</span></div>
        <div class="inbox-conversation-scroll">${list.length ? list.map(c => `<button class="inbox-conversation ${s.selected === c.id ? 'selected' : ''}" data-action="inbox-select" data-id="${c.id}" aria-pressed="${s.selected === c.id}">
          <div class="inbox-conversation-top">${avatar(c)}<div class="inbox-person"><div class="inbox-person-title"><strong>@${esc(c.name)}</strong><span>${esc(c.time)}${c.unread ? '<i class="inbox-unread-dot"></i>' : ''}</span></div><p>${esc(c.text)}</p></div></div>
          <div class="inbox-conversation-meta">${tag(c.channel, c.channel === '私信' ? 'blue' : 'gray')}<span class="inbox-account-label"><b class="inbox-douyin">♪</b>@${esc(c.account)}</span>${stat(c)}</div>
        </button>`).join('') : '<div class="empty inbox-empty-list">没有符合条件的会话<br><button class="inbox-text-button" data-action="inbox-reset">清除筛选</button></div>'}</div>
      </section>
    </aside>`;
  }

  function messages(c) {
    return `<div class="inbox-messages" id="inbox-messages"><div class="inbox-date"><span>11 月 16 日 · 演示会话</span></div>${c.messages.map(m => `<div class="inbox-message ${m.side === 'out' ? 'outgoing' : 'incoming'}">
      ${m.side === 'in' ? avatar(c) : '<div class="inbox-bot-avatar">i</div>'}
      <div class="inbox-message-body"><div class="inbox-bubble">${esc(m.text).replace(/\n/g, '<br>')}</div><div class="inbox-message-time">${m.side === 'out' ? `<span class="inbox-check">${icon('check')}</span>` : ''}${esc(m.time)}${m.demo ? ' · 模拟发送' : ''}</div></div>
    </div>`).join('')}</div>`;
  }

  function chat(c) {
    if (!c) return '<section class="panel inbox-chat inbox-no-selection"><div class="empty">没有匹配的会话<br>请调整左侧筛选条件</div></section>';
    return `<section class="panel inbox-chat">
      <header class="inbox-chat-header">${avatar(c)}<div class="inbox-chat-person"><strong>@${esc(c.name)}</strong>${tag(`${c.channel}会话`, 'blue')}<p>来源账号：@${esc(c.account)} <span>｜ 抖音个人号</span></p></div>${stat(c)}<button class="inbox-icon-button inbox-text-button" data-action="inbox-profile" aria-label="查看会话用户资料">${icon('more')}</button></header>
      ${messages(c)}
      <section class="inbox-ai-card">
        <div class="inbox-ai-title"><strong>${icon('sparkles')}AI 建议回复</strong><span class="inbox-ai-caption">基于知识库与会话内容</span>${tag('参考建议', 'green')}</div>
        <div class="inbox-ai-response">${esc(c.suggestion)}</div>
        <div class="inbox-ai-tags"><span>引用知识：</span>${c.tags.map(t => `<button data-action="inbox-knowledge" data-title="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      </section>
      <section class="inbox-composer">
        <div class="inbox-composer-heading"><strong>人工发送</strong><span>在工作台内完成回复</span><span class="inbox-demo-label">仅本地演示</span></div>
        <label class="inbox-composer-field"><span class="inbox-sr-only">给 ${esc(c.name)} 的回复</span><textarea id="inbox-draft" data-change="inbox-draft" maxlength="500" placeholder="输入回复内容，或使用上方 AI 建议…">${esc(draft(c))}</textarea><span id="inbox-character-count">${draft(c).length} / 500</span></label>
        <div class="inbox-composer-actions"><button class="inbox-text-button inbox-icon-button" data-action="inbox-phrases" aria-label="插入快捷回复">${icon('message')}</button><span class="inbox-draft-hint" id="inbox-draft-hint">${S().saved[c.id] ? '草稿已保存' : 'Ctrl + Enter 发送'}</span><button class="btn small" data-action="inbox-use-suggestion">${icon('file')}使用 AI 建议</button><button class="btn small" data-action="inbox-save">保存草稿</button><button class="btn primary small" data-action="inbox-send">${icon('send')}发送</button></div>
      </section>
    </section>`;
  }

  function knowledgeContent(title) {
    if (/尺码|容量|商品/.test(title)) return '请根据商品详情页的实测尺寸与材质信息提供说明。不同款式的规格可能不同，回复前请确认当前商品。';
    if (/售后|退换/.test(title)) return '符合条件的商品支持七天无理由退货。商品需保持完好，具体适用条件以商品页售后说明为准。';
    if (/洗护/.test(title)) return '洗护方式以衣物内侧标签为准。针织材质建议轻柔手洗，平铺晾干，避免高温烘干。';
    return '现货商品通常在付款后 24 小时内发货。杭州地区预计 1–2 天送达，实际送达时间以承运方的物流信息为准。可为客户备注加急，不承诺固定到达时间。';
  }

  function info(c) {
    if (!c) return '<aside class="panel inbox-info"><div class="empty">选择一条会话查看详情</div></aside>';
    const sent = c.messages.filter(m => m.side === 'out').slice().reverse();
    return `<aside class="panel inbox-info">
      <div class="inbox-info-tabs"><button class="${S().infoTab === 'info' ? 'active' : ''}" data-action="inbox-info-tab" data-value="info">会话信息</button><button class="${S().infoTab === 'ai' ? 'active' : ''}" data-action="inbox-info-tab" data-value="ai">AI 工具</button></div>
      ${S().infoTab === 'ai' ? `<section class="inbox-info-section"><h3>${icon('sparkles')}回复助手</h3><p class="muted">选择一种表达方式，调整当前建议。此处为本地预设演示。</p><div class="inbox-tone-options">${[['friendly', '亲切自然'], ['brief', '简洁直接'], ['formal', '专业正式']].map(([key, text]) => `<button class="btn" data-action="inbox-tone" data-value="${key}">${text}</button>`).join('')}</div><div class="inbox-ai-tool-note">${icon('shield')}使用建议前，请核对商品与订单信息。</div></section>` : `<section class="inbox-info-section"><h3>${icon('users')}来源信息</h3><dl class="inbox-source"><dt>渠道类型</dt><dd><b class="inbox-douyin">♪</b>${c.channel}（抖音）</dd><dt>来源账号</dt><dd>@${esc(c.account)}</dd><dt>用户</dt><dd>@${esc(c.name)}<button class="inbox-text-button" data-action="inbox-profile">用户资料 ${icon('chevronRight')}</button></dd></dl><div class="inbox-related-label">关联内容</div><button class="inbox-related" data-action="inbox-content"><div class="inbox-content-placeholder">${icon('play')}<span>作品预览</span></div><span><strong>${esc(c.topic)}</strong><small>${c.channel === '评论' ? '回复此作品下的一级评论' : '来自用户咨询的关联作品'}</small></span>${icon('chevronRight')}</button></section>`}
      <section class="inbox-info-section"><h3>${icon('book')}知识建议 <small>（${c.tags.length} 条）</small><button class="inbox-text-button" data-action="inbox-all-knowledge">全部知识 ${icon('chevronRight')}</button></h3><div class="inbox-knowledge-list">${c.tags.map(t => `<button data-action="inbox-knowledge" data-title="${esc(t)}"><span class="inbox-file-icon">${icon('file')}</span><span>${esc(t)}</span>${icon('chevronRight')}</button>`).join('')}</div></section>
      <section class="inbox-info-section"><h3>${icon('shield')}回复提示</h3><div class="inbox-safety">${icon('check')}发送前请核对具体信息</div><p class="inbox-safety-description">原型使用预设建议；未调用模型或真实合规审核。</p></section>
      <section class="inbox-info-section inbox-history"><h3>${icon('clock')}发送记录 <small>（${sent.length} 次）</small></h3>${sent.length ? sent.slice(0, 3).map(m => `<div class="inbox-history-item"><i>${icon('check')}</i><div><strong>${m.demo ? '已模拟发送' : '已回复（示例）'}</strong><time>${esc(m.time)}</time><p>${esc(m.text)}</p></div></div>`).join('') : '<p class="muted">这条会话还没有回复记录。</p>'}</section>
    </aside>`;
  }

  P.pages.inbox = () => {
    const c = current();
    return `${toolbar()}<div class="inbox-workspace">${conversationList()}${chat(c)}${info(c)}</div>`;
  };

  P.actions['inbox-select'] = el => {
    S().selected = el.dataset.id;
    const c = current();
    if (c) c.unread = false;
    P.render();
  };
  P.actions['inbox-channel'] = el => {
    S().channel = el.dataset.value;
    S().status = 'all';
    applyFilter();
    P.render();
  };
  P.actions['inbox-waiting'] = () => {
    S().status = S().status === 'waiting' ? 'all' : 'waiting';
    applyFilter();
    P.render();
  };
  P.actions['inbox-quick'] = el => { S().quick = el.dataset.value; applyFilter(); P.render(); };
  P.actions['inbox-sort'] = () => { S().reversed = !S().reversed; P.render(); };
  P.actions['inbox-filter'] = () => { S().filterOpen = !S().filterOpen; P.render(); };
  P.actions['inbox-reset'] = () => {
    Object.assign(S(), { channel: 'all', status: 'all', account: 'all', range: '7', search: '', quick: 'all' });
    applyFilter();
    P.render();
  };
  P.actions['inbox-sync'] = () => P.toast('演示收件箱已刷新，当前没有新的示例消息');
  P.changes['inbox-search'] = el => { S().search = el.value; applyFilter(); renderWithFocus('inbox-search'); };
  for (const key of ['account', 'status', 'range']) {
    P.changes[`inbox-${key}`] = el => { S()[key] = el.value; applyFilter(); P.render(); };
  }
  P.changes['inbox-draft'] = el => {
    const c = current();
    if (!c) return;
    S().drafts[c.id] = el.value;
    S().saved[c.id] = false;
    document.getElementById('inbox-character-count').textContent = `${el.value.length} / 500`;
    document.getElementById('inbox-draft-hint').textContent = '尚未保存 · Ctrl + Enter 发送';
  };

  function persistDrafts() {
    try { localStorage.setItem('inbora-prototype-inbox-drafts', JSON.stringify(S().drafts)); return true; }
    catch (_) { P.toast('浏览器未允许本地保存，草稿仍保留在本次页面中'); return false; }
  }
  P.actions['inbox-save'] = () => {
    const c = current();
    if (!c) return;
    if (persistDrafts()) {
      S().saved[c.id] = true;
      P.render();
      P.toast('该会话的演示草稿已保存到当前浏览器');
    }
  };
  P.actions['inbox-use-suggestion'] = () => {
    const c = current();
    if (!c) return;
    const existing = draft(c);
    if (existing.trim() && existing !== c.suggestion) {
      P.modal('替换当前草稿？', '<p>编辑区已有文字。使用 AI 建议会替换这条会话的当前草稿。</p>', '<button class="btn" data-action="inbox-close">保留草稿</button><button class="btn primary" data-action="inbox-replace">使用建议</button>');
      return;
    }
    replaceSuggestion();
  };
  function replaceSuggestion() {
    const c = current();
    if (!c) return;
    S().drafts[c.id] = c.suggestion;
    S().saved[c.id] = false;
    P.closeModal();
    P.render();
    document.getElementById('inbox-draft')?.focus();
    P.toast('建议已填入编辑区，可继续修改');
  }
  P.actions['inbox-replace'] = replaceSuggestion;
  P.actions['inbox-close'] = () => P.closeModal();
  P.actions['inbox-send'] = () => {
    const c = current();
    if (!c) return;
    const text = draft(c);
    if (!text.trim()) { P.toast('请先输入回复内容'); document.getElementById('inbox-draft')?.focus(); return; }
    c.messages.push({ side: 'out', text, time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }), demo: true });
    c.status = 'replied';
    c.unread = false;
    c.text = text;
    c.time = c.messages[c.messages.length - 1].time;
    c.activityOrder = ++latestActivityOrder;
    S().drafts[c.id] = '';
    S().saved[c.id] = false;
    persistDrafts();
    P.render();
    const box = document.getElementById('inbox-messages');
    if (box) box.scrollTop = box.scrollHeight;
    P.toast('已模拟发送，仅更新当前原型，没有向抖音发送消息');
  };
  P.actions['inbox-info-tab'] = el => { S().infoTab = el.dataset.value; P.render(); };
  P.actions['inbox-profile'] = () => {
    const c = current();
    if (!c) return;
    P.modal(`@${c.name} · 演示用户资料`, `<div class="inbox-profile-modal">${avatar(c)}<div><strong>@${esc(c.name)}</strong><p>来源：${esc(c.channel)} · @${esc(c.account)}</p></div></div><dl class="inbox-modal-details"><dt>会话状态</dt><dd>${c.status === 'waiting' ? '等待回复' : '已回复'}</dd><dt>咨询主题</dt><dd>${esc(c.topic)}</dd><dt>消息数量</dt><dd>${c.messages.length} 条演示消息</dd></dl>`);
  };
  P.actions['inbox-content'] = () => {
    const c = current();
    if (!c) return;
    P.modal('关联作品', `<div class="inbox-work-preview">${P.icon('play', 36)}<strong>${esc(c.topic)}</strong><p>@${esc(c.account)}</p><span>原型未接入视频素材</span></div><p class="muted">此处展示会话与作品的关联位置，未读取真实账号或作品。</p>`);
  };
  P.actions['inbox-knowledge'] = el => {
    const title = el.dataset.title || '知识详情';
    P.modal(title, `<div class="inbox-knowledge-modal">${tag('共享知识 · 示例', 'blue')}<h3>${esc(title)}</h3><p>${esc(knowledgeContent(title))}</p><p class="muted">适用范围：当前演示账号 · 版本 v3.2</p></div>`);
  };
  P.actions['inbox-all-knowledge'] = () => {
    const c = current();
    if (!c) return;
    P.modal('本会话的知识建议', c.tags.map(t => `<section class="inbox-knowledge-modal"><h3>${esc(t)}</h3><p>${esc(knowledgeContent(t))}</p></section>`).join(''));
  };
  const phrases = ['您好，很高兴为您服务。', '感谢您的耐心等待，我帮您确认一下。', '谢谢您的喜欢，有问题欢迎随时联系。'];
  P.actions['inbox-phrases'] = () => P.modal('快捷回复', `<div class="inbox-phrase-list">${phrases.map((p, i) => `<button class="btn" data-action="inbox-insert-phrase" data-index="${i}">${esc(p)}</button>`).join('')}</div>`);
  P.actions['inbox-insert-phrase'] = el => {
    const c = current();
    if (!c) return;
    const text = phrases[Number(el.dataset.index)];
    const combined = draft(c) ? `${draft(c)}\n${text}` : text;
    if (combined.length > 500) { P.toast('插入后超过 500 字，请先精简当前草稿'); return; }
    S().drafts[c.id] = combined;
    S().saved[c.id] = false;
    P.closeModal();
    P.render();
    document.getElementById('inbox-draft')?.focus();
  };
  P.actions['inbox-tone'] = el => {
    const c = current();
    if (!c) return;
    if (!c.originalSuggestion) c.originalSuggestion = c.suggestion;
    const original = c.originalSuggestion;
    if (el.dataset.value === 'brief') c.suggestion = original.split(/[。！]/).filter(Boolean).slice(0, 2).join('。') + '。';
    else if (el.dataset.value === 'formal') c.suggestion = '您好，感谢您的咨询。' + original.replace(/^您好[！!，,]?/, '').replace(/[～~]/g, '。');
    else c.suggestion = original;
    P.render();
    P.toast('已切换预设表达方式，编辑区的草稿保持不变');
  };
  document.addEventListener('keydown', event => {
    if (event.ctrlKey && event.key === 'Enter' && document.activeElement?.id === 'inbox-draft') {
      event.preventDefault();
      P.actions['inbox-send']();
    }
  });
}());
