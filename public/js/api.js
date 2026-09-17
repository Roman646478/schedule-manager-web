// Тонкая обёртка над fetch для API. Куки сессии браузер шлёт сам (same-origin).
// Для небезопасных методов автоматически подставляется заголовок X-CSRF-Token.
window.api = {
  get(url) {
    return request('GET', url);
  },
  post(url, body) {
    return request('POST', url, { body });
  },
  put(url, body) {
    return request('PUT', url, { body });
  },
  // body — необязательное тело (DELETE с параметрами, напр. /group-subjects).
  del(url, body) {
    return request('DELETE', url, body === undefined ? {} : { body });
  },
  // Скачивание файла: тело ответа — сам файл, поэтому обычный request() не годится
  // (он ждёт JSON). Имя берём из Content-Disposition, ошибку сервер шлёт JSON-ом.
  // Возвращает { filename, warnings } — предупреждения экспорта едут заголовком.
  async download(url, body, retried = false) {
    const headers = { 'X-CSRF-Token': await ensureCsrf(), 'Content-Type': 'application/json' };
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body || {}) });
    if (res.status === 403 && !retried) {
      csrfToken = null; // токен устарел (рестарт сервера) — обновить и повторить раз
      return api.download(url, body, true);
    }
    if (!res.ok) return handle(res); // бросит Error с текстом сервера
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileNameOf(res.headers.get('Content-Disposition'));
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    const warn = res.headers.get('X-Export-Warnings');
    return { filename: a.download, warnings: warn ? decodeURIComponent(warn).split('; ') : [] };
  },
  async upload(url, files, fields) {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    if (fields) for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return request('POST', url, { form });
  },
  // Фоновое отслеживание чужих правок: сервер считает изменения (/api/data-version),
  // опрашиваем счётчик и зовём onChange, когда прирост больше, чем сделали сами —
  // значит правку внесли в другом окне. Свои правки страница уже отрисовала.
  watchChanges(onChange, ms = 4000) {
    let known = null;
    let knownEpoch = null;
    let polling = false;
    const tick = async () => {
      if (document.hidden || polling) return;
      polling = true;
      try {
      let version, epoch;
      try {
        ({ version, epoch } = await request('GET', '/api/data-version'));
      } catch {
        return; // сервер/сессия недоступны — повторим на следующем тике
      }
      const delta = known === null ? 0 : version - known;
      const restarted = known !== null && (epoch !== knownEpoch || delta < 0);
      if (!restarted && delta <= 0) { known = version; knownEpoch = epoch; selfChanges = 0; return; }
      const mine = restarted ? 0 : Math.min(delta, selfChanges);
      if (restarted || delta > mine) {
        // onChange вернул false — страница сейчас занята (идёт выбор ячейки для
        // переноса, перерисовка стёрла бы подсветку). Версию не запоминаем:
        // предложим обновиться снова на следующем тике.
        let busy = false;
        try { busy = (await onChange()) === false; } catch { return; }
        if (busy) return;
      }
      known = version;
      knownEpoch = epoch;
      selfChanges = 0;
      } finally { polling = false; }
    };
    tick();
    setInterval(tick, ms);
    // Вкладку не опрашиваем в фоне; вернулись к ней — проверяем сразу.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) tick();
    });
  },
};

// Сколько изменений внесла эта вкладка — чтобы не перерисовывать её от своих же правок.
let selfChanges = 0;

let csrfToken = null;

// Получить (и закэшировать) CSRF-токен текущей сессии.
async function ensureCsrf() {
  if (csrfToken) return csrfToken;
  const res = await fetch('/api/csrf', { headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  csrfToken = data.token || null;
  return csrfToken;
}

async function request(method, url, { body, form } = {}, retried = false) {
  const unsafe = method !== 'GET' && method !== 'HEAD';
  const headers = {};
  if (unsafe) headers['X-CSRF-Token'] = await ensureCsrf();
  const opts = { method, headers };
  if (form) {
    opts.body = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body || {});
  }

  const res = await fetch(url, opts);
  // Токен мог устареть (рестарт сервера/новая сессия) — обновить и повторить раз.
  if (res.status === 403 && unsafe && !retried) {
    const d = await res.clone().json().catch(() => null);
    if (d && /CSRF/i.test(d.error || '')) {
      csrfToken = null;
      return request(method, url, { body, form }, true);
    }
  }
  const data = await handle(res);
  if (unsafe) selfChanges++; // своя правка — она не должна дёргать перерисовку этой вкладки
  return data;
}

// Имя файла из Content-Disposition. Кириллица едет в filename*=UTF-8''… —
// его и предпочитаем, filename="…" остаётся запасным ASCII-вариантом.
function fileNameOf(header) {
  const h = String(header || '');
  const star = h.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try { return decodeURIComponent(star[1]); } catch { /* битая кодировка — ниже */ }
  }
  const plain = h.match(/filename="([^"]+)"/i);
  return plain ? plain[1] : 'schedule.xlsx';
}

async function handle(res) {
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* пустой ответ */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Ошибка ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
