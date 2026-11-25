import { icon, logo } from '../shared/icons.js';
import { esc, initials, patternFor, uid } from '../shared/util.js';
import {
  DEFAULT_API_BASE,
  getState,
  normalizeEnv,
  saveEnvironment,
  patchEnvironment,
  deleteEnvironment,
  saveAccount,
  deleteAccount,
  saveSettings,
  accountsForEnv,
} from '../shared/store.js';
import { encrypt, decrypt } from '../shared/vault.js';

const $ = (sel, root = document) => root.querySelector(sel);
let state = null;
let granted = {};

async function render() {
  state = await getState();
  granted = {};
  for (const env of state.environments) {
    granted[env.id] = await chrome.permissions.contains({ origins: [patternFor(env.origin)] });
  }
  renderWelcome();
  renderEnvironments();
  renderAccounts();
  renderSettings();
}

function renderWelcome() {
  $('#welcome').innerHTML = state.environments.length
    ? ''
    : `<div class="welcome">
        ${logo(40)}
        <div class="grow"><h2>Welcome to NJF Companion</h2><p>Add the NJF environment you work on, then save the accounts you sign in with.</p></div>
        <button class="btn btn-primary" data-act="env-add">${icon('plus', 14)}Add environment</button>
      </div>`;
}

function renderEnvironments() {
  const list = $('#env-list');
  if (!state.environments.length) {
    list.innerHTML = `<div class="empty">${icon('server', 22)}<strong>No environments</strong><span>Add the URL you open NJF on, e.g. <span class="mono">http://192.168.1.200</span>.</span></div>`;
    return;
  }
  list.innerHTML = state.environments
    .map((env) => {
      const accs = accountsForEnv(state.accounts, env.id);
      const ok = granted[env.id];
      return `<div class="item" data-id="${esc(env.id)}">
        <span class="tile">${icon('server', 17)}</span>
        <div class="grow">
          <div class="title">${esc(env.name)}
            ${ok ? `<span class="chip chip-ok">${icon('check', 11)}Access granted</span>` : `<span class="chip chip-warn">Access needed</span>`}
          </div>
          <div class="sub"><span class="mono">${esc(env.origin)}</span> · API <span class="mono">${esc(env.apiBase || DEFAULT_API_BASE)}</span></div>
          <div class="env-controls">
            ${ok ? '' : `<button class="btn btn-primary btn-sm" data-act="env-grant">${icon('lock', 13)}Grant access</button>`}
            <label class="inline-control"><span class="switch"><input type="checkbox" data-act="env-autologin" ${env.autoLogin ? 'checked' : ''}><span></span></span>Auto sign-in</label>
            <label class="inline-control">as
              <select class="input" data-act="env-default" ${accs.length ? '' : 'disabled'}>
                <option value="">Last used account</option>
                ${accs.map((a) => `<option value="${esc(a.id)}" ${a.id === env.defaultAccountId ? 'selected' : ''}>${esc(a.label)} (${esc(a.username)})</option>`).join('')}
              </select>
            </label>
          </div>
        </div>
        <div class="tools">
          <button class="icon-btn" data-act="env-open" title="Open">${icon('external', 16)}</button>
          <button class="icon-btn" data-act="env-edit" title="Edit">${icon('edit', 16)}</button>
          <button class="icon-btn" data-act="env-delete" title="Delete">${icon('trash', 16)}</button>
        </div>
      </div>`;
    })
    .join('');
}

function renderAccounts() {
  const list = $('#acc-list');
  if (!state.accounts.length) {
    list.innerHTML = `<div class="empty">${icon('user', 22)}<strong>No saved accounts</strong><span>Save the users you test with to switch between them in one click.</span></div>`;
    return;
  }
  const envName = (id) => state.environments.find((e) => e.id === id)?.name;
  list.innerHTML = state.accounts
    .map((a) => {
      const envs = (a.envIds || []).map(envName).filter(Boolean);
      return `<div class="item" data-id="${esc(a.id)}">
        <div class="avatar">${esc(initials(a.label))}</div>
        <div class="grow">
          <div class="title">${esc(a.label)} ${a.secret ? '' : '<span class="chip chip-warn">No password</span>'}</div>
          <div class="sub"><span class="mono">${esc(a.username)}</span></div>
          <div class="chips" style="margin-top:6px">${envs.length ? envs.map((n) => `<span class="chip">${esc(n)}</span>`).join('') : '<span class="chip">All environments</span>'}</div>
        </div>
        <div class="tools">
          <button class="icon-btn" data-act="acc-edit" title="Edit">${icon('edit', 16)}</button>
          <button class="icon-btn" data-act="acc-delete" title="Delete">${icon('trash', 16)}</button>
        </div>
      </div>`;
    })
    .join('');
}

function renderSettings() {
  const form = $('#settings-form');
  for (const [key, value] of Object.entries(state.settings)) {
    const input = form.elements[key];
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = !!value;
    else if (document.activeElement !== input) input.value = value;
  }
}

let snackTimer;
function snack(text, tone = '') {
  const el = $('#snackbar');
  el.textContent = text;
  el.className = `snackbar show ${tone}`;
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => (el.className = 'snackbar'), tone === 'error' ? 4500 : 2200);
}

function confirmed(btn) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1';
  const original = btn.innerHTML;
  const originalTitle = btn.title;
  btn.innerHTML = btn.classList.contains('icon-btn') ? icon('check', 16) : 'Click again to confirm';
  btn.title = 'Click again to confirm';
  btn.style.color = 'var(--danger)';
  setTimeout(() => {
    delete btn.dataset.armed;
    btn.innerHTML = original;
    btn.title = originalTitle;
    btn.style.color = '';
  }, 3000);
  return false;
}

const envDialog = $('#env-dialog');
const envForm = $('#env-form');

function openEnvDialog(env) {
  envForm.reset();
  envForm.dataset.id = env?.id || '';
  $('#env-dialog-title').textContent = env ? 'Edit environment' : 'Add environment';
  $('#env-error').textContent = '';
  envForm.elements.name.value = env?.name || '';
  envForm.elements.origin.value = env?.origin || '';
  envForm.elements.apiBase.value = env?.apiBase && env.apiBase !== DEFAULT_API_BASE ? env.apiBase : '';
  envDialog.showModal();
}

envForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.submitter?.value === 'cancel') return envDialog.close();
  const id = envForm.dataset.id || null;
  const existing = state.environments.find((x) => x.id === id);
  let env;
  try {
    env = normalizeEnv({
      ...existing,
      id,
      name: envForm.elements.name.value,
      origin: envForm.elements.origin.value,
      apiBase: envForm.elements.apiBase.value,
    });
  } catch (err) {
    $('#env-error').textContent = err.message;
    return;
  }
  const asked = chrome.permissions.request({ origins: [patternFor(env.origin)] }).catch(() => false);
  saveEnvironment(env)
    .then(async () => {
      envDialog.close();
      const ok = await asked;
      snack(ok ? `${env.name} saved` : `${env.name} saved. Grant access to activate it.`);
      await chrome.runtime.sendMessage({ type: 'SYNC' });
      render();
    })
    .catch((err) => ($('#env-error').textContent = err.message));
});

const accDialog = $('#acc-dialog');
const accForm = $('#acc-form');

function openAccDialog(acc) {
  accForm.reset();
  accForm.dataset.id = acc?.id || '';
  $('#acc-dialog-title').textContent = acc ? 'Edit account' : 'Add account';
  $('#acc-error').textContent = '';
  accForm.elements.label.value = acc?.label && acc.label !== acc.username ? acc.label : '';
  accForm.elements.username.value = acc?.username || '';
  accForm.elements.password.type = 'password';
  accForm.elements.password.required = !acc?.secret;
  accForm.elements.password.placeholder = acc?.secret ? 'Leave blank to keep the saved password' : '';
  $('[data-act="toggle-pw"]').innerHTML = icon('eye', 16);
  $('#acc-envs').innerHTML = state.environments.length
    ? state.environments
        .map(
          (env) =>
            `<label class="env-check"><input type="checkbox" value="${esc(env.id)}" ${acc?.envIds?.includes(env.id) ? 'checked' : ''}>${esc(env.name)}</label>`,
        )
        .join('')
    : '<span class="faint">No environments yet: the account will be available everywhere.</span>';
  accDialog.showModal();
}

accForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.submitter?.value === 'cancel') return accDialog.close();
  try {
    await saveAccount({
      id: accForm.dataset.id || null,
      label: accForm.elements.label.value,
      username: accForm.elements.username.value,
      password: accForm.elements.password.value,
      envIds: [...accForm.querySelectorAll('#acc-envs input:checked')].map((i) => i.value),
    });
    accDialog.close();
    snack('Account saved');
    render();
  } catch (err) {
    $('#acc-error').textContent = err.message;
  }
});

async function exportConfig() {
  const withPasswords = $('#export-passwords').checked;
  const { settings, environments, accounts } = await getState();
  const originOf = (id) => environments.find((e) => e.id === id)?.origin;
  const data = {
    format: 'njf-companion',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    environments: environments.map((e) => ({
      name: e.name,
      origin: e.origin,
      apiBase: e.apiBase,
      autoLogin: e.autoLogin,
      defaultAccount: accounts.find((a) => a.id === e.defaultAccountId)?.username || null,
    })),
    accounts: await Promise.all(
      accounts.map(async (a) => ({
        label: a.label,
        username: a.username,
        environments: (a.envIds || []).map(originOf).filter(Boolean),
        ...(withPasswords && a.secret ? { password: await decrypt(a.secret).catch(() => undefined) } : {}),
      })),
    ),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `njf-companion-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  snack(withPasswords ? 'Exported with passwords. Keep the file private.' : 'Exported without passwords');
}

async function importConfig(file) {
  const data = JSON.parse(await file.text());
  if (data?.format !== 'njf-companion' || !Array.isArray(data.environments) || !Array.isArray(data.accounts)) {
    throw new Error('This file is not an NJF Companion export');
  }
  const current = await getState();
  const environments = [...current.environments];
  const newEnvs = [];
  for (const raw of data.environments) {
    const existing = environments.find((e) => e.origin === raw.origin);
    if (existing) {
      existing.name = normalizeEnv({ ...existing, name: raw.name || existing.name }).name;
      continue;
    }
    const env = normalizeEnv({ ...raw, id: null, defaultAccountId: null });
    environments.push(env);
    newEnvs.push(env);
  }
  const external = newEnvs.filter((e) => /^https?:/i.test(e.apiBase) && new URL(e.apiBase).origin !== e.origin);
  if (
    external.length &&
    !confirm(
      `This file sends sign-ins for these environments to a different host:\n\n${external
        .map((e) => `${e.name} (${e.origin}) → ${e.apiBase}`)
        .join('\n')}\n\nOnly continue if you trust where this file came from.`,
    )
  ) {
    throw new Error('Import cancelled');
  }
  const accounts = [...current.accounts];
  let skipped = 0;
  for (const raw of data.accounts) {
    const username = String(raw.username || '').trim();
    if (!username) continue;
    const listed = Array.isArray(raw.environments) ? raw.environments : [];
    const envIds = listed.map((o) => environments.find((e) => e.origin === o)?.id).filter(Boolean);
    if (listed.length && !envIds.length) {
      skipped += 1;
      continue;
    }
    const existing = accounts.find((a) => a.username === username);
    const secret = raw.password ? await encrypt(String(raw.password)) : existing?.secret || null;
    const account = { id: existing?.id || uid(), label: String(raw.label || username), username, envIds, secret };
    if (existing) accounts[accounts.indexOf(existing)] = account;
    else accounts.push(account);
  }
  for (const raw of data.environments) {
    if (!raw.defaultAccount) continue;
    const env = environments.find((e) => e.origin === raw.origin);
    const acc = accounts.find((a) => a.username === raw.defaultAccount);
    if (env && acc) env.defaultAccountId = acc.id;
  }
  await chrome.storage.local.set({ environments, accounts });
  if (data.settings) await saveSettings(data.settings);
  return { envs: newEnvs.length, accounts: data.accounts.length - skipped };
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
  const act = el.dataset.act;
  const id = el.closest('.item')?.dataset.id;
  const env = state.environments.find((x) => x.id === id);
  const acc = state.accounts.find((x) => x.id === id);

  try {
    switch (act) {
      case 'env-add':
        return openEnvDialog(null);
      case 'env-edit':
        return openEnvDialog(env);
      case 'env-open':
        return chrome.tabs.create({ url: `${env.origin}/` });
      case 'env-grant': {
        const ok = await chrome.permissions.request({ origins: [patternFor(env.origin)] });
        if (ok) await chrome.runtime.sendMessage({ type: 'SYNC' });
        snack(ok ? `Access granted to ${env.name}` : 'Access was not granted', ok ? '' : 'error');
        return render();
      }
      case 'env-delete':
        if (!confirmed(el)) return;
        await deleteEnvironment(env.id);
        if (!state.environments.some((x) => x.id !== env.id && x.origin === env.origin)) {
          await chrome.permissions.remove({ origins: [patternFor(env.origin)] }).catch(() => {});
        }
        snack(`${env.name} removed`);
        return render();
      case 'acc-add':
        return openAccDialog(null);
      case 'acc-edit':
        return openAccDialog(acc);
      case 'acc-delete':
        if (!confirmed(el)) return;
        await deleteAccount(acc.id);
        snack(`${acc.label} removed`);
        return render();
      case 'toggle-pw': {
        const pw = accForm.elements.password;
        pw.type = pw.type === 'password' ? 'text' : 'password';
        el.setAttribute('aria-label', pw.type === 'password' ? 'Show password' : 'Hide password');
        return;
      }
      case 'export':
        return await exportConfig();
      case 'import':
        return $('#import-file').click();
      case 'reset': {
        if (!confirmed(el)) return;
        const origins = state.environments.map((x) => patternFor(x.origin));
        await chrome.storage.local.clear();
        await chrome.storage.session.clear();
        if (origins.length) await chrome.permissions.remove({ origins }).catch(() => {});
        await chrome.runtime.sendMessage({ type: 'SYNC' });
        snack('Extension reset');
        return render();
      }
    }
  } catch (err) {
    snack(err.message, 'error');
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  const id = el.closest('.item')?.dataset.id;
  try {
    if (el.dataset.act === 'env-autologin') {
      await patchEnvironment(id, { autoLogin: el.checked });
      return snack(el.checked ? 'Auto sign-in on' : 'Auto sign-in off');
    }
    if (el.dataset.act === 'env-default') {
      await patchEnvironment(id, { defaultAccountId: el.value || null });
      return snack('Default account updated');
    }
    if (el.form?.id === 'settings-form') {
      const value = el.type === 'checkbox' ? el.checked : Number(el.value);
      state.settings = await saveSettings({ [el.name]: value });
      renderSettings();
      return snack('Saved');
    }
    if (el.id === 'import-file' && el.files[0]) {
      const res = await importConfig(el.files[0]);
      el.value = '';
      await chrome.runtime.sendMessage({ type: 'SYNC' });
      snack(`Imported ${res.envs} new environment(s) and ${res.accounts} account(s). Grant access where needed.`);
      return render();
    }
  } catch (err) {
    snack(err.message, 'error');
    render();
  }
});

let renderQueued = false;
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== 'local' || renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    if (!envDialog.open && !accDialog.open) render();
  }, 100);
});
chrome.permissions.onAdded.addListener(render);
chrome.permissions.onRemoved.addListener(render);

$('#brand').innerHTML = `${logo(28)}<span>NJF Companion</span><span class="faint">Settings</span>`;
$('[data-act="env-add"]').innerHTML = `${icon('plus', 14)}Add environment`;
$('[data-act="acc-add"]').innerHTML = `${icon('plus', 14)}Add account`;
$('[data-act="export"]').innerHTML = `${icon('download', 14)}Export`;
$('[data-act="import"]').innerHTML = `${icon('upload', 14)}Import`;
$('#foot').innerHTML = `NJF Companion ${esc(chrome.runtime.getManifest().version)} · © ${new Date().getFullYear()} <a href="https://www.royryando.me" target="_blank" rel="noopener">Roy Ryando</a>`;

render().then(() => {
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
});
