// Every language has English's keys and each message's placeholders, and every key the
// code asks for exists.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { LANGUAGES } from "./lang.js";
import { BLOCKABLE, SITE_MODES, summary } from "./policy.js";

const read = (code) => JSON.parse(fs.readFileSync(new URL(`./locales/${code}.json`, import.meta.url), "utf8"));

/** Dotted key -> message, for every string in the table. */
function flatten(node, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") flatten(value, path, out);
    else out[path] = value;
  }
  return out;
}

const placeholders = (message) => [...String(message).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

const en = flatten(read("en"));

test("there is a file for every language, and no other", () => {
  const files = fs.readdirSync(new URL("./locales/", import.meta.url)).filter((f) => f.endsWith(".json")).sort();
  assert.deepEqual(files, LANGUAGES.map((l) => `${l}.json`).sort());
});

for (const code of LANGUAGES.filter((l) => l !== "en")) {
  test(`${code} has English's keys and placeholders`, () => {
    const other = flatten(read(code));
    assert.deepEqual(Object.keys(other).sort(), Object.keys(en).sort());
    for (const [key, message] of Object.entries(other)) {
      assert.equal(typeof message, "string", key);
      assert.ok(message.trim(), `${code} ${key} is empty`);
      assert.deepEqual(placeholders(message), placeholders(en[key]), `${code} ${key}`);
    }
  });
}

test("every message is a non-empty string", () => {
  for (const [key, message] of Object.entries(en)) {
    assert.equal(typeof message, "string", key);
    assert.ok(message.trim(), key);
  }
});

test("every key the worker and the pages ask for exists", () => {
  const used = new Set();
  for (const file of ["background.js", "ui/panel.js", "ui/approval.js", "ui/shared.js"]) {
    const source = fs.readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    for (const m of source.matchAll(/\b(?:t|tr)\(\s*"([\w.]+)"/g)) used.add(m[1]);
    // t(cond ? "a.b" : "c.d")
    for (const m of source.matchAll(/\bt\([^()"`]*\?\s*"([\w.]+)"\s*:\s*"([\w.]+)"/g)) {
      used.add(m[1]);
      used.add(m[2]);
    }
  }
  assert.ok(used.size > 30, "the scan found the keys");
  for (const key of used) assert.ok(key in en, `no English for ${key}`);
});

test("the keys built at run time exist", () => {
  for (const op of BLOCKABLE) {
    assert.ok(`settings.requests.kinds.${op}.label` in en, op);
    assert.ok(`settings.requests.kinds.${op}.hint` in en, op);
    assert.ok(`approval.summary.${summary(op, "https://example.com", {}).key}` in en, op);
  }
  for (const mode of SITE_MODES) {
    assert.ok(`settings.sites.modes.${mode}.label` in en);
    assert.ok(`settings.sites.modes.${mode}.hint` in en);
  }
  for (const group of ["reading", "acting", "tabs", "devtools"]) assert.ok(`settings.requests.groups.${group}` in en);
  for (const tab of ["agent", "general", "sites", "requests", "language", "theme", "server"]) assert.ok(`settings.tabs.${tab}` in en);
  for (const reason of ["name_taken", "reserved", "too_many", "invalid_name", "other"]) assert.ok(`pair.refused.${reason}` in en);
});
