(() => {
  'use strict';
  const P = window.P;
  const { icon, badge, btn, avatar, esc } = P;
  const names = ['@小橙子', '@星河漫漫', '@阿布', '@好物优选_01', '@数码玩家_05', '@家居好物'];
  P.state.overview = { trend: '今天', period: '近 7 天', channel: '评论通知', pool: '全部', group: '全部账号分组', paused: false, mode: '按数量' };
  const state = P.state.overview;
  function stat(label, value, symbol, note, tone = '') {
    return `<div class="panel stat"><span class="stat-icon ${tone}">${icon(symbol, 23)}</span><div class="stat-content"><div class="stat-title">${label}</div><div class="stat-value">${value}</div><div class="stat-note">${note}</div></div></div>`;
  }
  function head(label, symbol, extra = '') {
    return `<div class="section-head"><h2>${icon(symbol, 19)}${label}</h2>${extra}</div>`;
  }
  const more = (label, route) => `<a class="subtle-link" href="#${route}">${label}${icon('chevron-right', 14)}</a>`;
  function tabs(values, selected, action) {
    return `<div class="tabs compact">${values.map(value => `<button class="tab ${value === selected ? 'active' : ''}" data-action="${action}" data-value="${value}">${value}</button>`).join('')}</div>`;
  }
  function lineChart(type = 'daily', large = false) {
    const shift = type === '今天' ? 0 : type === '近 30 天' ? 16 : 8;
    const first = [11, 6, 16, 26, 22, 52, 43, 57, 45, 50, 39, 65, 74, 62].map((n, i) => n + (i % 3) * shift);
    const second = first.map((n, i) => Math.max(3, n * .76 + [4, 0, -3, 4][i % 4]));
    const max = type === '近 30 天' ? 120 : 100;
    const width = 540, height = 162;
    const path = series => {
      const points = series.map((n, i) => [42 + i * 36.1, height - n / max * 125]);
      return points.map(([x, y], i) => {
        if (!i) return `M ${x} ${y}`;
        const [px, py] = points[i - 1];
        const [bx, by] = points[Math.max(0, i - 2)];
        const [nx, ny] = points[Math.min(points.length - 1, i + 1)];
        return `C ${px + (x - bx) / 6} ${py + (y - by) / 6}, ${x - (nx - px) / 6} ${y - (ny - py) / 6}, ${x} ${y}`;
      }).join(' ');
    };
    const factor = large ? (type === '今天' ? .144 : type === '近 30 天' ? 4.13 : 1) * (state.group === '全部账号分组' ? 1 : .42) : 1;
    const labels = type === '今天' ? ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00', '22:00'] : large ? (type === '近 30 天' ? ['10-18', '10-23', '10-28', '11-02', '11-07', '11-12', '11-16'] : ['11-10', '11-11', '11-12', '11-13', '11-14', '11-15', '11-16']) : ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    return `<div class="line-chart"><div class="chart-legend"><span><i></i>${large ? '总处理消息' : '新增消息'} <b>${large ? Math.round(12846 * factor).toLocaleString('en-US') : '482'}</b></span><span><i></i>${large ? '确认发送消息' : '已回复'} <b>${large ? Math.round(8709 * factor).toLocaleString('en-US') : '461'}</b></span></div>
      <svg viewBox="0 0 ${width} 190" role="img" aria-label="${esc(type)}消息趋势，示例数据">
      ${[0, 1, 2, 3, 4].map(i => `<line x1="42" x2="518" y1="${37 + i * 31.25}" y2="${37 + i * 31.25}" stroke="#e9edf4"/><text x="31" y="${41 + i * 31.25}" text-anchor="end">${large ? Math.round((2000 - i * 500) * factor) : max - i * max / 4}</text>`).join('')}
      <path d="${path(first)} L 511.3 162 L 42 162 Z" fill="#eaf1fb"/>
      <path d="${path(first)}" fill="none" stroke="#6989bb" stroke-width="2.1"/>
      <path d="${path(second)} L 511.3 162 L 42 162 Z" fill="#c4d6ee" fill-opacity=".55"/>
      <path d="${path(second)}" fill="none" stroke="#a0b7d7" stroke-width="1.7"/>
      ${labels.map((text, i) => `<text x="${42 + i * 78.2}" y="181" text-anchor="middle">${text}</text>`).join('')}
      </svg></div>`;
  }
  const poolInfo = [
    ['HOT', '高活跃', '持续互动 / 流量佳', 12, 40, 'red'],
    ['WARM', '正常', '有互动 / 稳定运行', 13, 43, 'amber'],
    ['COLD', '低活跃', '互动少 / 需关注', 5, 17, 'blue'],
  ];
  function alerts() {
    const rows = [['alert', 'red', '账号登录失效：@小鹿好物', '10:24'], ['alert', 'amber', '浏览器内存偏高（1.8 GB）', '09:57'], ['clock', 'amber', '私信通道出现短时延迟', '09:36'], ['help-circle', 'blue', '2 个账号互动异常，已自动重试', '08:51']];
    return `<div class="alert-list">${rows.map(([symbol, tone, text, time]) => `<button class="alert-row" data-action="overview-alert" data-text="${text}"><span class="${tone}-text">${icon(symbol, 13)}</span><span>${text}</span><time>${time}</time></button>`).join('')}</div>`;
  }
  function donut(total, label, kind = '') {
    return `<div class="donut ${kind}" role="img" aria-label="${total} ${label}"><div><strong>${total}</strong><span>${label}</span></div></div>`;
  }
  function inboxTable() {
    const messages = ['这个有现货吗？大概什么时候能发？', '多少钱一件？有别的颜色吗？', '用起来会卡吗？适合日常办公吗？'];
    return `<div class="table-wrap"><table class="recent-table"><thead><tr><th>用户</th><th>来源</th><th>账号</th><th>消息内容（最新）</th><th>类型</th><th>等待时长</th><th>建议处理</th><th>操作</th></tr></thead><tbody>${messages.map((text, i) => `<tr><td><span class="row">${avatar(names[i], i, 'small')}${names[i]}</span></td><td><span class="douyin-mark">♪</span> 抖音</td><td class="muted">${['@好物优选_01', '@穿搭日记_03', '@数码玩家_05'][i]}</td><td>${text}</td><td>${badge(i === 1 ? '评论' : '私信', i === 1 ? 'gray' : 'blue')}</td><td class="${i ? 'amber' : 'red'}-text">${[12, 8, 6][i]} 分钟</td><td>${badge(i === 1 ? '可自动回复' : '✧ AI 推荐回复', i === 1 ? 'green' : 'purple')}</td><td><a href="#inbox" class="btn small ${i === 1 ? '' : 'dark'}">${i === 1 ? '查看' : '回复'}</a></td></tr>`).join('')}</tbody></table></div>`;
  }
  P.pages.dashboard = () => `<div class="stat-grid five">
    ${stat('已管理账号', '30', 'users', '较昨日 0')}
    ${stat('活跃浏览器', '8', 'monitor', '<span class="online-dot"></span> 运行中 / 共 8', 'green')}
    ${stat('今日新增消息', '482', 'message', '<strong>↑ +12.6%</strong> 较昨日 428')}
    ${stat('已确认发送', '461', 'send', '<strong>↑ +14.1%</strong> 较昨日 404', 'teal')}
    ${stat('待人工处理', '21', 'alert', '<strong>↓ -16.0%</strong> 较昨日 25', 'red')}
    </div>
    <div class="dashboard-upper">
      <section class="panel">${head('回复趋势', 'chart', tabs(['今天', '近 7 天', '近 30 天'], state.trend, 'overview-trend'))}${lineChart(state.trend)}</section>
      <section class="panel">${head('浏览器池', 'monitor', more('共 30 个账号', 'tasks'))}<div class="pool-summary">${poolInfo.map(([level, title, note, num, percent, tone]) => `<div class="pool-summary-row">${badge(level, tone)}<div><b>${title}</b><small>（${note}）</small></div><strong>${num}<span> 个</span></strong><small>${percent}%</small></div>`).join('')}<div class="stacked-meter"><i></i><i></i><i></i></div></div></section>
      <section class="panel">${head('最近告警', 'bell', more('全部告警', 'tasks'))}${alerts()}</section>
    </div>
    <div class="dashboard-middle">
      <section class="panel">${head('账号状态概览', 'user', more('共 30 个账号', 'accounts'))}<div class="account-summary">${donut('30', '账号总数')}<div class="donut-legend">${[['在线', '24', '80.0%', 'green'], ['暂停', '2', '6.7%', 'gray'], ['异常', '1', '3.3%', 'amber'], ['待登录', '3', '10.0%', 'pale']].map(([label, n, percent, color]) => `<div><i class="legend-dot ${color}"></i><span>${label}</span><b>${n}</b><small>${percent}</small></div>`).join('')}</div></div></section>
      <section class="panel">${head('通道健康状态', 'layers')}<div class="channel-health">${[['message', '评论通知通道', '320', '99.8%'], ['send', '私信通道', '410', '99.6%']].map(([symbol, name, ms, success]) => `<a href="#tasks" class="health-row"><span class="health-icon">${icon(symbol, 18)}</span><span>${name}</span>${badge('正常', 'green')}<span class="health-number"><small>延迟</small>${ms} ms</span><span class="health-number"><small>成功率</small>${success}</span>${icon('chevron-right', 15)}</a>`).join('')}</div></section>
      <section class="panel">${head('系统状态', 'activity')}<div class="system-status"><div>${icon('box', 16)}<span>运行模式</span>${badge('Headless 优先', 'green')}</div><div>${icon('globe', 16)}<span>账号网络配置</span><small>账号独立配置</small></div><div>${icon('database', 16)}<span>本地数据库</span><small><i class="online-dot"></i> SQLite 模式</small></div></div></section>
    </div>
    <section class="panel recent-panel">${head('最近待处理会话 <span class="muted">（21）</span>', 'message', more('前往会话中心', 'inbox'))}${inboxTable()}</section>`;

  function browserPool() {
    const rows = state.pool === '全部' ? poolInfo : poolInfo.filter(row => row[0] === state.pool);
    return `<div class="browser-pool">${rows.map(([level, title, note, n, percent, tone]) => {
      const index = poolInfo.findIndex(row => row[0] === level);
      return `<div class="browser-group"><div class="browser-group-info"><div class="row">${badge(level, tone)}<strong>${title}</strong></div><p class="muted">${n} 个 · 运行中 ${n - 1} · 负载 ${[78, 56, 18][index]}%</p><div class="mini-meter ${tone}"><i style="width:${percent * 1.8}%"></i></div></div><div class="browser-tiles">${[0, 1, 2].map((n, j) => `<button class="browser-tile" data-action="overview-browser" data-name="${names[(index + j) % names.length]}"><span class="browser-dots"><i></i><i></i><i></i></span>${icon('globe', 24)}<span><i class="online-dot"></i>${names[(index + j) % names.length]}</span></button>`).join('')}</div></div>`;
    }).join('')}</div>`;
  }
  function queueTable() {
    const isComment = state.channel === '评论通知';
    return `<div class="table-wrap"><table class="queue-table"><thead><tr><th>任务 ID</th><th>账号</th><th>任务内容</th><th>优先级</th><th>状态</th><th>预计执行</th><th>操作</th></tr></thead><tbody>${[0, 1, 2, 3, 4, 5].map(i => `<tr><td>${isComment ? 'CMT' : 'PM'}-${34890 + i}</td><td><span class="row">${avatar(names[i], i, 'small')}${names[i]}</span></td><td>${(isComment ? ['回复评论：这个什么时候上新？', '回复评论：有多大尺寸？', '评论通知：补充颜色选项'] : ['私信回复：是否支持退换？', '私信回复：这是正品吗？', '私信回复：可以开票吗？'])[i % 3]}</td><td>${badge(i < 2 ? '高' : i < 4 ? '中' : '低', i < 2 ? 'red' : i < 4 ? 'amber' : 'blue')}</td><td><span class="queue-state"><i class="legend-dot ${state.paused ? 'gray' : 'green'}"></i>${state.paused ? '已暂停' : i < 3 ? '执行中' : '排队中'}</span></td><td>${state.paused ? '等待恢复' : ['约 7 秒', '约 12 秒', '约 1 分 20 秒', '约 1 分 18 秒', '约 2 分 10 秒', '约 4 分 35 秒'][i]}</td><td><button class="btn small" data-action="overview-task" data-index="${i}">查看</button></td></tr>`).join('')}</tbody></table></div>`;
  }
  P.pages.tasks = () => `<div class="stat-grid six">${stat('托管账号数', '30', 'users', '较昨日 0')}${stat('打开的浏览器', '18', 'monitor', '<span class="online-dot"></span> 运行中 / 共 30', 'green')}${stat('活跃界面动作', '136', 'target', '<strong>↑ +18.3%</strong> 较昨日 115', 'purple')}${stat('待执行任务', '482', 'list', '<strong>↑ +12.6%</strong> 较昨日 428', 'red')}${stat('待核验任务', '37', 'send', '<strong>↓ -22.9%</strong> 较昨日 48', 'teal')}${stat('节点数量', '6', 'layers', '在线 6 / 异常 0', 'green')}</div>
    <div class="task-layout"><div class="stack"><section class="panel">${head('浏览器池', 'monitor', tabs(['全部', 'HOT', 'WARM', 'COLD'], state.pool, 'overview-pool'))}${browserPool()}</section><section class="panel">${head('任务队列', 'layers', `<div class="row">${tabs(['评论通知', '私信任务'], state.channel, 'overview-channel')}${btn(state.paused ? '恢复演示' : '暂停演示', 'overview-pause', 'small', state.paused ? 'play' : 'pause')}</div>`)}${queueTable()}</section></div>
    <div class="stack"><section class="panel">${head('实时运行监控', 'activity', '<span class="muted">共 18 个浏览器运行中</span>')}<div class="table-wrap"><table><thead><tr><th>账号</th><th>当前动作</th><th>运行时长</th></tr></thead><tbody>${names.map((name, i) => `<tr><td><span class="row">${avatar(name, i, 'small')}${name}</span></td><td>${badge(state.paused ? '已暂停' : ['观察中', '撰写中', '审核中', '发送中', '校验中', '已暂停'][i], ['blue', 'purple', 'amber', 'green', 'blue', 'gray'][i])}</td><td class="muted">00:${['14:32', '06:18', '03:49', '01:27', '00:56', '08:21'][i]}</td></tr>`).join('')}</tbody></table></div></section><section class="panel">${head('资源监控', 'cpu', '<span class="muted">近 5 分钟趋势</span>')}<div class="resource-grid">${[['CPU 使用率', '28%'], ['内存使用率', '62%'], ['浏览器内存', '4.8 GB'], ['队列延迟', '320 ms']].map(([label, value], i) => `<div><span>${label}</span><strong>${value}</strong><svg viewBox="0 0 100 24" aria-hidden="true"><polyline points="0,18 10,13 20,17 30,12 40,15 50,8 60,12 70,7 80,${8 + i * 2} 90,11 100,4" fill="none" stroke="#66b68a" stroke-width="1.5"/></svg></div>`).join('')}</div></section><section class="panel">${head('运行告警', 'bell')}${alerts()}</section></div></div>`;

  function bars() {
    const ratio = state.mode === '按占比';
    const factor = state.period === '今天' ? .68 : state.period === '近 30 天' ? 1.12 : 1;
    return `<div class="bar-chart"><div class="chart-legend"><span><i class="purple"></i>评论消息</span><span><i class="blue"></i>私信消息</span></div><div class="bar-plot">${[56, 65, 84, 80, 94, 107, 122].map((value, i) => `<button class="bar-column" data-action="overview-bar" data-index="${i}" aria-label="11月${i + 10}日，查看数据"><span class="bar-stack" style="height:${ratio ? 136 : value * factor}px"><i style="height:${37 + i * 2}%"></i><i></i></span><small>11-${i + 10}</small></button>`).join('')}</div></div>`;
  }
  P.pages.analytics = () => {
    const factor = (state.period === '今天' ? .144 : state.period === '近 30 天' ? 4.13 : 1) * (state.group === '全部账号分组' ? 1 : .42);
    const number = n => Math.round(n * factor).toLocaleString('en-US');
    return `<div class="panel analytics-toolbar"><div class="row"><strong>统计时间</strong>${tabs(['今天', '近 7 天', '近 30 天'], state.period, 'overview-period')}</div><label class="row"><span>账号分组</span><select data-change="overview-group" aria-label="账号分组">${['全部账号分组', '好物分享', '品牌运营'].map(text => `<option ${state.group === text ? 'selected' : ''}>${text}</option>`).join('')}</select></label>${btn('导出报表', 'overview-export', '', 'download')}</div>
      <div class="stat-grid six">${stat('消息处理总数', number(12846), 'message', '<strong>↑ +15.2%</strong> 较上期')}${stat('确认发送数', number(8709), 'send', '<strong>↑ +18.6%</strong> 较上期', 'teal')}${stat('人工回复率', '23.7%', 'users', '<strong>↓ -4.3 pp</strong> 较上期')}${stat('首响平均时长', '28 秒', 'zap', '<strong>↓ -31.7%</strong> 较上期')}${stat('Token 消耗', number(2814935), 'layers', '<strong>↑ +12.1%</strong> 较上期', 'teal')}${stat('账号使用率', '80.0%', 'pie-chart', '<strong>↑ +6.7 pp</strong> 较上期', 'green')}</div>
      <div class="analytics-charts"><section class="panel">${head('消息处理趋势', 'chart')}${lineChart(state.period, true)}</section><section class="panel">${head('评论 / 私信占比', 'layers', tabs(['按数量', '按占比'], state.mode, 'overview-mode'))}${bars()}</section></div>
      <div class="analytics-bottom"><section class="panel">${head('人工与 AI 占比', 'pie-chart')}<div class="analytics-donut">${donut(number(12846), '处理消息总数', 'ai-donut')}<div class="donut-legend">${[['自动发送', '56.8%', number(7300), 'green'], ['AI 辅助回复', '19.5%', number(2507), 'blue'], ['人工回复', '23.7%', number(3039), 'amber']].map(([label, percent, n, color]) => `<div><i class="legend-dot ${color}"></i><span>${label}</span><b>${percent}</b><small>${n}</small></div>`).join('')}</div></div></section><section class="panel">${head('账号表现排行', 'flag', '<span class="muted">按处理消息总数排序</span>')}<div class="table-wrap"><table><thead><tr><th>排名</th><th>账号</th><th>处理消息</th><th>确认发送</th><th>人工回复率</th><th>首响时长</th><th>账号利用率</th></tr></thead><tbody>${names.slice(0, 5).map((name, i) => `<tr><td><span class="rank ${i < 3 ? 'rank-' + i : ''}">${i + 1}</span></td><td><span class="row">${avatar(name, i, 'small')}${name}</span></td><td>${number([2364, 2128, 1876, 1673, 1602][i])}</td><td>${number([1672, 1489, 1304, 1133, 1111][i])}</td><td>${[18.9, 20.4, 22.1, 25.9, 27.6][i]}%</td><td>${24 + i * 2} 秒</td><td><span class="utilization"><span>${92.6 - i * 4}%</span><i><b style="width:${92 - i * 4}%"></b></i></span></td></tr>`).join('')}</tbody></table></div></section></div>`;
  };
  for (const [action, key] of [['overview-trend', 'trend'], ['overview-period', 'period'], ['overview-pool', 'pool'], ['overview-channel', 'channel'], ['overview-mode', 'mode']]) {
    P.actions[action] = el => { state[key] = el.dataset.value; P.render(); };
  }
  P.changes['overview-group'] = (el, event) => {
    if (event.type !== 'change') return;
    state.group = el.value;
    P.render();
  };
  P.actions['overview-pause'] = () => { state.paused = !state.paused; P.render(); P.toast(state.paused ? '演示任务队列已暂停' : '演示任务队列已恢复'); };
  P.actions['overview-alert'] = el => P.modal('告警详情', `<p>${esc(el.dataset.text)}</p><p class="muted">时间：今天 10:24 · 演示事件</p><div class="notice-item">建议检查对应账号的状态与任务记录。此事件来自参考图中的示例，不代表真实账号异常。</div>`, `<a class="btn primary" href="#tasks" data-action="close-modal">查看任务调度</a>${btn('关闭', 'close-modal')}`);
  P.actions['overview-browser'] = el => P.modal('浏览器详情', `<div class="row">${avatar(el.dataset.name, 2, 'large')}<div><strong>${esc(el.dataset.name)}</strong><p class="muted">独立账号浏览器 · 演示数据</p></div></div><div class="notice-item">${badge('在线', 'green')} Headless 无头模式</div><div class="notice-item">当前内存：268 MB · 会话时长：00:14:32</div>`, `<a class="btn primary" href="#accounts" data-action="close-modal">打开账号管理</a>`);
  P.actions['overview-task'] = el => P.modal('任务详情', `<label class="field">任务编号<strong>${state.channel === '评论通知' ? 'CMT' : 'PM'}-${34890 + Number(el.dataset.index)}</strong></label><div class="notice-item">账号：${names[Number(el.dataset.index)]}</div><div class="notice-item">状态：${state.paused ? '已暂停' : '排队处理中'} · 本地演示</div><p class="muted">此原型仅展示任务状态，不会启动浏览器或执行真实发送。</p>`);
  P.actions['overview-bar'] = el => P.modal('每日消息明细', `<p>11 月 ${10 + Number(el.dataset.index)} 日</p><div class="notice-item">${badge('评论', 'purple')} ${426 + Number(el.dataset.index) * 50} 条</div><div class="notice-item">${badge('私信', 'blue')} ${642 + Number(el.dataset.index) * 81} 条</div><p class="muted">统计范围：${state.period} · ${state.group} · 演示数据</p>`);
  P.actions['overview-export'] = () => {
    const factor = (state.period === '今天' ? .144 : state.period === '近 30 天' ? 4.13 : 1) * (state.group === '全部账号分组' ? 1 : .42);
    const csv = '\ufeff统计范围,账号分组,消息处理总数,确认发送数,人工回复率,说明\r\n' + [state.period, state.group, Math.round(12846 * factor), Math.round(8709 * factor), '23.7%', '原型演示数据'].join(',');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'inbora-演示统计.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    P.toast('演示统计报表已导出');
  };
})();
