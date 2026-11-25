import { encrypt } from './vault.js';
import { originOf, uid } from './util.js';

export const DEFAULT_SETTINGS = Object.freeze({
  autoRefresh: true,
  refreshLeadSec: 120,
  reloginOnRefreshFail: true,
  autoLoginDelaySec: 3,
  showBadge: true,
  reloadOtherTabs: true,
});

export const DEFAULT_API_BASE = '/api/v1';

export async function getState() {
  const raw = await chrome.storage.local.get(['settings', 'environments', 'accounts', 'lastAccount']);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    environments: raw.environments || [],
    accounts: raw.accounts || [],
    lastAccount: raw.lastAccount || {},
  };
}

export async function saveSettings(patch) {
  const { settings } = await getState();
  const next = { ...settings, ...patch };
  next.refreshLeadSec = clamp(Number(next.refreshLeadSec) || DEFAULT_SETTINGS.refreshLeadSec, 30, 1800);
  next.autoLoginDelaySec = clamp(Number(next.autoLoginDelaySec) || 0, 0, 30);
  await chrome.storage.local.set({ settings: next });
  return next;
}

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

export function normalizeEnv(input) {
  const origin = originOf(String(input.origin || '').trim());
  if (!origin) throw new Error('Enter a valid http(s) URL for the app, e.g. http://192.168.1.200');
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Give the environment a name');
  let apiBase = String(input.apiBase || '').trim() || DEFAULT_API_BASE;
  if (!apiBase.startsWith('/')) {
    try {
      const u = new URL(apiBase);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
      apiBase = u.href;
    } catch {
      throw new Error('API base must be a path like /api/v1 or a full http(s) URL');
    }
  }
  return {
    id: input.id || uid(),
    name,
    origin,
    apiBase: apiBase.replace(/\/+$/, ''),
    autoLogin: !!input.autoLogin,
    defaultAccountId: input.defaultAccountId || null,
  };
}

export async function saveEnvironment(input) {
  const env = normalizeEnv(input);
  const { environments } = await getState();
  const clash = environments.find((e) => e.origin === env.origin && e.id !== env.id);
  if (clash) throw new Error(`${env.origin} is already configured as "${clash.name}"`);
  const idx = environments.findIndex((e) => e.id === env.id);
  if (idx >= 0) environments[idx] = { ...environments[idx], ...env };
  else environments.push(env);
  await chrome.storage.local.set({ environments });
  return env;
}

export async function patchEnvironment(id, patch) {
  const { environments } = await getState();
  const env = environments.find((e) => e.id === id);
  if (!env) throw new Error('Environment not found');
  Object.assign(env, patch);
  await chrome.storage.local.set({ environments });
  return env;
}

export async function deleteEnvironment(id) {
  const { environments, accounts, lastAccount } = await getState();
  delete lastAccount[id];
  await chrome.storage.local.set({
    environments: environments.filter((e) => e.id !== id),
    accounts: accounts.map((a) => ({ ...a, envIds: (a.envIds || []).filter((x) => x !== id) })),
    lastAccount,
  });
}

export async function saveAccount(input) {
  const username = String(input.username || '').trim();
  if (!username) throw new Error('Username is required');
  const label = String(input.label || '').trim() || username;
  const { accounts } = await getState();
  const existing = input.id ? accounts.find((a) => a.id === input.id) : null;
  if (!existing && !input.password) throw new Error('Password is required');
  const account = {
    id: existing?.id || uid(),
    label,
    username,
    envIds: Array.isArray(input.envIds) ? input.envIds : [],
    secret: input.password ? await encrypt(input.password) : existing.secret,
  };
  const next = existing ? accounts.map((a) => (a.id === account.id ? account : a)) : [...accounts, account];
  await chrome.storage.local.set({ accounts: next });
  return account;
}

export async function deleteAccount(id) {
  const { accounts, environments, lastAccount } = await getState();
  for (const k of Object.keys(lastAccount)) if (lastAccount[k] === id) delete lastAccount[k];
  await chrome.storage.local.set({
    accounts: accounts.filter((a) => a.id !== id),
    environments: environments.map((e) => (e.defaultAccountId === id ? { ...e, defaultAccountId: null } : e)),
    lastAccount,
  });
}

export async function setLastAccount(envId, accountId) {
  const { lastAccount } = await getState();
  lastAccount[envId] = accountId;
  await chrome.storage.local.set({ lastAccount });
}

export const envForOrigin = (environments, origin) => environments.find((e) => e.origin === origin) || null;

export const accountsForEnv = (accounts, envId) =>
  accounts.filter((a) => !a.envIds?.length || a.envIds.includes(envId));

export const publicAccount = (a) =>
  a && { id: a.id, label: a.label, username: a.username, envIds: a.envIds || [], hasPassword: !!a.secret };
