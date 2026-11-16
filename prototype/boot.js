(() => {
  'use strict';
  const P = window.P;
  document.querySelector('.skip-link').addEventListener('click', event => {
    event.preventDefault();
    document.getElementById('main-content').focus();
  });
  document.querySelector('.mobile-menu').innerHTML = P.icon('menu');
  document.querySelector('.notification-btn').insertAdjacentHTML('afterbegin', P.icon('bell'));
  document.querySelector('.help-btn').innerHTML = P.icon('help-circle');
  document.querySelector('.profile-btn').innerHTML = P.icon('user');
  document.addEventListener('click', event => {
    const el = event.target.closest('[data-action]');
    if (el && !el.disabled) P.actions[el.dataset.action]?.(el, event);
  });
  for (const type of ['input', 'change']) {
    document.addEventListener(type, event => {
      const el = event.target.closest('[data-change]');
      if (!el) return;
      const changeOnly = el.matches('select, input[type="checkbox"], input[type="radio"], input[type="file"]');
      if (event.type !== (changeOnly ? 'change' : 'input')) return;
      P.changes[el.dataset.change]?.(el, event);
    });
  }
  window.addEventListener('hashchange', () => {
    P.render();
    document.getElementById('main-content').scrollTop = 0;
  });
  P.render();
})();
