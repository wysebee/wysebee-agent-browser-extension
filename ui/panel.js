// The side panel: pairing with Wysebee, then what is waiting for a yes, and
// the settings (sites, kinds of request, language, theme, and the Wysebee Cloud server:
// the build's own, server.js's, unless a self-hosted one is set here; cloud.js).
//
// It only shows the worker's state (get_state, read every second and a half) and sends
// it messages; every rule is the worker's. Each part is drawn again only when what it
// shows changed, so a field being typed in is not replaced under the person.

import { SITE_MODES } from "../policy.js";
import { checkServer } from "../cloud.js";
import { LANGUAGE_NAMES, THEMES, approvalList, copyButton, el, fill, send, t, toSiteUrl, useBrowserLanguage, useLanguage, useTheme } from "./shared.js";

/** Kinds of request, grouped as the settings show them (policy.js's BLOCKABLE). */
const REQUEST_KINDS = [
  { group: "reading", ops: ["browser_tabs", "browser_snapshot", "browser_screenshot", "browser_record", "browser_bookmarks"] },
  {
    group: "acting",
    ops: ["browser_click", "browser_type", "browser_scroll", "browser_drag", "browser_mouse", "native_input"],
  },
  { group: "tabs", ops: ["browser_navigate", "browser_open_tab", "browser_close_tab", "browser_activate"] },
  {
    // Offered only to an agent given "Web development tools" in Wysebee.
    group: "devtools",
    ops: [
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
    ],
  },
];

// The Agent tab holds this browser's agent (General: pairing, the Enabled switch, Unpair)
// and what it may do (Sites, Permissions, Server), as sub tabs.
const TABS = ["agent", "language", "theme"];
const SUBTABS = ["general", "sites", "requests", "server"];

/** The tab last shown; one saved before the Agent tab (sites, requests, server) opens as
 * Agent. The Agent tab always opens on General. */
function savedTab() {
  const tab = localStorage.getItem("tab");
  return TABS.includes(tab) ? tab : "agent";
}

const $ = (id) => document.getElementById(id);

let state = null;
// What only this page knows.
const ui = {
  tab: savedTab(),
  sub: "general",
  busy: false,
  pairError: "",
  nameDraft: "",
  siteError: "",
  siteMode: "auto",
  confirmUnpair: false,
  // The Server tab: what is typed, why it was refused, and the server waiting for the
  // person's yes to unpair (a pairing belongs to its server).
  serverDraft: null,
  serverError: "",
  confirmServer: "",
};
// When the code runs out, by this page's clock.
let deadline = 0;
/** What each part last drew, so it is drawn again only on a change. */
const drawn = {};

function draw(part, key, render) {
  const text = JSON.stringify(key);
  if (drawn[part] === text) return;
  drawn[part] = text;
  render();
}

async function refresh() {
  const next = await send({ type: "get_state" });
  const down = $("worker-down");
  if (!next || !next.link) {
    await useBrowserLanguage();
    down.hidden = false;
    down.textContent = t("common.workerDown");
    return;
  }
  down.hidden = true;
  state = next;
  useTheme(state.theme);
  if (await useLanguage(state.language)) for (const part of Object.keys(drawn)) delete drawn[part];
  if (state.link.phase === "pending") deadline = Date.now() + state.link.expiresIn * 1000;
  render();
}

function render() {
  if (!state) return;
  const { link } = state;
  $("version").textContent = state.version;
  // "Wysebee Agent" or "Wysebee Agent Local" (scripts/build.mjs).
  $("name").textContent = chrome.runtime.getManifest().name;

  draw("link", [{ ...link, expiresIn: 0 }, state.connected, state.enabled, state.server, ui.busy, ui.pairError, ui.confirmUnpair], renderLink);
  tick();

  const paired = link.phase === "paired";

  $("approvals").hidden = state.approvals.length === 0;
  draw("approvals", state.approvals, () => {
    fill($("approvals"),
      el("h2", { text: t("waiting") }),
      ...approvalList(state.approvals, async (id, decision) => {
        await send({ type: "answer", id, decision });
        await refresh();
      }),
    );
  });

  draw("tabs", [ui.tab, ui.sub], renderTabs);
  const agent = ui.tab === "agent";
  const general = agent && ui.sub === "general";
  $("subtabs").hidden = !agent;
  $("link").hidden = !general;
  $("tab-body").hidden = general;
  if (general) {
    // The link card, drawn above.
  } else if (agent && ui.sub === "sites") {
    draw("body", ["sites", state.sites, ui.siteError], renderSites);
  } else if (agent && ui.sub === "requests") {
    draw("body", ["requests", state.blocked, state.bookmarksAllowed, state.uploadRecordings], renderRequests);
  } else if (agent) {
    draw("body", ["server", state.server, state.defaultServer, link.phase, ui.serverError, ui.confirmServer], renderServer);
  } else if (ui.tab === "language") {
    draw("body", ["language", state.languageOverride, state.browserLanguage], renderLanguage);
  } else {
    draw("body", ["theme", state.theme], renderTheme);
  }
}

// --- the link: pairing, or the agent this browser belongs to -------------------------

/** Unpair, under the paired agent: asked twice. */
function unpairCard(link) {
  return el(
    "div",
    { class: "stack unpair" },
    el("p", { class: "muted small", text: t("unpair.hint") }),
    ui.confirmUnpair
      ? [
          el("p", { role: "alert", text: t("unpair.confirm", { label: link.agent.label || link.agent.name }) }),
          el(
            "div",
            { class: "row" },
            el("button", {
              class: "btn danger solid",
              type: "button",
              text: t("unpair.yes"),
              onclick: async () => {
                ui.confirmUnpair = false;
                await send({ type: "unpair" });
                await refresh();
              },
            }),
            el("button", {
              class: "btn",
              type: "button",
              text: t("unpair.cancel"),
              onclick: () => {
                ui.confirmUnpair = false;
                render();
              },
            }),
          ),
        ]
      : el(
          "div",
          { class: "row" },
          el("button", {
            class: "btn danger",
            type: "button",
            text: t("unpair.button"),
            onclick: () => {
              ui.confirmUnpair = true;
              render();
            },
          }),
        ),
  );
}

/** The Enabled switch: off, Wysebee can no longer use this browser and nothing polls, but it
 * stays paired — switched back on, it carries on as the same agent. */
function enabledSwitch() {
  return el(
    "label",
    { class: "switch-row enabled" },
    el(
      "span",
      { class: "grow" },
      el("span", { class: "strong", text: t("link.enabled") }),
      el("span", { class: "muted small block", text: t(state.enabled ? "link.enabledHint" : "link.disabledHint") }),
    ),
    el("input", {
      type: "checkbox",
      class: "switch",
      role: "switch",
      checked: state.enabled,
      disabled: ui.busy,
      "aria-label": t("link.enabled"),
      onchange: async (e) => {
        ui.busy = true;
        render();
        await send({ type: "set_enabled", enabled: e.target.checked });
        ui.busy = false;
        await refresh();
      },
    }),
  );
}

function renderLink() {
  const { link } = state;
  const box = $("link");
  if (link.phase === "paired") {
    fill(box,
      el("p", { class: "muted small", text: t("link.agent") }),
      el("p", { class: "agent-label", text: link.agent.label || link.agent.name }),
      el("p", { class: "muted", text: `@${link.agent.name}` }),
      state.server !== state.defaultServer ? el("p", { class: "muted small", text: t("link.server", { server: state.server }) }) : null,
      el(
        "p",
        { class: `status ${state.enabled && state.connected ? "on" : "off"}`, role: "status" },
        el("span", { class: "dot", "aria-hidden": "true" }),
        t(!state.enabled ? "link.turnedOff" : state.connected ? "link.connected" : "link.reconnecting"),
      ),
      enabledSwitch(),
      unpairCard(link),
    );
    return;
  }
  if (link.phase === "pending") {
    fill(box,
      el("p", { class: "muted", text: t("pair.codeFor", { name: link.name }) }),
      // The code as shown (XXXX-XXXX): Wysebee takes it with or without the dash.
      el(
        "div",
        { class: "code-row" },
        el("p", { class: "code", "aria-live": "polite", text: link.code }),
        copyButton(link.code, t("pair.copy"), t("pair.copied")),
      ),
      el("p", { text: t("pair.codeHelp") }),
      el("p", { id: "countdown", class: "muted small" }),
      el("div", { class: "row" }, el("button", { class: "btn", text: t("pair.cancel"), onclick: cancelPairing })),
    );
    return;
  }
  if (link.phase === "refused" || link.phase === "expired") {
    const why =
      link.phase === "expired"
        ? t("pair.expired")
        : t(`pair.refused.${["name_taken", "reserved", "too_many", "invalid_name"].includes(link.reason) ? link.reason : "other"}`);
    ui.nameDraft = ui.nameDraft || link.name || "";
    fill(box,
      el("p", { class: "notice warn", role: "alert", text: why }),
      link.name ? el("p", { class: "muted", text: t("pair.codeFor", { name: link.name }) }) : null,
      el("div", { class: "row" }, el("button", { class: "btn primary", text: t("pair.tryAnother"), onclick: cancelPairing })),
    );
    return;
  }
  // Not paired: the agent's name, and Pair.
  const input = el("input", {
    id: "agent-name",
    type: "text",
    maxlength: "60",
    autocomplete: "off",
    placeholder: t("pair.namePlaceholder"),
    value: ui.nameDraft,
    disabled: ui.busy,
    oninput: (e) => {
      ui.nameDraft = e.target.value;
    },
  });
  fill(box,
    link.notice === "unpaired" ? el("p", { class: "notice", text: t("pair.unpairedNotice") }) : null,
    el("p", { text: t("pair.intro") }),
    el("p", { class: "muted small", text: t("pair.server", { server: state.server }) }),
    el(
      "form",
      {
        class: "stack",
        onsubmit: (e) => {
          e.preventDefault();
          void pair(input.value);
        },
      },
      el("label", { for: "agent-name", class: "label", text: t("pair.nameLabel") }),
      input,
      ui.pairError ? el("p", { class: "error small", role: "alert", text: ui.pairError }) : null,
      el(
        "div",
        { class: "row" },
        el("button", { class: "btn primary", type: "submit", disabled: ui.busy, text: t(ui.busy ? "pair.starting" : "pair.pair") }),
      ),
    ),
  );
}

/** The countdown under the code, by this page's clock. */
function tick() {
  const node = $("countdown");
  if (!node || state?.link.phase !== "pending") return;
  const left = Math.max(Math.ceil((deadline - Date.now()) / 1000), 0);
  const time = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  node.textContent = t("pair.expiresIn", { time });
}

async function pair(typed) {
  const name = String(typed ?? "").trim();
  if (!name || [...name].length > 60) {
    ui.pairError = t("pair.nameInvalid");
    render();
    return;
  }
  ui.busy = true;
  ui.pairError = "";
  render();
  const res = await send({ type: "pair", name });
  ui.busy = false;
  if (!res) ui.pairError = t("common.workerDown");
  else if (res.ok) ui.nameDraft = "";
  else if (res.error === "invalid_name") ui.pairError = t("pair.nameInvalid");
  else if (res.error === "unreachable") ui.pairError = t("pair.failed", { server: res.server || state.server });
  await refresh();
  render();
}

async function cancelPairing() {
  await send({ type: "cancel_pairing" });
  ui.pairError = "";
  await refresh();
  document.getElementById("agent-name")?.focus();
}

// --- settings ----------------------------------------------------------------------

function tabButton(kind, tab, selected, choose) {
  return el("button", {
    type: "button",
    role: "tab",
    class: `${kind}${selected ? " selected" : ""}`,
    "aria-selected": selected ? "true" : "false",
    text: t(`settings.tabs.${tab}`),
    onclick: () => {
      choose();
      ui.confirmUnpair = false;
      render();
    },
  });
}

function renderTabs() {
  fill($("tabs"),
    ...TABS.map((tab) =>
      tabButton("tab", tab, tab === ui.tab, () => {
        ui.tab = tab;
        ui.sub = "general";
        localStorage.setItem("tab", tab);
      }),
    ),
  );
  fill($("subtabs"),
    ...SUBTABS.map((sub) =>
      tabButton("subtab", sub, sub === ui.sub, () => {
        ui.sub = sub;
      }),
    ),
  );
}

function modeSelect(value, label, onchange) {
  return el(
    "select",
    { "aria-label": label, onchange },
    ...SITE_MODES.map((m) => el("option", { value: m, selected: m === value, text: t(`settings.sites.modes.${m}.label`) })),
  );
}

function renderSites() {
  const entries = Object.entries(state.sites)
    .filter(([, mode]) => SITE_MODES.includes(mode))
    .sort(([a], [b]) => a.localeCompare(b));
  const input = el("input", {
    type: "text",
    class: "grow",
    placeholder: t("settings.sites.placeholder"),
    "aria-label": t("settings.sites.siteAria"),
  });
  const hint = el("p", {
    class: ui.siteError ? "error small" : "muted small",
    text: ui.siteError || t(`settings.sites.modes.${ui.siteMode}.hint`),
  });
  const add = async (e) => {
    e.preventDefault();
    const origin = toSiteUrl(input.value);
    if (!origin) {
      ui.siteError = t("settings.sites.invalid");
      hint.className = "error small";
      hint.textContent = ui.siteError;
      return;
    }
    const res = await send({ type: "set_site", origin, mode: ui.siteMode });
    ui.siteError = res?.ok ? "" : t("settings.sites.saveFailed");
    delete drawn.body;
    await refresh();
  };
  fill($("tab-body"),
    el("p", { class: "muted small", text: t("settings.sites.intro") }),
    el(
      "form",
      { class: "card stack", onsubmit: add },
      el(
        "div",
        { class: "row" },
        input,
        modeSelect(ui.siteMode, t("settings.sites.newLevelAria"), (e) => {
          ui.siteMode = e.target.value;
          if (!ui.siteError) hint.textContent = t(`settings.sites.modes.${ui.siteMode}.hint`);
        }),
        el("button", { class: "btn primary", type: "submit", text: t("settings.sites.add") }),
      ),
      hint,
    ),
    entries.length === 0
      ? el("p", { class: "muted", text: t("settings.sites.none") })
      : el(
          "ul",
          { class: "card list" },
          ...entries.map(([origin, mode]) =>
            el(
              "li",
              { class: "row" },
              el("span", { class: "grow origin", text: origin, title: origin }),
              modeSelect(mode, t("settings.sites.levelFor", { origin }), async (e) => {
                await send({ type: "set_site", origin, mode: e.target.value });
                await refresh();
              }),
              el("button", {
                class: "btn danger",
                type: "button",
                text: t("settings.sites.remove"),
                "aria-label": t("settings.sites.removeOrigin", { origin }),
                onclick: async () => {
                  await send({ type: "forget", origin });
                  await refresh();
                },
              }),
            ),
          ),
        ),
  );
}

function renderRequests() {
  const blocked = new Set(state.blocked);
  const toggle = async (op, block) => {
    const next = new Set(blocked);
    if (block) next.add(op);
    else next.delete(op);
    await send({ type: "set_blocked", blocked: [...next].sort() });
    await refresh();
  };
  fill($("tab-body"),
    el("p", { class: "muted small", text: t("settings.requests.intro") }),
    ...REQUEST_KINDS.flatMap((g) => [
      el("h2", { text: t(`settings.requests.groups.${g.group}`) }),
      el(
        "ul",
        { class: "card list" },
        ...g.ops.map((op) => {
          const label = t(`settings.requests.kinds.${op}.label`);
          const isBlocked = blocked.has(op);
          return el(
            "li",
            {},
            el(
              "label",
              { class: "switch-row" },
              el(
                "span",
                { class: "grow" },
                el("span", { class: isBlocked ? "struck" : "strong", text: label }),
                el("span", { class: "muted small block", text: t(`settings.requests.kinds.${op}.hint`) }),
              ),
              el("span", { class: isBlocked ? "error small" : "muted small", text: t(isBlocked ? "settings.requests.blocked" : "settings.requests.allowed") }),
              el("input", {
                type: "checkbox",
                class: "switch",
                role: "switch",
                // On = allowed; off = blocked on every site.
                checked: !isBlocked,
                "aria-label": t("settings.requests.blockAria", { label }),
                onchange: (e) => void toggle(op, !e.target.checked),
              }),
            ),
            // Bookmarks belong to no site, so no site's level covers them: the one way to
            // stop the prompt is this machine-wide switch (policy.js).
            op === "browser_bookmarks" && !isBlocked
              ? el(
                  "label",
                  { class: "check-row small" },
                  el("input", {
                    type: "checkbox",
                    checked: !!state.bookmarksAllowed,
                    "aria-label": t("settings.requests.bookmarksAllowAria"),
                    onchange: async (e) => {
                      await send({ type: "set_bookmarks_allowed", allowed: e.target.checked });
                      await refresh();
                    },
                  }),
                  el("span", { text: t("settings.requests.bookmarksAllow") }),
                )
              : null,
            // A video can show anything on the tab, so it stays in Downloads unless the
            // person ticks this (off by default; video.js's uploadBlocked).
            op === "browser_record" && !isBlocked
              ? el(
                  "label",
                  { class: "check-row small" },
                  el("input", {
                    type: "checkbox",
                    checked: !!state.uploadRecordings,
                    "aria-label": t("settings.requests.recordUploadAria"),
                    onchange: async (e) => {
                      await send({ type: "set_upload_recordings", on: e.target.checked });
                      await refresh();
                    },
                  }),
                  el("span", { text: t("settings.requests.recordUpload") }),
                )
              : null,
          );
        }),
      ),
    ]),
  );
}

/**
 * The Wysebee Cloud this browser pairs with: the default, or a self-hosted one. Changing it
 * while a pairing is under way or made asks first, since that pairing is the old server's.
 */
function renderServer() {
  const linked = state.link.phase === "pending" || state.link.phase === "paired";
  const isDefault = state.server === state.defaultServer;
  const input = el("input", {
    id: "server",
    type: "text",
    class: "grow",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: t("settings.server.placeholder"),
    value: ui.serverDraft ?? state.server,
    oninput: (e) => {
      ui.serverDraft = e.target.value;
    },
  });
  const save = async (typed, unpair = false) => {
    const res = await send({ type: "set_cloud_server", server: typed, unpair });
    if (res?.ok) {
      ui.serverDraft = null;
      ui.serverError = "";
      ui.confirmServer = "";
    } else if (res?.error === "linked") {
      // "" is the default: the question names it.
      ui.confirmServer = typed || state.defaultServer;
    } else {
      ui.serverError = t(res?.error === "invalid" ? "settings.server.invalid" : "settings.server.saveFailed");
    }
    delete drawn.body;
    await refresh();
  };
  const submit = (e) => {
    e.preventDefault();
    const server = checkServer(input.value);
    ui.serverDraft = input.value;
    ui.confirmServer = "";
    if (!server) {
      ui.serverError = t("settings.server.invalid");
      delete drawn.body;
      render();
      return;
    }
    ui.serverError = "";
    void save(server);
  };
  fill($("tab-body"),
    el("p", { class: "muted small", text: t("settings.server.intro") }),
    el(
      "form",
      { class: "card stack", onsubmit: submit },
      el("label", { for: "server", class: "label", text: t("settings.server.label") }),
      el("div", { class: "row" }, input, el("button", { class: "btn primary", type: "submit", text: t("settings.server.save") })),
      el("p", {
        class: ui.serverError ? "error small" : "muted small",
        role: ui.serverError ? "alert" : null,
        text: ui.serverError || t("settings.server.hint"),
      }),
      ui.confirmServer && linked
        ? [
            el("p", { role: "alert", text: t("settings.server.confirm", { server: ui.confirmServer }) }),
            el(
              "div",
              { class: "row" },
              el("button", {
                class: "btn danger solid",
                type: "button",
                text: t("settings.server.confirmYes"),
                onclick: () => void save(ui.confirmServer === state.defaultServer ? "" : ui.confirmServer, true),
              }),
              el("button", {
                class: "btn",
                type: "button",
                text: t("settings.server.cancel"),
                onclick: () => {
                  ui.confirmServer = "";
                  ui.serverDraft = null;
                  delete drawn.body;
                  render();
                },
              }),
            ),
          ]
        : null,
      isDefault
        ? el("p", { class: "muted small", text: t("settings.server.isDefault") })
        : el(
            "div",
            { class: "row" },
            el("button", {
              class: "btn",
              type: "button",
              text: t("settings.server.useDefault", { server: state.defaultServer }),
              onclick: () => {
                ui.serverDraft = null;
                ui.serverError = "";
                void save("");
              },
            }),
          ),
    ),
  );
}

function renderLanguage() {
  const browser = LANGUAGE_NAMES.find((l) => l.code === state.browserLanguage)?.name ?? "English";
  fill($("tab-body"),
    el(
      "div",
      { class: "card stack" },
      el("label", { for: "language", class: "label", text: t("settings.language.label") }),
      el(
        "select",
        {
          id: "language",
          onchange: async (e) => {
            await send({ type: "set_language", language: e.target.value });
            await refresh();
          },
        },
        el("option", { value: "", selected: !state.languageOverride, text: t("settings.language.followBrowser", { name: browser }) }),
        ...LANGUAGE_NAMES.map((l) => el("option", { value: l.code, selected: l.code === state.languageOverride, text: l.name })),
      ),
      el("p", { class: "muted small", text: t("settings.language.hint") }),
    ),
  );
}

function renderTheme() {
  fill($("tab-body"),
    el(
      "div",
      { class: "card stack" },
      el("label", { for: "theme", class: "label", text: t("settings.theme.label") }),
      el(
        "select",
        {
          id: "theme",
          onchange: async (e) => {
            useTheme(e.target.value);
            await send({ type: "set_theme", theme: e.target.value });
            await refresh();
          },
        },
        ...THEMES.map((theme) =>
          el("option", { value: theme, selected: theme === (state.theme || ""), text: t(`settings.theme.${theme || "system"}`) }),
        ),
      ),
      el("p", { class: "muted small", text: t("settings.theme.hint") }),
    ),
  );
}

void refresh();
setInterval(() => void refresh(), 1500);
setInterval(tick, 1000);
