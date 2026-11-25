import { icon, logo } from '../shared/icons.js';
import { esc, fmtClock, fmtSpan, fmtAgo, decodeJwt, initials, patternFor } from '../shared/util.js';
import { accountsForEnv, patchEnvironment, saveSettings } from '../shared/store.js';

const $ = (sel) => document.querySelector(sel);
const app = $('#app');

const S = {
  tab: null,
  ctx: null,
  view: 'session',
  session: null,
  busy: null,
  errors: null,
  errorId: null,
  clock: null,
  poll: null,
};

async function bg(message) {
  const res = await chrome.runtime.sendMessage(message);
  if (!res?.ok) throw new Error(res?.error || 'Something went wrong');
  return res;
}

async function page(message) {
  const res = await chrome.tabs.sendMessage(S.tab.id, message);
  if (!res?.ok) throw new Error(res?.error || 'The page did not respond');
  return res;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureContent(attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await chrome.tabs.sendMessage(S.tab.id, { type: 'PING' });
      if (res?.active) return true;
      if (res?.ok) await chrome.tabs.sendMessage(S.tab.id, { type: 'CONFIG_CHANGED' }).catch(() => {});
    } catch {
      if (i === 0) await bg({ type: 'INJECT', tabId: S.tab.id }).catch(() => {});
    }
    await wait(250 + i * 150);
  }
  return false;
}

let snackTimer;
function snack(text, tone = '') {
  const el = $('#snackbar');
  el.textContent = text;
  el.className = `snackbar show ${tone}`;
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => (el.className = 'snackbar'), tone === 'error' ? 4200 : 2200);
}

function stopTimers() {
  clearInterval(S.clock);
  clearInterval(S.poll);
  S.clock = S.poll = null;
}

async function init() {
  $('#brand').innerHTML = `${logo(22)}<span>NJF Companion</span>`;
  $('#foot').innerHTML = `© ${new Date().getFullYear()} <a href="https://www.royryando.me" target="_blank" rel="noopener">Roy Ryando</a>`;
  $('#open-settings').innerHTML = icon('settings', 17);
  $('#open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('#tabs').addEventListener('click', (e) => {
    const view = e.target.closest('[data-view]')?.dataset.view;
    if (view && view !== S.view) setView(view);
  });
  app.addEventListener('click', onAction);
  app.addEventListener('change', onToggle);

  const forcedTab = Number(new URLSearchParams(location.search).get('tab'));
  [S.tab] = forcedTab ? [await chrome.tabs.get(forcedTab)] : await chrome.tabs.query({ active: true, currentWindow: true });
  await loadContext();
}

async function loadContext() {
  stopTimers();
  S.ctx = await bg({ type: 'POPUP_CONTEXT', tabId: S.tab.id, url: S.tab.url || '' });
  const env = S.ctx.env;
  $('#env-chip').innerHTML = env ? `<span class="chip chip-brand" title="${esc(env.origin)}">${esc(env.name)}</span>` : '';
  $('#tabs').classList.add('hidden');

  if (!env) return renderNoEnv();
  if (!env.granted) return renderGrant();
  app.innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
  if (!(await ensureContent())) return renderInactive();

  $('#tabs').classList.remove('hidden');
  await loadErrors({ countOnly: true });
  setView(S.view);
}

function setView(view) {
  S.view = view;
  for (const b of document.querySelectorAll('#tabs [data-view]')) b.setAttribute('aria-selected', String(b.dataset.view === view));
  stopTimers();
  if (view === 'history') return loadHistory();
  if (view === 'status') return loadStatus();
  if (view === 'errors') return loadErrors();
  return loadSession();
}

async function loadSession({ quiet = false } = {}) {
  try {
    const res = await page({ type: 'PAGE_SESSION' });
    const changed = !S.session || S.session.token !== res.session.token || S.session.user !== res.session.user;
    S.session = res.session;
    if (!quiet || changed) renderSession();
  } catch (err) {
    if (!quiet) renderInactive(err.message);
    return;
  }
  if (!S.clock) {
    S.clock = setInterval(updateClock, 1000);
    S.poll = setInterval(() => S.view === 'session' && !S.busy && loadSession({ quiet: true }), 3000);
  }
}

function leadMs(s) {
  const lead = S.ctx.settings.refreshLeadSec * 1000;
  return s.lifetime ? Math.min(lead, s.lifetime * 0.5) : lead;
}

function renderSession() {
  const s = S.session;
  const env = S.ctx.env;
  const accounts = accountsForEnv(S.ctx.accounts, env.id);
  const current = accounts.find((a) => a.username === s.user);
  const claims = s.token ? decodeJwt(s.token) : null;
  const displayName = claims?.name || current?.label || s.user || 'Signed in';
  const subParts = [...new Set([s.user, current?.label, claims?.email].filter((v) => v && v !== displayName))];
  const defaultAcc = accounts.find((a) => a.id === env.defaultAccountId) || accounts.find((a) => a.id === S.ctx.lastAccount[env.id]);

  const identity = s.signedIn
    ? `<div class="identity">
         <div class="avatar">${esc(initials(displayName))}</div>
         <div class="who"><div class="name" title="${esc(displayName)}">${esc(displayName)}</div><div class="sub" title="${esc(subParts.join(' · '))}">${esc(subParts.join(' · '))}</div></div>
         <span class="chip chip-ok">${icon('check', 11)}Active</span>
       </div>
       <div class="timer">
         <div class="timer-head"><span class="timer-label">Session expires in</span><span class="clock" id="clock">--:--</span></div>
         <div class="bar"><span id="bar"></span></div>
         <div class="timer-meta"><span id="auto-meta"></span><span id="sso-meta"></span></div>
       </div>
       <div class="actions">
         <button class="btn" data-act="refresh" ${S.busy ? 'disabled' : ''}>${S.busy === 'refresh' ? '<span class="spinner"></span>' : icon('refresh', 14)}Extend</button>
         <button class="btn" data-act="copy">${icon('copy', 14)}Copy token</button>
         <button class="btn btn-danger" data-act="signout" ${S.busy ? 'disabled' : ''}>${S.busy === 'signout' ? '<span class="spinner"></span>' : icon('logout', 14)}Sign out</button>
       </div>`
    : `<div class="identity">
         <div class="avatar" style="background:var(--surface-2);color:var(--text-3)">${icon('user', 17)}</div>
         <div class="who"><div class="name">Signed out</div><div class="sub">${accounts.length ? 'Pick an account below to sign in.' : 'Add an account in Settings to sign in from here.'}</div></div>
       </div>`;

  const rows = accounts.length
    ? accounts
        .map((a) => {
          const isCurrent = s.signedIn && a.username === s.user;
          const busy = S.busy === `switch:${a.id}`;
          return `<button class="row-btn" data-act="switch" data-id="${esc(a.id)}" ${isCurrent || S.busy || !a.hasPassword ? 'disabled' : ''}>
            <div class="avatar avatar-sm">${esc(initials(a.label))}</div>
            <div class="grow"><div class="title">${esc(a.label)}</div><div class="meta mono">${esc(a.username)}</div></div>
            ${isCurrent ? '<span class="chip chip-brand">Current</span>' : busy ? '<span class="spinner" style="color:var(--brand-text)"></span>' : !a.hasPassword ? '<span class="chip">No password</span>' : `<span class="go">${icon('chevron', 16)}</span>`}
          </button>`;
        })
        .join('')
    : `<div class="empty" style="padding:14px">${icon('user', 20)}<span>No saved accounts for ${esc(env.name)}.</span>
         <button class="btn btn-sm" data-act="settings" data-hash="accounts">${icon('plus', 13)}Add account</button></div>`;

  app.innerHTML = `
    <section class="card card-pad">${identity}</section>
    <section class="card">
      <div class="section-title"><span>${s.signedIn ? 'Switch account' : 'Sign in as'}</span><a href="#" data-act="settings" data-hash="accounts">Manage</a></div>
      <div class="rows">${rows}</div>
    </section>
    <section class="card prefs">
      <label class="pref" title="Signs in automatically on the ${esc(env.name)} login page">
        <div><div class="label">Auto sign-in</div><div class="hint">${defaultAcc ? `as ${esc(defaultAcc.label)}` : 'last used account'}</div></div>
        <span class="switch"><input type="checkbox" data-pref="autoLogin" ${env.autoLogin ? 'checked' : ''}><span></span></span>
      </label>
      <label class="pref" title="Extends the session before it expires (all environments)">
        <div><div class="label">Auto-refresh</div><div class="hint">${fmtSpan(Math.min(S.ctx.settings.refreshLeadSec * 1000, (s.lifetime || Infinity) * 0.5))} before expiry</div></div>
        <span class="switch"><input type="checkbox" data-pref="autoRefresh" ${S.ctx.settings.autoRefresh ? 'checked' : ''}><span></span></span>
      </label>
    </section>`;
  updateClock();
}

function updateClock() {
  const s = S.session;
  const clock = $('#clock');
  if (!s?.signedIn || !clock) return;
  if (!s.expiresAt) {
    clock.textContent = '--:--';
    return;
  }
  const left = s.expiresAt - Date.now();
  const lead = leadMs(s);
  const tone = left <= 0 ? 'expired' : left <= lead ? 'warn' : '';
  clock.textContent = left <= 0 ? 'Expired' : fmtClock(left);
  clock.className = `clock ${tone}`;
  const bar = $('#bar');
  bar.style.width = `${Math.max(0, Math.min(100, (left / (s.lifetime || 1)) * 100))}%`;
  bar.className = tone;

  const auto = $('#auto-meta');
  if (!S.ctx.settings.autoRefresh) auto.innerHTML = `${icon('clock', 12).replace('class="i"', 'class="i" style="display:inline;vertical-align:-2px"')} Auto-refresh off`;
  else if (left > lead) auto.innerHTML = `Auto-refresh in <span class="mono">${fmtClock(left - lead)}</span>`;
  else if (left > 0) auto.textContent = 'Refreshing…';
  else auto.textContent = 'Session ended';

  const ssoExp = decodeJwt(s.refreshToken)?.exp;
  const sso = $('#sso-meta');
  if (ssoExp) {
    const ssoLeft = ssoExp * 1000 - Date.now();
    sso.innerHTML = ssoLeft > 0 ? `SSO <span class="mono">${fmtClock(ssoLeft)}</span>` : 'SSO ended';
    sso.title = 'Refresh-token (single sign-on) lifetime. When it ends, the account is signed in again if it is saved.';
  } else sso.textContent = '';
}

async function loadHistory() {
  let snap;
  try {
    snap = await page({ type: 'PAGE_HISTORY' });
  } catch (err) {
    return renderInactive(err.message);
  }
  if (!snap.supported) {
    app.innerHTML = `<div class="card empty">${icon('history', 22)}<strong>Page history unavailable</strong><span>This version of Chrome does not expose tab navigation history to extensions.</span></div>`;
    return;
  }
  const key = `hist:${S.tab.id}`;
  const meta = (await chrome.storage.session.get(key))[key] || {};
  const current = snap.entries.find((e) => e.key === snap.currentKey);
  const entries = [...snap.entries].sort((a, b) => b.index - a.index);

  const items = entries
    .map((e) => {
      let url;
      try {
        url = new URL(e.url);
      } catch {
        return '';
      }
      const m = meta[e.key] || {};
      const isCurrent = e.key === snap.currentKey;
      const isForward = current && e.index > current.index;
      const params = [...url.searchParams].slice(0, 4);
      const when = fmtAgo(m.lastSeen || m.firstSeen);
      const metaLine = [isForward ? 'Forward' : null, when, m.user ? `as ${m.user}` : null].filter(Boolean).join(' · ');
      return `<button class="row-btn entry ${isCurrent ? 'current' : ''} ${isForward ? 'forward' : ''}" data-act="traverse" data-key="${esc(e.key)}" data-url="${esc(e.url)}" ${isCurrent ? 'aria-current="page"' : ''} title="${esc(url.pathname + url.search)}">
        <div class="grow">
          <div class="line"><div class="title">${esc(m.title || url.pathname)}</div>${isCurrent ? '<span class="chip chip-brand">Current</span>' : ''}</div>
          <div class="path">${esc(url.pathname + url.hash)}</div>
          ${params.length ? `<div class="params">${params.map(([k, v]) => `<span class="chip" title="${esc(`${k}=${v}`)}">${esc(k)}=${esc(v.length > 18 ? v.slice(0, 17) + '…' : v)}</span>`).join('')}${url.searchParams.size > 4 ? `<span class="chip">+${url.searchParams.size - 4}</span>` : ''}</div>` : ''}
          ${metaLine ? `<div class="meta">${esc(metaLine)}</div>` : ''}
        </div>
      </button>`;
    })
    .join('');

  app.innerHTML = `
    <div class="hist-toolbar">
      <button class="btn btn-sm" data-act="back" ${snap.canGoBack ? '' : 'disabled'}>${icon('back', 13)}Back</button>
      <button class="btn btn-sm" data-act="forward" ${snap.canGoForward ? '' : 'disabled'}>Forward${icon('forward', 13)}</button>
      <span class="count">${snap.entries.length} ${snap.entries.length === 1 ? 'page' : 'pages'} in this tab</span>
    </div>
    <section class="card timeline">${items || `<div class="empty">${icon('history', 20)}<span>No pages yet.</span></div>`}</section>
    <p class="faint" style="margin:0 2px;font-size:11.5px">Jumping to an entry restores it from the tab's own history, including its URL state and scroll position.</p>`;
  app.querySelector('.entry.current')?.scrollIntoView({ block: 'nearest' });
}

async function traverse(message) {
  try {
    await page({ type: 'PAGE_TRAVERSE', ...message });
  } catch (err) {
    return snack(err.message, 'error');
  }
  await wait(450);
  if (await ensureContent()) loadHistory();
}

const STATUS_POLL_MS = 15000;

async function loadStatus({ quiet = false } = {}) {
  if (!quiet || !S.status) renderStatus(null);
  let res;
  try {
    res = await page({ type: 'PAGE_STATUS' });
  } catch (err) {
    if (S.view === 'status') renderInactive(err.message);
    return;
  }
  if (S.view !== 'status') return;
  S.status = res;
  renderStatus(res);
  if (!S.poll) S.poll = setInterval(() => S.view === 'status' && loadStatus({ quiet: true }), STATUS_POLL_MS);
}

function latencyClass(ms) {
  if (ms == null) return '';
  return ms < 300 ? 'fast' : ms < 1000 ? 'slow' : 'bad';
}

function renderStatus(res) {
  const checking = !res;
  const services = res?.services || S.status?.services || [];
  const up = services.filter((x) => x.state === 'up').length;
  const down = services.filter((x) => x.state === 'down').length;
  const timed = services.filter((x) => x.ms != null);
  const avg = timed.length ? Math.round(timed.reduce((a, x) => a + x.ms, 0) / timed.length) : null;
  const reachable = services.some((x) => x.ms != null);

  let headline = 'Checking services…';
  let tone = 'checking';
  if (!checking) {
    if (!reachable) [headline, tone] = ['NJF API unreachable', 'down'];
    else if (down) [headline, tone] = [`${down} ${down === 1 ? 'service' : 'services'} down`, 'down'];
    else if (up === services.length) [headline, tone] = ['All services operational', 'up'];
    else [headline, tone] = [`${up} of ${services.length} services up`, 'unknown'];
  }
  const checked = res ? new Date(res.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';

  const rows = (services.length ? services : Array.from({ length: 9 }, () => null))
    .map((x) => {
      if (!x || checking) {
        return `<div class="svc"><span class="dot checking"></span><div class="grow"><div class="title">${esc(x?.name || '')}<span class="skeleton" style="${x ? 'display:none' : ''}"></span></div></div><span class="ms faint">…</span></div>`;
      }
      const base = res?.apiBase || S.status?.apiBase || '';
      const path = base && x.url.startsWith(base) ? x.url.slice(base.length) : x.url;
      const chip = x.state === 'up' ? 'chip-ok' : x.state === 'down' ? 'chip-danger' : '';
      return `<div class="svc" title="${esc(x.url)}">
        <span class="dot ${x.state}"></span>
        <div class="grow"><div class="title">${esc(x.name)}</div><div class="meta mono">${esc(path)}</div></div>
        <span class="ms ${latencyClass(x.ms)}">${x.ms == null ? '—' : `${x.ms} ms`}</span>
        <span class="chip ${chip}">${esc(x.detail || x.state.toUpperCase())}</span>
      </div>`;
    })
    .join('');

  app.innerHTML = `
    <section class="card card-pad status-sum">
      <div class="sum-line"><span class="dot ${tone}"></span><strong>${esc(headline)}</strong>
        <button class="btn btn-sm" data-act="recheck" ${checking ? 'disabled' : ''}>${checking ? '<span class="spinner"></span>' : icon('refresh', 13)}Recheck</button></div>
      <div class="muted sum-meta">${
        checking ? 'Pinging actuator health endpoints…' : `${up}/${services.length} up${avg != null ? ` · avg ${avg} ms` : ''} · checked ${esc(checked)}`
      }</div>
    </section>
    <section class="card"><div class="svc-list">${rows}</div></section>
    <p class="faint" style="margin:0 2px;font-size:11.5px">Spring Boot actuator health via the gateway, re-checked every ${STATUS_POLL_MS / 1000} s while this tab is open. Latency is time to first response.</p>`;
}

const errorsKey = () => `errors:${S.tab.id}`;

async function loadErrors({ countOnly = false } = {}) {
  S.errors = (await chrome.storage.session.get(errorsKey()))[errorsKey()] || { count: 0, items: [] };
  const badge = $('#err-count');
  badge.textContent = S.errors.count > 99 ? '99+' : String(S.errors.count);
  badge.classList.toggle('hidden', !S.errors.count);
  if (countOnly || S.view !== 'errors') return;
  if (S.errorId && S.errors.items.some((x) => x.id === S.errorId)) renderErrorDetail();
  else {
    S.errorId = null;
    renderErrors();
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && S.tab && changes[errorsKey()]) loadErrors({ countOnly: S.view !== 'errors' || !!S.errorId });
});

function apiBaseHref() {
  try {
    return new URL(S.ctx.env.apiBase || '/api/v1', `${S.ctx.env.origin}/`).href.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

const relPath = (url) => {
  const base = apiBaseHref();
  return base && url.startsWith(base) ? url.slice(base.length) || '/' : url;
};
const statusClass = (code) => (!code ? 's0' : code >= 500 ? 's5' : code >= 400 ? 's4' : 's3');
const statusLabel = (e) => (e.status ? String(e.status) : 'ERR');

function renderErrors() {
  const { count, items } = S.errors;
  if (!items.length) {
    app.innerHTML = `<section class="card empty">${icon('check', 22)}<strong>No failed API requests</strong><span>Requests to <span class="mono">${esc(apiBaseHref())}</span> from this tab that do not return 2xx appear here.</span></section>`;
    return;
  }
  const rows = items
    .map(
      (e) => `<button class="row-btn err-row" data-act="error-detail" data-id="${esc(e.id)}" title="${esc(e.url)}">
        <span class="status-pill ${statusClass(e.status)}">${esc(statusLabel(e))}</span>
        <div class="grow">
          <div class="title"><span class="method">${esc(e.method)}</span>${esc(relPath(e.url))}</div>
          <div class="meta">${esc([fmtAgo(e.ts), e.ms != null ? `${e.ms} ms` : null, e.statusText && e.status ? e.statusText : null, e.user ? `as ${e.user}` : null].filter(Boolean).join(' · '))}</div>
        </div>
        <span class="go">${icon('chevron', 16)}</span>
      </button>`,
    )
    .join('');
  app.innerHTML = `
    <div class="hist-toolbar">
      <span class="count-strong">${count} failed ${count === 1 ? 'request' : 'requests'}</span>
      ${count > items.length ? `<span class="faint" style="font-size:11.5px">latest ${items.length} kept</span>` : ''}
      <button class="btn btn-sm" data-act="clear-errors" style="margin-left:auto">${icon('trash', 13)}Clear</button>
    </div>
    <section class="card"><div class="rows" style="padding-top:6px">${rows}</div></section>`;
}

function prettyBody(text) {
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

const maskSecret = (name, value) =>
  /^(authorization|cookie|x-auth-token)$/i.test(name) ? String(value).replace(/^(\S+\s+)?(.{10}).{6,}$/, '$1$2… (hidden)') : value;

function headersBlock(headers, { mask }) {
  const entries = Object.entries(headers || {});
  if (!entries.length) return '<p class="faint pre-empty">None captured</p>';
  return `<pre class="code">${esc(entries.map(([k, v]) => `${k}: ${mask ? maskSecret(k, v) : v}`).join('\n'))}</pre>`;
}

function bodyBlock(text) {
  return text ? `<pre class="code">${esc(prettyBody(text))}</pre>` : '<p class="faint pre-empty">Empty</p>';
}

function renderErrorDetail() {
  const e = S.errors.items.find((x) => x.id === S.errorId);
  const page = (() => {
    try {
      const u = new URL(e.page);
      return u.pathname + u.search;
    } catch {
      return e.page || '';
    }
  })();
  const reqCount = Object.keys(e.requestHeaders || {}).length;
  const resCount = Object.keys(e.responseHeaders || {}).length;
  app.innerHTML = `
    <div class="hist-toolbar"><button class="btn btn-sm" data-act="errors-back">${icon('back', 13)}All errors</button></div>
    <section class="card card-pad">
      <div class="detail-head"><span class="status-pill ${statusClass(e.status)}">${esc(statusLabel(e))}</span><strong>${esc(e.statusText || (e.status ? 'Error' : 'Network error'))}</strong></div>
      <div class="detail-url mono"><span class="method">${esc(e.method)}</span>${esc(e.url)}</div>
      <dl class="kv">
        <dt>Time</dt><dd>${esc(new Date(e.ts).toLocaleString())}</dd>
        <dt>Duration</dt><dd>${e.ms != null ? `${e.ms} ms` : '—'}</dd>
        <dt>Page</dt><dd class="mono" title="${esc(e.page)}">${esc(page)}</dd>
        ${e.user ? `<dt>User</dt><dd>${esc(e.user)}</dd>` : ''}
      </dl>
      <div class="detail-actions">
        <button class="btn btn-sm" data-act="copy-curl">${icon('copy', 13)}Copy as cURL</button>
        <button class="btn btn-sm" data-act="copy-response">${icon('copy', 13)}Copy response</button>
      </div>
    </section>
    <details class="card sect" open><summary>Response body</summary>${bodyBlock(e.responseBody)}</details>
    <details class="card sect"><summary>Response headers <span class="faint">${resCount}</span></summary>${headersBlock(e.responseHeaders, { mask: false })}</details>
    <details class="card sect"><summary>Request headers <span class="faint">${reqCount}</span></summary>${headersBlock(e.requestHeaders, { mask: true })}</details>
    <details class="card sect" ${e.requestBody ? 'open' : ''}><summary>Request body</summary>${bodyBlock(e.requestBody)}</details>`;
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function toCurl(e) {
  const parts = [`curl -X ${e.method} ${shellQuote(e.url)}`];
  for (const [k, v] of Object.entries(e.requestHeaders || {})) parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  const body = e.requestBody || '';
  if (body && !/^\[(multipart\/form-data\]|Blob ·|binary ·)/.test(body)) parts.push(`--data-raw ${shellQuote(body)}`);
  return parts.join(' \\\n  ');
}

function renderNoEnv() {
  const { environments, accounts, origin } = S.ctx;
  const addable = origin && !environments.some((e) => e.origin === origin);
  const envRows = environments
    .map((env) => {
      const accs = accountsForEnv(accounts, env.id).filter((a) => a.hasPassword);
      return `<div class="env-row">
        <div class="head">
          <span class="avatar avatar-sm" style="border-radius:7px">${icon('server', 14)}</span>
          <div class="grow"><div style="font-weight:600">${esc(env.name)}</div><div class="faint mono" style="font-size:11px">${esc(env.origin)}</div></div>
          <button class="btn btn-sm" data-act="open-env" data-env="${esc(env.id)}">Open${icon('external', 12)}</button>
        </div>
        ${accs.length ? `<div class="as"><span class="faint" style="font-size:11.5px;align-self:center">Open as</span>${accs.map((a) => `<button class="chip chip-brand" style="border:0;cursor:pointer" data-act="open-env" data-env="${esc(env.id)}" data-account="${esc(a.id)}">${esc(a.label)}</button>`).join('')}</div>` : ''}
      </div>`;
    })
    .join('');

  app.innerHTML = `
    <section class="card notice">${icon('server', 17)}<div><strong>Not an NJF environment</strong><p>${
      addable ? 'Add this site to manage its session, or open one of your environments.' : 'Open one of your NJF environments to manage its session.'
    }</p>
      ${addable ? `<button class="btn btn-primary btn-sm" data-act="add-site">${icon('plus', 13)}Add ${esc(origin)}</button>` : ''}
    </div></section>
    ${
      environments.length
        ? `<section class="card"><div class="section-title"><span>Environments</span><a href="#" data-act="settings" data-hash="environments">Manage</a></div>${envRows}</section>`
        : `<section class="card empty">${icon('settings', 20)}<strong>No environments yet</strong><span>Add the URL of your NJF app in Settings.</span><button class="btn btn-sm" data-act="settings" data-hash="environments">Open Settings</button></section>`
    }`;
}

function renderGrant() {
  const env = S.ctx.env;
  app.innerHTML = `<section class="card notice warn">${icon('lock', 17)}<div><strong>Access needed</strong>
    <p>Allow NJF Companion to run on <span class="mono">${esc(env.origin)}</span> so it can manage the session in this tab.</p>
    <button class="btn btn-primary btn-sm" data-act="grant">Grant access</button></div></section>`;
}

function renderInactive(detail) {
  $('#tabs').classList.add('hidden');
  app.innerHTML = `<section class="card notice warn">${icon('alert', 17)}<div><strong>Reload to activate</strong>
    <p>${esc(detail && !/receiving end/i.test(detail) ? detail : 'NJF Companion is not connected to this tab yet.')}</p>
    <button class="btn btn-primary btn-sm" data-act="reload">${icon('refresh', 13)}Reload tab</button></div></section>`;
}

async function onAction(e) {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  e.preventDefault();
  const act = el.dataset.act;

  if (act === 'add-site') return addSite();
  if (act === 'grant') return grant();

  switch (act) {
    case 'settings':
      chrome.tabs.create({ url: chrome.runtime.getURL(`src/options/options.html#${el.dataset.hash || ''}`) });
      return window.close();
    case 'reload':
      chrome.tabs.reload(S.tab.id);
      return window.close();
    case 'open-env':
      await bg({ type: 'OPEN_ENV', envId: el.dataset.env, accountId: el.dataset.account || null }).catch((err) => snack(err.message, 'error'));
      return window.close();
    case 'copy':
      await navigator.clipboard.writeText(S.session?.token || '');
      return snack('Access token copied');
    case 'error-detail':
      S.errorId = el.dataset.id;
      renderErrorDetail();
      app.scrollTop = 0;
      return;
    case 'errors-back':
      S.errorId = null;
      return renderErrors();
    case 'clear-errors':
      await bg({ type: 'CLEAR_ERRORS', tabId: S.tab.id }).catch((err) => snack(err.message, 'error'));
      return loadErrors();
    case 'copy-curl':
    case 'copy-response': {
      const e = S.errors?.items.find((x) => x.id === S.errorId);
      if (!e) return;
      await navigator.clipboard.writeText(act === 'copy-curl' ? toCurl(e) : prettyBody(e.responseBody));
      return snack(act === 'copy-curl' ? 'cURL copied (includes the auth header)' : 'Response copied');
    }
    case 'recheck':
      clearInterval(S.poll);
      S.poll = null;
      return loadStatus();
    case 'back':
    case 'forward':
      return traverse({ direction: act });
    case 'traverse':
      if (el.getAttribute('aria-current')) return;
      return traverse({ key: el.dataset.key, url: el.dataset.url });
    case 'refresh':
      return busy('refresh', async () => {
        const res = await page({ type: 'PAGE_REFRESH' });
        if (res.relogin) snack('Signed in again with the saved account');
        else if (res.refreshed) snack('Session extended');
        else snack('Another NJF tab is refreshing the session; try again in a moment');
      });
    case 'signout':
      return busy('signout', async () => {
        await bg({ type: 'SIGN_OUT', tabId: S.tab.id });
        snack('Signed out');
        await wait(900);
      });
    case 'switch': {
      const account = S.ctx.accounts.find((a) => a.id === el.dataset.id);
      return busy(`switch:${el.dataset.id}`, async () => {
        await bg({ type: 'SWITCH_USER', tabId: S.tab.id, accountId: el.dataset.id });
        snack(`Signed in as ${account?.label || 'account'}`);
        await wait(1100);
      });
    }
  }
}

async function busy(id, fn) {
  S.busy = id;
  renderSession();
  try {
    await fn();
  } catch (err) {
    snack(err.message, 'error');
  } finally {
    S.busy = null;
  }
  await loadContext();
}

async function onToggle(e) {
  const pref = e.target.dataset.pref;
  if (!pref) return;
  try {
    if (pref === 'autoLogin') {
      await patchEnvironment(S.ctx.env.id, { autoLogin: e.target.checked });
      S.ctx.env.autoLogin = e.target.checked;
    } else {
      S.ctx.settings = await saveSettings({ [pref]: e.target.checked });
      updateClock();
    }
  } catch (err) {
    e.target.checked = !e.target.checked;
    snack(err.message, 'error');
  }
}

function addSite() {
  const origin = S.ctx.origin;
  const saved = chrome.runtime.sendMessage({ type: 'ADD_ENV', origin });
  const asked = chrome.permissions.request({ origins: [patternFor(origin)] });
  Promise.all([saved, asked])
    .then(async ([res, granted]) => {
      if (!res?.ok) throw new Error(res?.error || 'Could not add environment');
      await bg({ type: 'SYNC' });
      snack(granted ? `Added ${res.env.name}` : 'Added. Grant access to activate it.');
      await loadContext();
    })
    .catch((err) => snack(err.message, 'error'));
}

function grant() {
  chrome.permissions
    .request({ origins: [patternFor(S.ctx.env.origin)] })
    .then(async (granted) => {
      if (!granted) return snack('Access was not granted', 'error');
      await bg({ type: 'SYNC' });
      await loadContext();
    })
    .catch((err) => snack(err.message, 'error'));
}

init().catch((err) => {
  app.innerHTML = `<section class="card notice warn">${icon('alert', 17)}<div><strong>Something went wrong</strong><p>${esc(err.message)}</p></div></section>`;
});
