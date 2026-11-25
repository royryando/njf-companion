const DB_NAME = 'njf-companion-vault';
const STORE = 'keys';
const KEY_ID = 'primary';

let keyPromise = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbRequest(db, mode, run) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = run(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadKey() {
  const db = await openDb();
  try {
    const existing = await idbRequest(db, 'readonly', (s) => s.get(KEY_ID));
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    try {
      await idbRequest(db, 'readwrite', (s) => s.add(key, KEY_ID));
      return key;
    } catch {
      return await idbRequest(db, 'readonly', (s) => s.get(KEY_ID));
    }
  } finally {
    db.close();
  }
}

function getKey() {
  keyPromise ??= loadKey().catch((err) => {
    keyPromise = null;
    throw err;
  });
  return keyPromise;
}

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

export async function encrypt(plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(), new TextEncoder().encode(plain));
  return { v: 1, iv: toB64(iv), data: toB64(data) };
}

export async function decrypt(secret) {
  if (!secret?.iv || !secret?.data) throw new Error('No password saved for this account');
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(secret.iv) }, await getKey(), fromB64(secret.data));
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error('Saved password could not be decrypted. Re-enter it in Settings.');
  }
}
