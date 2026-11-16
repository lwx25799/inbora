/* Standalone demo UI. No account, application or network integration. */
(() => {
  'use strict';
  const aliases = {
    message: 'message-circle', chat: 'message-circle', book: 'book-open', file: 'file-text',
    refresh: 'refresh-cw', close: 'x', more: 'more-horizontal', chevronDown: 'chevron-down',
    chevronRight: 'chevron-right', chevronLeft: 'chevron-left', alert: 'alert-circle',
    checkCircle: 'check-circle', edit: 'edit-3', sparkles: 'zap', bot: 'cpu',
    chart: 'bar-chart-2', arrowUp: 'arrow-up-right', arrowDown: 'arrow-down-right',
    shieldCheck: 'shield', stop: 'pause', logout: 'log-out', server: 'database',
    heart: 'activity', uploadCloud: 'upload', 'shield-check': 'shield',
    info: 'help-circle', flask: 'activity', robot: 'cpu',
  };
  const P = window.P = {
    pages: {}, actions: {}, changes: {}, state: {},
    route: 'dashboard',
    esc(value) {
      return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[char]));
    },
    icon(name, size = 20) {
      const svg = window.FeatherIcons[aliases[name] || name] || window.FeatherIcons['circle'] || window.FeatherIcons['layers'];
      return svg.replace('width="24"', `width="${Number(size) || 20}"`)
        .replace('height="24"', `height="${Number(size) || 20}"`)
        .replace('<svg ', '<svg aria-hidden="true" class="icon" ')
        .replace('stroke-width="2"', 'stroke-width="1.7"');
    },
    badge(text, tone = 'gray') {
      return `<span class="badge ${P.esc(tone)}">${P.esc(text)}</span>`;
    },
    btn(text, action, kind = '', icon = '') {
      return `<button type="button" class="btn ${P.esc(kind)}" data-action="${P.esc(action)}">${icon ? P.icon(icon, 16) : ''}${P.esc(text)}</button>`;
    },
    avatar(name, index = 0, size = '') {
      const colors = ['sage', 'sand', 'slate', 'rose', 'sky', 'plum'];
      return `<span class="avatar ${colors[Math.abs(Number(index) || 0) % colors.length]} ${P.esc(size)}" aria-hidden="true">${P.esc(String(name).replace(/^@/, '').slice(0, 1))}</span>`;
    },
    toast(message) {
      const element = document.getElementById('toast');
      element.textContent = message;
      element.classList.add('visible');
      clearTimeout(P.toastTimer);
      P.toastTimer = setTimeout(() => element.classList.remove('visible'), 3600);
    },
    modal(title, body, footer = '') {
      const dialog = document.getElementById('modal');
      document.getElementById('modal-title').textContent = title;
      document.getElementById('modal-body').innerHTML = body;
      document.getElementById('modal-footer').innerHTML = footer || P.btn('知道了', 'close-modal', 'primary');
      if (!dialog.open) dialog.showModal();
    },
    closeModal() { document.getElementById('modal').close(); },
    navigate(route) {
      if (location.hash === `#${route}`) P.render();
      else location.hash = route;
    },
    persist(key, value) {
      try { localStorage.setItem(`inbora-prototype-${key}`, JSON.stringify(value)); }
      catch { P.toast('浏览器未允许本地保存，本次操作仍已生效。'); }
    },
    restore(key, fallback) {
      try { return JSON.parse(localStorage.getItem(`inbora-prototype-${key}`)) ?? fallback; }
      catch { return fallback; }
    },
  };
  P.routes = [
    ['dashboard', '工作台', 'home', '您好，欢迎使用 inbora', '抖音个人号智能客服工作台 · 多账号集中管理 · AI 智能回复 · 评论私信一体化'],
    ['inbox', '会话中心', 'message', '会话中心', '统一管理私信与评论，全渠道会话一站处理 · AI 智能回复 · 人工协作'],
    ['accounts', '账号管理', 'users', '账号管理', '集中管理抖音个人账号，安全隔离、多环境运行，稳定高效触达与回复'],
    ['rules', '自动回复', 'zap', '自动回复 · 规则与自动化', '设置安全、可控的自动回复策略，提升响应效率，确保一致的品牌体验'],
    ['knowledge', '知识库', 'book', '知识库管理', '管理客服使用的知识内容，提升 AI 问答准确率与一致性'],
    ['ai', 'AI 配置', 'cpu', 'AI 配置 · AI Agent Studio', '配置客服 Agent，定义人设、回复策略与安全边界，支持实时测试与效果评估'],
    ['tasks', '任务调度', 'calendar', '任务调度 · 浏览器自动化', '统一调度账号执行评论与私信任务，实时掌握运行状态'],
    ['analytics', '数据统计', 'chart', '数据统计', '客户服务工作台数据分析 · 消息处理、回复效率、AI 使用与账号表现'],
    ['settings', '系统设置', 'settings', '系统设置', '管理工作台偏好、数据与运行环境，让每一项设置都井然有序'],
  ];
  P.render = () => {
    const route = location.hash.slice(1) || 'dashboard';
    P.route = P.pages[route] ? route : 'dashboard';
    const info = P.routes.find(item => item[0] === P.route);
    document.title = `${info[1]} · inbora 交互原型`;
    document.getElementById('page-title').textContent = info[3];
    document.getElementById('page-description').textContent = info[4];
    document.getElementById('navigation').innerHTML = P.routes.map(([id, label, icon]) =>
      `<a class="nav-item ${P.route === id ? 'active' : ''}" href="#${id}" ${P.route === id ? 'aria-current="page"' : ''}>${P.icon(icon, 19)}<span>${label}</span>${id === 'inbox' ? '<span class="nav-count">21</span>' : ''}</a>`).join('');
    const content = document.getElementById('main-content');
    content.className = `page-${P.route}`;
    content.innerHTML = P.pages[P.route]();
    document.querySelector('.sidebar').classList.remove('mobile-open');
  };
  P.actions['close-modal'] = P.closeModal;
  P.actions['toggle-menu'] = () => document.querySelector('.sidebar').classList.toggle('mobile-open');
  P.actions.notifications = () => P.modal('通知中心', `<div class="notice-item">${P.badge('演示', 'blue')} 工作台原型已准备就绪。所有页面与数据均可离线查看。</div><div class="notice-item">${P.icon('shield', 18)} 当前为独立演示环境，不连接任何真实账号。</div>`);
  P.actions.help = () => P.modal('欢迎体验 inbora', '<p>这是根据文件夹内 10 张效果图制作的交互原型。</p><ul class="help-list"><li>左侧导航可切换 9 个功能页面。</li><li>会话中心支持筛选、使用 AI 建议、保存草稿和模拟发送。</li><li>账号、知识库和规则支持选择、编辑与状态切换。</li><li>所有数据均为演示；发送、测试和设置不会触发真实业务。</li><li>直接双击项目根目录的 Inbora原型.html 即可离线打开。</li></ul>');
  P.actions.profile = () => P.modal('演示工作空间', `<div class="row">${P.avatar('演示管理员', 0, 'large')}<div><strong>演示管理员</strong><p class="muted">inbora 产品原型 · 本地工作空间</p></div></div>`);
  P.actions.goto = el => P.navigate(el.dataset.route);
})();
