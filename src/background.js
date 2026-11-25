import {
  getState,
  saveEnvironment,
  setLastAccount,
  envForOrigin,
  accountsForEnv,
  publicAccount,
} from './shared/store.js';
import { decrypt } from './shared/vault.js';
import { originOf, patternFor, suggestEnvName } from './shared/util.js';

const CONTENT_SCRIPT_ID = 'njf-companion';
const CONTENT_SCRIPT_FILE = 'src/content/content.js';
const HOOK_SCRIPT_ID = 'njf-companion-hook';
const HOOK_SCRIPT_FILE = 'src/content/page-hook.js';
const SCRIPT_IDS = [CONTENT_SCRIPT_ID, HOOK_SCRIPT_ID];
const TICK_ALARM = 'session-tick';
const HISTORY_LIMIT = 300;
const ERRORS_LIMIT = 100;
const BADGE_COLOR = '#b42318';

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await setup();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(setup);

async function setup() {
  await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
  await syncContentScripts();
}

chrome.permissions.onAdded.addListener(() => syncContentScripts());
chrome.permissions.onRemoved.addListener(() => syncContentScripts());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.environments) syncContentScripts();
  if (changes.environments || changes.settings || changes.accounts) broadcast({ type: 'CONFIG_CHANGED' });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  historyChains.delete(tabId);
  errorChains.delete(tabId);
  chrome.storage.session.remove([histKey(tabId), suppressKey(tabId), pendingKey(tabId), grantKey(tabId), errorsKey(tabId)]);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK_ALARM) broadcast({ type: 'TICK' });
});

let syncChain = Promise.resolve();
function syncContentScripts() {
  syncChain = syncChain.then(doSync).catch((err) => console.warn('[NJF Companion] sync failed', err));
  return syncChain;
}

async function grantedOrigins() {
  const { environments } = await getState();
  const out = [];
  for (const env of environments) {
    if (await chrome.permissions.contains({ origins: [patternFor(env.origin)] })) out.push(env.origin);
  }
  return [...new Set(out)];
}

async function doSync() {
  const matches = (await grantedOrigins()).map(patternFor);
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS });
  if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: registered.map((r) => r.id) });
  if (!matches.length) return;
  await chrome.scripting.registerContentScripts([
    { id: CONTENT_SCRIPT_ID, matches, js: [CONTENT_SCRIPT_FILE], runAt: 'document_start', persistAcrossSessions: true },
    { id: HOOK_SCRIPT_ID, matches, js: [HOOK_SCRIPT_FILE], runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true },
  ]);
  const tabs = await chrome.tabs.query({ url: matches });
  await Promise.all(tabs.map((t) => injectInto(t.id)));
}

async function injectInto(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [HOOK_SCRIPT_FILE], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] });
    return true;
  } catch {
    return false;
  }
}

async function njfTabs(origin) {
  const origins = origin ? [origin] : await grantedOrigins();
  if (!origins.length) return [];
  return chrome.tabs.query({ url: origins.map(patternFor) });
}

async function broadcast(message) {
  for (const tab of await njfTabs()) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
}

const histKey = (tabId) => `hist:${tabId}`;
const suppressKey = (tabId) => `suppress:${tabId}`;
const pendingKey = (tabId) => `pending:${tabId}`;
const errorsKey = (tabId) => `errors:${tabId}`;
const grantKey = (tabId) => `grant:${tabId}`;
const signedInKey = (envId) => `signedin:${envId}`;
const GRANT_TTL_MS = 2 * 60 * 1000;

const historyChains = new Map();
const errorChains = new Map();

async function sessionGet(key) {
  return (await chrome.storage.session.get(key))[key];
}

function recordHistory(tabId, meta) {
  const run = async () => {
    const key = histKey(tabId);
    const all = (await sessionGet(key)) || {};
    const prev = all[meta.key] || {};
    all[meta.key] = {
      url: meta.url || prev.url,
      title: meta.title || prev.title || null,
      user: meta.user ?? prev.user ?? null,
      firstSeen: prev.firstSeen || meta.ts,
      lastSeen: meta.ts,
    };
    const keys = Object.keys(all);
    if (keys.length > HISTORY_LIMIT) {
      keys.sort((a, b) => all[a].lastSeen - all[b].lastSeen);
      for (const k of keys.slice(0, keys.length - HISTORY_LIMIT)) delete all[k];
    }
    await chrome.storage.session.set({ [key]: all });
  };
  const next = (historyChains.get(tabId) || Promise.resolve()).then(run, run);
  historyChains.set(tabId, next);
  return next;
}

async function showErrorCount(tabId, count) {
  const { settings } = await getState();
  const text = settings.showBadge && count > 0 ? (count > 99 ? '99+' : String(count)) : '';
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
      await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
    }
  } catch {
  }
}

function recordError(tabId, entry) {
  const run = async () => {
    const key = errorsKey(tabId);
    const data = (await sessionGet(key)) || { count: 0, items: [] };
    data.count += 1;
    data.items.unshift({ id: `${Date.now().toString(36)}-${data.count}`, ...entry });
    data.items.length = Math.min(data.items.length, ERRORS_LIMIT);
    await chrome.storage.session.set({ [key]: data });
    await showErrorCount(tabId, data.count);
  };
  const next = (errorChains.get(tabId) || Promise.resolve()).then(run, run);
  errorChains.set(tabId, next);
  return next;
}

function pickAutoLoginAccount(state, env) {
  const scoped = accountsForEnv(state.accounts, env.id).filter((a) => a.secret);
  return (
    scoped.find((a) => a.id === env.defaultAccountId) ||
    scoped.find((a) => a.id === state.lastAccount[env.id]) ||
    scoped[0] ||
    null
  );
}

async function credentialsFor(env, accountId) {
  const { accounts } = await getState();
  const account = accountsForEnv(accounts, env.id).find((a) => a.id === accountId);
  if (!account) throw new Error('Account is not available for this environment');
  return { accountId: account.id, username: account.username, password: await decrypt(account.secret) };
}

async function grant(tabId, accountId) {
  await chrome.storage.session.set({ [grantKey(tabId)]: { accountId, until: Date.now() + GRANT_TTL_MS } });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg?.type) return false;
  const fromContent = !!sender.tab && !String(sender.url || '').startsWith(`chrome-extension://${chrome.runtime.id}/`);
  const handler = fromContent ? contentHandlers[msg.type] : uiHandlers[msg.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(
      (res) => sendResponse({ ok: true, ...(res || {}) }),
      (err) => sendResponse({ ok: false, error: err?.message || String(err) }),
    );
  return true;
});

async function senderEnv(sender) {
  const state = await getState();
  const env = envForOrigin(state.environments, originOf(sender.url));
  if (!env) throw new Error('This site is not a configured NJF environment');
  return { state, env };
}

const contentHandlers = {
  async CS_INIT(_msg, sender) {
    const state = await getState();
    const env = envForOrigin(state.environments, originOf(sender.url));
    if (!env) return { env: null };
    return { env, settings: state.settings };
  },

  async AUTOLOGIN_QUERY(_msg, sender) {
    const { state, env } = await senderEnv(sender);
    const tabId = sender.tab.id;
    const pending = await sessionGet(pendingKey(tabId));
    if (pending) {
      const account = state.accounts.find((a) => a.id === pending);
      if (account) {
        await grant(tabId, account.id);
        return { account: publicAccount(account), delaySec: 0, explicit: true };
      }
    }
    if (!env.autoLogin || (await sessionGet(suppressKey(tabId)))) return { account: null };
    const account = pickAutoLoginAccount(state, env);
    if (account) await grant(tabId, account.id);
    return { account: publicAccount(account), delaySec: state.settings.autoLoginDelaySec };
  },

  async PENDING_QUERY(_msg, sender) {
    const { state } = await senderEnv(sender);
    const pending = await sessionGet(pendingKey(sender.tab.id));
    const account = pending && state.accounts.find((a) => a.id === pending);
    if (account) await grant(sender.tab.id, account.id);
    return { account: publicAccount(account) || null };
  },

  async AUTOLOGIN_SUPPRESS(_msg, sender) {
    await chrome.storage.session.set({ [suppressKey(sender.tab.id)]: true });
    await chrome.storage.session.remove(pendingKey(sender.tab.id));
  },

  async CREDENTIALS(msg, sender) {
    const { env } = await senderEnv(sender);
    const tabId = sender.tab.id;
    if (msg.purpose === 'relogin') {
      const record = await sessionGet(signedInKey(env.id));
      if (!record || record.username !== msg.username) throw new Error('Session was not started by NJF Companion');
      if (await sessionGet(suppressKey(tabId))) throw new Error('Signed out');
      return credentialsFor(env, record.accountId);
    }
    const granted = await sessionGet(grantKey(tabId));
    await chrome.storage.session.remove(grantKey(tabId));
    if (!granted || granted.accountId !== msg.accountId || granted.until < Date.now()) {
      throw new Error('Sign-in was not authorised. Try again from the toolbar.');
    }
    return credentialsFor(env, granted.accountId);
  },

  async LOGIN_DONE(msg, sender) {
    const { state, env } = await senderEnv(sender);
    const account = state.accounts.find((a) => a.id === msg.accountId);
    if (account && account.username === msg.username) {
      await setLastAccount(env.id, account.id);
      await chrome.storage.session.set({ [signedInKey(env.id)]: { accountId: account.id, username: account.username } });
    }
    await chrome.storage.session.remove([suppressKey(sender.tab.id), pendingKey(sender.tab.id)]);
  },

  async CLEAR_SUPPRESS(_msg, sender) {
    await senderEnv(sender);
    await chrome.storage.session.remove(suppressKey(sender.tab.id));
  },

  async HISTORY_RECORD(msg, sender) {
    await senderEnv(sender);
    if (msg.meta?.key) await recordHistory(sender.tab.id, msg.meta);
  },

  async API_ERROR(msg, sender) {
    await senderEnv(sender);
    if (msg.entry?.url) await recordError(sender.tab.id, msg.entry);
  },

  async ERRORS_SYNC(_msg, sender) {
    const data = await sessionGet(errorsKey(sender.tab.id));
    await showErrorCount(sender.tab.id, data?.count || 0);
  },
};

const uiHandlers = {
  async POPUP_CONTEXT({ tabId, url }) {
    const state = await getState();
    const origin = originOf(url);
    const environments = [];
    for (const env of state.environments) {
      environments.push({ ...env, granted: await chrome.permissions.contains({ origins: [patternFor(env.origin)] }) });
    }
    return {
      origin,
      env: environments.find((e) => e.origin === origin) || null,
      environments,
      accounts: state.accounts.map(publicAccount),
      settings: state.settings,
      lastAccount: state.lastAccount,
      tabId,
    };
  },

  async CLEAR_ERRORS({ tabId }) {
    const run = async () => {
      await chrome.storage.session.remove(errorsKey(tabId));
      await showErrorCount(tabId, 0);
    };
    const next = (errorChains.get(tabId) || Promise.resolve()).then(run, run);
    errorChains.set(tabId, next);
    await next;
  },

  async INJECT({ tabId }) {
    return { injected: await injectInto(tabId) };
  },

  async ADD_ENV({ origin }) {
    const env = await saveEnvironment({ name: suggestEnvName(origin), origin });
    return { env };
  },

  async SYNC() {
    await syncContentScripts();
  },

  async SWITCH_USER({ tabId, accountId }) {
    const tab = await chrome.tabs.get(tabId);
    const state = await getState();
    const env = envForOrigin(state.environments, originOf(tab.url));
    if (!env) throw new Error('This tab is not an NJF environment');
    const creds = await credentialsFor(env, accountId);
    await chrome.storage.session.remove(suppressKey(tabId));
    const res = await chrome.tabs.sendMessage(tabId, { type: 'PAGE_LOGIN', ...creds, envId: env.id, mode: 'switch' }, { frameId: 0 });
    if (!res?.ok) throw new Error(res?.error || 'Sign-in failed');
    await setLastAccount(env.id, accountId);
    if (state.settings.reloadOtherTabs) {
      for (const other of await njfTabs(env.origin)) if (other.id !== tabId) chrome.tabs.reload(other.id);
    }
    return { username: creds.username };
  },

  async SIGN_OUT({ tabId }) {
    const tab = await chrome.tabs.get(tabId);
    const origin = originOf(tab.url);
    const ids = origin ? (await njfTabs(origin)).map((t) => t.id) : [];
    const state = await getState();
    const env = envForOrigin(state.environments, origin);
    if (env) await chrome.storage.session.remove(signedInKey(env.id));
    await chrome.storage.session.set(Object.fromEntries([...new Set([tabId, ...ids])].map((id) => [suppressKey(id), true])));
    const res = await chrome.tabs.sendMessage(tabId, { type: 'PAGE_SIGN_OUT' });
    if (!res?.ok) throw new Error(res?.error || 'Sign-out failed');
  },

  async OPEN_ENV({ envId, accountId }) {
    const { environments } = await getState();
    const env = environments.find((e) => e.id === envId);
    if (!env) throw new Error('Environment not found');
    if (!accountId) {
      await chrome.tabs.create({ url: `${env.origin}/` });
      return;
    }
    const tab = await chrome.tabs.create({ url: 'about:blank' });
    await chrome.storage.session.set({ [pendingKey(tab.id)]: accountId });
    await chrome.tabs.update(tab.id, { url: `${env.origin}/` });
  },
};
