# NJF Companion: Privacy Policy

_Last updated: 25 November 2026_

NJF Companion is a browser extension that helps people who use the NJF web application manage their
sign-in session. This policy explains what the extension handles and where that data goes.

## What the extension stores

All data is stored **locally in your browser** using Chrome's extension storage. It never leaves your device
except as described under "Network requests".

| Data | Purpose | Where |
|---|---|---|
| Environment names and URLs you add | Know which sites to work on | `chrome.storage.local` |
| Account labels, usernames and passwords you save | Sign in automatically and switch accounts | `chrome.storage.local`, passwords encrypted with AES-GCM |
| Encryption key for saved passwords | Decrypt passwords on this device | Extension IndexedDB, non-extractable |
| Extension settings | Your preferences | `chrome.storage.local` |
| Page history of NJF tabs (URL, page title, time, username) | Show and navigate the tab's page history | `chrome.storage.session`, cleared when the tab or browser closes |
| Failed NJF API requests made by the app in NJF tabs (URL, status, timing, request/response headers and bodies, up to 64 KB each) | Show the Error APIs list and the error count | `chrome.storage.session`, cleared when the tab or browser closes, or with **Clear** |

The NJF session tokens remain where the NJF application keeps them (the site's own `localStorage`). The
extension reads and updates them there to show the session countdown and to refresh the session.

## Network requests

The extension sends requests **only** to the NJF environments you add yourself, and only to the
application's own authentication endpoints (sign-in, token refresh, sign-out), the menu endpoint the
application loads after sign-in, and, when you open the Service Status tab, the services' public health
endpoints (`/actuator/health`). These are the same requests the NJF web application makes when you sign in
manually.

The extension has **no server of its own** and contains **no analytics, advertising, tracking or
third-party code**. No data is sold, shared or transferred to anyone.

## Permissions

- **Site access (optional, per environment):** requested only for the NJF addresses you add, so the
  extension can run on those pages. You can revoke it at any time in Chrome's extension settings or by
  deleting the environment.
- **storage:** save your settings, environments and accounts locally.
- **scripting:** run the extension on the NJF environments you granted.
- **alarms:** check every 30 seconds whether a session needs refreshing, including in background tabs.
- **activeTab:** read the address of the current tab when you open the extension, to offer adding it.

## Your control

- Delete any account or environment in **Settings** at any time.
- **Settings → Privacy → Reset everything** erases all extension data and revokes site access.
- Uninstalling the extension deletes all of its data.

## Contact

Questions about this policy: contact the publisher through the Chrome Web Store listing.
