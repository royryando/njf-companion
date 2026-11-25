# Chrome Web Store submission notes

Copy-paste material for the Developer Dashboard. Upload `dist/njf-companion-<version>.zip` built by
`tools/package.sh`.

## Listing

**Name:** NJF Companion

**Summary (≤132 chars):**
Saved accounts, auto sign-in, token auto-refresh, session countdown and per-tab page history for the NJF web app.

**Category:** Productivity → Developer Tools (or Workflow & Planning)

**Description:**

> NJF Companion keeps you signed in to the NJF joint-financing web application and makes switching between
> test or role accounts a single click.
>
> • Saved accounts: store the users you work with; passwords are encrypted on your device.
> • Auto sign-in: on the login page, sign in automatically with your chosen account (with a cancel countdown),
>   then return to the page you were trying to open.
> • Auto-refresh: renews the access token before it expires, so the "session ending" dialog never interrupts you.
> • Session countdown: see exactly how long your session has left.
> • Error APIs: the toolbar icon counts the NJF API requests that failed in the current tab; open any of them
>   to inspect the request and response, or copy it as cURL.
> • Switch user: change to another saved account without signing out and in by hand.
> • Service status: see at a glance which NJF services are up, and their response time in milliseconds.
> • Page history: see every page visited in the current tab, including filters and parameters, and jump back
>   to any of them with its state restored.
>
> Works only on the NJF addresses you add and grant. No servers, no analytics, no tracking.
> The extension does not change the NJF application; it works alongside it.

**Single purpose:**
Manage the user's sign-in session (saved accounts, automatic sign-in, token refresh, session countdown and
in-tab page history) for the NJF web application environments the user configures.

## Permission justifications

| Permission | Justification |
|---|---|
| `storage` | Save the user's environments, accounts (encrypted passwords) and preferences locally. |
| `scripting` | Register the content script only on the NJF environments the user explicitly grants, and activate it in already-open tabs. |
| `alarms` | A 30-second check so sessions in background tabs are refreshed before they expire (tab timers are throttled). |
| `activeTab` | Read the current tab's address when the user opens the popup, to offer "Add this site as an environment". |
| Optional host permissions (`http://*/*`, `https://*/*`) | NJF is deployed on customer-specific addresses that cannot be known in advance. Access is requested at runtime for exactly the origin the user adds; nothing is granted at install. |

**Remote code:** No. All code ships in the package. No `eval`, no remote scripts.

## Data usage disclosures (Privacy practices tab)

- Collects: **Authentication information** (usernames/passwords the user saves; session tokens of the NJF app)
  and **Web history** (pages visited within NJF tabs, kept for the browser session only).
- Data is **not** sold, **not** transferred to third parties, **not** used for anything unrelated to the
  single purpose, and **not** used for creditworthiness or lending.
- Privacy policy URL: host `PRIVACY.md` (e.g. on the company site or a public Git page) and paste the link.

## Assets to prepare

- Store icon 128×128: `icons/icon128.png`
- At least one screenshot at 1280×800 or 640×400 (popup over an NJF page, settings page).
- Optional small promo tile 440×280.

## Review tips

- Reviewers cannot reach a private NJF environment. In "Test instructions", explain that the extension needs an
  NJF deployment and describe the flow, or provide a reachable demo environment and test account.
- If the extension is only meant for your team, consider **Unlisted** visibility (installable by link, not
  searchable), or publish privately to your Google Workspace domain.
