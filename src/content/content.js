(() => {
  const previous = window.__njfCompanion;
  if (previous?.alive()) return;
  previous?.dispose();
  const runtime = chrome.runtime;

  const ENTRY_URL = location.href;

  const LOCK_KEY = 'njf-companion:refresh-lock';
  const LOCK_NAME = 'njf-companion:refresh';
  const PRESERVED_KEYS = /^(lang|.*theme.*)$/i;
  const API_MESSAGES = {
    40101: 'Incorrect username or password.',
    40901: 'This account is already signed in elsewhere. Sign it out there, or wait for that session to lapse.',
  };

  const LEASE_MS = 20000;

  let cfg = null;
  let refreshing = null;
  let retryAt = 0;
  let failures = 0;
  let reloginBlocked = false;
  let prompt = null;
  let autoLoginChecking = false;
  let tickTimer = null;
  let lastSeenExpiry = null;
  let wasSignedIn = null;

  const alive = () => {
    try {
      return !!runtime?.id;
    } catch {
      return false;
    }
  };

  function send(message) {
    return new Promise((resolve) => {
      if (!alive()) return resolve(null);
      try {
        chrome.runtime.sendMessage(message, (res) => {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function readJSON(key) {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  function readSession() {
    const token = readJSON('token') || null;
    const refreshToken = readJSON('refreshToken') || null;
    const user = readJSON('user');
    const lifetime = Number(readJSON('expired')) || 0;
    const issuedAt = Number(readJSON('timestamp')) || 0;
    return {
      signedIn: !!token,
      user: user == null || user === '' ? null : String(user),
      token,
      refreshToken,
      lifetime,
      issuedAt,
      expiresAt: token && lifetime && issuedAt ? issuedAt + lifetime : null,
    };
  }

  function writeKeys(values, { notify }) {
    for (const [key, value] of Object.entries(values)) {
      const oldValue = localStorage.getItem(key);
      const newValue = JSON.stringify(value);
      localStorage.setItem(key, newValue);
      if (notify) {
        window.dispatchEvent(
          new StorageEvent('storage', { key, oldValue, newValue, url: location.href, storageArea: localStorage }),
        );
      }
    }
  }

  function clearAppStorage(keep = {}) {
    for (const key of Object.keys(localStorage)) {
      if (!PRESERVED_KEYS.test(key) && !(key in keep) && key !== LOCK_KEY) localStorage.removeItem(key);
    }
  }

  const isLoginPath = (pathname) => /\/login$/i.test(String(pathname).replace(/\/+$/, ''));
  const isLoginPage = () => isLoginPath(location.pathname);

  function refreshLeadMs(s) {
    const lead = (cfg?.settings.refreshLeadSec || 120) * 1000;
    return s.lifetime ? Math.min(lead, s.lifetime * 0.5) : lead;
  }

  const isRefreshDue = (s) =>
    s.signedIn && !!s.refreshToken && !!s.expiresAt && s.expiresAt - Date.now() <= refreshLeadMs(s);

  const apiUrl = (path) => new URL(String(cfg.env.apiBase || '/api/v1').replace(/\/+$/, '') + path, location.origin);

  async function api(path, { method = 'POST', body, query, token, user } = {}) {
    const url = apiUrl(path);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);

    const headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (user) headers['X-Auth-Key'] = user;
    const lang = localStorage.getItem('lang');
    if (lang) headers['X-LANG'] = lang;

    let res;
    try {
      res = await fetch(url.href, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error(`Cannot reach the NJF API at ${url.origin}. Check the environment's API base URL.`);
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
    }
    const code = json?.code != null ? String(json.code) : null;
    if (!res.ok || (code && code !== '00000')) {
      const err = new Error(API_MESSAGES[code] || json?.message || json?.error || `Request failed (HTTP ${res.status})`);
      err.code = code;
      err.status = res.status;
      throw err;
    }
    return json && 'data' in json ? json.data : json;
  }

  function flattenMenu(list) {
    const out = [];
    const walk = (items) => {
      for (const item of items || []) {
        if (Array.isArray(item.items) && item.items.length) walk(item.items);
        else out.push(item);
      }
    };
    try {
      walk(list);
    } catch {
    }
    return out;
  }

  async function logoutRemote(s) {
    if (!s.token || !s.refreshToken) return;
    try {
      await api('/identity/auth/logout', { query: { refreshToken: s.refreshToken }, token: s.token, user: s.user });
    } catch {
    }
  }

  async function login({ username, password, accountId }, { mode }) {
    const prev = readSession();
    const sameUser = prev.signedIn && prev.user === username;
    if (sameUser) await logoutRemote(prev);

    const data = await api('/identity/auth/login', { body: { username, password } });
    if (!data?.access_token) throw new Error('Unexpected sign-in response from NJF');

    let menu = [];
    try {
      menu = (await api('/identity/menu/navbar2', { method: 'GET', token: data.access_token, user: username })) || [];
    } catch {
    }

    if (prev.signedIn && !sameUser) await logoutRemote(prev);

    const prevPing = readJSON('pingInterval');
    const values = {
      token: data.access_token,
      refreshToken: data.refresh_token,
      expired: String(Number(data.expires_in) * 1000),
      timestamp: String(Date.now()),
      user: username,
      pingInterval: data.ping_interval != null ? String(Number(data.ping_interval) * 1000) : prevPing || '300000',
      menu: Array.isArray(menu) ? menu : [],
      'menu-auth': flattenMenu(menu),
    };

    if (mode === 'relogin') {
      writeKeys(values, { notify: true });
    } else {
      clearAppStorage(values);
      writeKeys(values, { notify: false });
    }
    failures = 0;
    retryAt = 0;
    send({ type: 'LOGIN_DONE', accountId, username });
    setTimeout(tick, 0);
  }

  async function withSessionLock(fn) {
    if (navigator.locks?.request) return navigator.locks.request(LOCK_NAME, fn);
    const owner = Math.random().toString(36).slice(2);
    const lease = () => localStorage.setItem(LOCK_KEY, JSON.stringify({ owner, until: Date.now() + LEASE_MS }));
    const held = readJSON(LOCK_KEY);
    if (held && held.until > Date.now()) return { skipped: true };
    lease();
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 90));
    if (readJSON(LOCK_KEY)?.owner !== owner) return { skipped: true };
    const renew = setInterval(() => readJSON(LOCK_KEY)?.owner === owner && lease(), 5000);
    try {
      return await fn();
    } finally {
      clearInterval(renew);
      if (readJSON(LOCK_KEY)?.owner === owner) localStorage.removeItem(LOCK_KEY);
    }
  }

  const isAuthFailure = (err) => [400, 401, 403].includes(err?.status);

  function refreshSession(reason) {
    if (refreshing) return refreshing;
    refreshing = withSessionLock(async () => {
      const s = readSession();
      if (!s.signedIn || !s.refreshToken) throw new Error('Not signed in');
      if (reason === 'auto' && !isRefreshDue(s)) return { skipped: true };

      let data;
      try {
        data = await api('/identity/auth/refresh-token', { query: { refreshToken: s.refreshToken } });
        if (!data?.access_token) throw new Error('Unexpected refresh response from NJF');
      } catch (err) {
        if (!isAuthFailure(err) || !cfg.settings.reloginOnRefreshFail || reloginBlocked || !s.user) throw err;
        const creds = await send({ type: 'CREDENTIALS', purpose: 'relogin', username: s.user });
        if (!creds?.ok) throw err;
        try {
          await login(creds, { mode: 'relogin' });
        } catch (loginErr) {
          if (loginErr.code === '40101') reloginBlocked = true;
          throw loginErr;
        }
        dismissExpiryWarning();
        return { relogin: true };
      }

      writeKeys(
        {
          token: data.access_token,
          refreshToken: data.refresh_token || s.refreshToken,
          expired: String(Number(data.expires_in) * 1000),
          timestamp: String(Date.now()),
        },
        { notify: true },
      );
      dismissExpiryWarning();
      return { refreshed: true };
    })
      .then(
        (res) => {
          if (res?.skipped) retryAt = Date.now() + 3000 + Math.random() * 2000;
          else {
            failures = 0;
            retryAt = 0;
          }
          return res;
        },
        (err) => {
          failures += 1;
          retryAt = Date.now() + Math.min(30000 * 2 ** (failures - 1), 10 * 60000);
          throw err;
        },
      )
      .finally(() => {
        refreshing = null;
        setTimeout(tick, 0);
      });
    return refreshing;
  }

  function dismissExpiryWarning() {
    for (const modal of document.querySelectorAll('.modal.show')) {
      if (/sesi sebentar lagi berakhir/i.test(modal.textContent || '')) modal.querySelector('.btn-close')?.click();
    }
  }

  const SERVICES = [
    ['identity', 'Identity'],
    ['common', 'Common'],
    ['log', 'Log'],
    ['lms', 'LMS'],
    ['interest', 'Interest'],
    ['scheduler', 'Scheduler'],
    ['controller', 'Controller'],
    ['screening', 'Screening'],
    ['allocation', 'Allocation'],
  ];
  const PROBE_TIMEOUT_MS = 8000;

  async function probe([id, name]) {
    const url = apiUrl(`/${id}/actuator/health`);
    const result = { id, name, url: url.href, state: 'down', detail: '', ms: null };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const start = performance.now();
    try {
      const res = await fetch(url.href, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: ctrl.signal });
      result.ms = Math.round(performance.now() - start);
      let body = null;
      try {
        body = await res.json();
      } catch {
      }
      const status = typeof body?.status === 'string' ? body.status.toUpperCase() : null;
      if (status) {
        result.state = status === 'UP' ? 'up' : 'down';
        result.detail = status;
      } else if (res.status === 404 || res.ok) {
        result.state = 'unknown';
        result.detail = 'Not exposed';
      } else {
        result.detail = res.status === 503 ? 'Unavailable' : `HTTP ${res.status}`;
      }
    } catch (err) {
      result.detail = err?.name === 'AbortError' ? 'Timeout' : 'Unreachable';
    } finally {
      clearTimeout(timer);
    }
    return result;
  }

  async function serviceStatus() {
    return { checkedAt: Date.now(), apiBase: apiUrl('').href, services: await Promise.all(SERVICES.map(probe)) };
  }

  const API_ERROR_EVENT = 'njf-companion:api-error';
  const str = (v, max = 70000) => String(v ?? '').slice(0, max);
  const headerMap = (h) =>
    Object.fromEntries(
      Object.entries(h && typeof h === 'object' ? h : {})
        .slice(0, 100)
        .map(([k, v]) => [str(k, 200), str(v, 8000)]),
    );

  function onApiError(e) {
    if (!cfg || !alive() || typeof e.detail !== 'string' || e.detail.length > 400000) return;
    let entry;
    try {
      entry = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (!entry || typeof entry.url !== 'string') return;
    const base = apiUrl('').href.replace(/\/+$/, '');
    if (!(entry.url === base || entry.url.startsWith(`${base}/`) || entry.url.startsWith(`${base}?`))) return;
    send({
      type: 'API_ERROR',
      entry: {
        method: str(entry.method, 16),
        url: str(entry.url, 4000),
        status: Number(entry.status) || 0,
        statusText: str(entry.statusText, 200),
        ts: Number(entry.ts) || Date.now(),
        ms: Number.isFinite(entry.ms) ? Math.round(entry.ms) : null,
        page: str(entry.page, 4000),
        user: readSession().user,
        requestHeaders: headerMap(entry.requestHeaders),
        requestBody: str(entry.requestBody),
        responseHeaders: headerMap(entry.responseHeaders),
        responseBody: str(entry.responseBody),
      },
    });
  }

  function tick() {
    if (!cfg || !alive()) return;
    const s = readSession();
    if (s.signedIn && wasSignedIn !== true) send({ type: 'CLEAR_SUPPRESS' });
    wasSignedIn = s.signedIn;
    lastSeenExpiry = s.signedIn ? s.expiresAt : null;
    if (cfg.settings.autoRefresh && isRefreshDue(s) && !refreshing && Date.now() >= retryAt) {
      refreshSession('auto').catch(() => {});
    }
  }

  function pageTitle({ fromDom }) {
    const path = location.pathname;
    const menu = readJSON('menu-auth');
    if (Array.isArray(menu)) {
      const hit = menu.find((m) => m && m.to === path);
      if (hit?.name) return String(hit.name);
    }
    if (isLoginPage()) return 'Login';
    if (fromDom) {
      const crumb = document.querySelector('.breadcrumb-item.active, .breadcrumb li:last-child');
      const text = crumb?.textContent?.trim();
      if (text) return text.slice(0, 120);
    }
    return null;
  }

  function recordHistory({ fromDom }) {
    const entry = window.navigation?.currentEntry;
    if (!cfg || !entry?.key) return;
    send({
      type: 'HISTORY_RECORD',
      meta: {
        key: entry.key,
        url: entry.url || location.href,
        title: pageTitle({ fromDom }),
        user: readSession().user,
        ts: Date.now(),
      },
    });
  }

  function onEntryChange() {
    recordHistory({ fromDom: false });
    const key = window.navigation?.currentEntry?.key;
    const later = () => window.navigation?.currentEntry?.key === key && recordHistory({ fromDom: true });
    setTimeout(later, 700);
    setTimeout(later, 2000);
    tick();
    maybeAutoLogin();
  }

  function historySnapshot() {
    const nav = window.navigation;
    if (!nav?.entries) return { supported: false };
    return {
      supported: true,
      currentKey: nav.currentEntry?.key || null,
      canGoBack: !!nav.canGoBack,
      canGoForward: !!nav.canGoForward,
      entries: nav.entries().map((e) => ({ key: e.key, url: e.url, index: e.index })),
    };
  }

  function returnUrl() {
    const candidates = [ENTRY_URL];
    const nav = window.navigation;
    if (nav?.entries && nav.currentEntry && nav.currentEntry.index > 0) {
      candidates.push(nav.entries()[nav.currentEntry.index - 1]?.url);
    }
    candidates.push(document.referrer);
    for (const candidate of candidates) {
      try {
        const u = new URL(candidate);
        if (u.origin === location.origin && !isLoginPath(u.pathname)) return u.href;
      } catch {
      }
    }
    return `${location.origin}/`;
  }

  async function maybeAutoLogin() {
    if (!cfg || prompt || autoLoginChecking || !alive()) return;
    autoLoginChecking = true;
    try {
      const s = readSession();
      if (s.signedIn) {
        const pending = await send({ type: 'PENDING_QUERY' });
        if (!pending?.account || prompt) return;
        if (pending.account.username === s.user) send({ type: 'LOGIN_DONE', accountId: pending.account.id, username: s.user });
        else showPrompt(pending.account, 0, true);
        return;
      }
      if (!isLoginPage()) return;
      const res = await send({ type: 'AUTOLOGIN_QUERY' });
      if (res?.ok && res.account && !prompt && !readSession().signedIn) showPrompt(res.account, res.delaySec || 0, false);
    } finally {
      autoLoginChecking = false;
    }
  }

  function showPrompt(account, delaySec, switching) {
    const host = document.createElement('div');
    host.id = 'njf-companion-prompt';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:20px;bottom:20px;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${PROMPT_CSS}</style>
      <div class="card" role="status" aria-live="polite">
        <div class="head"><span class="dot"></span><span class="brand">NJF Companion</span>
          <button class="x" data-act="cancel" aria-label="Dismiss">&times;</button></div>
        <div class="body">
          <div class="title"></div>
          <div class="sub"></div>
        </div>
        <div class="bar"><span></span></div>
        <div class="actions">
          <button class="btn ghost" data-act="cancel">Cancel</button>
          <button class="btn primary" data-act="go">Sign in now</button>
        </div>
      </div>`;
    document.documentElement.appendChild(host);

    const $ = (sel) => root.querySelector(sel);
    const label = account.label && account.label !== account.username ? `${account.label} (${account.username})` : account.username;
    let timer = null;
    let busy = false;

    const setView = ({ title, sub, bar, actions, tone }) => {
      $('.title').textContent = title;
      $('.sub').textContent = sub || '';
      $('.card').dataset.tone = tone || '';
      $('.bar').style.display = bar ? '' : 'none';
      $('.actions').style.display = actions ? '' : 'none';
      if (actions) {
        $('[data-act="go"]').textContent = actions.go;
        $('.actions [data-act="cancel"]').textContent = actions.cancel;
      }
    };

    const close = () => {
      clearTimeout(timer);
      host.remove();
      prompt = null;
    };

    const go = async () => {
      if (busy) return;
      busy = true;
      clearTimeout(timer);
      setView({ title: `Signing in as ${label}…`, sub: cfg.env.name, bar: false, actions: null });
      try {
        const outcome = await withSessionLock(async () => {
          if (!switching && readSession().signedIn) return 'already';
          const creds = await send({ type: 'CREDENTIALS', accountId: account.id });
          if (!creds?.ok) throw new Error(creds?.error || 'Saved account is unavailable');
          await login(creds, { mode: switching ? 'switch' : 'login' });
          return 'done';
        });
        if (outcome?.skipped) throw new Error('Another tab is signing in. Try again in a moment.');
        setView({ title: outcome === 'already' ? 'Already signed in' : `Signed in as ${label}`, sub: 'Loading…', tone: 'ok' });
        if (switching || !isLoginPage()) location.reload();
        else location.replace(returnUrl());
      } catch (err) {
        busy = false;
        setView({ title: 'Automatic sign-in failed', sub: err.message, tone: 'error', actions: { go: 'Retry', cancel: 'Dismiss' } });
      }
    };

    root.addEventListener('click', (e) => {
      const act = e.target.closest?.('[data-act]')?.dataset.act;
      if (act === 'go') go();
      if (act === 'cancel' && !busy) {
        send({ type: 'AUTOLOGIN_SUPPRESS' });
        close();
      }
    });

    prompt = { close, busy: () => busy };
    setView({
      title: switching ? `Switch to ${label}?` : `Signing in as ${label}`,
      sub: switching ? `Requested from the toolbar · ${cfg.env.name}` : `Auto sign-in · ${cfg.env.name}`,
      bar: delaySec > 0,
      actions: { go: switching ? 'Switch now' : 'Sign in now', cancel: 'Cancel' },
    });
    if (delaySec > 0) {
      const fill = $('.bar span');
      fill.style.transition = 'none';
      fill.style.width = '100%';
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          fill.style.transition = `width ${delaySec}s linear`;
          fill.style.width = '0%';
        }),
      );
      timer = setTimeout(go, delaySec * 1000);
    } else {
      go();
    }
  }

  const PROMPT_CSS = `
    :host { all: initial; }
    .card { width: 320px; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1b2330;
      background: #fff; border: 1px solid #e3e6eb; border-radius: 10px; overflow: hidden;
      box-shadow: 0 12px 32px rgba(16,24,40,.18), 0 2px 6px rgba(16,24,40,.08); animation: in .18s ease-out; }
    @keyframes in { from { opacity: 0; transform: translateY(6px); } }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 0; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #1d5a9b; }
    .card[data-tone="ok"] .dot { background: #1f7a52; }
    .card[data-tone="error"] .dot { background: #b42318; }
    .brand { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: #6b7585; flex: 1; }
    .x { all: unset; cursor: pointer; font-size: 18px; line-height: 1; color: #8a94a3; padding: 0 2px; }
    .x:hover { color: #1b2330; }
    .body { padding: 6px 12px 10px; }
    .title { font-weight: 600; font-size: 14px; }
    .sub { color: #5d6878; margin-top: 2px; word-break: break-word; }
    .card[data-tone="error"] .sub { color: #b42318; }
    .bar { height: 3px; background: #eef1f5; margin: 0 12px; border-radius: 2px; overflow: hidden; }
    .bar span { display: block; height: 100%; width: 100%; background: #1d5a9b; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 12px 12px; }
    .btn { all: unset; cursor: pointer; font-weight: 600; font-size: 12.5px; padding: 6px 12px; border-radius: 6px; }
    .btn.ghost { color: #3b4655; }
    .btn.ghost:hover { background: #f1f3f6; }
    .btn.primary { background: #1d5a9b; color: #fff; }
    .btn.primary:hover { background: #174c85; }
    .btn:focus-visible, .x:focus-visible { outline: 2px solid #1d5a9b; outline-offset: 2px; }
  `;

  const handlers = {
    PING: () => ({ active: !!cfg }),
    TICK: () => {
      tick();
      return {};
    },
    CONFIG_CHANGED: async () => {
      await init();
      return {};
    },
    PAGE_SESSION: () => ({ session: readSession(), path: location.pathname, loginPage: isLoginPage() }),
    PAGE_REFRESH: async () => refreshSession('manual'),
    PAGE_LOGIN: async (msg) => {
      if (msg.envId !== cfg.env.id) throw new Error('This tab changed environment. Try again.');
      prompt?.close();
      await login(msg, { mode: msg.mode || 'switch' });
      setTimeout(() => (isLoginPage() ? location.replace(returnUrl()) : location.reload()), 50);
      return {};
    },
    PAGE_SIGN_OUT: async () => {
      prompt?.close();
      await logoutRemote(readSession());
      clearAppStorage();
      setTimeout(() => location.replace('/login'), 50);
      return {};
    },
    PAGE_HISTORY: () => historySnapshot(),
    PAGE_STATUS: () => serviceStatus(),
    PAGE_TRAVERSE: (msg) => {
      const nav = window.navigation;
      setTimeout(() => {
        try {
          if (msg.direction === 'back') nav.back();
          else if (msg.direction === 'forward') nav.forward();
          else nav.traverseTo(msg.key).finished.catch(() => msg.url && location.assign(msg.url));
        } catch {
          if (msg.url) location.assign(msg.url);
        }
      }, 0);
      return {};
    },
  };

  function onMessage(msg, sender, sendResponse) {
    if (!alive() || sender.id !== runtime.id) return false;
    const handler = handlers[msg?.type];
    if (!handler) return false;
    if (!cfg && msg.type !== 'PING' && msg.type !== 'CONFIG_CHANGED') {
      sendResponse({ ok: false, error: 'NJF Companion is not active on this site' });
      return false;
    }
    Promise.resolve()
      .then(() => handler(msg))
      .then(
        (res) => sendResponse({ ok: true, ...(res || {}) }),
        (err) => sendResponse({ ok: false, error: err?.message || String(err) }),
      );
    return true;
  }

  async function init() {
    const res = await send({ type: 'CS_INIT' });
    cfg = res?.ok && res.env ? { env: res.env, settings: res.settings } : null;
    reloginBlocked = false;
    retryAt = 0;
    send({ type: 'ERRORS_SYNC' });
    if (!cfg) {
      clearInterval(tickTimer);
      tickTimer = null;
      return;
    }
    if (!tickTimer) tickTimer = setInterval(() => (alive() ? tick() : dispose()), 5000);
    onEntryChange();
  }

  const onVisibility = () => document.visibilityState === 'visible' && tick();

  function onStorage(e) {
    if (e.key !== 'token' && e.key !== 'timestamp' && e.key !== null) return;
    if (e.isTrusted && prompt && !prompt.busy() && readSession().signedIn && isLoginPage()) {
      prompt.close();
      location.replace(returnUrl());
      return;
    }
    tick();
  }

  function onPageHide() {
    if (!cfg || !alive() || lastSeenExpiry == null) return;
    if (!readSession().signedIn && lastSeenExpiry - Date.now() > 15000) send({ type: 'AUTOLOGIN_SUPPRESS' });
  }

  function dispose() {
    clearInterval(tickTimer);
    tickTimer = null;
    cfg = null;
    prompt?.close();
    window.navigation?.removeEventListener?.('currententrychange', onEntryChange);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener(API_ERROR_EVENT, onApiError);
    try {
      runtime.onMessage.removeListener(onMessage);
    } catch {
    }
  }

  window.__njfCompanion = { alive, dispose };
  runtime.onMessage.addListener(onMessage);
  window.navigation?.addEventListener?.('currententrychange', onEntryChange);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('storage', onStorage);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener(API_ERROR_EVENT, onApiError);

  init();
})();
