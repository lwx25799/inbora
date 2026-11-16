(function () {
  'use strict';
  const P = window.P;
  const escape = value => P.esc(String(value ?? ''));
  const icon = (name, size = 18) => P.icon(name, size);
  const names = ['小橙子', '星河漫漫', '阿布', '好物优选_01', '穿搭日记_03', '数码玩家_05', '居家好物', '旅行日记', '美食探店', '运动健身', '职场成长', '读书分享', '情感树洞', '摄影笔记', '宠物日常', '汽车生活', '母婴好物', '理财小课', '游戏资讯', 'AI工具箱'];
  const categories = ['美妆', '生活', '数码', '好物', '穿搭', '数码', '家居', '旅行', '美食', '运动', '职场', '教育', '情感', '摄影', '宠物', '汽车', '母婴', '财经', '游戏', 'AI工具'];
  const accountIds = ['xiaochengzi', 'xinghemanman', 'abu_6688', 'haowu_01', 'chuanda_03', 'shuma_05'];
  const accountState = P.state.managementAccounts ||= {
    query: '', filter: '全部账号', category: '全部分类', selected: 0, checked: [], page: 1, pageSize: 20,
    rows: names.map((name, i) => ({
      id: i, name, handle: accountIds[i] || `inbora_demo_${String(i + 1).padStart(2, '0')}`,
      category: categories[i], status: [7, 14].includes(i) ? '异常' : [10, 19].includes(i) ? '待登录' : '在线',
      network: i % 3 === 0 ? '固定代理' : i % 3 === 1 ? '直连' : '节点（上海）',
      heat: ['HOT', 'WARM', 'COLD'][i % 3], pending: [3, 1, 0, 0, 2, 0, 0, 3, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 0, 1][i],
      synced: `今天 ${i < 7 ? '10' : '09'}:${String(24 - i).padStart(2, '0')}`,
      auto: i % 4 !== 3
    }))
  };
  const knowledgeData = [
    ['发货政策', '物流配送', '售后', '共享知识', '商品与服务', '3.2', [
      ['一般多久发货？', '现货商品在订单付款后 24 小时内发货，预售商品会在商品详情页标注预计发货时间。'],
      ['支持哪些快递？', '目前支持顺丰、京东、圆通、中通等快递，系统会根据收货地址和时效自动选择合适的快递。'],
      ['可以修改收货地址吗？', '在订单发货前可以修改，请尽快联系我们的客服处理；订单发出后暂不支持修改。']
    ]],
    ['尺码指南', '商品信息', '尺码', '共享知识', '商品信息', '2.5', [
      ['应该如何选择尺码？', '请以商品详情页的尺码表为准，结合实际身体数据选择。处于两个尺码之间时，可以咨询客服确认。'],
      ['不同款式的尺码一样吗？', '不同款式的版型存在差异，请单独核对当前商品的尺码说明。']
    ]],
    ['退款说明', '售后', '退款', '共享知识', '售后政策', '4.1', [
      ['退款多久到账？', '退款申请审核通过后，将按原支付渠道退回，具体到账时间以支付渠道为准。'],
      ['如何申请退款？', '请在订单详情页提交售后申请，并按页面提示补充相关资料。']
    ]],
    ['品牌语气规范', '客服话术', '品牌调性', '账号私有', '售前咨询', '1.8', [
      ['回复时使用什么语气？', '保持亲切、准确和简洁。先回应用户的具体问题，再提供必要的下一步说明，避免夸大承诺。']
    ]],
    ['联系方式边界', '合规', '风险控制', '共享知识', '敏感规则', '1.3', [
      ['可以索取用户联系方式吗？', '仅在实际服务需要且取得用户同意时处理必要的信息。禁止索取无关的敏感个人信息。']
    ]],
    ['商品保修政策', '售后', '保修', '共享知识', '售后政策', '2.0', [
      ['商品可以保修吗？', '保修范围和期限以当前商品详情页与随附保修凭证为准，请提供订单信息供客服核对。']
    ]],
    ['优惠券使用规则', '活动规则', '优惠', '共享知识', '售前咨询', '1.6', [
      ['优惠券可以叠加吗？', '请查看对应优惠券的使用门槛、有效期及叠加说明，以订单结算页展示的优惠为准。']
    ]],
    ['订单修改与取消', '订单', '修改取消', '账号私有', '售后政策', '2.4', [
      ['订单可以取消吗？', '未发货订单可以在订单页申请取消。已发货订单请按平台售后流程处理。']
    ]],
    ['敏感话题应答规范', '敏感规则', '合规', '共享知识', '敏感规则', '1.7', [
      ['遇到无法准确回答的问题怎么办？', '说明已知信息与限制，必要时转交人工处理，不编造专业意见或未经证实的结论。']
    ]],
    ['发票开具说明', '财务', '发票', '共享知识', '售后政策', '2.1', [
      ['如何申请发票？', '请在订单页选择申请发票，核对发票抬头及必要的信息后提交。开票进度可在订单中查看。']
    ]]
  ];
  const knowledgeState = P.state.managementKnowledge ||= {
    query: '', category: '全部知识', scope: '全部范围', status: '全部状态', selected: 0, tab: '内容预览', checked: [],
    rows: knowledgeData.map((d, i) => ({ id: i, title: d[0], tags: d.slice(1, 3), scope: d[3], category: d[4], version: d[5], qa: d[6], status: i === 4 ? '草稿' : '已发布', updated: i < 2 ? `今天 ${i ? '09:57' : '10:24'}` : `11月${15 - Math.floor(i / 2)}日 16:20`, history: [] }))
  };
  function button(text, action, extra = '', kind = '') {
    return `<button type="button" class="btn ${kind}" data-action="${action}" ${extra}>${text}</button>`;
  }
  function stat(label, value, note, glyph, tone = 'blue') {
    return `<div class="panel mg-stat"><span class="mg-stat-icon ${tone}">${icon(glyph, 26)}</span><div><div class="mg-stat-label">${label}</div><strong class="mg-stat-value">${value}</strong><div class="mg-stat-note">${note}</div></div><span class="mg-stat-arrow">${icon('chevron-right', 15)}</span></div>`;
  }
  function statusBadge(value) {
    return P.badge(`● ${value}`, value === '在线' || value === '已发布' ? 'green' : value === '异常' ? 'red' : 'gray');
  }
  function heatBadge(heat) { return P.badge(heat, heat === 'HOT' ? 'red' : heat === 'WARM' ? 'amber' : 'blue'); }
  function selectedAccount() { return accountState.rows.find(row => row.id === accountState.selected) || accountState.rows[0]; }
  function selectedKnowledge() { return knowledgeState.rows.find(row => row.id === knowledgeState.selected) || knowledgeState.rows[0]; }
  function focusRender(el, selector) {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    P.render();
    const next = document.querySelector(selector);
    if (next) {
      next.focus();
      if (start !== null && typeof next.setSelectionRange === 'function') next.setSelectionRange(start, end);
    }
  }
  function filterAccounts() {
    return accountState.rows.filter(row => (accountState.filter === '全部账号' || row.status === accountState.filter)
      && (accountState.category === '全部分类' || row.category === accountState.category)
      && `${row.name} ${row.handle} ${row.category}`.toLowerCase().includes(accountState.query.toLowerCase()));
  }
  function accountTable() {
    const rows = filterAccounts();
    const pages = Math.max(1, Math.ceil(rows.length / accountState.pageSize));
    accountState.page = Math.min(accountState.page, pages);
    const visible = rows.slice((accountState.page - 1) * accountState.pageSize, accountState.page * accountState.pageSize);
    return `<div class="panel mg-account-list"><div class="table-wrap"><table class="mg-account-table"><thead><tr><th><input type="checkbox" aria-label="选择当前页账号" data-change="mg-account-check-all" ${visible.length && visible.every(r => accountState.checked.includes(r.id)) ? 'checked' : ''}></th><th>账号信息</th><th>分类</th><th>登录状态</th><th>浏览器模式</th><th>网络模式</th><th>浏览器池</th><th>最后同步</th><th>待处理</th><th>操作</th></tr></thead><tbody>
      ${visible.map(row => `<tr class="${row.id === accountState.selected ? 'selected' : ''}"><td><input type="checkbox" aria-label="选择 ${escape(row.name)}" data-change="mg-account-check" data-id="${row.id}" ${accountState.checked.includes(row.id) ? 'checked' : ''}></td><td><button class="mg-person" data-action="mg-account-select" data-id="${row.id}">${P.avatar(row.name, row.id)}<span><strong>@${escape(row.name)}</strong><small>抖音号：${escape(row.handle)}</small></span></button></td><td>${P.badge(escape(row.category), row.id % 2 ? 'blue' : 'purple')}</td><td>${statusBadge(row.status)}</td><td><span class="mg-inline">${icon('monitor', 15)} Headless</span></td><td>${escape(row.network)}</td><td>${heatBadge(row.heat)}</td><td class="mg-nowrap">${row.synced}</td><td>${row.pending ? P.badge(row.pending, 'red') : '<span class="muted">—</span>'}</td><td>${button('管理', 'mg-account-select', `data-id="${row.id}"`, 'small')}</td></tr>`).join('')}
      ${visible.length ? '' : '<tr><td colspan="10"><div class="empty">没有找到匹配的账号，请调整筛选条件。</div></td></tr>'}
    </tbody></table></div><div class="mg-pagination"><span>共 ${rows.length} 条${accountState.checked.length ? ` · 已选 ${accountState.checked.length} 个` : ''}</span><div class="row">${button(icon('chevron-left', 15), 'mg-account-page', `data-step="-1" aria-label="上一页" ${accountState.page === 1 ? 'disabled' : ''}`, 'small')}<span class="mg-page-current">${accountState.page}</span><span class="muted">/ ${pages}</span>${button(icon('chevron-right', 15), 'mg-account-page', `data-step="1" aria-label="下一页" ${accountState.page === pages ? 'disabled' : ''}`, 'small')}<select aria-label="每页账号数量" data-change="mg-account-page-size"><option value="20" ${accountState.pageSize === 20 ? 'selected' : ''}>每页 20 条</option><option value="10" ${accountState.pageSize === 10 ? 'selected' : ''}>每页 10 条</option></select></div></div></div>`;
  }
  function detailLine(glyph, title, content) {
    return `<div class="mg-detail-line"><span class="mg-detail-label">${icon(glyph, 17)}${title}</span><div>${content}</div></div>`;
  }
  function accountDetail() {
    const row = selectedAccount();
    return `<aside class="panel mg-account-detail"><div class="section-head"><h3>账号详情</h3>${P.badge(row.status === '在线' ? '安全运行中' : '需要关注', row.status === '在线' ? 'green' : 'amber')}</div><div class="mg-profile">${P.avatar(row.name, row.id, 'large')}<div><h3>@${escape(row.name)}</h3><p class="muted">抖音号：${escape(row.handle)}</p></div>${P.badge(escape(row.category), 'purple')}</div><div class="mg-sync-status">${statusBadge(row.status)}<span>最后同步：${row.synced}</span>${button(icon('refresh', 17), 'mg-account-sync', 'aria-label="模拟同步账号"', 'ghost small')}</div>
      ${detailLine('folder', '配置文件', `<span class="mg-detail-value">专属 Profile · ${escape(row.handle)}</span>`)}
      ${detailLine('globe', '绑定网络出口', `${escape(row.network)} ${P.badge('32 ms', 'green')}`)}
      ${detailLine('layers', 'Token 使用', '<span>7,320 / 10,000（73.2%）</span><div class="mg-progress"><span style="width:73.2%"></span></div>')}
      ${detailLine('sparkles', 'AI 自动回复', `<span>${row.auto ? '已开启' : '已关闭'}</span><button type="button" class="mg-switch ${row.auto ? 'on' : ''}" role="switch" aria-label="此演示账号自动回复" aria-checked="${row.auto}" data-action="mg-account-auto"></button>`)}
      ${detailLine('clock', '业务时段', '每天 09:00 – 22:00')}
      ${detailLine('monitor', '浏览器模式', 'Headless（无界面运行）')}
      ${detailLine('layers', '浏览器池状态', heatBadge(row.heat))}
      ${detailLine('shield', '账号健康度', statusBadge(row.status === '在线' ? '在线' : row.status))}
      <div class="mg-detail-actions"><a class="btn primary" href="#inbox">${icon('message', 18)}打开会话</a>${button(`${icon('edit', 18)} 编辑账号`, 'mg-account-edit')}${button(`${icon('file', 18)} 查看日志`, 'mg-account-log')}</div><p class="mg-demo-note">当前为演示账号，不访问真实 Profile。</p></aside>`;
  }
  P.pages.accounts = () => {
    const count = status => accountState.rows.filter(r => r.status === status).length;
    return `<section class="mg-page"><div class="mg-stats five">${stat('账号总数', accountState.rows.length, '配置容量 30', 'users')}${stat('在线账号', count('在线'), `在线率 ${(count('在线') / accountState.rows.length * 100).toFixed(1)}%`, 'monitor', 'green')}${stat('浏览器池配置', accountState.rows.length, '已绑定配置文件', 'layers')}${stat('异常账号', count('异常'), `需处理 ${count('异常')} 项`, 'alert', 'red')}${stat('待登录账号', count('待登录'), '未完成登录', 'send', 'cyan')}</div><div class="panel mg-account-toolbar"><div class="mg-filter-tabs">${['全部账号', '在线', '异常', '待登录'].map(label => button(`${label} <span>${label === '全部账号' ? accountState.rows.length : count(label)}</span>`, 'mg-account-filter', `data-value="${label}"`, `${accountState.filter === label ? 'primary' : ''} mg-filter-tab`)).join('')}</div><label class="mg-search">${icon('search', 18)}<input id="mg-account-search" type="search" placeholder="搜索账号名称、抖音号或分类..." value="${escape(accountState.query)}" data-change="mg-account-search" aria-label="搜索账号"></label>${button(`${icon('filter', 16)} 筛选`, 'mg-account-category')}${button('批量操作', 'mg-account-batch')}${button(`${icon('plus', 17)} 添加账号`, 'mg-account-add', '', 'primary')}</div><div class="mg-account-layout">${accountTable()}${accountDetail()}</div></section>`;
  };
  P.actions['mg-account-filter'] = el => { accountState.filter = el.dataset.value; accountState.page = 1; P.render(); };
  P.changes['mg-account-search'] = el => { accountState.query = el.value; accountState.page = 1; focusRender(el, '#mg-account-search'); };
  P.actions['mg-account-select'] = el => { accountState.selected = Number(el.dataset.id); P.render(); };
  P.actions['mg-account-page'] = el => { accountState.page += Number(el.dataset.step); P.render(); };
  P.changes['mg-account-page-size'] = el => { accountState.pageSize = Number(el.value); accountState.page = 1; P.render(); };
  P.changes['mg-account-check'] = el => {
    const id = Number(el.dataset.id);
    accountState.checked = el.checked ? [...new Set([...accountState.checked, id])] : accountState.checked.filter(v => v !== id);
    P.render();
  };
  P.changes['mg-account-check-all'] = el => {
    const ids = filterAccounts().slice((accountState.page - 1) * accountState.pageSize, accountState.page * accountState.pageSize).map(r => r.id);
    accountState.checked = el.checked ? [...new Set([...accountState.checked, ...ids])] : accountState.checked.filter(id => !ids.includes(id));
    P.render();
  };
  P.actions['mg-account-auto'] = () => { const row = selectedAccount(); row.auto = !row.auto; P.render(); P.toast(`演示账号自动回复已${row.auto ? '开启' : '关闭'}`); };
  P.actions['mg-account-sync'] = () => { selectedAccount().synced = '刚刚'; P.render(); P.toast('演示同步完成，账号信息已刷新'); };
  P.actions['mg-account-log'] = () => {
    const row = selectedAccount();
    P.modal('账号运行日志', `<div class="mg-log"><p class="muted">@${escape(row.name)} · 本地演示记录</p><p><time>10:24:18</time>${P.badge('正常', 'green')} 完成一次会话同步</p><p><time>10:23:42</time>${P.badge('正常', 'green')} 无头浏览器心跳正常</p><p><time>10:22:05</time>${P.badge('正常', 'green')} 更新账号运行状态</p></div>`);
  };
  P.actions['mg-account-category'] = () => P.modal('筛选账号', `<label class="field">账号分类<select id="mg-account-category-select">${['全部分类', ...new Set(accountState.rows.map(r => r.category))].map(c => `<option ${c === accountState.category ? 'selected' : ''}>${escape(c)}</option>`).join('')}</select></label>`, button('应用筛选', 'mg-account-category-save', '', 'primary'));
  P.actions['mg-account-category-save'] = () => { accountState.category = document.getElementById('mg-account-category-select').value; accountState.page = 1; P.closeModal(); P.render(); };
  P.actions['mg-account-batch'] = () => {
    if (!accountState.checked.length) return P.toast('请先勾选需要操作的演示账号');
    P.modal('批量设置自动回复', `<p>已选择 ${accountState.checked.length} 个演示账号。此操作只更新原型中的状态。</p>`, button('关闭自动回复', 'mg-account-batch-save', 'data-enabled="false"') + button('开启自动回复', 'mg-account-batch-save', 'data-enabled="true"', 'primary'));
  };
  P.actions['mg-account-batch-save'] = el => { accountState.rows.filter(r => accountState.checked.includes(r.id)).forEach(r => { r.auto = el.dataset.enabled === 'true'; }); P.closeModal(); P.render(); P.toast('已更新选中的演示账号'); };
  function accountForm(editing) {
    const row = editing ? selectedAccount() : { name: '', handle: '', category: '生活', network: '直连' };
    P.modal(editing ? '编辑演示账号' : '添加演示账号', `<p class="muted">仅用于体验账号管理，不会发起真实登录。</p><div class="mg-form"><label class="field">账号名称<input id="mg-account-name" required maxlength="30" value="${escape(row.name)}" placeholder="例如：好物优选_02"></label><label class="field">抖音号<input id="mg-account-handle" required maxlength="40" value="${escape(row.handle)}" placeholder="输入演示账号标识"></label><label class="field">分类<select id="mg-account-category">${[...new Set(categories)].map(c => `<option ${c === row.category ? 'selected' : ''}>${c}</option>`).join('')}</select></label><label class="field">网络模式<select id="mg-account-network">${['直连', '固定代理', '节点（上海）'].map(c => `<option ${c === row.network ? 'selected' : ''}>${c}</option>`).join('')}</select></label></div>`, button('保存账号', 'mg-account-save', `data-editing="${editing}"`, 'primary'));
  }
  P.actions['mg-account-add'] = () => accountForm(false);
  P.actions['mg-account-edit'] = () => accountForm(true);
  P.actions['mg-account-save'] = el => {
    const nameEl = document.getElementById('mg-account-name');
    const handleEl = document.getElementById('mg-account-handle');
    if (!nameEl.value.trim()) { nameEl.value = ''; nameEl.reportValidity(); return; }
    if (!handleEl.value.trim()) { handleEl.value = ''; handleEl.reportValidity(); return; }
    const editing = el.dataset.editing === 'true';
    const id = editing ? selectedAccount().id : Math.max(...accountState.rows.map(r => r.id)) + 1;
    if (accountState.rows.some(r => r.handle === handleEl.value.trim() && r.id !== id)) return P.toast('该演示抖音号已存在，请使用不同标识');
    const data = { name: nameEl.value.trim(), handle: handleEl.value.trim(), category: document.getElementById('mg-account-category').value, network: document.getElementById('mg-account-network').value };
    if (editing) Object.assign(selectedAccount(), data);
    else accountState.rows.unshift({ ...data, id, status: '待登录', heat: 'COLD', pending: 0, synced: '尚未同步', auto: false });
    accountState.selected = id; accountState.filter = '全部账号'; accountState.category = '全部分类'; accountState.query = ''; accountState.page = 1;
    P.closeModal(); P.render(); P.toast(editing ? '演示账号已更新' : '已添加演示账号');
  };
  function knowledgeRows() {
    return knowledgeState.rows.filter(row => (knowledgeState.category === '全部知识' || knowledgeState.category === 'FAQ' || row.scope === knowledgeState.category || row.category === knowledgeState.category || (knowledgeState.category === '商品与服务' && row.category !== '敏感规则'))
      && (knowledgeState.scope === '全部范围' || row.scope === knowledgeState.scope)
      && (knowledgeState.status === '全部状态' || row.status === knowledgeState.status)
      && `${row.title} ${row.tags.join(' ')} ${row.qa.flat().join(' ')}`.toLowerCase().includes(knowledgeState.query.toLowerCase()));
  }
  function categoryNav(name, glyph, count, child = false) {
    return `<button class="mg-knowledge-nav-item ${child ? 'child' : ''} ${knowledgeState.category === name ? 'active' : ''}" data-action="mg-knowledge-category" data-value="${name}"><span>${icon(glyph, 18)}${name}</span><small>${count}</small></button>`;
  }
  function knowledgeNav() {
    const rows = knowledgeState.rows;
    const count = category => rows.filter(r => r.category === category || r.scope === category).length;
    return `<aside class="panel mg-knowledge-nav"><div class="section-head"><h3>知识库导航</h3>${icon('book', 18)}</div>${categoryNav('全部知识', 'layers', rows.length)}${categoryNav('共享知识', 'users', count('共享知识'))}${categoryNav('账号私有', 'user', count('账号私有'))}${categoryNav('FAQ', 'message', rows.reduce((total, r) => total + r.qa.length, 0))}<div class="mg-nav-divider"></div>${categoryNav('商品与服务', 'folder', rows.filter(r => r.category !== '敏感规则').length)}${categoryNav('商品信息', 'folder', count('商品信息'), true)}${categoryNav('售前咨询', 'folder', count('售前咨询'), true)}${categoryNav('售后政策', 'folder', count('售后政策'), true)}<div class="mg-nav-divider"></div>${categoryNav('敏感规则', 'shield', count('敏感规则'))}<p class="mg-nav-hint">知识内容仅为原型示例，可编辑、发布和停用。</p></aside>`;
  }
  function knowledgeList() {
    const rows = knowledgeRows();
    return `<section class="panel mg-knowledge-list"><div class="section-head"><h3>文档列表 <small class="muted">（共 ${rows.length} 条）</small></h3></div><div class="mg-knowledge-filters"><label class="mg-search">${icon('search', 17)}<input id="mg-knowledge-search" type="search" value="${escape(knowledgeState.query)}" data-change="mg-knowledge-search" placeholder="搜索文档标题、内容或标签" aria-label="搜索知识库"></label><select aria-label="知识适用范围" data-change="mg-knowledge-scope">${['全部范围', '共享知识', '账号私有'].map(v => `<option ${v === knowledgeState.scope ? 'selected' : ''}>${v}</option>`).join('')}</select><select aria-label="知识状态" data-change="mg-knowledge-status">${['全部状态', '已发布', '草稿', '已停用'].map(v => `<option ${v === knowledgeState.status ? 'selected' : ''}>${v}</option>`).join('')}</select></div><div class="table-wrap"><table class="mg-knowledge-table"><thead><tr><th>文档标题</th><th>标签</th><th>适用范围</th><th>状态</th><th>更新时间</th><th>版本</th></tr></thead><tbody>${rows.map(row => `<tr class="${row.id === knowledgeState.selected ? 'selected' : ''}"><td><button class="mg-document-name" data-action="mg-knowledge-select" data-id="${row.id}">${icon('file', 17)}${escape(row.title)}</button></td><td><div class="mg-tags">${row.tags.map((tag, i) => P.badge(escape(tag), i ? 'purple' : 'blue')).join('')}</div></td><td>${row.scope}</td><td>${statusBadge(row.status)}</td><td class="mg-nowrap">${row.updated}</td><td>v${row.version}</td></tr>`).join('')}${rows.length ? '' : '<tr><td colspan="6"><div class="empty">没有匹配的文档，请试试其他关键词。</div></td></tr>'}</tbody></table></div><div class="mg-pagination"><span>共 ${rows.length} 条演示文档</span><span class="muted">全部已加载</span></div></section>`;
  }
  function knowledgeDetail() {
    const row = selectedKnowledge();
    const tabs = ['内容预览', '版本历史', '关联使用'];
    let content;
    if (knowledgeState.tab === '内容预览') content = `<h4 class="mg-preview-heading">知识片段 <span class="muted">（共 ${row.qa.length} 条）</span></h4>${row.qa.map(([q, a]) => `<article class="mg-qa"><h4><span>Q</span>${escape(q)}</h4><p><span>A</span>${escape(a)}</p></article>`).join('')}`;
    if (knowledgeState.tab === '版本历史') content = `<div class="mg-version"><strong>v${row.version} · 当前版本</strong><p class="muted">${row.updated} 更新 · ${row.status}</p></div>${row.history.map(v => `<div class="mg-version"><strong>v${v.version}</strong><p class="muted">${v.updated} · ${escape(v.title)}</p></div>`).join('')}<p class="mg-demo-note">编辑并保存后，旧版本会保留在这里。</p>`;
    if (knowledgeState.tab === '关联使用') content = `<div class="mg-related">${icon('sparkles', 26)}<h4>FAQ · ${escape(row.tags[0])}</h4><p>适用范围：${row.scope}</p><p class="muted">${row.status === '已发布' ? '该示例内容可用于自动回复的演示预览。' : '当前内容未发布，不用于回复预览。'}</p><a class="btn" href="#rules">查看自动回复规则</a></div>`;
    return `<aside class="panel mg-knowledge-detail"><div class="section-head"><h3>${icon('file', 22)}${escape(row.title)}</h3></div><div class="mg-knowledge-meta"><div class="mg-tags">${row.tags.map((t, i) => P.badge(escape(t), i ? 'purple' : 'blue')).join('')}</div>${statusBadge(row.status)}</div><div class="mg-detail-tabs">${tabs.map(tab => `<button class="${knowledgeState.tab === tab ? 'active' : ''}" data-action="mg-knowledge-tab" data-value="${tab}">${tab}</button>`).join('')}</div><div class="mg-knowledge-preview">${content}</div><div class="mg-knowledge-foot"><div>${icon('layers', 20)}<span>适用范围<small>${row.scope}</small></span></div><div>${icon('layers', 20)}<span>当前版本<small>v${row.version}（${row.updated}）</small></span></div></div><div class="mg-knowledge-actions">${button(`${icon('edit', 17)} 编辑`, 'mg-knowledge-edit')}${button(`${icon('send', 17)} 发布`, 'mg-knowledge-publish', row.status === '已发布' ? 'disabled' : '', 'primary')}${button('停用', 'mg-knowledge-disable', row.status === '已停用' ? 'disabled' : '', 'mg-danger')}</div></aside>`;
  }
  P.pages.knowledge = () => {
    const rows = knowledgeState.rows;
    return `<section class="mg-page"><div class="mg-page-actions">${button(`${icon('upload', 17)} 导入文档`, 'mg-knowledge-import')}${button(`${icon('plus', 18)} 新增 FAQ`, 'mg-knowledge-new')}${button(`${icon('refresh', 18)} 重建索引`, 'mg-knowledge-index', '', 'primary')}<input id="mg-import-file" type="file" accept=".txt,.md,text/plain,text/markdown" hidden data-change="mg-knowledge-file"></div><div class="mg-stats four">${stat('共享知识', rows.filter(r => r.scope === '共享知识').length, '全部账号可用', 'book', 'cyan')}${stat('账号私有知识', rows.filter(r => r.scope === '账号私有').length, '按账号独立管理', 'users', 'purple')}${stat('FAQ 条目', rows.reduce((t, r) => t + r.qa.length, 0), '结构化问题与答案', 'message')}${stat('已发布文档', rows.filter(r => r.status === '已发布').length, '用于回复内容参考', 'check', 'green')}</div><div class="mg-knowledge-layout">${knowledgeNav()}${knowledgeList()}${knowledgeDetail()}</div></section>`;
  };
  P.actions['mg-knowledge-category'] = el => { knowledgeState.category = el.dataset.value; P.render(); };
  P.actions['mg-knowledge-select'] = el => { knowledgeState.selected = Number(el.dataset.id); knowledgeState.tab = '内容预览'; P.render(); };
  P.actions['mg-knowledge-tab'] = el => { knowledgeState.tab = el.dataset.value; P.render(); };
  P.changes['mg-knowledge-search'] = el => { knowledgeState.query = el.value; focusRender(el, '#mg-knowledge-search'); };
  P.changes['mg-knowledge-scope'] = el => { knowledgeState.scope = el.value; P.render(); };
  P.changes['mg-knowledge-status'] = el => { knowledgeState.status = el.value; P.render(); };
  P.actions['mg-knowledge-publish'] = () => { selectedKnowledge().status = '已发布'; P.render(); P.toast('文档已在原型中发布'); };
  P.actions['mg-knowledge-disable'] = () => { selectedKnowledge().status = '已停用'; P.render(); P.toast('文档已在原型中停用'); };
  P.actions['mg-knowledge-index'] = () => { P.toast(`演示索引已更新，共 ${knowledgeState.rows.length} 篇文档`); };
  function knowledgeForm(editing, imported) {
    const row = editing ? selectedKnowledge() : { title: imported?.title || '', scope: '共享知识', qa: [[imported ? '文档内容' : '', imported?.content || '']] };
    P.modal(editing ? '编辑知识内容' : '新增 FAQ', `<div class="mg-form"><label class="field">文档标题<input id="mg-k-title" required maxlength="50" value="${escape(row.title)}" placeholder="例如：发货政策"></label><label class="field">适用范围<select id="mg-k-scope"><option ${row.scope === '共享知识' ? 'selected' : ''}>共享知识</option><option ${row.scope === '账号私有' ? 'selected' : ''}>账号私有</option></select></label><div class="mg-qa-editor">${row.qa.map(([q, a], i) => `<label class="field">问题 ${i + 1}<input class="mg-k-question" required maxlength="120" value="${escape(q)}" placeholder="用户会如何提问？"></label><label class="field">回答 ${i + 1}<textarea class="mg-k-answer" required rows="${i ? 3 : 4}" maxlength="12000" placeholder="填写准确、清晰的回答">${escape(a)}</textarea></label>`).join('')}</div><p class="muted">保存为草稿后，可在右侧预览并发布。</p></div>`, button('保存草稿', 'mg-knowledge-save', `data-editing="${editing}"`, 'primary'));
  }
  P.actions['mg-knowledge-new'] = () => knowledgeForm(false);
  P.actions['mg-knowledge-edit'] = () => knowledgeForm(true);
  P.actions['mg-knowledge-save'] = el => {
    const titleEl = document.getElementById('mg-k-title');
    const questions = [...document.querySelectorAll('.mg-k-question')];
    const answers = [...document.querySelectorAll('.mg-k-answer')];
    for (const input of [titleEl, ...questions, ...answers]) {
      if (!input.value.trim()) { input.value = ''; input.reportValidity(); return; }
    }
    const data = { title: titleEl.value.trim(), scope: document.getElementById('mg-k-scope').value, qa: questions.map((q, i) => [q.value.trim(), answers[i].value.trim()]), status: '草稿', updated: '刚刚' };
    if (el.dataset.editing === 'true') {
      const row = selectedKnowledge();
      row.history.unshift({ version: row.version, updated: row.updated, title: row.title });
      Object.assign(row, data, { version: (Number(row.version) + 0.1).toFixed(1) });
    } else {
      const id = Math.max(...knowledgeState.rows.map(r => r.id)) + 1;
      knowledgeState.rows.unshift({ ...data, id, tags: ['FAQ', '新建'], category: '售前咨询', version: '1.0', history: [] });
      knowledgeState.selected = id;
    }
    knowledgeState.query = ''; knowledgeState.category = '全部知识'; knowledgeState.scope = '全部范围'; knowledgeState.status = '全部状态'; knowledgeState.tab = '内容预览';
    P.closeModal(); P.render(); P.toast('知识内容已保存为演示草稿');
  };
  P.actions['mg-knowledge-import'] = () => document.getElementById('mg-import-file').click();
  P.changes['mg-knowledge-file'] = async (el, event) => {
    if (event?.type === 'input') return;
    const file = el.files?.[0];
    if (!file) return;
    if (!/\.(txt|md)$/i.test(file.name)) return P.toast('原型支持导入 TXT 或 Markdown 文本');
    if (file.size > 200000) return P.toast('演示文档请控制在 200 KB 以内');
    try {
      const content = await file.text();
      if (!content.trim()) return P.toast('文档内容为空');
      if (content.length > 12000) return P.toast('演示文档内容请控制在 12,000 字符以内');
      knowledgeForm(false, { title: file.name.replace(/\.(txt|md)$/i, '').slice(0, 50), content });
    } catch { P.toast('无法读取该文档，请换一个文本文件重试'); }
  };
})();
