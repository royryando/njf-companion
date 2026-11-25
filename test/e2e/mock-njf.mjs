import http from 'node:http';

export const stats = { login: 0, loginAttempts: 0, refresh: 0, logout: 0, active: new Set(), loginErrors: [], rejectLogins: false };
const tokens = new Map();
const refreshTokens = new Map();
let seq = 0;
const EXPIRES_IN = 20;

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function issue(user) {
  const now = Math.floor(Date.now() / 1000);
  const access = `${b64u({ alg: 'none' })}.${b64u({ sub: user, preferred_username: user, name: user === 'maker' ? 'Maya Maker' : 'Cahya Checker', email: `${user}.with-a-very-long-address@adira-example.co.id`, exp: now + EXPIRES_IN, n: ++seq })}.sig`;
  const refresh = `${b64u({ alg: 'none' })}.${b64u({ sub: user, exp: now + 1800, n: seq })}.rsig`;
  tokens.set(access, { user, exp: Date.now() + EXPIRES_IN * 1000 });
  refreshTokens.set(refresh, user);
  return { access_token: access, refresh_token: refresh, expires_in: EXPIRES_IN, refresh_expires_in: 1800, token_type: 'Bearer' };
}
const authUser = (req) => {
  const t = tokens.get(String(req.headers.authorization || '').replace(/^Bearer /, ''));
  return t && t.exp > Date.now() ? t.user : null;
};

const APP = `<!doctype html><html><head><title>NJF</title><style>body{font:14px system-ui;margin:0}nav a{margin-right:10px}.wrap{padding:20px}</style></head>
<body><div class="wrap"><ol class="breadcrumb"><li class="breadcrumb-item active" id="crumb"></li></ol>
<nav><a href="/home" data-link>Home</a><a href="/transformation/index/tfm_allocation?id=7&readOnly=true" data-link>Disbursement</a><a href="/report/aging?from=2026-01-01&to=2026-11-30&branch=JKT" data-link>Report</a></nav>
<h1 id="h"></h1><div id="who"></div><form id="login" hidden><input id="u" placeholder="username"><input id="p" type="password"><button>Login</button></form></div>
<script>
  window.__storageEvents = [];
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k)) } catch { return null } };
  addEventListener('storage', (e) => { __storageEvents.push(e.key);
    if (e.key === 'token' && !e.newValue && location.pathname !== '/login') location.href = '/login'; });
  const names = { '/home': 'Home', '/transformation/index/tfm_allocation': 'Disbursement', '/report/aging': 'Aging Report' };
  function render() {
    const tok = read('token');
    if (location.pathname === '/login' && tok) return (location.href = '/');
    if (location.pathname !== '/login' && !tok) { history.replaceState(null, '', '/login'); return render(); }
    document.getElementById('crumb').textContent = names[location.pathname] || (location.pathname === '/login' ? 'Login' : 'Dashboard');
    document.getElementById('h').textContent = location.pathname;
    document.getElementById('who').textContent = tok ? 'user: ' + read('user') : 'signed out';
    document.getElementById('login').hidden = location.pathname !== '/login';
  }
  document.addEventListener('click', (e) => { const a = e.target.closest('[data-link]'); if (!a) return; e.preventDefault();
    history.pushState({ position: history.length }, '', a.getAttribute('href')); render(); });
  addEventListener('popstate', render);
  setInterval(async () => { const tok = read('token'); if (!tok) return;
    const r = await fetch('/api/v1/identity/auth/ping', { method: 'POST', headers: { Authorization: 'Bearer ' + tok } });
    if (r.status === 401) { localStorage.clear(); location.href = '/login'; } }, 2000);
  render();
</script></body></html>`;

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

export function start(port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    let body = '';
    for await (const c of req) body += c;

    if (p === '/api/v1/identity/auth/login') {
      const { username, password } = JSON.parse(body || '{}');
      stats.loginAttempts++;
      if (password !== 'pw' || stats.rejectLogins) {
        stats.loginErrors.push('40101');
        return json(res, 401, { code: '40101', message: 'Unauthorized', data: null });
      }
      if (stats.active.has(username)) {
        stats.loginErrors.push('40901');
        return json(res, 409, { code: '40901', message: 'Akun sedang digunakan', data: null });
      }
      stats.login++;
      stats.active.add(username);
      return json(res, 200, { code: '00000', message: 'Login success', data: { ...issue(username), ping_interval: 300 } });
    }
    if (p === '/api/v1/identity/auth/refresh-token') {
      const rt = url.searchParams.get('refreshToken');
      const user = refreshTokens.get(rt);
      if (!user) return json(res, 400, { code: '40000', message: 'Invalid refresh token', data: null });
      refreshTokens.delete(rt);
      stats.refresh++;
      return json(res, 200, { code: '00000', message: 'Refresh token', data: issue(user) });
    }
    if (p === '/api/v1/identity/auth/logout') {
      const user = authUser(req);
      if (!user) return json(res, 401, { code: '40101', message: 'NOT OK' });
      stats.logout++;
      stats.active.delete(user);
      refreshTokens.delete(url.searchParams.get('refreshToken'));
      return json(res, 200, { code: '00000', message: 'OK', data: null });
    }
    if (p === '/api/v1/identity/auth/ping') {
      return authUser(req) ? json(res, 200, { code: '00000', message: 'OK' }) : json(res, 401, { code: '40101', message: 'Unauthorized' });
    }
    if (p === '/api/v1/identity/menu/navbar2') {
      if (!authUser(req)) return json(res, 401, { code: '40101' });
      return json(res, 200, { code: '00000', data: [{ name: 'Home', to: '/home' }, { name: 'JF Framework', items: [{ name: 'Disbursement', to: '/transformation/index/tfm_allocation' }] }] });
    }
    const health = p.match(/^\/api\/v1\/([a-z]+)\/actuator\/health$/);
    if (health) {
      if (health[1] === 'interest') await new Promise((r) => setTimeout(r, 450));
      if (health[1] === 'lms') return json(res, 503, { status: 'DOWN' });
      return json(res, 200, { status: 'UP' });
    }
    if (p === '/api/v1/lms/demo-fail') return json(res, 500, { code: '50000', message: 'Boom from LMS', data: null });
    if (p === '/api/v1/common/demo-missing') return json(res, 404, { code: '40400', message: 'Not found' });
    if (p === '/api/v1/common/demo-ok') return json(res, 200, { code: '00000', data: [] });
    if (p === '/other/demo-fail') return json(res, 500, { message: 'outside API base' });
    if (p === '/api/v1/lms/demo-slow') { await new Promise((r) => setTimeout(r, 1500)); return json(res, 200, {}); }
    if (p === '/__reject-logins') {
      stats.rejectLogins = url.searchParams.get('on') === '1';
      return json(res, 200, { ok: true });
    }
    if (p === '/__reset-active') {
      stats.active.clear();
      return json(res, 200, { ok: true });
    }
    if (p === '/__revoke-refresh') {
      refreshTokens.clear();
      return json(res, 200, { ok: true });
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(APP);
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}
