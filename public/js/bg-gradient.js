// Динамический фон: градиент следует за курсором (см. .claude-rules.md §3).
// Позиция передаётся в CSS через --mx/--my; движение сглаживается через rAF + lerp.
// Подключается на любой странице, где есть <div class="bg-gradient">.
(function () {
  'use strict';

  const bg = document.querySelector('.bg-gradient');
  if (!bg) return;

  // Целевая (мышь) и текущая (сглаженная) позиции в процентах.
  let targetX = 50;
  let targetY = 50;
  let currentX = 50;
  let currentY = 50;
  const EASE = 0.08;

  function setTarget(clientX, clientY) {
    targetX = (clientX / window.innerWidth) * 100;
    targetY = (clientY / window.innerHeight) * 100;
  }

  window.addEventListener('pointermove', function (e) {
    setTarget(e.clientX, e.clientY);
  });

  // Поддержка касаний на тач-устройствах.
  window.addEventListener('touchmove', function (e) {
    const t = e.touches && e.touches[0];
    if (t) setTarget(t.clientX, t.clientY);
  }, { passive: true });

  // Уважаем системную настройку «уменьшить движение»: ставим фон статично.
  const reduceMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function frame() {
    currentX += (targetX - currentX) * EASE;
    currentY += (targetY - currentY) * EASE;
    bg.style.setProperty('--mx', currentX.toFixed(2) + '%');
    bg.style.setProperty('--my', currentY.toFixed(2) + '%');
    requestAnimationFrame(frame);
  }

  if (reduceMotion) {
    bg.style.setProperty('--mx', '50%');
    bg.style.setProperty('--my', '50%');
  } else {
    requestAnimationFrame(frame);
  }
})();
