# Wysebee Agent

A Chrome / Edge extension (Manifest V3) that pairs one browser profile with
[Wysebee](https://app.wysebee.com) as **an agent of its own**. That agent, and only that
agent, can then see and control the browser's tabs, where and when you allow it.

The extension is the authority over the browser, and nothing else: per-site approvals,
blocked kinds of request, the agent pointer drawn on
the page, the debugger whitelists, and recording frames and steps. It has no chat, no tasks
and no Wysebee settings. It talks to Wysebee Cloud only (no native messaging, no local
socket); Wysebee Desktop and agents living in the cloud drive it through the cloud.

`link.js` is the extension's side of the protocol with Wysebee Cloud.

## Build it, and load it unpacked

Each build has a default Wysebee Cloud, set when it is built. A self-hosted Wysebee Cloud
is set in the side panel instead ([Self-hosted Wysebee Cloud](#self-hosted-wysebee-cloud)),
with no rebuild. There is one published build, and a local one for development:

| Build | Default server | Name in the browser | Icon |
|---|---|---|---|
| **prod** | `https://app.wysebee.com` | Wysebee Agent | the yellow bee |
| **local** | the one you give it | Wysebee Agent Local | a pink bee |

```bash
node scripts/build.mjs          # or: npm run build   -> dist/prod
node scripts/build.mjs prod     # dist/prod
node scripts/build.mjs local http://localhost:8000   # dist/local
WYSEBEE_CLOUD_URL=http://localhost:8001 npm run build:local   # dist/local, the same way
```

The local build's server can come from `WYSEBEE_CLOUD_URL`, the variable Wysebee Desktop
reads, instead of the command line (which wins when both are given). Only the local build
reads it: prod always talks to `https://app.wysebee.com`.

The script copies what the extension ships (no tests or docs) into `dist/<build>` and
writes the server into its `server.js`; for local it also renames the extension
and recolours the bee. No dependencies.

**local** is for developing against a wysebee-cloud of your own: on this computer
(`http://localhost:8000`) or elsewhere. Give it any http or
https address; it is built only when named, and never packaged. Rebuild it to change its
default server, then reload it in `chrome://extensions` (or set the server in the side
panel's **Agent → Server** tab). A pairing is with one cloud: after changing the server, pair again.

1. Open `chrome://extensions` (Edge: `edge://extensions`) and turn on **Developer mode**.
2. **Load unpacked** and choose `dist/prod` or `dist/local`. They are separate
   extensions, each with its own pairing, so they can be loaded side by side.
3. Click the Wysebee Agent icon in the toolbar: the side panel opens.

Rebuild after a change, then press the extension's reload button. (The repository folder
itself also loads, as the prod build: its `server.js` is prod's.)

Chrome 116 or later.

## Self-hosted Wysebee Cloud

The side panel's **Agent → Server** tab sets which Wysebee Cloud this browser pairs with. It
defaults to `https://app.wysebee.com` (the build's server). To pair with your own Wysebee
Cloud (`WYSEBEE_EDITION=selfhost`), open the **Agent → Server** tab, enter its address, such as
`http://localhost:8000` or `https://wysebee.example.com`, and **Save**. Then pair as usual:
the code is typed in your server's web app.

- The address is kept in this browser's extension storage (`cloudServer`, `cloud.js`) and
  every request to the cloud goes there: pairing, polling, results, recordings, unpairing.
- It is saved as an origin: a path, query and trailing slashes are dropped
  (`https://wysebee.example.com/app/` is `https://wysebee.example.com`). Typed without a
  scheme it is https, or http for a private host.
- It must be https, except on this computer or a private network, where plain http is
  allowed: `localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`, `10.0.0.0/8`,
  `172.16.0.0/12`, `192.168.0.0/16` and `*.local` (e.g. `http://localhost:8000`).
- A pairing belongs to its server. Changing the server while paired, or while a code is
  showing, asks first, then unpairs (telling the old server) before switching.
- **Use the default** goes back to the build's server. The panel shows the server under
  the pairing form, and under the agent's name when it is not the default.
- No new permission: the manifest's `<all_urls>` host permission already lets the worker
  reach any origin. Agents never send the server's owner token; pairing is the code plus
  this browser's own secret, as with the hosted cloud.

## Package it for the Chrome Web Store

```bash
node scripts/package.mjs        # or: npm run package
```

Builds prod and zips it as `wysebee-agent-<version>.zip` in the repository folder, with
`manifest.json` at the root of the zip: the file to upload in the store's developer
dashboard. The version is `manifest.json`'s; raise it before each upload, since the store
refuses a version it has already seen. Only prod is packaged.

## Pairing

1. In the side panel, type a name for the agent (1 to 60 characters) and press **Pair**.
2. The panel shows a code, `XXXX-XXXX`, good for ten minutes.
3. In Wysebee (Desktop or the website, signed in): **Devices → Pair a
   browser**, and type the code.
4. Wysebee creates a new agent under that name; the panel shows it, and "Connected".

A name already taken or reserved is refused; the panel says why and you pick another.
**Unpair** (under the agent, once paired) forgets the pairing here and tells Wysebee; the
agent stays, without a browser. Unpairing in Wysebee, or deleting the agent, unpairs the extension at its next
check-in.

## What you control

- **Let Wysebee use this browser** (the switch under the agent, 2026-11-14): off, Wysebee
  cannot use this browser, what waits is refused, and the extension **stops polling** — nothing
  is kept open to Wysebee Cloud — but it stays paired; the badge shows OFF. Back on, it carries
  on as the same agent. Pairing again switches it on.
- **Unpair** (under the agent) stops Wysebee using this browser at once and forgets the
  pairing.
- **Approvals**: anything on a site you have not trusted asks first, in a small window, a
  notification and the side panel: Allow once, Always allow (that site becomes Trusted),
  or Deny. Closing one of your own tabs and faking network responses always ask, and
  reading bookmarks never offers "always".
- **Sites**: the sites that run without asking, each Trusted or Allow everything (which
  also closes tabs and fakes network responses without asking; meant for a web app under
  automated test).
- **Off until you turn them on**: Fake network responses and Record videos start blocked;
  switch them to Allowed under **Agent → Permissions** in the side panel. Blocking one again ends what
  is running (a recording is still saved).
- **Fake network responses** (`browser_mock`, a web development tool): to test how an
  app handles errors, the agent can answer chosen requests on a tab with a status and
  body it makes up, fail them (`ConnectionRefused`, `TimedOut`, …) or hold them back for
  a while. Only what a page loads is faked, never a page itself, and the rules end when
  the tab goes to another site, the agent is paused or unpaired, or the debugging bar is
  cancelled (`mock.js`).
- **Scenario videos** (`browser_record`): the agent says when a scenario starts and stops,
  and the tab is filmed meanwhile — the red dot included — as a WebM video. It is saved in
  Downloads/Wysebee Agent/. It is also uploaded to Wysebee for replay only if you tick
  "Also upload each video to Wysebee" under Record videos (off by default; the
  `uploadRecordings` setting). Starting one is asked like
  any action on the site; stopping never asks. A recording also ends after 15 minutes, 5
  minutes after the agent's last action, or when the tab closes or the agent is paused, and
  what was filmed is kept. It uses Chrome's screencast through the debugger, so the
  debugging bar shows while it films (`video.js`, `ui/offscreen.js`, `webm.js`).
- **The agent pointer**: a red dot shows where the agent's mouse is. Like a mouse cursor
  it stays where the agent left it, page loads included, until the agent is paused or
  unpaired, says its task is over, or has done nothing for five minutes.
- **The end of a task** (`browser_end_task`): the AI app calls it once its whole task is
  finished. The dot goes from every tab it was drawn on, and the debugger lets go of every
  tab it holds (its bar closes; faked responses, console and network logging and a changed
  viewport end) — except a tab being filmed, whose recording carries on until
  `browser_record` stops it. It never asks, and does nothing when nothing is left showing.
  Wysebee Cloud also leaves a notification from the agent on its Activity page.
- **Permissions**: kinds of request refused on every site, real mouse input (through the
  browser's debugger) among them, and the one machine-wide switch that lets bookmarks be
  read without asking.
- **Language**: follows the browser, or the one you choose (English, French, Japanese,
  Simplified and Traditional Chinese).

## Privacy

- Every request the agent makes, and its result, passes **through Wysebee Cloud**: page
  snapshots, screenshots, tab titles and sites, typed text, console and network logs when
  the web development tools are used, bookmarks when you allow them, and scenario videos
  the agent records (also saved in your Downloads). The cloud keeps
  each until it is read, an hour at most.
- The approvals and the blocked kinds are enforced **here, in the extension**,
  before anything is read or sent.
- The extension keeps a random secret in this browser's extension storage; Wysebee Cloud
  keeps only its SHA-256. The secret is never shown.
- No analytics. Trusted sites and settings stay in this browser.
- Secret request headers and password-like fields are redacted from network logs before
  they leave the browser (`devtools.js`).

## Files

| | |
|---|---|
| `background.js` | The service worker: the poll loop, policy, approvals, every operation. |
| `link.js` | The link with Wysebee Cloud: secret, code, requests, the pairing's state. Pure. |
| `server.js` | The cloud's default base URL, written by `scripts/build.mjs` into each build (prod in the source tree). |
| `cloud.js` | The Server tab's setting: checking a typed server, and which server to use. Pure. |
| `scripts/build.mjs` | Makes `dist/prod`, and `dist/local` for a server you give it. |
| `scripts/package.mjs` | Builds prod and zips it for the Chrome Web Store. |
| `policy.js` | Whether an operation runs, asks or is refused. Pure. This file is the safety model. |
| `page.js`, `devpage.js` | Functions injected into pages. |
| `native_input.js`, `devtools.js`, `mock.js`, `video.js` | The four debugger whitelists and what uses them. |
| `webm.js`, `ui/offscreen.js` | Scenario videos: the offscreen recorder, and the WebM duration fix. |
| `pointer.js`, `recording.js`, `screenshot.js`, `lang.js` | The agent pointer, recording frames and steps, screenshot fitting, language. |
| `locales/<code>.json` | Every string a person reads, read by the worker and the pages. |
| `ui/` | The side panel and the approval window: plain HTML, CSS and JavaScript. |

## Tests

```bash
npm test             # node --test, with coverage and a 100% gate
```

Node 22.8 or later. The suites cover the pure modules (`*.test.mjs`) and check that every
language has English's keys and placeholders (`locales.test.mjs`), and that each build
defaults to its own server (`build.test.mjs`), and that a typed server is checked and its
requests go to it (`cloud.test.mjs`). The pages' shared
helpers and the approval window run against a small fake DOM (`ui.test.mjs`), and
screenshot fitting against faked image calls (`screenshot.test.mjs`). Nothing reaches the
network.

**`npm test` fails when coverage drops below 100%** of lines, branches or functions
(`node --test --experimental-test-coverage --test-coverage-lines=100
--test-coverage-branches=100 --test-coverage-functions=100`). Node counts only the files
the tests load: every module above, `scripts/build.mjs`, `server.js`, `ui/shared.js` and
`ui/approval.js`. Not counted, because they run only inside the browser:
`background.js` (the service worker, `chrome.*` from its first line), `page.js` and
`devpage.js` (injected into a real page's DOM), and `ui/panel.js` (the side panel); nor
`scripts/package.mjs`, which writes the store zip into this folder with the system `zip`.
A new pure module is counted once a test imports it, and must then be covered in full.
