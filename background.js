// The service worker: keeps the link with Wysebee Cloud (link.js),
// applies policy.js, asks the person.
//
// Nothing here runs unless the paired agent asked for it through the cloud, and nothing
// page-changing or page-reading runs unless policy.js says so or the person says yes in
// the prompt. The extension is only the authority over this browser: it carries no chat,
// no tasks and no settings of Wysebee's.

import {
  BLOCKABLE,
  NATIVE_INPUT,
  OPS,
  SITE_MODES,
  decide,
  effectiveBlocked,
  fromOwnPage,
  isBlocked,
  originOf,
  splitBlocked,
  summary,
} from "./policy.js";
import { LANGUAGES, chooseLanguage, format, lookup, resolveLanguage } from "./lang.js";
import { ALLOWED_METHODS, nativeMouse } from "./native_input.js";
import {
  DEVTOOLS_METHODS,
  MAX_EXPRESSION,
  NETWORK_BUFFER,
  RECORDING_DOMAINS,
  Recorder,
  checkViewport,
  evaluationResult,
  responseBody,
} from "./devtools.js";
import * as devpage from "./devpage.js";
import { fitScreenshot } from "./screenshot.js";
import {
  GLIDE,
  IDLE_MS,
  caretCommand,
  dragCommand,
  endTaskPlan,
  hideCommand,
  pointerCommand,
  refClickCommand,
  restoreCommand,
  scrollCommand,
} from "./pointer.js";
import { MOCK_METHODS, Mocks, answerFor } from "./mock.js";
import {
  MAX_RECORDINGS,
  MAX_VIDEO_MS,
  SCREENCAST,
  VIDEO_BITS_PER_SECOND,
  VIDEO_FPS,
  VIDEO_METHODS,
  checkRecordArgs,
  videoExpired,
  uploadBlocked,
  videoFileName,
  videoStatus,
} from "./video.js";
import {
  FRAME_MAX_EDGE,
  FRAME_QUALITY,
  captureWait,
  refsFor,
  settleMs,
  stepFor,
  wantsFrame,
} from "./recording.js";
import * as page from "./page.js";
import { SERVER } from "./server.js";
import { SERVER_KEY, checkServer, serverFrom } from "./cloud.js";
import {
  POLL_WAIT_SECONDS,
  UNPAIRED,
  afterPoll,
  backoff,
  browserName,
  checkName,
  exchange,
  makeSecret,
  pollRequest,
  polls,
  publicState,
  resultRequest,
  secretHash,
  startRequest,
  started,
  unpairRequest,
  recordingRequest,
} from "./link.js";

const APPROVAL_TIMEOUT_MS = 60_000;
const NAV_TIMEOUT_MS = 20_000;
const VERSION = chrome.runtime.getManifest().version;
const BROWSER = browserName(navigator.userAgent);

/** @type {Map<string, {id: string, op: string, origin: string, summary: string, resolve: Function, timer: number}>} */
const approvals = new Map();
let seq = 0;

// --- storage -------------------------------------------------------------

async function load() {
  const {
    sites = {},
    blocked = [],
    allowedKinds = [],
    bookmarksAllowed = false,
  } = await chrome.storage.local.get(["sites", "blocked", "allowedKinds", "bookmarksAllowed"]);
  // Kinds that are off until turned on (policy.js's OFF_BY_DEFAULT) count as blocked here.
  return { sites, blocked: effectiveBlocked(blocked, allowedKinds), bookmarksAllowed };
}

async function setSite(origin, mode) {
  const { sites } = await load();
  if (mode) sites[origin] = mode;
  else delete sites[origin];
  await chrome.storage.local.set({ sites });
}

// --- theme -------------------------------------------------------------------------

// The pages follow the computer's light or dark look, unless the person chose one
// (`theme`, kept in this browser).
const THEMES = ["", "light", "dark"];

async function currentTheme() {
  const { theme = "" } = await chrome.storage.local.get("theme");
  return THEMES.includes(theme) ? theme : "";
}

// --- language ------------------------------------------------------------------
//
// The extension follows the browser's languages, unless the person chose one in its
// settings (`languageOverride`, kept in this browser). Messages are locales/<code>.json,
// read by this worker and by the pages alike.

const localeCache = new Map();

async function localeTable(code) {
  if (!localeCache.has(code)) {
    try {
      const res = await fetch(chrome.runtime.getURL(`locales/${code}.json`));
      localeCache.set(code, res.ok ? await res.json() : {});
    } catch {
      localeCache.set(code, {}); // English keys are the fallback
    }
  }
  return localeCache.get(code);
}

async function languages() {
  const { languageOverride = "" } = await chrome.storage.local.get("languageOverride");
  const preferred = navigator.languages || [navigator.language];
  return {
    current: chooseLanguage(languageOverride, "", preferred),
    browser: resolveLanguage("", preferred),
    override: LANGUAGES.includes(languageOverride) ? languageOverride : "",
  };
}

async function currentLanguage() {
  return (await languages()).current;
}

/** One message in the person's language, English when it has none. */
async function tr(key, vars) {
  const [table, en] = await Promise.all([localeTable(await currentLanguage()), localeTable("en")]);
  return format(lookup(table, key, en), vars);
}

// --- recordings ------------------------------------------------------------------
//
// With recording on in Wysebee, whatever drives this browser saves pictures of what the
// agent did here (recording.js) and, once the GIF and WebP are made, says where
// (`recording_saved`). The person is told by a notification; a newer recording replaces
// the last one's.

const RECORDING_NOTIFICATION = "wysebee-recording";

chrome.notifications.onClicked.addListener((id) => {
  if (id === RECORDING_NOTIFICATION) void chrome.notifications.clear(id);
});

async function notifyRecording(args) {
  const folder = String(args?.folder ?? "");
  if (!folder) throw new Error("Say where the recording is.");
  await chrome.notifications.clear(RECORDING_NOTIFICATION);
  await chrome.notifications.create(RECORDING_NOTIFICATION, {
    type: "basic",
    iconUrl: "icon.png",
    title: await tr("recording.title"),
    message: await tr("recording.message", { folder }),
  });
  return { shown: true };
}

// --- tabs this probe opened --------------------------------------------------
//
// Closing one of these never asks (policy.js), so the set has to survive the service
// worker going to sleep: it is in session storage, not a variable, and a worker that
// woke with an empty set would start asking about tabs it opened itself. Session
// storage also ends with the browser, which is right — tab ids do too.

async function openedTabs() {
  const { opened = [] } = await chrome.storage.session.get("opened");
  return new Set(opened);
}

async function markOpened(tabId, yes) {
  const opened = await openedTabs();
  if (yes) opened.add(tabId);
  else opened.delete(tabId);
  await chrome.storage.session.set({ opened: [...opened] });
}

chrome.tabs.onRemoved.addListener((tabId) => void markOpened(tabId, false));

// --- an approved mouse gesture -------------------------------------------------
//
// Press, move and release are separate calls; one approval covers the gesture (see
// policy.js). The grant names a tab and a site and expires, and lives in session
// storage for the same reason the opened-tabs set does: a worker asleep mid-gesture
// would otherwise wake up and ask again.
const GESTURE_MS = 60_000;

// A grant made for simulated input does not cover real input: switching to the
// debugger is its own yes. One made for real input covers both.
async function gestureGranted(tabId, origin, native) {
  const { gesture } = await chrome.storage.session.get("gesture");
  return (
    !!gesture &&
    gesture.tabId === tabId &&
    gesture.origin === origin &&
    Date.now() < gesture.until &&
    (!native || gesture.native)
  );
}

async function grantGesture(tabId, origin, native) {
  // Extending a live grant keeps what it already covered: a simulated move inside an
  // approved real-input gesture must not make the next real one ask again.
  const kept = native || (await gestureGranted(tabId, origin, true));
  await chrome.storage.session.set({ gesture: { tabId, origin, native: kept, until: Date.now() + GESTURE_MS } });
}

// --- real input, through the debugger ------------------------------------------
//
// Opt-in per call (`native`), because attaching puts Chrome's own "started debugging
// this browser" bar on the tab — which is also the person's signal that it is
// happening, so it is never hidden. Attached on first use, detached after a short
// idle spell so the bar does not linger, and detached at once on pause.
//
// Cancel on that bar is the person saying no. The tab is remembered and real input
// on it is refused from then on (until it closes), rather than attaching again and
// putting the bar straight back.
//
// Only ALLOWED_METHODS ever reaches sendCommand — see native_input.js for why.
const DEBUGGER_IDLE_MS = 30_000;
/** @type {Map<number, number>} tab id -> idle detach timer */
const attached = new Map();

async function refusedTabs() {
  const { nativeRefused = [] } = await chrome.storage.session.get("nativeRefused");
  return new Set(nativeRefused);
}

async function attachDebugger(tabId) {
  if ((await refusedTabs()).has(tabId)) {
    throw new Error(
      "The user stopped the debugger on this tab (Cancel on the debugging bar). Use simulated input, or a new tab.",
    );
  }
  if (!attached.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
    } catch (e) {
      // "Another debugger is already attached" means one of two things, and Chrome
      // words them the same: a worker that restarted while attached and forgot the
      // map (the session is ours), or somebody else holding the tab — another
      // extension such as Claude in Chrome. Only the client that attached may
      // detach, so trying it tells them apart: ours detaches and re-attaches cleanly.
      if (!/already attached/i.test(String(e?.message))) {
        console.warn("[wysebee] debugger attach failed", tabId, e);
        throw new Error(`Could not start real input on this tab: ${e?.message || e}`);
      }
      try {
        await chrome.debugger.detach({ tabId });
        await chrome.debugger.attach({ tabId }, "1.3");
      } catch (again) {
        console.warn("[wysebee] tab held by another debugger", tabId, e, again);
        throw new Error(
          "Another debugger is attached to this tab (another extension, such as Claude in Chrome, " +
            "or a debugging tool). Close it or use another tab, then try again.",
        );
      }
    }
  }
  clearTimeout(attached.get(tabId));
  // A tab being recorded stays attached far longer: the console and network log are
  // only collected while attached, and a gap would lose exactly what was being watched.
  const idle = videos.has(tabId) ? MAX_VIDEO_MS : recorders.has(tabId) ? DEVTOOLS_IDLE_MS : DEBUGGER_IDLE_MS;
  attached.set(tabId, setTimeout(() => void detachDebugger(tabId), idle));
}

async function detachDebugger(tabId) {
  void stopVideo(tabId, null, "detached");
  clearTimeout(attached.get(tabId));
  attached.delete(tabId);
  mocks.delete(tabId);
  recorders.get(tabId)?.stop();
  await chrome.storage.session.remove(`native:${tabId}`);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* already gone */
  }
}

async function cdp(tabId, method, params) {
  if (!ALLOWED_METHODS.has(method)) throw new Error(`${method} is not allowed.`);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    console.warn("[wysebee] debugger command failed", tabId, method, e);
    throw new Error(`Real input failed: ${e?.message || e}`);
  }
}

chrome.debugger.onDetach.addListener(async ({ tabId }, reason) => {
  if (tabId == null) return;
  void stopVideo(tabId, null, "detached");
  clearTimeout(attached.get(tabId));
  attached.delete(tabId);
  mocks.delete(tabId);
  recorders.get(tabId)?.stop();
  await chrome.storage.session.remove(`native:${tabId}`);
  if (reason === "canceled_by_user") {
    const refused = await refusedTabs();
    refused.add(tabId);
    await chrome.storage.session.set({ nativeRefused: [...refused] });
  }
});

// --- web development tools, through the same debugger session ----------------------
//
// Offered only to an agent whose owner turned on "Web development tools" in Wysebee;
// policy.js judges each call by the tab's site, like any page operation. The first such
// call on a tab starts recording its console and network log (Chrome's debugging bar
// shows meanwhile); recording stops when the tab has had no developer-tool call for
// DEVTOOLS_IDLE_MS, on pause, or when the person cancels the bar.
//
// Only DEVTOOLS_METHODS ever reaches sendCommand from here — see devtools.js for what is
// deliberately left out (cookies, interception, other targets). The service worker stays
// awake while it records: an attached debugger session and the poll loop both keep it
// alive, so the in-memory log is not lost to sleep.
const DEVTOOLS_IDLE_MS = 10 * 60_000;
/** @type {Map<number, Recorder>} tab id -> what that tab's session has recorded */
const recorders = new Map();

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (tabId == null) return;
  if (method === "Fetch.requestPaused") {
    void answerPaused(tabId, params);
    return;
  }
  if (method === "Page.screencastFrame") {
    onScreencastFrame(tabId, params);
    return;
  }
  recorders.get(tabId)?.onEvent(method, params);
});

// --- fake network responses (browser_mock), through the same debugger session ----------
//
// What may be faked, and why it is fenced in as it is: mock.js. Rules live here per tab,
// with the site they were made on; Fetch pauses each request whose URL a rule names and
// answerPaused decides it. They are dropped when the tab goes to another site, closes, or
// its debugger session ends (idle, pause, unpair, Cancel on the bar) — Chrome stops
// pausing requests then by itself.
/** @type {Map<number, Mocks>} */
const mocks = new Map();

async function mockCdp(tabId, method, params = {}) {
  if (!MOCK_METHODS.has(method)) throw new Error(`${method} is not allowed.`);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    console.warn("[wysebee] mock command failed", tabId, method, e);
    throw new Error(`Could not fake that response: ${e?.message || e}`);
  }
}

async function answerPaused(tabId, params) {
  const rule = mocks.get(tabId)?.take(params) ?? null;
  const { method, params: answer, delayMs } = answerFor(rule, params.requestId);
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  // A request whose page has gone, or a session that has ended, needs no answer.
  await mockCdp(tabId, method, answer).catch(() => {});
}

/** Stop faking anything on this tab. */
async function dropMocks(tabId) {
  if (!mocks.delete(tabId)) return;
  if (attached.has(tabId)) await mockCdp(tabId, "Fetch.disable").catch(() => {});
}

// --- scenario videos (browser_record), through the same debugger session ----------------
//
// What and why: video.js. Here: one recording a tab, the screencast's pictures passed to
// the offscreen recorder (ui/offscreen.js) as they come, and on stop the WebM saved to
// Downloads, and uploaded to Wysebee Cloud only if the person turned that on
// (`uploadRecordings`, off by default; video.js's uploadBlocked). A recording also ends when its tab closes, its
// debugger session ends, the agent is paused or unpaired, or on video.js's time limits
// (checked on the 30 s alarm); what was filmed until then is kept all the same.
/** @type {Map<number, {key: string, tabId: number, name: string, origin: string|null,
 *   startedAt: number, lastActionAt: number, frames: number}>} */
const videos = new Map();
// The last few uploads, for browser_record's status: an upload outlives the call that stopped it.
const uploads = [];
/** @type {Map<number, string>} download id -> recording key, until the file is written */
const videoDownloads = new Map();

async function videoCdp(tabId, method, params = {}) {
  if (!VIDEO_METHODS.has(method)) throw new Error(`${method} is not allowed.`);
  return await chrome.debugger.sendCommand({ tabId }, method, params);
}

const toRecorder = (msg) => chrome.runtime.sendMessage({ target: "offscreen", ...msg });

async function ensureRecorder() {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: "ui/offscreen.html",
      reasons: ["BLOBS"],
      justification: "Turn the agent's scenario recordings into WebM videos.",
    });
  } catch (e) {
    if (!/single offscreen/i.test(String(e?.message))) throw e;
  }
}

/** Close the recorder page once nothing is being filmed, saved or uploaded. */
async function closeRecorderIfIdle() {
  if (videos.size) return;
  try {
    const res = await toRecorder({ type: "video_busy" });
    if (!res?.busy && !videos.size) await chrome.offscreen.closeDocument();
  } catch {
    /* Already closed. */
  }
}

function onScreencastFrame(tabId, params) {
  // Every picture is acknowledged, or Chrome sends no more.
  videoCdp(tabId, "Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
  const rec = videos.get(tabId);
  if (!rec) return;
  rec.frames++;
  toRecorder({ type: "video_frame", key: rec.key, data: params.data }).catch(() => {});
}

async function startVideo(tab, name, origin) {
  if (videos.has(tab.id)) throw new Error("This tab is already being recorded: stop that recording first.");
  if (videos.size >= MAX_RECORDINGS) throw new Error(`At most ${MAX_RECORDINGS} recordings at once: stop one first.`);
  const now = Date.now();
  const rec = { key: `${tab.id}-${now}`, tabId: tab.id, name, origin, startedAt: now, lastActionAt: now, frames: 0 };
  await ensureRecorder();
  const ready = await toRecorder({ type: "video_start", key: rec.key, fps: VIDEO_FPS, bitsPerSecond: VIDEO_BITS_PER_SECOND });
  if (!ready?.ok) throw new Error("The recorder did not start.");
  videos.set(tab.id, rec); // before attaching, so the debugger stays for the whole recording
  try {
    await attachDebugger(tab.id);
    await videoCdp(tab.id, "Page.startScreencast", SCREENCAST);
  } catch (e) {
    videos.delete(tab.id);
    await toRecorder({ type: "video_stop", key: rec.key, upload: null }).catch(() => {});
    throw new Error(`Could not record this tab: ${e?.message || e}`);
  }
  return { ...videoStatus(rec, now), note: "Call browser_record with action stop when the scenario is over." };
}

/**
 * End the tab's recording and save it: Downloads, and Wysebee Cloud when paired and the
 * person turned uploading on. `why`
 * is how it ended ("stopped" by the agent, or by itself: "idle", "time_limit", "paused",
 * "detached", "tab_closed"). Null when nothing was being recorded there.
 */
async function stopVideo(tabId, callId, why) {
  const rec = videos.get(tabId);
  if (!rec) return null;
  videos.delete(tabId);
  await videoCdp(tabId, "Page.stopScreencast").catch(() => {});
  if (why === "stopped" || why === "idle") {
    // The scenario is over — the agent said so, or stopped acting long ago: leave the
    // page as the person had it. The dot goes, and the debugger lets go of the tab at
    // once, so Chrome's "started debugging this browser" bar closes rather than staying
    // its idle time (minutes, once the console or network was read). Anything the agent
    // does next attaches again as it needs.
    hidePointer(tabId);
    if (attached.has(tabId)) void detachDebugger(tabId);
  } else if (attached.has(tabId)) {
    // The debugger no longer needs to stay for the recording: back to its usual idle time.
    clearTimeout(attached.get(tabId));
    const idle = recorders.has(tabId) ? DEVTOOLS_IDLE_MS : DEBUGGER_IDLE_MS;
    attached.set(tabId, setTimeout(() => void detachDebugger(tabId), idle));
  }
  const link = await loadLink();
  const { uploadRecordings } = await chrome.storage.local.get("uploadRecordings");
  const blockedUpload = uploadBlocked(polls(link), uploadRecordings);
  const upload = !blockedUpload
    ? recordingRequest(await cloudServer(), link.id, link.secret, {
        name: rec.name,
        startedAt: rec.startedAt,
        durationMs: Date.now() - rec.startedAt,
        origin: rec.origin,
        callId,
      })
    : null;
  const done = await toRecorder({ type: "video_stop", key: rec.key, upload });
  if (!done?.ok) {
    void closeRecorderIfIdle();
    throw new Error(done?.error || "The recording could not be finished.");
  }
  const file = videoFileName(rec.name, rec.startedAt);
  let saved = null;
  try {
    const id = await chrome.downloads.download({ url: done.url, filename: file, conflictAction: "uniquify", saveAs: false });
    videoDownloads.set(id, rec.key);
    saved = `Downloads/${file}`;
  } catch (e) {
    console.warn("[wysebee] recording not saved to Downloads", e);
    void toRecorder({ type: "video_release", key: rec.key }).catch(() => {});
  }
  const entry = { name: rec.name, file: saved, upload: blockedUpload ?? "uploading", key: rec.key };
  uploads.unshift(entry);
  uploads.length = Math.min(uploads.length, 10);
  return {
    tab_id: tabId,
    name: rec.name,
    ended: why,
    file: saved,
    bytes: done.bytes,
    duration_ms: done.durationMs,
    frames: rec.frames,
    upload: entry.upload,
  };
}

chrome.downloads.onChanged.addListener(({ id, state }) => {
  const key = videoDownloads.get(id);
  if (!key || !state || state.current === "in_progress") return;
  videoDownloads.delete(id);
  void toRecorder({ type: "video_release", key })
    .catch(() => {})
    .then(() => closeRecorderIfIdle());
});

/** The recordings that have run out of time, ended (on the alarm). */
function expireVideos() {
  const now = Date.now();
  for (const rec of [...videos.values()]) {
    const why = videoExpired(rec, now);
    if (why) void stopVideo(rec.tabId, null, why).catch(() => {});
  }
}

/** browser_record's stop and status: no prompt, they only end or describe a recording. */
async function recordControl(action, args, ctx) {
  if (action === "status") {
    const now = Date.now();
    return {
      recordings: [...videos.values()].map((r) => videoStatus(r, now)),
      recent: uploads.map(({ key: _key, ...u }) => u),
    };
  }
  let tabId = typeof args.tab_id === "number" ? args.tab_id : null;
  if (tabId === null && videos.size === 1) tabId = [...videos.keys()][0];
  if (tabId === null) tabId = (await targetTab({})).id;
  const result = await stopVideo(tabId, ctx?.id ?? null, "stopped");
  if (!result) throw new Error("Nothing is being recorded on that tab.");
  return result;
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  const m = mocks.get(tabId);
  if (m && info.url && originOf(info.url) !== m.origin) void dropMocks(tabId);
});

async function devCdp(tabId, method, params = {}) {
  if (!DEVTOOLS_METHODS.has(method)) throw new Error(`${method} is not allowed.`);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    console.warn("[wysebee] devtools command failed", tabId, method, e);
    throw new Error(`The developer tools could not do that: ${e?.message || e}`);
  }
}

/** Attach (if needed) and make sure this tab is being recorded. */
async function startDevtools(tabId) {
  let rec = recorders.get(tabId);
  const fresh = !rec;
  if (fresh) {
    rec = new Recorder();
    recorders.set(tabId, rec); // before attaching, so the long idle timer applies
  }
  try {
    await attachDebugger(tabId);
  } catch (e) {
    if (fresh) recorders.delete(tabId);
    throw e;
  }
  if (!rec.recording) {
    for (const method of RECORDING_DOMAINS) {
      await devCdp(tabId, method, method === "Network.enable" ? NETWORK_BUFFER : {});
    }
    rec.start();
  }
  return rec;
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  void stopVideo(tabId, null, "tab_closed").catch(() => {});
  recorders.delete(tabId);
  mocks.delete(tabId);
  await chrome.storage.session.remove(`shot:${tabId}`);
  const refused = await refusedTabs();
  if (refused.delete(tabId)) await chrome.storage.session.set({ nativeRefused: [...refused] });
});

// --- the badge: always-visible "an AI can act here" indicator ------------

async function refreshBadge() {
  const link = await loadLink();
  let text = "";
  let color = "#2e7d32";
  if (link.phase === "paired" && !(await isEnabled())) {
    // Paired, but switched off: nothing runs and nothing polls.
    text = "OFF";
    color = "#757575";
  } else if (link.phase !== "paired" || !isConnected()) {
    text = "";
  } else if (approvals.size > 0) {
    text = String(approvals.size);
    color = "#c62828";
  } else {
    text = "ON";
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

// --- the link with Wysebee Cloud ---------------------------------------------------
//
// The pairing (link.js's state, with the secret) is `link` in local storage; the
// cloud's base URL is cloudServer(): the one set in the side panel's Server tab, else
// server.js's (the build's default). While there is a link to poll, one loop of long polls
// runs: each `paired` answer's calls go to handle() and their results are posted back;
// `cancelled` ids stop what they can. A worker that was killed starts the loop again
// from the alarm, onStartup, onInstalled, or a page asking for the state.

async function loadLink() {
  const { link } = await chrome.storage.local.get("link");
  return link && typeof link === "object" && link.phase ? link : UNPAIRED;
}

async function saveLink(link) {
  await chrome.storage.local.set({ link });
}

/** The Wysebee Cloud to talk to: the one set in the Server tab, else the build's (cloud.js). */
async function cloudServer() {
  const { [SERVER_KEY]: stored } = await chrome.storage.local.get(SERVER_KEY);
  return serverFrom(stored, SERVER);
}

/**
 * Set the server ("" for the build's default). A pairing belongs to its server, so one that
 * is under way or made is forgotten first (telling the old server) - only with `unpair`,
 * the person's yes in the panel; without it the answer is "linked".
 */
async function setCloudServer(typed, unpair) {
  const server = typed === "" ? SERVER : checkServer(typed);
  if (!server) return { ok: false, error: "invalid" };
  if (server !== (await cloudServer())) {
    const link = await loadLink();
    if (polls(link) && !unpair) return { ok: false, error: "linked" };
    if (link.phase !== "unpaired") await forgetLink();
  }
  if (server === SERVER) await chrome.storage.local.remove(SERVER_KEY);
  else await chrome.storage.local.set({ [SERVER_KEY]: server });
  return { ok: true, server };
}


// When a poll was last answered by the cloud; "connected" is one within the last 45 s,
// the cloud's own rule for this link.
let lastPollOkAt = 0;
const CONNECTED_MS = 45_000;

function isConnected() {
  return Date.now() - lastPollOkAt < CONNECTED_MS;
}

/** @type {Map<string, {id: string, cancelled: boolean}>} calls being run, by id */
const running = new Map();

/** Sleep, touching an extension API every so often so the worker's idle timer never runs out. */
async function rest(ms) {
  let left = ms;
  while (left > 0) {
    const step = Math.min(left, 10_000);
    await new Promise((r) => setTimeout(r, step));
    left -= step;
    await chrome.runtime.getPlatformInfo();
  }
}

let looping = false;
// Set by anything that changes the link (pair, cancel, unpair) or switches it off: a loop
// mid-wait starts over.
let linkEpoch = 0;

/**
 * The Enabled switch (the side panel's): off, the extension stays paired but polls no more,
 * so Wysebee can neither reach this browser nor keep a request open to it. On by default.
 */
async function isEnabled() {
  const { enabled } = await chrome.storage.local.get("enabled");
  return enabled !== false;
}

const TURNED_OFF = "Wysebee Agent is turned off in this browser.";

/** Switch the extension on or off. Off: what waits is refused, what runs is stopped, and one
 * last poll tells Wysebee it was switched off (any call it hands out then is refused). */
async function setEnabled(on) {
  await chrome.storage.local.set({ enabled: on });
  linkEpoch++;
  if (on) {
    ensureLoop();
  } else {
    lastPollOkAt = 0;
    stopEverything();
    const link = await loadLink();
    if (link.phase === "paired") {
      const server = await cloudServer();
      try {
        const answer = await exchange(
          (url, init) => fetch(url, init),
          pollRequest(server, link.id, link.secret, { version: VERSION, browser: BROWSER, paused: true }, 0),
        );
        const calls = Array.isArray(answer?.body?.calls) ? answer.body.calls : [];
        for (const call of calls) {
          void exchange((url, init) => fetch(url, init), resultRequest(server, link.id, link.secret, call.id, { ok: false, error: TURNED_OFF }));
        }
      } catch {
        /* Not told: Wysebee sees it as offline once it hears nothing. */
      }
    }
  }
  await refreshBadge();
}

function ensureLoop() {
  if (looping) return;
  looping = true;
  void pollLoop()
    .catch((e) => console.warn("[wysebee] the poll loop stopped", e))
    .finally(() => {
      looping = false;
    });
}

async function pollLoop() {
  let failures = 0;
  let first = true;
  for (;;) {
    const link = await loadLink();
    if (!polls(link) || !(await isEnabled())) return;
    const epoch = linkEpoch;
    // Reading storage is also the extension API touched between polls.
    await load();
    const server = await cloudServer();
    // The first poll of a loop does not wait, so "connected" is known at once.
    const wait = first || failures > 0 ? 0 : POLL_WAIT_SECONDS;
    first = false;
    let answer = null;
    const askedAt = Date.now();
    try {
      answer = await exchange(
        (url, init) => fetch(url, init),
        pollRequest(server, link.id, link.secret, { version: VERSION, browser: BROWSER }, wait),
      );
    } catch {
      /* Offline, or the cloud is down: back off below. */
    }
    const now = await loadLink();
    // Cancelled, unpaired or paired again while this poll was out: its answer is nobody's.
    if (epoch !== linkEpoch || now.id !== link.id || now.phase !== link.phase) continue;
    const out = afterPoll(now, answer, Date.now());
    if (out.state !== now) await saveLink(out.state);
    if (out.failed) {
      failures += 1;
      void refreshBadge();
      await rest(backoff(failures));
      continue;
    }
    failures = 0;
    if (polls(out.state)) lastPollOkAt = Date.now();
    else {
      // Unpaired in Wysebee (or refused, expired): nothing may keep running for it.
      lastPollOkAt = 0;
      stopEverything();
    }
    for (const id of out.cancelled) cancelCall(id);
    for (const call of out.calls) void runCall(server, out.state, call);
    void refreshBadge();
    // A cloud that answers a long poll at once with nothing to do must not be hammered.
    if (wait > 0 && !out.calls.length && Date.now() - askedAt < 1_000) await rest(1_000);
  }
}

/** Run one call the cloud handed out and post what it answered. */
async function runCall(server, link, call) {
  const ctx = { id: call.id, cancelled: false };
  running.set(call.id, ctx);
  let outcome;
  try {
    outcome = { ok: true, result: await handle(call.op, call.args || {}, ctx) };
  } catch (e) {
    outcome = { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    running.delete(call.id);
  }
  // Nobody is waiting for a cancelled call's answer.
  if (ctx.cancelled) return;
  const request = resultRequest(server, link.id, link.secret, call.id, outcome);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { status } = await exchange((url, init) => fetch(url, init), request);
      // 204 taken; 404 the call is gone (cancelled, expired); 401 unpaired: all final.
      if (status < 500) return;
    } catch {
      /* Not sent: try again. */
    }
    await rest(backoff(attempt));
  }
  console.warn("[wysebee] a result could not be posted", call.op);
}

/** The cloud says this call was cancelled: stop what can be stopped. */
function cancelCall(id) {
  const ctx = running.get(id);
  if (!ctx) return;
  ctx.cancelled = true;
  for (const a of [...approvals.values()]) {
    if (a.callId === id) void settle(a.id, "deny", "cancelled");
  }
}

/** The link is gone: refuse what waits, and let go of every tab. */
function stopEverything() {
  for (const ctx of running.values()) ctx.cancelled = true;
  denyAll();
  void chrome.storage.session.remove("gesture");
  for (const tabId of [...attached.keys()]) void detachDebugger(tabId);
  recorders.clear();
  mocks.clear();
  for (const tabId of [...videos.keys()]) void stopVideo(tabId, null, "paused").catch(() => {});
  hidePointers();
}

async function startPairing(typed) {
  const name = checkName(typed);
  if (!name) return { ok: false, error: "invalid_name" };
  const current = await loadLink();
  if (polls(current)) return { ok: false, error: "already" };
  const server = await cloudServer();
  const secret = makeSecret();
  let answer;
  try {
    answer = await exchange(
      (url, init) => fetch(url, init),
      startRequest(server, { name, secretHash: await secretHash(secret), browser: BROWSER, version: VERSION }),
    );
  } catch {
    return { ok: false, error: "unreachable", server };
  }
  if (answer.status === 422) return { ok: false, error: "invalid_name", detail: String(answer.body?.detail ?? "") };
  const link = answer.status === 200 ? started(name, secret, answer.body, Date.now()) : null;
  if (!link) return { ok: false, error: "unreachable", server };
  linkEpoch += 1;
  await saveLink(link);
  ensureLoop();
  return { ok: true };
}

/** Forget the link here, telling the cloud when there is one to tell (best effort). */
async function forgetLink() {
  const link = await loadLink();
  linkEpoch += 1;
  await saveLink(UNPAIRED);
  lastPollOkAt = 0;
  stopEverything();
  let told = true;
  if (polls(link)) {
    try {
      const { status } = await exchange(
        (url, init) => fetch(url, init),
        unpairRequest(await cloudServer(), link.id, link.secret),
        10_000,
      );
      told = status < 500;
    } catch {
      told = false;
    }
  }
  await refreshBadge();
  return told;
}

// --- approvals -------------------------------------------------------------

// The prompt itself: a small window that opens by itself and comes to the front.
// Notifications alone were not enough - macOS and Focus modes quietly swallow them, and
// the side panel only exists while someone has it open - so a request nobody could
// see simply timed out as a denial. Closing the window denies what is waiting.
let approvalWindowId = null;

async function showApprovalWindow() {
  if (approvalWindowId !== null) {
    try {
      await chrome.windows.update(approvalWindowId, { focused: true, drawAttention: true });
      return;
    } catch {
      approvalWindowId = null; // it was closed under us
    }
  }
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL("ui/approval.html"),
      type: "popup",
      width: 400,
      height: 460,
      focused: true,
    });
    approvalWindowId = win.id ?? null;
  } catch {
    /* The notification and the badge remain. */
  }
}

async function closeApprovalWindow() {
  const id = approvalWindowId;
  approvalWindowId = null;
  if (id !== null) {
    try {
      await chrome.windows.remove(id);
    } catch {
      /* already gone */
    }
  }
}

chrome.windows.onRemoved.addListener((id) => {
  if (id === approvalWindowId) {
    approvalWindowId = null;
    denyAll();
  }
});

async function requestApproval(op, origin, summary, trustable = true, native = false, callId = null) {
  const id = String(++seq);
  const [title, allowOnce, deny] = await Promise.all([
    tr("approval.title"),
    tr("approval.allowOnce"),
    tr("approval.deny"),
  ]);
  return new Promise((resolve) => {
    const timer = setTimeout(() => settle(id, "deny", "timeout"), APPROVAL_TIMEOUT_MS);
    approvals.set(id, { id, op, origin, summary, trustable, native, callId, resolve, timer });
    void chrome.notifications.create(`wysebee-${id}`, {
      type: "basic",
      iconUrl: "icon.png",
      title,
      message: summary,
      buttons: [{ title: allowOnce }, { title: deny }],
      requireInteraction: true,
    });
    void refreshBadge();
    void showApprovalWindow();
  });
}

async function settle(id, decision, _reason = "answered") {
  const entry = approvals.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  approvals.delete(id);
  void chrome.notifications.clear(`wysebee-${id}`);
  // "always" trusts the site — never for an operation trust does not cover (closing).
  if (decision === "always" && entry.trustable) {
    // Never a downgrade: "Always allow" on a site already at "full" leaves it there.
    const { sites } = await load();
    if (sites[entry.origin] !== "full") await setSite(entry.origin, "auto");
  }
  entry.resolve(decision === "always" ? "once" : decision);
  if (approvals.size === 0) void closeApprovalWindow();
  void refreshBadge();
}

function denyAll() {
  for (const id of [...approvals.keys()]) void settle(id, "deny", "cancelled");
}

chrome.notifications.onButtonClicked.addListener((notificationId, button) => {
  void settle(notificationId.replace("wysebee-", ""), button === 0 ? "once" : "deny");
});
chrome.notifications.onClosed.addListener((notificationId, byUser) => {
  if (byUser) void settle(notificationId.replace("wysebee-", ""), "deny", "dismissed");
});

// --- the pages' channel -----------------------------------------------------------
//
// Only this extension's own pages (the side panel, the approval window) may ask
// (policy.js fromOwnPage): a content script runs on a web page's address, and nothing else
// can reach this listener at all. Not "has no tab": the approval window's page has one.

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (!fromOwnPage(sender, chrome.runtime.id, chrome.runtime.getURL(""))) {
      reply({ ok: false, error: "Not allowed." });
      return;
    }
    if (msg.type === "get_state") {
      // Someone opened the side panel: make sure the link is being kept up (unless switched off).
      ensureLoop();
      const { sites, blocked, bookmarksAllowed } = await load();
      const { uploadRecordings = false } = await chrome.storage.local.get("uploadRecordings");
      const lang = await languages();
      const link = await loadLink();
      reply({
        version: VERSION,
        link: publicState(link, Date.now()),
        // Whether Wysebee Cloud answered a poll lately; only means something when paired.
        connected: polls(link) && isConnected(),
        enabled: await isEnabled(),
        // The Wysebee Cloud this browser pairs with, and the build's default.
        server: await cloudServer(),
        defaultServer: SERVER,
        language: lang.current,
        browserLanguage: lang.browser,
        languageOverride: lang.override,
        theme: await currentTheme(),
        sites,
        blocked,
        bookmarksAllowed,
        uploadRecordings,
        approvals: [...approvals.values()].map(({ id, op, origin, summary, trustable }) => ({
          id,
          op,
          origin,
          summary,
          trustable,
        })),
      });
    } else if (msg.type === "pair") {
      // The agent name the person typed: ask the cloud for a code and start polling — on,
      // whatever the switch said, since a code nobody polls for never pairs.
      await chrome.storage.local.set({ enabled: true });
      reply(await startPairing(msg.name));
    } else if (msg.type === "set_enabled") {
      await setEnabled(!!msg.enabled);
      reply({ ok: true, enabled: !!msg.enabled });
    } else if (msg.type === "cancel_pairing") {
      // Cancel while the code shows, or "Try another name" after a refusal or an expiry:
      // back to unpaired either way. Never drops a pairing that was made.
      const link = await loadLink();
      if (link.phase === "paired") {
        reply({ ok: false, error: "Paired: unpair instead." });
      } else {
        await forgetLink();
        reply({ ok: true });
      }
    } else if (msg.type === "unpair") {
      // Forgotten here whatever the cloud says; `told` is whether it heard.
      reply({ ok: true, told: await forgetLink() });
    } else if (msg.type === "answer") {
      await settle(String(msg.id), msg.decision);
      reply({ ok: true });
    } else if (msg.type === "forget") {
      await setSite(String(msg.origin), null);
      reply({ ok: true });
    } else if (msg.type === "set_blocked") {
      // Only names policy.js knows: anything else would be stored and never mean anything.
      const blocked = [...new Set(Array.isArray(msg.blocked) ? msg.blocked : [])]
        .map(String)
        .filter((op) => BLOCKABLE.has(op))
        .sort();
      // Off-by-default kinds the panel shows as allowed are stored as turned on.
      await chrome.storage.local.set(splitBlocked(blocked));
      // Blocking applies to what is already waiting, not only to what comes next.
      for (const a of [...approvals.values()]) {
        if (isBlocked(a.op, a.native, blocked)) void settle(a.id, "deny");
      }
      if (blocked.includes("browser_mouse") || blocked.includes(NATIVE_INPUT)) {
        await chrome.storage.session.remove("gesture");
      }
      if (blocked.includes(NATIVE_INPUT)) {
        // A tab being recorded by the developer tools keeps its session: that is not
        // real input, and blocking one must not quietly end the other.
        for (const tabId of [...attached.keys()]) {
          if (!recorders.get(tabId)?.recording && !videos.has(tabId)) await detachDebugger(tabId);
        }
      }
      // Turned off while in use: a recording ends (and is kept), faked responses stop.
      if (blocked.includes("browser_record")) {
        for (const tabId of [...videos.keys()]) void stopVideo(tabId, null, "blocked").catch(() => {});
      }
      if (blocked.includes("browser_mock")) {
        for (const tabId of [...mocks.keys()]) await dropMocks(tabId);
      }
      await refreshBadge();
      reply({ ok: true, blocked });
    } else if (msg.type === "set_bookmarks_allowed") {
      // Machine-wide, and deliberately not a site's business: a bookmark read returns
      // every URL you have, whatever page the agent is on. See policy.js.
      const allowed = !!msg.allowed;
      await chrome.storage.local.set({ bookmarksAllowed: allowed });
      if (!allowed) {
        // Turning it off settles what is already waiting on it the same way blocking
        // does — a prompt approved under the old setting must not ride through.
        for (const a of [...approvals.values()]) {
          if (a.op === "browser_bookmarks") void settle(a.id, "deny");
        }
      }
      await refreshBadge();
      reply({ ok: true, bookmarksAllowed: allowed });
    } else if (msg.type === "set_cloud_server") {
      // The Server tab: a self-hosted Wysebee Cloud, or "" for the default.
      reply(await setCloudServer(String(msg.server ?? ""), msg.unpair === true));
    } else if (msg.type === "set_upload_recordings") {
      // Whether scenario videos also go to Wysebee Cloud (off by default). It applies to
      // recordings stopped from now on; one already uploading carries on.
      const on = msg.on === true;
      await chrome.storage.local.set({ uploadRecordings: on });
      reply({ ok: true, uploadRecordings: on });
    } else if (msg.type === "set_site") {
      // Add a site, or change its level. The origin is re-derived here rather than
      // trusted from the page, so only an http(s) origin is ever stored and it is stored
      // in the one form policy.js compares against.
      const origin = originOf(String(msg.origin || ""));
      if (!origin || !SITE_MODES.includes(msg.mode)) {
        reply({ ok: false, error: "Only an http or https site can be added." });
      } else {
        await setSite(origin, msg.mode);
        reply({ ok: true, origin });
      }
    } else if (msg.type === "set_theme") {
      // The theme picker: "light", "dark", or "" to follow the computer's look.
      const choice = String(msg.theme ?? "");
      if (!THEMES.includes(choice)) {
        reply({ ok: false, error: "Unknown theme." });
      } else {
        await chrome.storage.local.set({ theme: choice });
        reply({ ok: true, theme: choice });
      }
    } else if (msg.type === "set_language") {
      // The language picker: one of LANGUAGES, or "" to follow the browser.
      const choice = String(msg.language ?? "");
      if (choice && !LANGUAGES.includes(choice)) {
        reply({ ok: false, error: "Unknown language." });
      } else {
        await chrome.storage.local.set({ languageOverride: choice });
        reply({ ok: true, language: await currentLanguage() });
      }
    } else if (msg.type === "video_uploaded") {
      // The recorder page's word that an upload is over (it outlives the call that stopped it).
      const entry = uploads.find((u) => u.key === msg.key);
      if (entry) entry.upload = msg.ok ? "uploaded" : `failed: ${String(msg.error || "unknown")}`;
      if (entry && msg.ok && msg.id) entry.recording_id = String(msg.id);
      reply({ ok: true });
      void closeRecorderIfIdle();
    } else {
      reply({ ok: false });
    }
  })().catch((e) => reply({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true; // async reply
});

// --- operations ----------------------------------------------------------------


async function targetTab(args) {
  if (typeof args.tab_id === "number") return chrome.tabs.get(args.tab_id);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("There is no active tab.");
  return tab;
}

async function waitComplete(tabId, timeoutMs) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") return;
  await new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// When the last captureVisibleTab ran, and when the agent pointer's picture of the
// current op is complete — for recording frames (recording.js), which must respect
// Chrome's ~2 captures a second and show the action, not the moment before it.
let lastCaptureAt = 0;
let pointerSettlesAt = 0;

/** The visible area of `tab` (the active one in its window), fitted for a model. */
async function capture(tab) {
  lastCaptureAt = Date.now();
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const cssWidth = await runInPage(tab.id, () => window.innerWidth).catch(() => 0);
  const shot = await fitScreenshot(dataUrl, Number(cssWidth) || 0);
  // What a pixel of *this* image is in the page, for the browser_mouse that
  // follows: its x/y are picked off this image.
  await chrome.storage.session.set({ [`shot:${tab.id}`]: shot.pxPerCss });
  return { image: shot.data, mime: shot.mime, width: shot.width, height: shot.height };
}

/**
 * A recording frame of `tabId` once its action has shown, or null: when the tab is not
 * the one in front of its window (a frame never switches tabs), the window is
 * minimised, or the capture fails. Smaller than a screenshot, and it leaves the
 * screenshot scale browser_mouse reads (`shot:<tab>`) alone.
 */
async function recordFrame(tabId) {
  try {
    const settles = pointerSettlesAt || Date.now() + settleMs(null);
    const wait = captureWait(Date.now(), settles, lastCaptureAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) return null;
    lastCaptureAt = Date.now();
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const shot = await fitScreenshot(dataUrl, 0, FRAME_MAX_EDGE, FRAME_QUALITY);
    return { image: shot.data, mime: shot.mime, width: shot.width, height: shot.height };
  } catch {
    return null; /* Minimised window, rate limit, a closed tab: no frame. */
  }
}

async function runInPage(tabId, func, args = []) {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return injection?.result;
}

// The agent pointer (pointer.js, drawn by page.overlay) — only ever from here, for an
// agent's action, never for the person's own mouse. Best effort: a page that refuses
// the injection, or navigates away mid-way, simply shows none. Returns once the dot
// has glided to where the action starts, so the person sees it arrive, then act.
async function showPointer(tabId, cmd) {
  if (!cmd) return;
  try {
    const res = await runInPage(tabId, page.overlay, [{ ...cmd, idleMs: IDLE_MS }]);
    if (Array.isArray(res?.at)) {
      lastPointer.set(tabId, { point: res.at, at: Date.now() });
      void rememberPointed(tabId);
    }
    else if (lastPointer.has(tabId)) lastPointer.get(tabId).at = Date.now(); // a caret: still active
    if (res?.lead > 0) await new Promise((r) => setTimeout(r, Math.min(res.lead, GLIDE.maxMs)));
    pointerSettlesAt = Date.now() + settleMs(cmd);
  } catch {
    /* Nothing to draw on. */
  }
}

// Where the agent's dot was last left in each tab, so it stays on screen like a mouse
// cursor: a page load wipes the page's overlay, and the dot is drawn again at the same
// spot (pointer.js's restoreCommand) until IDLE_MS after the agent's last action.
// Kept in memory only: a service worker that was stopped has nothing to restore.
/** @type {Map<number, {point: [number, number], at: number}>} */
const lastPointer = new Map();

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete" || !lastPointer.has(tabId)) return;
  const cmd = restoreCommand(lastPointer.get(tabId), Date.now());
  if (!cmd) {
    lastPointer.delete(tabId);
    return;
  }
  runInPage(tabId, page.overlay, [cmd]).catch(() => {
    /* A page the extension cannot draw on (chrome://, the store): no dot there. */
  });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  lastPointer.delete(tabId);
  void forgetPointed(tabId);
});

// The tabs the dot was drawn on, kept in session storage as well: a worker that was stopped
// forgets lastPointer, but the dot is still on those pages until it fades, and
// browser_end_task must still find it there.
async function pointedTabs() {
  const { pointed } = await chrome.storage.session.get("pointed");
  return Array.isArray(pointed) ? pointed : [];
}

async function rememberPointed(tabId) {
  const pointed = await pointedTabs();
  if (!pointed.includes(tabId)) await chrome.storage.session.set({ pointed: [...pointed, tabId] });
}

async function forgetPointed(tabId) {
  const pointed = await pointedTabs();
  if (pointed.includes(tabId)) await chrome.storage.session.set({ pointed: pointed.filter((t) => t !== tabId) });
}

/** Take the dot (and any caret) off one tab: its scenario is over. Resolves once it is off. */
function hidePointer(tabId) {
  lastPointer.delete(tabId);
  void forgetPointed(tabId);
  return runInPage(tabId, page.overlay, [hideCommand()]).then(
    () => true,
    () => false, /* Gone or not drawable: nothing to hide. */
  );
}

/**
 * browser_end_task: the AI app's whole task is over. The dot goes from every tab it was
 * drawn on, the debugger lets go of every tab it holds (its bar closes, faked responses
 * and logging stop) and an approved mouse gesture ends — but a recording carries on until
 * browser_record stops it (pointer.js's endTaskPlan). Never asks: it only takes away what
 * the agent left showing. Harmless when there is nothing to take away.
 */
async function endTask() {
  const plan = endTaskPlan({
    pointed: [...lastPointer.keys(), ...(await pointedTabs())],
    attached: [...attached.keys()],
    filming: [...videos.keys()],
  });
  const hidden = await Promise.all(plan.hide.map((tabId) => hidePointer(tabId)));
  await chrome.storage.session.remove(["pointed", "gesture"]);
  for (const tabId of plan.release) {
    await detachDebugger(tabId);
    recorders.delete(tabId);
  }
  const now = Date.now();
  return {
    ended: true,
    pointer_removed_from: plan.hide.filter((_, i) => hidden[i]),
    debugger_released_from: plan.release,
    recordings_running: plan.filming.map((tabId) => videoStatus(videos.get(tabId), now)),
    ...(plan.filming.length
      ? { note: "A recording is still running: call browser_record with action stop to end and save it." }
      : {}),
  };
}

/** Take the dot off every page it is on: the agent was paused or unpaired. */
function hidePointers() {
  for (const tabId of [...lastPointer.keys()]) hidePointer(tabId);
}
/**
 * One operation the paired agent asked for. `ctx` is the call it came in (`cancelled`
 * once the cloud says so): a cancelled call is not started, and not carried on after a
 * prompt.
 */
async function handle(op, args, ctx = null) {
  if (op === "ping") return {};
  if (op !== "recording_saved" && op !== "browser_end_task" && !OPS.has(op)) throw new Error(`Unknown operation ${op}.`);
  // Wysebee's notice that a recording of this browser is saved: told to the
  // person, not judged by policy — it touches no tab and reads nothing.
  if (op === "recording_saved") return await notifyRecording(args);
  // The AI app's task is over: take away what the agent left showing. No prompt — it only
  // ends things, like stopping a recording.
  if (op === "browser_end_task") return await endTask();
  // Stopping or asking about a scenario video changes nothing on any page: no prompt, so a
  // recording can always be ended, whatever the tab shows by then.
  if (op === "browser_record") {
    const { action } = checkRecordArgs(args);
    if (action !== "start") return await recordControl(action, args, ctx);
  }
  // Closing never falls back to "the active tab": guessing wrong closes something of
  // the person's, so the caller has to name it.
  if (op === "browser_close_tab" && typeof args.tab_id !== "number") {
    throw new Error("Say which tab to close: pass a tab_id from browser_tabs.");
  }
  const { sites, blocked, bookmarksAllowed } = await load();
  const tabless = op === "browser_tabs" || op === "browser_open_tab" || op === "browser_bookmarks";
  const tab = tabless ? null : await targetTab(args);
  const tabOrigin = tab ? originOf(tab.url || "") : null;
  // The agent is still at work on a tab being filmed: its recording does not time out.
  if (tab && videos.has(tab.id)) videos.get(tab.id).lastActionAt = Date.now();
  const destOrigin =
    op === "browser_navigate" || op === "browser_open_tab" ? originOf(String(args.url || "")) : null;
  const openedByProbe = op === "browser_close_tab" && (await openedTabs()).has(tab.id);

  const inGesture = op === "browser_mouse" && (await gestureGranted(tab.id, tabOrigin, !!args.native));
  const verdict = decide({
    op,
    tabOrigin,
    destOrigin,
    sites,
    openedByProbe,
    gestureGranted: inGesture,
    blocked,
    native: op === "browser_mouse" && !!args.native,
    bookmarksAllowed,
  });
  if (verdict.verdict === "deny") throw new Error(verdict.reason);
  if (verdict.verdict === "ask") {
    const asked = summary(op, verdict.origin, { ...args, title: tab?.title });
    const answer = await requestApproval(
      op,
      verdict.origin,
      await tr(`approval.summary.${asked.key}`, asked.vars),
      verdict.trustable !== false,
      op === "browser_mouse" && !!args.native,
      ctx?.id ?? null,
    );
    if (answer !== "once") throw new Error("The user declined.");
  }
  if (ctx?.cancelled) throw new Error("Cancelled.");

  pointerSettlesAt = 0;
  const recording = wantsFrame(op, args);
  // What the action is about to act on, for the Playwright test the desktop writes:
  // described now, while its elements are still there.
  const step = recording ? await describeStep(op, args, tab.id) : null;
  const result = await perform(op, args, tab, tabOrigin, blocked);
  if (!recording) return result;
  // A recording frame (recording.js), when the desktop asked for one: of the tab in
  // front only, never where screenshots are blocked, and never failing the op.
  const frame = isBlocked("browser_screenshot", false, blocked) ? null : await recordFrame(tab.id);
  return { ...result, ...(frame ? { frame } : {}), ...(step ? { step } : {}) };
}

/** The recording step for `op` (recording.js stepFor), or null. Best effort. */
async function describeStep(op, args, tabId) {
  if (op === "browser_navigate") return stepFor(op, args, null);
  try {
    const pxPerCss = (await chrome.storage.session.get(`shot:${tabId}`))[`shot:${tabId}`] ?? null;
    const point = args.x == null || args.y == null ? null : [Number(args.x), Number(args.y)];
    const d = await runInPage(tabId, page.describe, [refsFor(op, args), point, args.points ?? null, pxPerCss]);
    return stepFor(op, args, d);
  } catch {
    return null; /* A page that refuses the injection: no step. */
  }
}

async function perform(op, args, tab, tabOrigin, blocked) {
  switch (op) {
    case "browser_tabs": {
      const tabs = await chrome.tabs.query({});
      const opened = await openedTabs();
      return {
        tabs: tabs.map((t) => ({
          id: t.id,
          title: t.title || "",
          origin: originOf(t.url || ""),
          active: t.active,
          // Tabs the probe opened: closing these does not ask the person.
          opened_by_probe: opened.has(t.id),
        })),
      };
    }
    case "browser_open_tab": {
      const created = await chrome.tabs.create({ url: String(args.url), active: args.active !== false });
      await markOpened(created.id, true);
      await waitComplete(created.id, NAV_TIMEOUT_MS);
      return { tab_id: created.id, ...(await summarise(created.id)) };
    }
    case "browser_close_tab":
      await chrome.tabs.remove(tab.id);
      return { closed: true, tab_id: tab.id };
    case "browser_activate":
      await chrome.tabs.update(tab.id, { active: true });
      return { tab_id: tab.id };
    case "browser_snapshot": {
      const snap = await runInPage(tab.id, page.snapshot);
      // A picture of what was read, for the chat (`with_image`, desktop 0.3+). Only of a
      // tab already in front — a snapshot never switches tabs to take one — and never
      // where screenshots are blocked in the side panel's Settings. It shows what the snapshot
      // already reads, under the same approval. Best effort: no picture is no failure.
      if (args.with_image && tab.active && !isBlocked("browser_screenshot", false, blocked)) {
        try {
          return { ...snap, ...(await capture(tab)) };
        } catch {
          /* Minimised window, capture rate limit: the text is the answer. */
        }
      }
      return snap;
    }
    case "browser_screenshot": {
      if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
      return await capture(tab);
    }
    case "browser_navigate":
      await chrome.tabs.update(tab.id, { url: String(args.url) });
      await waitComplete(tab.id, NAV_TIMEOUT_MS);
      return { tab_id: tab.id, ...(await summarise(tab.id)) };
    case "browser_click": {
      await showPointer(tab.id, refClickCommand(args.ref));
      const res = await runInPage(tab.id, page.click, [String(args.ref)]);
      if (!res?.ok) throw new Error(res?.error || "Click failed.");
      await new Promise((r) => setTimeout(r, 300));
      await waitComplete(tab.id, NAV_TIMEOUT_MS);
      return { clicked: true };
    }
    case "browser_scroll": {
      const scrollArgs = [
        args.ref == null ? null : String(args.ref),
        String(args.direction || "down"),
        Number(args.pages ?? 1),
      ];
      // Where it would scroll, first, so the pointer shows the scroll there.
      const plan = await runInPage(tab.id, page.scroll, [...scrollArgs, true]).catch(() => null);
      if (plan?.ok) await showPointer(tab.id, scrollCommand(plan, scrollArgs[1]));
      const res = await runInPage(tab.id, page.scroll, scrollArgs);
      if (!res?.ok) throw new Error(res?.error || "Scrolling failed.");
      const { ok: _ok, ...where } = res;
      return where;
    }
    case "browser_drag": {
      const dragArgs = [
        String(args.from_ref),
        args.to_ref == null ? null : String(args.to_ref),
        args.to_text == null ? null : String(args.to_text),
        Number(args.dx || 0),
        Number(args.dy || 0),
      ];
      // Where it would go, first, so the pointer is pressed on the source as the
      // drag starts and carries it to the target.
      const plan = await runInPage(tab.id, page.drag, [...dragArgs, true]).catch(() => null);
      if (plan?.ok) await showPointer(tab.id, dragCommand(plan));
      const res = await runInPage(tab.id, page.drag, dragArgs);
      if (!res?.ok) throw new Error(res?.error || "Dragging failed.");
      await waitComplete(tab.id, NAV_TIMEOUT_MS);
      return { dragged: true, kind: res.kind, ...(res.value != null ? { value: res.value } : {}) };
    }
    case "browser_bookmarks":
      return await readBookmarks(args.query ? String(args.query) : "", Number(args.limit) || 100);
    case "browser_mouse": {
      // Any mouse action that got this far was allowed, so (re)open the window for
      // the rest of the gesture on this tab and site.
      await grantGesture(tab.id, tabOrigin, !!args.native);
      // x/y are pixels of the latest screenshot of this tab, which is scaled to fit;
      // before any screenshot, the page falls back to devicePixelRatio.
      const pxPerCss = (await chrome.storage.session.get(`shot:${tab.id}`))[`shot:${tab.id}`] ?? null;
      const point = [
        args.x == null ? null : Number(args.x),
        args.y == null ? null : Number(args.y),
        args.ref == null ? null : String(args.ref),
      ];
      const isPath = String(args.action) === "path";
      // The point (or a path's points) is resolved in the page — refs,
      // devicePixelRatio, off-screen — for the agent pointer, and for real input,
      // which then goes through the debugger, not the page.
      const loc = isPath
        ? await runInPage(tab.id, page.locatePath, [args.points ?? null, pxPerCss])
        : await runInPage(tab.id, page.locate, [...point, pxPerCss]);
      if (loc?.ok) await showPointer(tab.id, pointerCommand(String(args.action), loc));
      if (args.native) {
        if (!loc?.ok) throw new Error(loc?.error || "Could not find that point.");
        await attachDebugger(tab.id);
        const key = `native:${tab.id}`;
        const state = (await chrome.storage.session.get(key))[key] || { buttons: 0, x: null, y: null };
        const out = await nativeMouse(
          {
            action: String(args.action),
            x: loc.x,
            y: loc.y,
            points: loc.points,
            button: String(args.button || "left"),
            deltaX: args.delta_x,
            deltaY: args.delta_y,
          },
          state,
          (method, params) => cdp(tab.id, method, params),
        );
        await chrome.storage.session.set({ [key]: state });
        await new Promise((r) => setTimeout(r, 50));
        return { ...out, input: "native", element: loc.element };
      }
      const res = await runInPage(tab.id, page.mouse, [
        String(args.action),
        ...point,
        String(args.button || "left"),
        Number(args.delta_x) || 0,
        Number(args.delta_y) || 0,
        pxPerCss,
        isPath ? (args.points ?? null) : null,
      ]);
      if (!res?.ok) throw new Error(res?.error || "The mouse action failed.");
      const { ok: _ok, ...result } = res;
      return { ...result, input: "simulated" };
    }
    case "browser_type": {
      const res = await runInPage(tab.id, page.type, [String(args.ref), String(args.text ?? ""), !!args.submit]);
      if (!res?.ok) throw new Error(res?.error || "Typing failed.");
      await showPointer(tab.id, caretCommand(args.ref));
      return { typed: true };
    }
    case "browser_console": {
      const rec = await startDevtools(tab.id);
      return {
        tab_id: tab.id,
        ...rec.console({
          level: String(args.level || "all"),
          limit: Number(args.limit) || 200,
          after: Number(args.after) || 0,
          clear: !!args.clear,
        }),
      };
    }
    case "browser_network": {
      const rec = await startDevtools(tab.id);
      return {
        tab_id: tab.id,
        ...rec.network({
          filter: args.filter ? String(args.filter) : "",
          type: args.resource_type ? String(args.resource_type) : "",
          failedOnly: !!args.failed_only,
          headers: !!args.include_headers,
          limit: Number(args.limit) || 200,
          clear: !!args.clear,
        }),
      };
    }
    case "browser_network_body": {
      const rec = recorders.get(tab.id);
      const id = String(args.request_id ?? "");
      if (!rec?.hasRequest(id)) {
        throw new Error("No such request on this tab; list them with browser_network first.");
      }
      await startDevtools(tab.id);
      const entry = rec.requests.get(id);
      // A redirect hop has no body of its own; its id names the request it was part of.
      const res = await devCdp(tab.id, "Network.getResponseBody", { requestId: id.split(":")[0] });
      return responseBody(res, entry);
    }
    case "browser_evaluate": {
      const expression = String(args.expression ?? "");
      if (!expression.trim()) throw new Error("Give the JavaScript to run.");
      if (expression.length > MAX_EXPRESSION) throw new Error("That script is too long.");
      await startDevtools(tab.id);
      const res = await devCdp(tab.id, "Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: args.await_promise !== false,
        replMode: true,
        userGesture: false,
        timeout: 15_000,
      });
      return { tab_id: tab.id, ...evaluationResult(res) };
    }
    case "browser_viewport": {
      const rec = await startDevtools(tab.id);
      if (args.reset) {
        await devCdp(tab.id, "Emulation.clearDeviceMetricsOverride");
        await devCdp(tab.id, "Emulation.setTouchEmulationEnabled", { enabled: false });
        if (rec.viewport?.userAgent) {
          await devCdp(tab.id, "Emulation.setUserAgentOverride", { userAgent: rec.viewport.userAgent });
        }
        rec.viewport = null;
      } else {
        const metrics = checkViewport(args);
        // Remember the real user agent once, so a reset can put it back.
        const original =
          rec.viewport?.userAgent ??
          (args.user_agent ? await runInPage(tab.id, () => navigator.userAgent) : null);
        await devCdp(tab.id, "Emulation.setDeviceMetricsOverride", metrics);
        await devCdp(tab.id, "Emulation.setTouchEmulationEnabled", { enabled: metrics.mobile });
        if (args.user_agent) {
          await devCdp(tab.id, "Emulation.setUserAgentOverride", { userAgent: String(args.user_agent).slice(0, 500) });
        }
        rec.viewport = { userAgent: original };
      }
      await new Promise((r) => setTimeout(r, 150));
      const size = await runInPage(tab.id, () => ({
        width: innerWidth,
        height: innerHeight,
        device_pixel_ratio: devicePixelRatio,
      }));
      return { tab_id: tab.id, emulating: !!rec.viewport, ...size };
    }
    case "browser_inspect": {
      const res = await runInPage(tab.id, devpage.inspect, [
        args.ref == null ? null : String(args.ref),
        args.selector == null ? null : String(args.selector),
        Number(args.index) || 0,
        Array.isArray(args.styles) ? args.styles.map(String) : null,
      ]);
      if (!res?.ok) throw new Error(res?.error || "Could not inspect that element.");
      const { ok: _ok, ...element } = res;
      return element;
    }
    case "browser_audit": {
      const res = await runInPage(tab.id, devpage.audit);
      if (!res?.ok) throw new Error("Could not audit the page.");
      const { ok: _ok, ...report } = res;
      // What the console has said counts too, when this tab is being recorded.
      const rec = recorders.get(tab.id);
      if (rec) report.console_errors = rec.console({ level: "error" }).total;
      return report;
    }
    case "browser_performance": {
      await startDevtools(tab.id);
      const { metrics = [] } = await devCdp(tab.id, "Performance.getMetrics");
      const res = await runInPage(tab.id, devpage.timings);
      const { ok: _ok, ...timing } = res || {};
      return { ...timing, metrics: Object.fromEntries(metrics.map((m) => [m.name, m.value])) };
    }
    case "browser_reload": {
      // Recording first, so the reload itself — every request and message from the
      // very start of the page — is captured.
      await startDevtools(tab.id);
      await chrome.tabs.reload(tab.id, { bypassCache: !!args.bypass_cache });
      await new Promise((r) => setTimeout(r, 300));
      await waitComplete(tab.id, NAV_TIMEOUT_MS);
      return { tab_id: tab.id, ...(await summarise(tab.id)) };
    }
    case "browser_record":
      return await startVideo(tab, checkRecordArgs(args).name, tabOrigin);
    case "browser_mock": {
      // Recording too, so the faked requests show in browser_network beside the real ones.
      await startDevtools(tab.id);
      const current = mocks.get(tab.id);
      const next = new Mocks(tabOrigin);
      if (!args.clear && current?.origin === tabOrigin) next.rules = current.rules.slice();
      if (args.rules != null) next.add(args.rules); // checked whole: nothing changes if a rule is wrong
      if (args.rules != null || args.clear) {
        if (next.rules.length) {
          mocks.set(tab.id, next);
          await mockCdp(tab.id, "Fetch.enable", { patterns: next.patterns() });
        } else {
          await dropMocks(tab.id);
        }
      }
      const live = mocks.get(tab.id);
      return {
        tab_id: tab.id,
        origin: tabOrigin,
        rules: live ? live.list() : [],
        note: "Rules last until cleared, the tab goes to another site, or the agent is paused. Pages themselves are never faked.",
      };
    }
    default:
      throw new Error(`Unknown operation ${op}.`);
  }
}

/**
 * Bookmarks as a flat list with the folder each sits in. A query uses the browser's own
 * search (title and URL); without one the whole tree is walked in order. Folders
 * themselves are not listed — their path is on every bookmark inside them.
 */
async function readBookmarks(query, limit) {
  const max = Math.min(Math.max(limit, 1), 500);
  const folderPath = new Map();
  const out = [];
  let total = 0;
  const walk = (agent, path) => {
    if (agent.url) {
      total++;
      if (!query && out.length < max) out.push(entry(agent, path));
      return;
    }
    const here = agent.title ? [...path, agent.title] : path;
    folderPath.set(agent.id, here.join(" / "));
    for (const child of agent.children || []) walk(child, here);
  };
  const entry = (agent, path) => ({
    id: agent.id,
    title: agent.title || "",
    url: String(agent.url).slice(0, 500),
    folder: Array.isArray(path) ? path.join(" / ") : path,
    date_added: agent.dateAdded ? new Date(agent.dateAdded).toISOString() : null,
  });
  for (const root of await chrome.bookmarks.getTree()) walk(root, []);
  if (!query) return { bookmarks: out, total, truncated: total > out.length };
  const found = (await chrome.bookmarks.search(query)).filter((b) => b.url);
  return {
    bookmarks: found.slice(0, max).map((b) => entry(b, folderPath.get(b.parentId) ?? "")),
    total: found.length,
    truncated: found.length > max,
  };
}

async function summarise(tabId) {
  const t = await chrome.tabs.get(tabId);
  return { title: t.title || "", origin: originOf(t.url || "") };
}

// --- lifecycle -------------------------------------------------------------------

// A service worker sleeps, and Chrome may kill it; the loop of long polls keeps it
// awake while it runs, and each of these
// starts the loop again if it is not running: an alarm every 30 s (Chrome's shortest),
// the browser starting, the extension being installed or updated, and a page of the
// extension asking for the state.
chrome.alarms.create("link", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  ensureLoop();
  expireVideos();
});
chrome.runtime.onStartup.addListener(() => ensureLoop());
chrome.runtime.onInstalled.addListener(() => ensureLoop());
// Settings an earlier version kept and this one no longer has, cleared at every start:
// its "server" (the Server tab's is cloud.js's SERVER_KEY now) and "Let Wysebee use this
// browser" (removed).
// Nothing reads either any more; clearing them only keeps storage honest.
void chrome.storage.local.remove(["server", "paused"]);
ensureLoop();
void refreshBadge();

// The toolbar icon opens the side panel (the manifest has no popup). Set on every start of
// the worker: it is cheap, and a browser that dropped it gets it back.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) =>
  console.warn("[wysebee] the side panel could not be set to open from the toolbar", e),
);
