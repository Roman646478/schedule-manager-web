// Форма входа в админку. Вынесено из login.html ради строгого CSP (script-src 'self').
(function () {
  'use strict';

  const form = document.getElementById('loginForm');
  const msg = document.getElementById('msg');
  const btn = document.getElementById('loginBtn');
  const pw = document.getElementById('password');
  const pwToggle = document.getElementById('pwToggle');

  // Показать/скрыть пароль.
  pwToggle.addEventListener('click', () => {
    const reveal = pw.type === 'password';
    pw.type = reveal ? 'text' : 'password';
    pwToggle.classList.toggle('show', reveal);
    const label = reveal ? 'Скрыть пароль' : 'Показать пароль';
    pwToggle.setAttribute('aria-label', label);
    pwToggle.title = label;
    pw.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (btn.classList.contains('loading')) return;
    msg.className = 'msg';
    msg.textContent = '';
    btn.classList.add('loading');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    try {
      await window.api.post('/api/login', {
        username: form.username.value,
        password: form.password.value,
      });
      location.href = '/admin.html';
    } catch (err) {
      msg.className = 'msg error';
      msg.textContent = err.message;
      btn.classList.remove('loading');
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      pw.focus();
      pw.select();
    }
  });
})();
