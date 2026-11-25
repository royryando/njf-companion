# NJF Companion

A Chrome (Manifest V3) extension that works alongside the NJF web app without any change to the NJF
codebase:

1. **Saved accounts**: usernames and passwords, encrypted at rest (AES-GCM, non-extractable key).
2. **Auto sign-in**: on `/login`, signs in with the environment's default (or last used) account after a
   cancellable countdown, then returns to the page originally requested.
3. **Auto-refresh**: renews the access token before it expires (default 120 s, capped at half the token
   lifetime). If the refresh token is dead too, it signs the same user in again from the saved account.
4. **Session countdown**: live in the popup (access token and SSO lifetime).
5. **Switch user**: one click. The new user signs in first, then the old session is released, so NJF's
   one-session-per-user rule never locks the account out.
6. **Service Status**: pings every NJF service's Spring Boot actuator health endpoint through the gateway
   (`{apiBase}/{service}/actuator/health`, a public path, so no token is needed) and shows UP/DOWN and latency
   in ms. It re-checks every 15 s while the tab is open.
7. **Error APIs**: every request the NJF app makes to the environment's API base that does not return 2xx
   (plus network errors and timeouts; requests the app cancels itself are ignored). The toolbar badge shows
   the count for the current tab. Each entry opens to show status, timing, request/response headers and
   bodies (JSON pretty-printed, `Authorization` masked), with **Copy as cURL** and **Copy response**.
   Captured by `src/content/page-hook.js`, a passive XHR/fetch observer injected into the page before the app
   loads. It never alters a request; bodies are capped at 64 KB, and the latest 100 entries are kept per tab.
8. **Page history**: the current tab's pages (title, path, query parameters, time, user). Clicking one
   traverses the tab's real history entry, so URL state and scroll position come back with it.

## Install for development

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. The Settings page opens. **Add environment** with the URL you open NJF on (e.g. `http://192.168.1.200`)
   and accept Chrome's access prompt.
   For a local front-end (`http://localhost:3000`) that calls the Dev API, set **API base URL** to
   `http://192.168.1.200/api/v1`.
3. **Add account** for each user you work with.
4. Open NJF and click the toolbar icon.

You can also open any NJF page, click the icon, and choose **Add <this site>**.

## How it integrates (no NJF changes)

| NJF behaviour | How the extension uses it |
|---|---|
| Session lives in `localStorage` as JSON strings: `token`, `refreshToken`, `expired` (ms), `timestamp` (ms), `user`, `pingInterval`, `menu`, `menu-auth` | Read for the countdown; written in exactly the same format the Login page writes |
| `useLocalStorage` refs follow `storage` events | After a refresh the content script dispatches `StorageEvent`s (`token`, `refreshToken`, `expired`, then `timestamp`), so `RefreshModal` re-arms its timer in place with no reload |
| `POST /identity/auth/login`, `/refresh-token?refreshToken=`, `/logout?refreshToken=`, `GET /identity/menu/navbar2` | Called from the content script, with the page's own origin and CORS, just as the app does |
| One live session per user (`40901` "Akun sedang digunakan") | Same user: log out, then log in. Different user: log in, then log out the old session. |
| Router guard rewrites unauthenticated visits to `/login` in place | The content script runs at `document_start` and remembers the URL actually requested |

API calls run in the content script on purpose: they carry the NJF page's origin, so they pass the gateway's
CORS rules in every deployment, exactly like the app's own requests. Passwords stay in the service worker
and are handed to the content script only at the moment of sign-in.

Multiple NJF tabs share one session. A cross-tab lock (Web Locks, or a short `localStorage` lease on plain
http origins where Web Locks are unavailable) ensures only one tab refreshes or auto-signs-in at a time.

## Project layout

```
manifest.json
src/background.js        service worker: config, vault, content-script registration, message broker, error badge
src/content/content.js   in-page agent: session read/write, refresh, sign-in/out, history, auto sign-in prompt
src/content/page-hook.js MAIN-world XHR/fetch observer reporting failed API requests
src/popup/               toolbar popup (Session · Page history)
src/options/             settings page (environments, accounts, behaviour, backup, privacy)
src/shared/              store (chrome.storage), vault (AES-GCM), icons, utils, design tokens (ui.css)
icons/                   icon16/32/48/128 generated from icons/logo.png by tools/make-icons.sh
test/e2e/                Puppeteer suite against a mock NJF server
tools/package.sh         builds dist/njf-companion-<version>.zip for the Web Store
```

No build step and no runtime dependencies: plain ES modules, so reviewers see exactly what runs.

## Test

```bash
cd test/e2e && npm install
CHROME="/path/to/Google Chrome for Testing" npm test
```

Branded Google Chrome no longer loads unpacked extensions from the command line; use Chrome for Testing
(`npx @puppeteer/browsers install chrome@stable`). The suite starts a mock NJF server (auth endpoints
including the single-session rule, 20-second tokens, a 401 → `/login` guard) and checks 26 behaviours:
auto sign-in and return path, storage format, refresh without reload, survival past the token lifetime,
switch user and release of the old session, re-sign-in after the refresh token is revoked, sign-out
suppression, page history titles and traversal, popup rendering and layout fit.

## Publish

```bash
tools/package.sh        # -> dist/njf-companion-1.0.0.zip
```

See [STORE_LISTING.md](STORE_LISTING.md) for listing copy, permission justifications and data disclosures,
and [PRIVACY.md](PRIVACY.md) for the privacy policy you must host and link.

## Debugging

- Popup against a specific tab: `chrome-extension://<id>/src/popup/popup.html?tab=<tabId>`
- Service worker logs: `chrome://extensions` → NJF Companion → *service worker*.
