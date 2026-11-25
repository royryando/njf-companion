import puppeteer from 'puppeteer-core';
import { cpSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { start, stats } from './mock-njf.mjs';

const SRC = process.argv[2] || new URL('../..', import.meta.url).pathname;
const HERE = new URL('.', import.meta.url).pathname;
const EXT = join(HERE, '.out', 'ext');
const SHOTS = join(HERE, '.out', 'shots');
const PORT = 4123;
const ORIGIN = `http://njf.test:${PORT}`;
const ADMIN = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME;

rmSync(EXT, { recursive: true, force: true });
for (const part of ['manifest.json', 'src', 'icons']) cpSync(join(SRC, part), join(EXT, part), { recursive: true });
mkdirSync(SHOTS, { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
manifest.host_permissions = [`${ORIGIN}/*`];
writeFileSync(join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 15000, every = 250) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(every);
  }
  return null;
}

const server = await start(PORT);
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  pipe: true,
  enableExtensions: [EXT],
  args: ['--no-first-run', '--no-default-browser-check', '--host-resolver-rules=MAP njf.test 127.0.0.1'],
  defaultViewport: { width: 1200, height: 800 },
});

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('src/background.js'), { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  check('service worker boots', !!extId, extId);

  const opts = await browser.newPage();
  await opts.goto(`chrome-extension://${extId}/src/options/options.html`);
  await opts.evaluate(async (origin) => {
    const store = await import('/src/shared/store.js');
    const env = await store.saveEnvironment({ name: 'Mock Dev', origin, autoLogin: true });
    const maker = await store.saveAccount({ label: 'Maker', username: 'maker', password: 'pw', envIds: [env.id] });
    await store.saveAccount({ label: 'Checker', username: 'checker', password: 'pw', envIds: [] });
    await store.saveAccount({ label: 'Approver', username: 'approver', password: 'wrong', envIds: [env.id] });
    await store.patchEnvironment(env.id, { defaultAccountId: maker.id });
    await store.saveSettings({ autoLoginDelaySec: 2 });
    await chrome.runtime.sendMessage({ type: 'SYNC' });
  }, ORIGIN);
  const stored = await opts.evaluate(() => chrome.storage.local.get('accounts'));
  check('passwords are encrypted at rest', !JSON.stringify(stored).includes('"pw"') && !!stored.accounts[0].secret?.data);
  const registered = await opts.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  check('content script registered for granted env', registered[0]?.matches?.[0] === `${ORIGIN}/*`, JSON.stringify(registered[0]?.matches));

  const app = await browser.newPage();
  await app.goto(`${ORIGIN}/transformation/index/tfm_allocation?id=7&readOnly=true`);
  const promptShown = await until(() => app.evaluate(() => !!document.getElementById('njf-companion-prompt')), 5000, 100);
  check('auto sign-in prompt appears on /login', !!promptShown && app.url().endsWith('/login'));
  await app.screenshot({ path: join(SHOTS, '1-autologin-prompt.png') });
  const signedIn = await until(() => app.evaluate(() => JSON.parse(localStorage.getItem('user') || 'null') === 'maker' && location.pathname !== '/login' && location.pathname));
  check('auto sign-in as default account', !!signedIn, `landed on ${signedIn}`);
  check('returns to the originally requested page', signedIn === '/transformation/index/tfm_allocation');
  const keys = await app.evaluate(() => ({
    token: typeof JSON.parse(localStorage.token), expired: JSON.parse(localStorage.expired), ping: JSON.parse(localStorage.pingInterval),
    menuAuth: JSON.parse(localStorage['menu-auth']).map((m) => m.to),
  }));
  check('session written in the app format', keys.token === 'string' && keys.expired === '20000' && keys.ping === '300000' && keys.menuAuth.length === 2, JSON.stringify(keys));

  check('test origin is non-secure (localStorage lease path)', await app.evaluate(() => !window.isSecureContext && !navigator.locks));
  const tabId = await opts.evaluate(async (o) => (await chrome.tabs.query({ url: `${o}/*` }))[0].id, ORIGIN);

  await app.click('a[href="/home"]');
  await sleep(300);
  await app.click('a[href^="/report/aging"]');
  await sleep(2500);
  const hist = await opts.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'PAGE_HISTORY' }), tabId);
  const paths = hist.entries.map((e) => new URL(e.url).pathname);
  check('history lists tab entries', hist.supported && paths.includes('/home') && paths.includes('/report/aging'), paths.join(' > '));
  const meta = await opts.evaluate((id) => chrome.storage.session.get(`hist:${id}`), tabId);
  const titles = Object.values(meta[`hist:${tabId}`] || {}).map((m) => m.title);
  check('history entries get page titles', titles.includes('Home') && titles.includes('Aging Report'), titles.join(', '));
  const target = hist.entries.find((e) => e.url.includes('tfm_allocation'));
  await opts.evaluate((id, key) => chrome.tabs.sendMessage(id, { type: 'PAGE_TRAVERSE', key }), tabId, target.key);
  const want = '/transformation/index/tfm_allocation?id=7&readOnly=true';
  const traversed = (await until(() => app.evaluate((w) => location.pathname + location.search === w, want), 4000)) ? want : await app.evaluate(() => location.pathname + location.search);
  check('jump to entry restores page and its URL state', traversed === '/transformation/index/tfm_allocation?id=7&readOnly=true', traversed);
  const hist2 = await opts.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'PAGE_HISTORY' }), tabId);
  check('forward entries are kept after jumping back', hist2.canGoForward && hist2.entries.length === hist.entries.length);

  await app.evaluate(async () => {
    const tok = JSON.parse(localStorage.token);
    const xhr = (method, url, body) => new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open(method, url);
      x.setRequestHeader('Authorization', 'Bearer ' + tok);
      x.setRequestHeader('Content-Type', 'application/json');
      x.onloadend = resolve;
      x.send(body);
    });
    await xhr('POST', '/api/v1/lms/demo-fail', JSON.stringify({ contNo: 'PK-001', amount: 1500000 }));
    await fetch('/api/v1/common/demo-missing?id=42', { headers: { Authorization: 'Bearer ' + tok } });
    await fetch('/api/v1/common/demo-ok');
    await fetch('/other/demo-fail');
    const ctrl = new AbortController();
    const p = fetch('/api/v1/lms/demo-slow', { signal: ctrl.signal }).catch(() => {});
    ctrl.abort();
    await p;
  });
  await sleep(800);
  const errs = (await opts.evaluate((id) => chrome.storage.session.get(`errors:${id}`), tabId))[`errors:${tabId}`];
  check('failed API requests captured (non-2xx only, API base only, aborts ignored)', errs?.count === 2 && errs.items.map((e) => e.status).join() === '404,500',
    JSON.stringify(errs?.items.map((e) => `${e.method} ${e.url} ${e.status}`)));
  const xhrErr = errs?.items.find((e) => e.status === 500);
  check('captured entry has request + response details', xhrErr?.requestBody.includes('PK-001') && xhrErr.responseBody.includes('Boom from LMS') && /bearer/i.test(xhrErr.requestHeaders.Authorization) && !!xhrErr.responseHeaders['content-type']);
  const badge = await opts.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
  check('toolbar badge shows the error count', badge === '2', `badge="${badge}"`);

  const pop = await browser.newPage();
  await pop.setViewport({ width: 360, height: 600, deviceScaleFactor: 2 });
  await pop.goto(`chrome-extension://${extId}/src/popup/popup.html?tab=${tabId}`);
  const clock = await until(() => pop.$eval('#clock', (el) => el.textContent).then((t) => /\d\d:\d\d/.test(t) && t), 6000);
  check('popup shows session countdown', !!clock, clock);
  const popupName = await pop.$eval('.identity .name', (el) => el.textContent);
  check('popup shows signed-in identity', popupName === 'Maya Maker', popupName);
  await pop.screenshot({ path: join(SHOTS, '2-popup-session.png'), fullPage: true });
  await pop.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await pop.bringToFront();
  await sleep(300);
  await pop.screenshot({ path: join(SHOTS, '2b-popup-session-light.png'), fullPage: true });
  const fits = await pop.evaluate(() => document.querySelector('main').scrollHeight <= document.querySelector('main').clientHeight);
  check('popup session view fits without scrolling (3 accounts)', fits);
  const noHScroll = await pop.evaluate(() => document.documentElement.scrollWidth <= 360 && document.querySelector('main').scrollWidth <= document.querySelector('main').clientWidth);
  check('popup never overflows horizontally (long identity line)', noHScroll);
  await pop.click('#tabs [data-view="history"]');
  await until(() => pop.$('.entry.current'), 4000);
  await pop.screenshot({ path: join(SHOTS, '3-popup-history.png'), fullPage: true });
  await pop.click('#tabs [data-view="status"]');
  const svc = await until(() => pop.$$eval('.svc', (rows) => rows.length === 9 && !rows.some((r) => r.querySelector('.dot.checking')) &&
    rows.map((r) => [r.querySelector('.title').textContent, r.querySelector('.chip').textContent, r.querySelector('.ms').textContent])), 10000);
  const byName = Object.fromEntries((svc || []).map(([n, c, ms]) => [n, { c, ms }]));
  check('service status lists all 9 services with latency', !!svc && svc.every(([, , ms]) => /\d+ ms/.test(ms)), JSON.stringify(svc?.map((r) => r.join(' '))));
  check('service status flags a DOWN service and the slow one', byName.LMS?.c === 'DOWN' && byName.Identity?.c === 'UP' && parseInt(byName.Interest?.ms) >= 400,
    `LMS=${byName.LMS?.c} Interest=${byName.Interest?.ms}`);
  check('service status headline', (await pop.$eval('.sum-line strong', (e) => e.textContent)) === '1 service down');
  await pop.screenshot({ path: join(SHOTS, '3b-popup-status.png'), fullPage: true });
  check('popup footer links to author site', (await pop.$eval('#foot a', (a) => a.href)) === 'https://www.royryando.me/');
  check('Error APIs tab shows the count', (await pop.$eval('#err-count', (e) => e.textContent)) === '2');
  await pop.click('#tabs [data-view="errors"]');
  await until(() => pop.$('.err-row'), 4000);
  const errRows = await pop.$$eval('.err-row', (rows) => rows.map((r) => r.querySelector('.status-pill').textContent + ' ' + r.querySelector('.title').textContent));
  check('Error APIs list shows newest first with API-relative paths', errRows.join('|') === '404 GET/common/demo-missing?id=42|500 POST/lms/demo-fail', errRows.join('|'));
  await pop.screenshot({ path: join(SHOTS, '3c-popup-errors.png'), fullPage: true });
  await pop.click('.err-row:nth-child(2)');
  await until(() => pop.$('.detail-head'), 3000);
  const detail = await pop.evaluate(() => document.querySelector('main').textContent);
  const pageToken = xhrErr.requestHeaders.Authorization.replace(/^Bearer /, '');
  check('error detail shows pretty JSON response and masks the token', detail.includes('"message": "Boom from LMS"') && detail.includes('(hidden)') && !detail.includes(pageToken));
  await pop.screenshot({ path: join(SHOTS, '3d-popup-error-detail.png'), fullPage: true });
  await pop.click('[data-act="errors-back"]');
  await pop.click('[data-act="clear-errors"]');
  await until(() => pop.$('.empty'), 3000);
  const cleared = await opts.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
  check('Clear empties the list and the badge', cleared === '' && (await pop.$eval('#err-count', (e) => e.classList.contains('hidden'))), `badge="${cleared}"`);

  const app2 = await browser.newPage();
  await app2.goto(`${ORIGIN}/home`);
  await sleep(500);
  const refreshBefore = stats.refresh;
  await app.evaluate(() => (window.__storageEvents.length = 0));
  const refreshed = await until(() => stats.refresh > refreshBefore, 25000);
  await sleep(500);
  const afterRefresh = await app.evaluate(() => ({ path: location.pathname, events: [...window.__storageEvents], user: JSON.parse(localStorage.user) }));
  check('token auto-refreshes before expiry', !!refreshed, `refresh calls: ${stats.refresh}`);
  check('app is notified in place (storage events, no reload)', ['token', 'refreshToken', 'expired', 'timestamp'].every((k) => afterRefresh.events.includes(k)), afterRefresh.events.join(','));
  await sleep(22000);
  const stillIn = await app.evaluate(() => location.pathname !== '/login' && !!localStorage.token);
  check('session survives past the original token lifetime', stillIn, `refresh calls: ${stats.refresh}`);
  const responsive = await Promise.race([Promise.all([app.evaluate(() => 1), app2.evaluate(() => 1)]).then(() => true), sleep(3000).then(() => false)]);
  check('two tabs stay responsive and do not double-refresh', responsive && stats.refresh - refreshBefore <= 4, `refreshes in ~45 s with 2 tabs: ${stats.refresh - refreshBefore}`);
  await app2.close();

  const sw1 = await opts.evaluate((id, accounts) => chrome.storage.local.get('accounts').then(({ accounts }) =>
    chrome.runtime.sendMessage({ type: 'SWITCH_USER', tabId: id, accountId: accounts.find((a) => a.username === 'checker').id })), tabId);
  check('switch user responds ok', sw1?.ok, sw1?.error);
  const switched = await until(() => app.evaluate(() => document.getElementById('who')?.textContent === 'user: checker' && 'user: checker'));
  check('page reloaded as the new user', switched === 'user: checker', switched);
  check('previous user session released on server', !stats.active.has('maker') && stats.active.has('checker'), [...stats.active].join(','));

  const bad = await opts.evaluate((id) => chrome.storage.local.get('accounts').then(({ accounts }) =>
    chrome.runtime.sendMessage({ type: 'SWITCH_USER', tabId: id, accountId: accounts.find((a) => a.username === 'approver').id })), tabId);
  check('wrong password surfaces a clear error', !bad.ok && /incorrect username or password/i.test(bad.error), bad.error);
  const unchanged = await app.evaluate(() => JSON.parse(localStorage.user));
  check('failed switch keeps the current session', unchanged === 'checker');

  const loginsBefore = stats.login;
  await fetch(`${ADMIN}/__revoke-refresh`);
  const relogged = await until(() => stats.login > loginsBefore, 25000);
  await sleep(800);
  const afterRelogin = await app.evaluate(() => ({ user: JSON.parse(localStorage.user), path: location.pathname }));
  check('re-signs in with saved account when refresh fails', !!relogged && afterRelogin.user === 'checker' && afterRelogin.path !== '/login', JSON.stringify(afterRelogin) + ' errors=' + stats.loginErrors.join(','));

  const envId = (await opts.evaluate(() => chrome.storage.local.get('environments'))).environments[0].id;
  const setAuto = (on) => opts.evaluate((id, v) => import('/src/shared/store.js').then((m) => m.patchEnvironment(id, { autoLogin: v })), envId, on);
  const restoreChecker = async () => {
    await fetch(`${ADMIN}/__reset-active`);
    await opts.evaluate((id) => chrome.storage.local.get('accounts').then(({ accounts }) =>
      chrome.runtime.sendMessage({ type: 'SWITCH_USER', tabId: id, accountId: accounts.find((a) => a.username === 'checker').id })), tabId);
    await until(() => app.evaluate(() => document.getElementById('who')?.textContent === 'user: checker'));
  };
  await setAuto(false);
  const attemptsBefore = stats.loginAttempts;
  await app.evaluate(() => {
    localStorage.token = '"forged"';
    localStorage.refreshToken = '"forged"';
    localStorage.expired = '"20000"';
    localStorage.timestamp = JSON.stringify(String(Date.now() - 15000));
    localStorage.user = '"maker"';
  });
  await sleep(9000);
  check('page-forged session cannot make the extension sign in another saved account', stats.loginAttempts === attemptsBefore && !stats.active.has('maker'), `login attempts: ${stats.loginAttempts - attemptsBefore}`);
  await restoreChecker();

  await fetch(`${ADMIN}/__reject-logins?on=1`);
  await fetch(`${ADMIN}/__revoke-refresh`);
  const stormBefore = stats.loginAttempts;
  await sleep(25000);
  check('failed re-sign-in backs off instead of looping', stats.loginAttempts - stormBefore <= 1, `login attempts in 25 s: ${stats.loginAttempts - stormBefore}`);
  await fetch(`${ADMIN}/__reject-logins?on=0`);
  await restoreChecker();
  await setAuto(true);

  const so = await opts.evaluate((id) => chrome.runtime.sendMessage({ type: 'SIGN_OUT', tabId: id }), tabId);
  await until(() => app.evaluate(() => location.pathname === '/login'), 5000);
  await sleep(3500);
  const out = await app.evaluate(() => ({ path: location.pathname, token: localStorage.token || null, prompt: !!document.getElementById('njf-companion-prompt') }));
  check('sign out clears the session and stays signed out', so.ok && out.path === '/login' && !out.token && !out.prompt && !stats.active.has('checker'), JSON.stringify(out));

  const ctx = await opts.evaluate((id) => chrome.runtime.sendMessage({ type: 'POPUP_CONTEXT', tabId: id, url: 'https://example.com/' }), tabId);
  check('popup context on non-NJF site lists environments', ctx.ok && !ctx.env && ctx.environments.length === 1 && ctx.environments[0].granted);
  const pagesBefore = (await browser.pages()).length;
  await opts.evaluate((envId, accId) => chrome.runtime.sendMessage({ type: 'OPEN_ENV', envId, accountId: accId }), ctx.environments[0].id, ctx.accounts.find((a) => a.username === 'maker').id);
  const newTab = await until(async () => (await browser.pages()).length > pagesBefore && (await browser.pages()).at(-1));
  const openedAs = await until(() => newTab.evaluate(() => JSON.parse(localStorage.user || 'null') === 'maker' && location.pathname !== '/login' && location.pathname), 12000);
  check('"Open as" signs in the chosen account in a new tab', !!openedAs, openedAs);

  await newTab.evaluate(() => { localStorage.clear(); });
  await fetch(`${ADMIN}/__reset-active`);
  const redir = await browser.newPage();
  await redir.goto(`${ORIGIN}//evil.example/phish`);
  const landed = await until(() => redir.evaluate(() => !!localStorage.token && location.pathname !== '/login' && location.href), 12000);
  check('return after auto sign-in stays on the NJF origin', !!landed && new URL(landed).host === `njf.test:${PORT}`, landed);

  await redir.evaluate(() => { localStorage.clear(); location.href = '/login'; });
  await sleep(4000);
  const afterAppLogout = await redir.evaluate(() => ({ path: location.pathname, token: !!localStorage.token, prompt: !!document.getElementById('njf-companion-prompt') }));
  check('app logout is not undone by auto sign-in', afterAppLogout.path === '/login' && !afterAppLogout.token && !afterAppLogout.prompt, JSON.stringify(afterAppLogout));

  await opts.setViewport({ width: 1100, height: 1500 });
  await opts.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await opts.bringToFront();
  await opts.reload();
  await sleep(1200);
  await opts.screenshot({ path: join(SHOTS, '4-settings.png'), fullPage: true });
  await pop.reload();
  await sleep(1200);
  await pop.screenshot({ path: join(SHOTS, '5-popup-signed-out.png'), fullPage: true });
} catch (err) {
  console.error(err);
  check('no unexpected exception', false, err.message);
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
