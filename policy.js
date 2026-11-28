// The decision of whether an operation may run, ask the person, or must be refused.
//
// Pure on purpose (no chrome.* here) so it can be tested with `agent --test` and read
// in one sitting: this file *is* the safety model, and everything else only carries
// out what it says.
//
//   a kind of request you blocked   -> deny   (on every site, trusted ones included)
//   browser_tabs                    -> allow  (ids, titles and origins only)
//   browser_bookmarks               -> ask    (unless allowed outright, below)
//   closing a tab the probe opened  -> allow  (nothing of yours is in it)
//   page is not http(s)             -> deny   (chrome://, the Web Store, file://, ...)
//   closing a tab on an "allow everything" site -> allow
//   closing a tab you opened        -> ask    (always: plain trust never covers it)
//   faking network responses        -> allow on an "allow everything" site, else ask (always)
//   mouse, inside an approved gesture -> allow (same tab and site, for a short while)
//   stopping a scenario video       -> allow  (background.js, before policy: it only ends one)
//   ending the task (browser_end_task) -> allow (background.js, before policy: it only takes the
//                                        dot and the debugger away)
//   site marked "auto" or "full"    -> allow
//   anything else                   -> ask    (reads and writes alike)
//
// For navigation and opening a tab the *destination* is what is judged: going to a
// site you trust is fine from anywhere, and going somewhere you have not approved
// asks even when the current tab is on a trusted site.
//
// Closing is the one operation trust does not cover. It can throw away work nobody
// saved — a half-written email on a site you trust completely — so a tab you opened
// is only ever closed with a yes, and the prompt offers no "always". A tab the probe
// opened itself is the exception, because there is nothing of yours in it to lose.
//
// A site has one of two levels, each set by the person: "auto" (trusted — what
// "Always allow" on a prompt gives) and "full" ("allow everything", set only on the
// popup's Settings). "full" is for a web app under automated test, where a prompt for
// every closed tab defeats the point; it is "auto" plus closing tabs, and nothing more.
// Neither level gets round a blocked kind of request, and neither
// covers bookmarks, which belong to no site.
//
// A mouse gesture is several calls — press, moves, release — and asking about each
// would be three prompts for one drag. So approving one mouse action grants the rest
// of the gesture: further mouse actions on the same tab *and* the same site, for a
// short window (background.js holds it). Navigating away ends it.
//
// A blocked kind of request is refused outright rather than asked about: blocking is
// the person saying "never this", so a prompt would only be a chance to click the
// wrong button. It sits above everything, so no trusted site, no
// gesture grant and no probe-opened tab gets round it. Real mouse input is its own
// kind (NATIVE_INPUT) because it is a different mechanism — the debugger — from the
// simulated mouse, and somebody may well want one without the other.
//
// The developer tools (DEVTOOLS_OPS — console, network, running script, the viewport,
// inspecting, auditing, performance, reloading) are offered only to an agent its owner
// gave "Web development tools" in Wysebee. Here they are ordinary operations on a tab:
// judged by the tab's site, so a trusted site (say http://localhost:3000) runs them
// without asking and anywhere else asks. Each is blockable on its own.
//
// browser_mock (mock.js) is the one developer tool plain trust does not cover: it makes
// the page see answers its server never gave, so like closing a tab it runs unasked only
// on an "allow everything" site — a web app under automated test — and otherwise asks
// every time, with no "always".

import { describeRules } from "./mock.js";

export const OPS = new Set([
  "browser_tabs",
  "browser_activate",
  "browser_snapshot",
  "browser_screenshot",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_open_tab",
  "browser_close_tab",
  "browser_scroll",
  "browser_drag",
  "browser_mouse",
  "browser_bookmarks",
  "browser_record",
  "browser_console",
  "browser_network",
  "browser_network_body",
  "browser_evaluate",
  "browser_viewport",
  "browser_inspect",
  "browser_audit",
  "browser_performance",
  "browser_reload",
  "browser_mock",
]);

// The developer tools, a subset of OPS (see above).
export const DEVTOOLS_OPS = new Set([
  "browser_console",
  "browser_network",
  "browser_network_body",
  "browser_evaluate",
  "browser_viewport",
  "browser_inspect",
  "browser_audit",
  "browser_performance",
  "browser_reload",
  "browser_mock",
]);

// Real (debugger-driven) mouse input: blockable on its own, apart from browser_mouse.
export const NATIVE_INPUT = "native_input";

// Every kind of request the popup's Settings can block.
export const BLOCKABLE = new Set([...OPS, NATIVE_INPUT]);

// Kinds that are blocked until the person turns them on (the side panel's Permissions tab): filming a
// tab and faking network responses are for a person testing their own app, not everyone.
// Turning one on is stored as an opt-in (`allowedKinds`), apart from the blocked list, so a
// list saved before these kinds existed does not count as having allowed them.
export const OFF_BY_DEFAULT = new Set(["browser_record", "browser_mock"]);

/** The blocked kinds in force: those stored, and every off-by-default kind not turned on. */
export function effectiveBlocked(stored, allowedKinds) {
  const on = new Set(Array.isArray(allowedKinds) ? allowedKinds : []);
  const out = new Set(Array.isArray(stored) ? stored : []);
  for (const op of OFF_BY_DEFAULT) if (!on.has(op)) out.add(op);
  return [...out].sort();
}

/** A blocked list from the side panel, split into what to store: `{blocked, allowedKinds}`. */
export function splitBlocked(list) {
  const all = new Set(list);
  return {
    blocked: [...all].filter((op) => !OFF_BY_DEFAULT.has(op)).sort(),
    allowedKinds: [...OFF_BY_DEFAULT].filter((op) => !all.has(op)).sort(),
  };
}

/** Whether the person has blocked this kind of request. */
export function isBlocked(op, native, blocked) {
  if (!blocked) return false;
  const list = blocked instanceof Set ? blocked : new Set(blocked);
  return list.has(op) || (op === "browser_mouse" && !!native && list.has(NATIVE_INPUT));
}

// The levels a site can be given, weakest first.
export const SITE_MODES = ["auto", "full"];

/** Whether a stored site level lets ordinary operations run without asking. */
export function isTrusted(mode) {
  return mode === "auto" || mode === "full";
}

// What a prompt for reading bookmarks shows where a site would be.
//
// **Bookmarks belong to no site, which is why they are not covered by one.** A read
// returns every bookmark URL you have, whatever page the agent happens to be on — so
// "allow everything on example.com" cannot sensibly grant it, and granting it that way
// would mean navigating to any fully-trusted site and then reading the lot. It is a
// setting of its own (`bookmarksAllowed`), off by default, for exactly that reason.
export const BOOKMARKS_ORIGIN = "Your bookmarks";

// Operations judged by where they go rather than where the tab is now.
const BY_DESTINATION = new Set(["browser_navigate", "browser_open_tab"]);

/** The origin of an http(s) URL, or null for anything this probe must not touch. */
export function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Whether a message to the worker comes from one of this extension's own pages (the side
 * panel, the approval window), which alone may ask it anything. Judged by the page's
 * address, not by whether it has a tab: the approval window is a popup *window*, so its
 * page has one, while a content script — which also carries this extension's id — runs on
 * a web page's address.
 */
export function fromOwnPage(sender, id, base) {
  return !!sender && sender.id === id && typeof sender.url === "string" && sender.url.startsWith(base);
}

/**
 * @param {{op: string, tabOrigin: string|null, destOrigin?: string|null,
 *          sites: Record<string,string>, openedByProbe?: boolean,
 *          gestureGranted?: boolean, blocked?: Iterable<string>, native?: boolean}} input
 * @returns {{verdict: "allow"|"ask"|"deny", origin?: string, reason?: string,
 *            trustable?: boolean}}
 *   `trustable: false` means the prompt must not offer "always allow this site".
 */
export function decide({
  op,
  tabOrigin,
  destOrigin = null,
  sites,
  openedByProbe = false,
  gestureGranted = false,
  blocked = [],
  native = false,
  bookmarksAllowed = false,
}) {
  if (!OPS.has(op)) return { verdict: "deny", reason: `Unknown operation ${op}.` };
  if (isBlocked(op, native, blocked)) {
    return {
      verdict: "deny",
      reason: "The user has blocked this kind of request in the extension's settings.",
    };
  }
  if (op === "browser_tabs") return { verdict: "allow" };
  // Bookmarks belong to no site, so no site's level reaches them and a prompt offers
  // no "always" — the one switch that turns them on is machine-wide and deliberate.
  // They carry full URLs that browser_tabs withholds, which is why the default is ask.
  if (op === "browser_bookmarks") {
    return bookmarksAllowed
      ? { verdict: "allow", origin: BOOKMARKS_ORIGIN }
      : { verdict: "ask", origin: BOOKMARKS_ORIGIN, trustable: false };
  }
  if (op === "browser_close_tab" && openedByProbe) return { verdict: "allow" };
  const origin = BY_DESTINATION.has(op) ? destOrigin : tabOrigin;
  if (!origin) {
    return {
      verdict: "deny",
      reason: "Only http and https pages can be controlled.",
    };
  }
  const mode = sites ? sites[origin] : undefined;
  if (op === "browser_close_tab" || op === "browser_mock") {
    return mode === "full" ? { verdict: "allow", origin } : { verdict: "ask", origin, trustable: false };
  }
  if (op === "browser_mouse" && gestureGranted) return { verdict: "allow", origin };
  if (isTrusted(mode)) return { verdict: "allow", origin };
  return { verdict: "ask", origin };
}

/**
 * What is being asked, for the prompt: a message key under `approval.summary` in the
 * extension's locale files and the values it takes. background.js renders it in the
 * person's language (lang.js); the English is locales/en.json.
 */
export function summary(op, origin, args) {
  const at = (key) => ({ key, vars: { origin } });
  switch (op) {
    case "browser_navigate":
      return { key: "navigate", vars: { url: args.url } };
    case "browser_open_tab":
      return { key: "openTab", vars: { url: args.url } };
    case "browser_close_tab":
      return args.title ? { key: "closeTabTitled", vars: { title: args.title, origin } } : at("closeTab");
    case "browser_click":
      return at("click");
    case "browser_type":
      return at("type");
    case "browser_scroll":
      return at("scroll");
    case "browser_drag":
      return at("drag");
    case "browser_bookmarks":
      return args.query ? { key: "bookmarksQuery", vars: { query: args.query } } : { key: "bookmarks", vars: {} };
    case "browser_mouse":
      return at(args.native ? "mouseNative" : "mouse");
    case "browser_screenshot":
      return at("screenshot");
    case "browser_record":
      return at("record");
    case "browser_activate":
      return at("activate");
    case "browser_console":
      return at("console");
    case "browser_network":
    case "browser_network_body":
      return at("network");
    case "browser_evaluate": {
      // The script itself, so the person can see what they are saying yes to.
      const code = String(args.expression ?? "").replace(/\s+/g, " ").trim();
      return { key: "evaluate", vars: { origin, code: code.length > 160 ? `${code.slice(0, 160)}…` : code } };
    }
    case "browser_viewport":
      return at(args.reset ? "viewportReset" : "viewport");
    case "browser_inspect":
      return at("inspect");
    case "browser_audit":
      return at("audit");
    case "browser_performance":
      return at("performance");
    case "browser_reload":
      return at("reload");
    case "browser_mock": {
      const rules = describeRules(args.rules);
      if (rules) return { key: args.clear ? "mockReplace" : "mock", vars: { origin, rules } };
      return at("mockClear");
    }
    default:
      return at("read");
  }
}
