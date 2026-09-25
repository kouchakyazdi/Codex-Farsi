import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { parseHTML } from "linkedom";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APP = join(ROOT, "public", "app.js");
const INDEX = join(ROOT, "public", "index.html");
const ICON = join(ROOT, "public", "icon.svg");
const STYLES = join(ROOT, "public", "styles.css");

class FakeEventSource {
  static latest = null;

  constructor() {
    this.listeners = new Map();
    FakeEventSource.latest = this;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    this.listeners.clear();
    if (FakeEventSource.latest === this) FakeEventSource.latest = null;
  }

  emit(type, data) {
    for (const listener of this.listeners.get(type) || []) {
      listener({ data: JSON.stringify(data) });
    }
  }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

function installHistory(window, initialUrl) {
  const entries = [{ state: null, url: new URL(initialUrl) }];
  let index = 0;
  const location = {};
  Object.defineProperty(location, "href", {
    configurable: true,
    get: () => entries[index].url.href,
  });

  function dispatchPopState() {
    const event = new window.Event("popstate");
    Object.defineProperty(event, "state", {
      configurable: true,
      value: entries[index].state,
    });
    window.dispatchEvent(event);
  }

  const history = {
    back() {
      if (index === 0) return;
      index -= 1;
      dispatchPopState();
    },
    forward() {
      if (index >= entries.length - 1) return;
      index += 1;
      dispatchPopState();
    },
    get length() {
      return entries.length;
    },
    pushState(state, _unused, value) {
      entries.splice(index + 1);
      entries.push({
        state: structuredClone(state),
        url: new URL(value, entries[index].url),
      });
      index = entries.length - 1;
    },
    replaceState(state, _unused, value) {
      entries[index] = {
        state: structuredClone(state),
        url: new URL(value, entries[index].url),
      };
    },
    get state() {
      return entries[index].state;
    },
  };
  Object.defineProperties(window, {
    history: { configurable: true, value: history },
    location: { configurable: true, value: location },
  });
  return history;
}

function installSelectValue(window) {
  Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
    configurable: true,
    get() {
      const options = [...this.querySelectorAll("option")];
      if (options.some((option) => option.value === this.__testValue)) {
        return this.__testValue;
      }
      return options[0]?.value || "";
    },
    set(value) {
      const normalized = String(value);
      this.__testValue = [...this.querySelectorAll("option")].some(
        (option) => option.value === normalized,
      )
        ? normalized
        : "";
    },
  });
}

function installDialogs(window) {
  for (const dialog of window.document.querySelectorAll("dialog")) {
    Object.defineProperty(dialog, "open", {
      configurable: true,
      get() {
        return this.hasAttribute("open");
      },
    });
    dialog.showModal = function showModal() {
      this.setAttribute("open", "");
    };
    dialog.close = function close() {
      if (!this.open) return;
      this.removeAttribute("open");
      this.dispatchEvent(new window.Event("close"));
    };
  }
}

async function createHarness(t, {
  fetchHandler,
  initialUrl = "http://localhost/",
  savedSettings = null,
}) {
  const html = await readFile(INDEX, "utf8");
  const { window } = parseHTML(html);
  const values = new Map();
  if (savedSettings) {
    values.set("codex-web-settings", JSON.stringify(savedSettings));
  }
  Object.defineProperties(window, {
    cancelAnimationFrame: {
      configurable: true,
      value: clearTimeout,
    },
    close: {
      configurable: true,
      value() {},
    },
    localStorage: {
      configurable: true,
      value: {
        getItem(key) {
          return values.get(key) ?? null;
        },
        removeItem(key) {
          values.delete(key);
        },
        setItem(key, value) {
          values.set(key, String(value));
        },
      },
    },
    requestAnimationFrame: {
      configurable: true,
      value(callback) {
        return setTimeout(() => callback(performance.now()), 0);
      },
    },
  });
  installSelectValue(window);
  installDialogs(window);
  const history = installHistory(window, initialUrl);
  window.HTMLElement.prototype.scrollTo = function scrollTo(options = {}) {
    if (typeof options.top === "number") this.scrollTop = options.top;
  };
  if (!window.HTMLTextAreaElement.prototype.setSelectionRange) {
    window.HTMLTextAreaElement.prototype.setSelectionRange =
      function setSelectionRange(start, end) {
        Object.defineProperties(this, {
          selectionEnd: {
            configurable: true,
            value: end,
            writable: true,
          },
          selectionStart: {
            configurable: true,
            value: start,
            writable: true,
          },
        });
      };
  }

  const nativeSetTimeout = globalThis.setTimeout;
  const globals = {
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    crypto: { randomUUID },
    document: window.document,
    EventSource: FakeEventSource,
    fetch: fetchHandler,
    localStorage: window.localStorage,
    navigator: window.navigator,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    setTimeout(callback, delay = 0, ...args) {
      return nativeSetTimeout(callback, delay >= 4_000 ? 0 : delay, ...args);
    },
    window,
  };
  const originals = new Map(
    Object.keys(globals).map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value,
      writable: true,
    });
  }
  t.after(() => {
    FakeEventSource.latest?.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    window.close();
  });

  await import(`${pathToFileURL(APP).href}?frontend-routing=${randomUUID()}`);
  return { history, values, window };
}

function typePrompt(window, value) {
  const prompt = window.document.querySelector("#prompt");
  prompt.value = value;
  prompt.dispatchEvent(new window.Event("input", { bubbles: true }));
  return prompt;
}

test(
  "deep links hydrate independently and use readiness of the opened thread provider",
  { concurrency: false },
  async (t) => {
    const now = Math.floor(Date.now() / 1000);
    const thread = {
      id: "codex-deep-link",
      name: "Codex deep link",
      cwd: "/workspace",
      createdAt: now,
      updatedAt: now,
      status: { type: "idle" },
      turns: [],
    };
    let resolveClaudeModels;
    let claudeModelsResolved = false;
    const requests = [];
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") {
        return jsonResponse({
          cwd: "/workspace",
          providers: {
            claude: { message: "Claude unavailable", ready: false },
            codex: { ready: true },
          },
          ready: true,
        });
      }
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      requests.push(request);
      if (request.method === "model/list" && request.params.provider === "claude") {
        return new Promise((resolve) => {
          resolveClaudeModels = () => {
            claudeModelsResolved = true;
            resolve(jsonResponse({ result: { data: [] } }));
          };
        });
      }
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: [thread], nextCursor: null } });
      }
      if (request.method === "thread/resume") {
        return jsonResponse({ result: { thread, cwd: thread.cwd } });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { history, window } = await createHarness(t, {
      fetchHandler,
      initialUrl:
        "http://localhost/?view=compact&thread=codex-deep-link#latest-message",
      savedSettings: {
        cwd: "/workspace",
        modelByProvider: { claude: "", codex: "" },
        provider: "claude",
        version: 4,
      },
    });

    await waitFor(
      () => window.document.querySelector("#thread-title").textContent === "Codex deep link",
      "deep-linked Codex thread waited for the unavailable default Claude provider",
    );
    assert.equal(claudeModelsResolved, false);
    assert.equal(
      requests.some(
        (request) =>
          request.method === "thread/resume" &&
          request.params.threadId === "codex-deep-link",
      ),
      true,
    );
    const canonicalUrl = new URL(window.location.href);
    assert.equal(canonicalUrl.searchParams.get("session"), "codex-deep-link");
    assert.equal(canonicalUrl.searchParams.get("thread"), null);
    assert.equal(canonicalUrl.searchParams.get("view"), "compact");
    assert.equal(canonicalUrl.hash, "#latest-message");
    assert.equal(history.length, 1);
    assert.equal(
      window.document.querySelector("#connection-label").textContent,
      "Codex متصل است",
    );

    FakeEventSource.latest.emit("status", {
      provider: "claude",
      ready: false,
      message: "Claude still unavailable",
    });
    assert.equal(
      window.document.querySelector("#connection-label").textContent,
      "Codex متصل است",
    );
    FakeEventSource.latest.emit("status", {
      ready: false,
      message: "Codex stopped",
    });
    assert.equal(
      window.document.querySelector("#connection-label").textContent,
      "Codex stopped",
    );
    resolveClaudeModels();
    await waitFor(() => claudeModelsResolved, "pending Claude model request did not settle");
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "session takes precedence over a legacy thread parameter and canonicalization preserves the URL",
  { concurrency: false },
  async (t) => {
    const now = Math.floor(Date.now() / 1000);
    const threads = new Map(
      [
        ["preferred-session", "Preferred session"],
        ["legacy-thread", "Legacy thread"],
      ].map(([id, name]) => [
        id,
        {
          id,
          name,
          cwd: "/workspace",
          createdAt: now,
          updatedAt: now,
          status: { type: "idle" },
          turns: [],
        },
      ]),
    );
    const resumed = [];
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") {
        return jsonResponse({
          cwd: "/workspace",
          providers: {
            claude: { ready: true },
            codex: { ready: true },
          },
          ready: true,
        });
      }
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      if (request.method === "model/list") {
        return jsonResponse({ result: { data: [] } });
      }
      if (request.method === "thread/list") {
        return jsonResponse({
          result: { data: [...threads.values()], nextCursor: null },
        });
      }
      if (request.method === "thread/resume") {
        resumed.push(request.params.threadId);
        const thread = threads.get(request.params.threadId);
        return jsonResponse({ result: { thread, cwd: thread.cwd } });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { history, window } = await createHarness(t, {
      fetchHandler,
      initialUrl:
        "http://localhost/?thread=legacy-thread&filter=active&session=preferred-session#turn",
    });

    await waitFor(
      () =>
        window.document.querySelector("#thread-title").textContent ===
        "Preferred session",
      "the canonical session parameter did not take precedence",
    );
    assert.deepEqual(resumed, ["preferred-session"]);
    const canonicalUrl = new URL(window.location.href);
    assert.equal(canonicalUrl.searchParams.get("session"), "preferred-session");
    assert.equal(canonicalUrl.searchParams.get("thread"), null);
    assert.equal(canonicalUrl.searchParams.get("filter"), "active");
    assert.equal(canonicalUrl.hash, "#turn");
    assert.equal(history.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "new sessions replace their draft URL and Back/Forward restore the matching draft",
  { concurrency: false },
  async (t) => {
    const now = Math.floor(Date.now() / 1000);
    const oldSummary = {
      id: "old-thread",
      name: "Old thread",
      cwd: "/workspace",
      createdAt: now,
      updatedAt: now,
      status: { type: "idle" },
    };
    const newThread = {
      ...oldSummary,
      id: "new-thread",
      name: "New thread",
      turns: [],
    };
    const threadStarts = [];
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") {
        return jsonResponse({
          cwd: "/workspace",
          providers: {
            claude: { ready: true },
            codex: { ready: true },
          },
          ready: true,
        });
      }
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const { method, params } = JSON.parse(options.body);
      if (method === "model/list") return jsonResponse({ result: { data: [] } });
      if (method === "thread/list") {
        return jsonResponse({ result: { data: [oldSummary], nextCursor: null } });
      }
      if (method === "thread/resume") {
        return jsonResponse({
          result: { thread: { ...oldSummary, turns: [] }, cwd: "/workspace" },
        });
      }
      if (method === "thread/start") {
        threadStarts.push(params);
        return jsonResponse({ result: { thread: newThread, cwd: "/workspace" } });
      }
      if (method === "turn/start") {
        return jsonResponse({
          result: {
            turn: { id: "new-turn", items: [], status: "inProgress" },
          },
        });
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    };

    const { history, window } = await createHarness(t, {
      fetchHandler,
      initialUrl: "http://localhost/?layout=wide#composer",
    });
    await waitFor(
      () => typeof history.state?.draftId === "string",
      "initial draft history state was not installed",
    );
    const draftId = history.state.draftId;
    const prompt = typePrompt(window, "پیش‌نویس حفظ‌شونده");

    await waitFor(
      () => window.document.querySelector("[data-thread-id='old-thread']"),
      "old thread was not listed",
    );
    window.document.querySelector("[data-thread-id='old-thread']").click();
    await waitFor(
      () => new URL(window.location.href).searchParams.get("session") === "old-thread",
      "opening an existing session did not push its URL",
    );
    history.back();
    await waitFor(
      () =>
        new URL(window.location.href).searchParams.get("session") === null &&
        prompt.value === "پیش‌نویس حفظ‌شونده",
      "browser Back did not restore the draft belonging to its history entry",
    );
    assert.equal(history.state.draftId, draftId);
    history.forward();
    await waitFor(
      () =>
        new URL(window.location.href).searchParams.get("session") === "old-thread" &&
        window.document.querySelector("#thread-title").textContent === "Old thread",
      "browser Forward did not restore the existing session",
    );
    history.back();
    await waitFor(
      () =>
        new URL(window.location.href).searchParams.get("session") === null &&
        prompt.value === "پیش‌نویس حفظ‌شونده",
      "browser Back did not restore the draft after a Forward navigation",
    );

    window.document.querySelector("#send-message").click();
    await waitFor(
      () => new URL(window.location.href).searchParams.get("session") === "new-thread",
      "the first message did not replace the draft URL with the created session",
    );
    assert.deepEqual(history.state, { threadId: "new-thread" });
    const finalUrl = new URL(window.location.href);
    assert.equal(finalUrl.searchParams.get("thread"), null);
    assert.equal(finalUrl.searchParams.get("layout"), "wide");
    assert.equal(finalUrl.hash, "#composer");
    assert.match(
      threadStarts[0].developerInstructions,
      /use a compact Markdown table by default/,
    );
  },
);

test(
  "popstate and SSE hydration share one resume flight and keep the newest history target",
  { concurrency: false },
  async (t) => {
    const now = Math.floor(Date.now() / 1000);
    const threads = new Map(
      ["race-a", "race-b"].map((id) => [
        id,
        {
          id,
          name: id === "race-a" ? "Race A" : "Race B",
          cwd: "/workspace",
          createdAt: now,
          updatedAt: now,
          status: { type: "idle" },
          turns: [],
        },
      ]),
    );
    const resumeCounts = new Map();
    const resumeResolvers = new Map();
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") {
        return jsonResponse({
          cwd: "/workspace",
          providers: {
            claude: { ready: true },
            codex: { ready: true },
          },
          ready: true,
        });
      }
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      if (request.method === "model/list") return jsonResponse({ result: { data: [] } });
      if (request.method === "thread/list") {
        return jsonResponse({
          result: { data: [...threads.values()], nextCursor: null },
        });
      }
      if (request.method === "thread/resume") {
        const threadId = request.params.threadId;
        resumeCounts.set(threadId, (resumeCounts.get(threadId) || 0) + 1);
        return new Promise((resolve) => {
          resumeResolvers.set(threadId, () =>
            resolve(
              jsonResponse({
                result: { thread: threads.get(threadId), cwd: "/workspace" },
              }),
            ),
          );
        });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { history, window } = await createHarness(t, { fetchHandler });
    await waitFor(
      () => typeof history.state?.draftId === "string",
      "initial hydration did not finish",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    function navigateTo(threadId) {
      history.pushState({ threadId }, "", `/?session=${threadId}`);
      const event = new window.Event("popstate");
      Object.defineProperty(event, "state", {
        configurable: true,
        value: { threadId },
      });
      window.dispatchEvent(event);
    }

    navigateTo("race-a");
    await waitFor(
      () => resumeCounts.get("race-a") === 1,
      "first popstate did not start its resume",
    );
    FakeEventSource.latest.emit("status", {
      message: "Codex status refreshed",
      provider: "codex",
      ready: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(resumeCounts.get("race-a"), 1);

    navigateTo("race-b");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(resumeCounts.get("race-b") || 0, 0);
    resumeResolvers.get("race-a")();
    await waitFor(
      () => resumeCounts.get("race-b") === 1,
      "latest popstate target was not resumed after the stale request settled",
    );
    resumeResolvers.get("race-b")();
    await waitFor(
      () => window.document.querySelector("#thread-title").textContent === "Race B",
      "stale hydration won over the newest history target",
    );
    assert.equal(resumeCounts.get("race-a"), 1);
    assert.equal(resumeCounts.get("race-b"), 1);
    assert.equal(
      new URL(window.location.href).searchParams.get("session"),
      "race-b",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test("plan step text can shrink and wrap unbroken paths on narrow viewports", async () => {
  const [app, styles] = await Promise.all([
    readFile(APP, "utf8"),
    readFile(STYLES, "utf8"),
  ]);
  assert.match(app, /text\.className = "plan-step-text"/);
  const rule = styles.match(/\.plan-step-text\s*\{(?<body>[^}]*)\}/)?.groups?.body || "";
  assert.match(rule, /min-width:\s*0/);
  assert.match(rule, /flex:\s*1 1 auto/);
  assert.match(rule, /overflow-wrap:\s*anywhere/);
});

test("conversation typography keeps ChatGPT-like readable dimensions and black canvas", async () => {
  const styles = await readFile(STYLES, "utf8");
  const root = styles.match(/:root\s*\{(?<body>[^}]*)\}/)?.groups?.body || "";
  const page = styles.match(/html,\s*body\s*\{(?<body>[^}]*)\}/)?.groups?.body || "";
  const assistant =
    styles.match(/\.assistant \.message-content\s*\{(?<body>[^}]*)\}/)?.groups?.body || "";
  const messages = styles.match(/\.messages\s*\{(?<body>[^}]*)\}/)?.groups?.body || "";
  const composer = styles.match(/\.composer\s*\{(?<body>[^}]*)\}/)?.groups?.body || "";
  const headings =
    styles.match(
      /\.message-content h1,\s*\.message-content h2,\s*\.message-content h3\s*\{(?<body>[^}]*)\}/,
    )?.groups?.body || "";
  const listMarker =
    styles.match(/\.message-content li::marker\s*\{(?<body>[^}]*)\}/)?.groups?.body || "";

  assert.match(root, /--bg:\s*#000(?:000)?/);
  assert.match(root, /--panel:\s*#0d0d0d/);
  assert.match(root, /--text:\s*#ececec/);
  assert.match(page, /font-size:\s*16px/);
  assert.match(page, /line-height:\s*1\.75/);
  assert.match(assistant, /font-size:\s*1rem/);
  assert.match(assistant, /line-height:\s*1\.625/);
  assert.match(messages, /width:\s*min\(48rem,/);
  assert.match(composer, /width:\s*min\(48rem,/);
  assert.match(headings, /font-weight:\s*600/);
  assert.match(headings, /text-wrap:\s*pretty/);
  assert.match(listMarker, /color:\s*var\(--muted-2\)/);
  assert.doesNotMatch(listMarker, /accent|danger|warning/);
});

test(
  "sidebar toggle stays simple, accessible, and persistent",
  { concurrency: false },
  async (t) => {
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const { method } = JSON.parse(options.body);
      if (method === "model/list" || method === "collaborationMode/list") {
        return jsonResponse({ result: { data: [] } });
      }
      if (method === "thread/list") {
        return jsonResponse({ result: { data: [], nextCursor: null } });
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    };

    const { values, window } = await createHarness(t, {
      fetchHandler,
      savedSettings: {
        cwd: "/workspace",
        modelByProvider: { codex: "", claude: "" },
        palette: "cyan",
        provider: "codex",
        sidebarCollapsed: true,
        version: 5,
      },
    });
    const { document } = window;
    const menu = document.querySelector("#menu-button");
    const close = document.querySelector("#sidebar-close");
    const sidebar = document.querySelector("#sidebar");

    assert.equal(document.body.classList.contains("sidebar-collapsed"), true);
    assert.equal(sidebar.getAttribute("aria-hidden"), "true");
    assert.equal(sidebar.hasAttribute("inert"), true);
    assert.equal(menu.getAttribute("aria-expanded"), "false");
    assert.equal(document.querySelectorAll(".sidebar-toggle-icon").length, 2);

    menu.click();
    assert.equal(document.body.classList.contains("sidebar-collapsed"), false);
    assert.equal(sidebar.getAttribute("aria-hidden"), "false");
    assert.equal(sidebar.hasAttribute("inert"), false);
    assert.equal(menu.getAttribute("aria-expanded"), "true");
    assert.equal(JSON.parse(values.get("codex-web-settings")).sidebarCollapsed, false);

    document.querySelector("#new-chat").click();
    assert.equal(document.body.classList.contains("sidebar-collapsed"), false);

    close.click();
    assert.equal(document.body.classList.contains("sidebar-collapsed"), true);
    assert.equal(sidebar.getAttribute("aria-hidden"), "true");
    assert.equal(JSON.parse(values.get("codex-web-settings")).sidebarCollapsed, true);
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test("favicon and in-app marks share a palette-aware terminal logo", async () => {
  const [index, icon, styles] = await Promise.all([
    readFile(INDEX, "utf8"),
    readFile(ICON, "utf8"),
    readFile(STYLES, "utf8"),
  ]);

  assert.match(index, /rel="icon" href="\/icon\.svg\?v=2"[^>]+sizes="any"/);
  assert.equal((index.match(/class="brand-logo"/g) || []).length, 2);
  assert.match(icon, /id="neon"/);
  assert.match(icon, /#42e8ff/);
  assert.match(icon, /#9b6dff/);
  assert.doesNotMatch(icon, /#d8ff6b/);
  assert.match(styles, /\.brand-logo\s*\{[^}]*stroke:\s*currentcolor/s);
});

test("composer uses a neon palette frame and neutral ChatGPT-like stop control", async () => {
  const [index, styles] = await Promise.all([
    readFile(INDEX, "utf8"),
    readFile(STYLES, "utf8"),
  ]);
  const composer = styles.match(/\.composer\s*\{(?<body>[^}]*)\}/)?.groups?.body || "";
  const stop =
    [...styles.matchAll(/\.stop-button\s*\{(?<body>[^}]*)\}/g)]
      .map((match) => match.groups?.body || "")
      .find((rule) => /background:/.test(rule)) || "";
  const placeholder =
    styles.match(/\.composer textarea:placeholder-shown\s*\{(?<body>[^}]*)\}/)?.groups?.body || "";

  // The composer chip picks the project now; settings stays in the topbar.
  assert.match(index, /class="context-chip-icon" data-icon="project"/);
  assert.match(index, /id="project-chip"[^>]*aria-haspopup="listbox"/);
  assert.doesNotMatch(index, /data-icon="settings"/);
  assert.match(index, /id="stop-turn"[^>]*>[\s\S]*?<rect[^>]+rx="1\.5"/);
  assert.match(index, /id="composer-tools"[^>]*>[\s\S]*?<path d="M12 5v14M5 12h14"/);
  assert.match(index, /<strong>Goal mode<\/strong>/);
  assert.match(index, /<strong>Plan mode<\/strong>/);
  assert.equal((index.match(/class="composer-tool-option-description"/g) || []).length, 2);
  assert.doesNotMatch(index, /id="record-voice"|id="voice-recorder"/);
  assert.match(
    styles,
    /\.composer-tool-option-description\s*\{[^}]*white-space:\s*nowrap/s,
  );
  assert.match(composer, /linear-gradient\(var\(--panel-3\), var\(--panel-3\)\) padding-box/);
  assert.match(composer, /rgb\(var\(--accent-rgb\) \/ 0\.58\)/);
  assert.match(composer, /rgb\(var\(--violet-rgb\) \/ 0\.46\)/);
  assert.match(stop, /color:\s*var\(--bg\)/);
  assert.match(stop, /background:\s*var\(--text\)/);
  assert.match(stop, /border-radius:\s*50%/);
  assert.doesNotMatch(stop, /danger|warning|#4b1728/);
  assert.match(placeholder, /direction:\s*rtl/);
  assert.match(placeholder, /text-align:\s*right/);
});

test("composer accepts files and exposes a clear drag-and-drop state", async () => {
  const [index, styles] = await Promise.all([
    readFile(INDEX, "utf8"),
    readFile(STYLES, "utf8"),
  ]);

  assert.match(index, /id="image-input"[\s\S]*?type="file"[\s\S]*?multiple/);
  assert.doesNotMatch(index, /id="image-input"[^>]*accept=/);
  assert.match(index, /aria-label="افزودن فایل یا تصویر"/);
  assert.match(index, /id="composer-drop-overlay"[\s\S]*?فایل‌ها را اینجا رها کنید/);
  assert.match(styles, /\.composer-drop-overlay\s*\{[^}]*position:\s*absolute/s);
  assert.match(styles, /\.composer\.drop-active\s*\{[^}]*--accent-rgb/s);
});

test("grid lists constrain their track so long titles ellipsize", async () => {
  const styles = await readFile(STYLES, "utf8");
  // A grid item's automatic minimum size is its content, so without this the
  // row grows past the sidebar and the list clips the title instead.
  for (const selector of [".thread-pinned", ".project-switcher-options"]) {
    const rule = styles.match(
      new RegExp(`\\${selector}\\s*\\{(?<body>[^}]*)\\}`),
    )?.groups?.body;
    assert.ok(rule, `${selector} rule is missing`);
    assert.match(rule, /display:\s*grid/);
    assert.match(
      rule,
      /grid-template-columns:\s*minmax\(0, 1fr\)/,
      `${selector} must allow its track to shrink`,
    );
  }
});

test("failed technical activity chips stay visually neutral", async () => {
  const styles = await readFile(STYLES, "utf8");
  const failedSummary =
    styles.match(/\.activity-card\.failed summary\s*\{(?<body>[^}]*)\}/)?.groups?.body || "";
  const failedIcon =
    styles.match(/\.activity-card\.failed summary::before\s*\{(?<body>[^}]*)\}/)?.groups?.body || "";

  assert.match(failedSummary, /color:\s*var\(--muted\)/);
  assert.match(failedSummary, /background:\s*var\(--panel-2\)/);
  assert.doesNotMatch(failedSummary, /--danger/);
  assert.match(failedIcon, /color:\s*var\(--muted-2\)/);
  assert.match(failedIcon, /content:\s*"›"/);
});

test(
  "cancelling a provider switch restores model options and provider-specific safety UI",
  { concurrency: false },
  async (t) => {
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") {
        return jsonResponse({
          cwd: "/workspace",
          providers: {
            claude: { ready: true },
            codex: { ready: true },
          },
          ready: true,
        });
      }
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: [], nextCursor: null } });
      }
      if (request.method === "model/list") {
        const data =
          request.params.provider === "claude"
            ? [{ displayName: "Claude Sonnet", id: "sonnet", model: "sonnet" }]
            : [{ displayName: "Codex Test", id: "codex-test", model: "codex-test" }];
        return jsonResponse({ result: { data } });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { window } = await createHarness(t, {
      fetchHandler,
      savedSettings: {
        cwd: "/workspace",
        effort: "ultra",
        modelByProvider: { claude: "sonnet", codex: "codex-test" },
        provider: "codex",
        version: 4,
      },
    });
    const document = window.document;
    await waitFor(
      () => document.querySelector("#model-select option[value='codex-test']"),
      "Codex models were not loaded",
    );
    document.querySelector("#open-settings").click();

    const provider = document.querySelector("#provider-select");
    provider.value = "claude";
    provider.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(
      () => document.querySelector("#model-select option[value='sonnet']"),
      "Claude models were not loaded after switching provider",
    );
    assert.equal(document.querySelector("#settings-dialog").dataset.provider, "claude");
    assert.equal(document.querySelector("#default-model-option").textContent, "پیش‌فرض Claude");
    assert.equal(document.querySelector("#effort-select option[value='ultra']").disabled, true);
    assert.equal(document.querySelector("#effort-select option[value='ultra']").hidden, true);

    const permission = document.querySelector("#claude-permission-mode");
    permission.value = "bypassPermissions";
    permission.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.equal(document.querySelector("#full-access-warning").classList.contains("visible"), true);
    const sandbox = document.querySelector("#sandbox-select");
    sandbox.value = "workspace-write";
    sandbox.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.equal(document.querySelector("#full-access-warning").classList.contains("visible"), true);

    document.querySelector("#settings-cancel").click();
    document.querySelector("#open-settings").click();
    assert.equal(provider.value, "codex");
    assert.ok(document.querySelector("#model-select option[value='codex-test']"));
    assert.equal(document.querySelector("#model-select option[value='sonnet']"), null);
    assert.equal(document.querySelector("#default-model-option").textContent, "پیش‌فرض Codex");
    assert.equal(document.querySelector("#effort-select option[value='ultra']").disabled, false);
    assert.equal(document.querySelector("#effort-select option[value='ultra']").hidden, false);
  },
);

test(
  "Claude conversations expose the provider-backed commands and run them over RPC",
  { concurrency: false },
  async (t) => {
    const now = Math.floor(Date.now() / 1000);
    const thread = {
      id: "claude:slash-thread",
      provider: "claude",
      name: "Claude slash",
      cwd: "/workspace",
      createdAt: now,
      updatedAt: now,
      status: { type: "idle" },
      turns: [],
    };
    const requests = [];
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") {
        return jsonResponse({
          cwd: "/workspace",
          providers: {
            claude: { ready: true },
            codex: { ready: true },
          },
          ready: true,
        });
      }
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      requests.push(request);
      if (request.method === "model/list") return jsonResponse({ result: { data: [] } });
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: [thread], nextCursor: null } });
      }
      if (request.method === "thread/resume") {
        return jsonResponse({ result: { thread, cwd: thread.cwd, tokenUsage: null } });
      }
      if (request.method === "thread/goal/get") {
        return jsonResponse({ result: { goal: null } });
      }
      if (request.method === "account/rateLimits/read") {
        return jsonResponse({ result: { rateLimitsByLimitId: {} } });
      }
      if (request.method === "thread/compact/start") {
        return jsonResponse({ result: {} });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { window } = await createHarness(t, {
      fetchHandler,
      initialUrl: "http://localhost/?session=claude%3Aslash-thread",
    });
    await waitFor(
      () => window.document.querySelector("#thread-title").textContent === "Claude slash",
      "Claude thread was not hydrated",
    );
    typePrompt(window, "/");
    assert.deepEqual(
      [
        ...window.document.querySelectorAll(
          "#slash-command-options [data-slash-command]",
        ),
      ].map((option) => option.dataset.slashCommand),
      [
        "goal",
        "plan",
        "compact",
        "new",
        "resume",
        "status",
        "usage",
        "model",
        "permissions",
      ],
    );

    const prompt = typePrompt(window, "/compact");
    assert.equal(window.document.querySelector("#send-message").disabled, false);
    const enter = new window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperties(enter, {
      isComposing: { configurable: true, value: false },
      key: { configurable: true, value: "Enter" },
      shiftKey: { configurable: true, value: false },
    });
    prompt.dispatchEvent(enter);
    await waitFor(
      () =>
        requests.some((request) => request.method === "thread/compact/start") &&
        prompt.value === "",
      "Claude compact was not requested",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "Plan mode sends Claude turns with the plan permission mode",
  { concurrency: false },
  async (t) => {
    const now = Math.floor(Date.now() / 1000);
    const thread = {
      id: "claude:plan-thread",
      provider: "claude",
      name: "Claude plan",
      cwd: "/workspace",
      createdAt: now,
      updatedAt: now,
      status: { type: "idle" },
      turns: [],
    };
    const starts = [];
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") {
        return jsonResponse({
          cwd: "/workspace",
          providers: { claude: { ready: true }, codex: { ready: true } },
          ready: true,
        });
      }
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      if (request.method === "model/list") return jsonResponse({ result: { data: [] } });
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: [thread], nextCursor: null } });
      }
      if (request.method === "thread/resume") {
        return jsonResponse({ result: { thread, cwd: thread.cwd, tokenUsage: null } });
      }
      if (request.method === "thread/goal/get") {
        return jsonResponse({ result: { goal: null } });
      }
      if (request.method === "turn/start") {
        starts.push(request.params);
        return jsonResponse({
          result: { turn: { id: "turn-plan", status: "inProgress", items: [] } },
        });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { window } = await createHarness(t, {
      fetchHandler,
      initialUrl: "http://localhost/?session=claude%3Aplan-thread",
    });
    await waitFor(
      () => window.document.querySelector("#thread-title").textContent === "Claude plan",
      "Claude thread was not hydrated",
    );

    const planOption = window.document.querySelector("#plan-mode-option");
    assert.equal(planOption.disabled, false);
    planOption.click();
    assert.equal(planOption.getAttribute("aria-checked"), "true");

    const prompt = typePrompt(window, "سلام");
    const enter = new window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperties(enter, {
      isComposing: { configurable: true, value: false },
      key: { configurable: true, value: "Enter" },
      shiftKey: { configurable: true, value: false },
    });
    prompt.dispatchEvent(enter);
    await waitFor(() => starts.length === 1, "Claude turn was not started");
    assert.equal(starts[0].permissionMode, "plan");
    assert.equal(starts[0].collaborationMode, undefined);
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "busy conversations queue, edit, remove, and automatically send prompts in order",
  { concurrency: false },
  async (t) => {
    const now = Math.floor(Date.now() / 1000);
    const thread = {
      id: "queue-thread",
      name: "Queue test",
      cwd: "/workspace",
      createdAt: now,
      updatedAt: now,
      status: { type: "idle" },
      turns: [],
    };
    const starts = [];
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      if (request.method === "model/list") return jsonResponse({ result: { data: [] } });
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: [thread], nextCursor: null } });
      }
      if (request.method === "thread/resume") {
        return jsonResponse({ result: { thread, cwd: thread.cwd } });
      }
      if (request.method === "turn/start") {
        starts.push(request.params);
        return jsonResponse({
          result: {
            turn: {
              id: `queue-turn-${starts.length}`,
              status: "inProgress",
              items: [],
              error: null,
            },
          },
        });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { window } = await createHarness(t, {
      fetchHandler,
      initialUrl: "http://localhost/?session=queue-thread",
    });
    const document = window.document;
    await waitFor(
      () => document.querySelector("#thread-title").textContent === "Queue test",
      "queue thread was not hydrated",
    );

    typePrompt(window, "پیام اول");
    document.querySelector("#send-message").click();
    await waitFor(() => starts.length === 1, "first prompt was not started");

    typePrompt(window, "پیام دوم با تصویر /tmp/reference.png");
    document.querySelector("#send-message").click();
    typePrompt(window, "پیام سوم");
    document.querySelector("#send-message").click();
    assert.equal(document.querySelectorAll(".prompt-queue-item").length, 2);
    assert.equal(document.querySelector("#prompt").value, "");
    assert.equal(document.querySelector("#send-message").title, "افزودن به صف");

    document
      .querySelector(".prompt-queue-item [data-queue-action='edit']")
      .click();
    assert.match(document.querySelector("#prompt").value, /reference\.png/);
    document.querySelector("#prompt").value += " ویرایش‌شده";
    document.querySelector("#prompt").dispatchEvent(new window.Event("input", { bubbles: true }));
    document.querySelector("#send-message").click();
    assert.equal(document.querySelectorAll(".prompt-queue-item").length, 2);
    document
      .querySelector(".prompt-queue-item [data-queue-action='remove']")
      .click();
    assert.equal(document.querySelectorAll(".prompt-queue-item").length, 1);

    FakeEventSource.latest.emit("rpc", {
      method: "turn/completed",
      params: {
        threadId: thread.id,
        turn: { id: "queue-turn-1", status: "completed", items: [], error: null },
      },
    });
    await waitFor(() => starts.length === 2, "queued prompt did not start automatically");
    assert.equal(starts[1].input[0].text, "پیام دوم با تصویر /tmp/reference.png ویرایش‌شده");
    assert.equal(document.querySelectorAll(".prompt-queue-item").length, 0);
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "assistant actions quote responses and palette previews revert or persist correctly",
  { concurrency: false },
  async (t) => {
    const now = Math.floor(Date.now() / 1000);
    const thread = {
      id: "actions-thread",
      name: "Actions test",
      cwd: "/workspace",
      createdAt: now,
      updatedAt: now,
      status: { type: "idle" },
      turns: [
        {
          id: "actions-turn",
          status: "completed",
          items: [
            {
              id: "assistant-actions",
              type: "agentMessage",
              text: "## عنوان\n\n- مورد اول\n- مورد دوم",
            },
          ],
        },
      ],
    };
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      if (request.method === "model/list") return jsonResponse({ result: { data: [] } });
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: [thread], nextCursor: null } });
      }
      if (request.method === "thread/resume") {
        return jsonResponse({ result: { thread, cwd: thread.cwd } });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { values, window } = await createHarness(t, {
      fetchHandler,
      initialUrl: "http://localhost/?session=actions-thread",
      savedSettings: {
        cwd: "/workspace",
        modelByProvider: { codex: "", claude: "" },
        palette: "red",
        provider: "codex",
        version: 5,
      },
    });
    const document = window.document;
    await waitFor(
      () => document.querySelector("[data-item-id='assistant-actions']"),
      "assistant action response was not rendered",
    );
    let copied = "";
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText(value) {
          copied = value;
        },
      },
    });
    const copy = document.querySelector(
      "[data-item-id='assistant-actions'] [data-message-action='copy']",
    );
    assert.equal(copy.title, "کپی Markdown");
    copy.click();
    await waitFor(() => copied, "Markdown response was not copied");
    assert.equal(copied, "## عنوان\n\n- مورد اول\n- مورد دوم");
    document
      .querySelector("[data-item-id='assistant-actions'] [data-message-action='quote']")
      .click();
    assert.equal(
      document.querySelector("#prompt").value,
      "> ## عنوان\n> \n> - مورد اول\n> - مورد دوم\n\n",
    );

    assert.equal(document.documentElement.dataset.palette, "red");
    document.querySelector("#open-settings").click();
    const purple = document.querySelector("input[name='accent-palette'][value='purple']");
    purple.checked = true;
    purple.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.equal(document.documentElement.dataset.palette, "purple");
    document.querySelector("#settings-cancel").click();
    assert.equal(document.documentElement.dataset.palette, "red");

    document.querySelector("#open-settings").click();
    const green = document.querySelector("input[name='accent-palette'][value='green']");
    green.checked = true;
    green.dispatchEvent(new window.Event("change", { bubbles: true }));
    document.querySelector("#save-settings").click();
    assert.equal(document.documentElement.dataset.palette, "green");
    assert.equal(JSON.parse(values.get("codex-web-settings")).palette, "green");
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "Plan and Goal modes use native Codex RPC fields and expose goal controls",
  { concurrency: false },
  async (t) => {
    const requests = [];
    const turns = [];
    let objective = "";
    let goalStatus = "active";
    const thread = {
      id: "mode-thread",
      name: "Mode test",
      cwd: "/workspace",
      provider: "codex",
      status: { type: "idle" },
      turns: [],
    };
    const goal = () => ({
      createdAt: 1,
      objective,
      status: goalStatus,
      threadId: thread.id,
      timeUsedSeconds: 0,
      tokenBudget: null,
      tokensUsed: 0,
      updatedAt: 1,
    });
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      requests.push(request);
      if (request.method === "model/list") {
        return jsonResponse({
          result: {
            data: [{ id: "gpt-test", model: "gpt-test", displayName: "GPT Test", isDefault: true }],
          },
        });
      }
      if (request.method === "collaborationMode/list") {
        return jsonResponse({
          result: { data: [{ name: "Plan", mode: "plan", reasoning_effort: "medium" }] },
        });
      }
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: [], nextCursor: null } });
      }
      if (request.method === "thread/start") return jsonResponse({ result: { thread } });
      if (request.method === "thread/goal/get") {
        return jsonResponse({ result: { goal: objective ? goal() : null } });
      }
      if (request.method === "thread/goal/set") {
        if (request.params.objective) objective = request.params.objective;
        if (request.params.status) goalStatus = request.params.status;
        return jsonResponse({ result: { goal: goal() } });
      }
      if (request.method === "thread/goal/clear") {
        objective = "";
        return jsonResponse({ result: { cleared: true } });
      }
      if (request.method === "thread/settings/update") {
        return jsonResponse({ result: {} });
      }
      if (request.method === "turn/start") {
        turns.push(request.params);
        return jsonResponse({
          result: {
            turn: {
              id: `mode-turn-${turns.length}`,
              status: "inProgress",
              items: [],
              error: null,
            },
          },
        });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { window } = await createHarness(t, {
      fetchHandler,
      savedSettings: {
        cwd: "/workspace",
        modelByProvider: { codex: "", claude: "" },
        palette: "cyan",
        provider: "codex",
        version: 5,
      },
    });
    const document = window.document;
    await waitFor(
      () => requests.some((request) => request.method === "collaborationMode/list"),
      "collaboration modes were not loaded",
    );

    document.querySelector("#composer-tools").click();
    document.querySelector("#plan-mode-option").click();
    assert.equal(document.querySelector("#plan-mode-option").getAttribute("aria-checked"), "true");
    assert.match(document.querySelector("#composer-tools").getAttribute("aria-label"), /Plan mode/);

    document.querySelector("#composer-tools").click();
    document.querySelector("#goal-mode-option").click();
    assert.equal(document.querySelector("#goal-dialog").open, true);
    document.querySelector("#goal-input").value = "همهٔ تست‌ها را سبز کن";
    document
      .querySelector("#goal-form")
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    assert.equal(document.querySelector("#prompt").value, "همهٔ تست‌ها را سبز کن");
    assert.equal(document.querySelector("#goal-progress").classList.contains("hidden"), false);

    document.querySelector("#goal-edit").click();
    document.querySelector("#goal-input").value = "تمام تست‌ها را سبز کن";
    document
      .querySelector("#goal-form")
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    assert.equal(document.querySelector("#prompt").value, "تمام تست‌ها را سبز کن");

    document.querySelector("#send-message").click();
    await waitFor(() => turns.length === 1, "Plan turn was not started");
    assert.equal(turns[0].input[0].text, "تمام تست‌ها را سبز کن");
    assert.deepEqual(turns[0].collaborationMode, {
      mode: "plan",
      settings: {
        developer_instructions: null,
        model: "gpt-test",
        reasoning_effort: "medium",
      },
    });
    assert.equal(turns[0].developerInstructions, undefined);
    const threadStart = requests.find((request) => request.method === "thread/start");
    assert.equal(threadStart.params.developerInstructions, undefined);
    const methods = requests.map((request) => request.method);
    assert.equal(methods.indexOf("thread/goal/set") < methods.indexOf("turn/start"), true);

    FakeEventSource.latest.emit("rpc", {
      method: "turn/completed",
      params: {
        threadId: thread.id,
        turn: {
          id: "mode-turn-1",
          status: "completed",
          items: [],
          error: null,
        },
      },
    });
    document.querySelector("#composer-tools").click();
    document.querySelector("#plan-mode-option").click();
    await waitFor(
      () =>
        requests.some(
          (request) =>
            request.method === "thread/settings/update" &&
            request.params.collaborationMode?.mode === "default",
        ),
      "Plan mode was not cleared from the thread",
    );
    assert.equal(document.querySelector("#plan-mode-option").getAttribute("aria-checked"), "false");

    FakeEventSource.latest.emit("rpc", {
      method: "thread/settings/updated",
      params: {
        threadId: thread.id,
        threadSettings: {
          collaborationMode: {
            mode: "plan",
            settings: {
              developer_instructions: null,
              model: "gpt-test",
              reasoning_effort: "medium",
            },
          },
        },
      },
    });
    assert.equal(document.querySelector("#plan-mode-option").getAttribute("aria-checked"), "true");
    FakeEventSource.latest.emit("rpc", {
      method: "thread/settings/updated",
      params: {
        threadId: thread.id,
        threadSettings: { collaborationMode: null },
      },
    });
    assert.equal(document.querySelector("#plan-mode-option").getAttribute("aria-checked"), "false");

    typePrompt(window, "حالا اجرا کن");
    document.querySelector("#send-message").click();
    await waitFor(() => turns.length === 2, "Default turn was not started");
    assert.equal(turns[1].collaborationMode.mode, "default");
    assert.match(turns[1].developerInstructions, /clear, polished visual hierarchy/);

    document.querySelector("#goal-toggle").click();
    await waitFor(
      () => document.querySelector("#goal-progress").dataset.status === "paused",
      "Goal was not paused",
    );
    assert.equal(document.querySelector("#goal-progress").dataset.status, "paused");

    document.querySelector("#goal-clear").click();
    await waitFor(
      () => document.querySelector("#goal-progress").classList.contains("hidden"),
      "Goal was not cleared",
    );
    assert.equal(document.querySelector("#goal-progress").classList.contains("hidden"), true);
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "Dictation inserts editable Persian speech into the composer",
  { concurrency: false },
  async (t) => {
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      if (request.method === "model/list") return jsonResponse({ result: { data: [] } });
      if (request.method === "collaborationMode/list") return jsonResponse({ result: { data: [] } });
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: [], nextCursor: null } });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };
    const { window } = await createHarness(t, { fetchHandler });
    class FakeSpeechRecognition {
      static latest = null;
      constructor() {
        FakeSpeechRecognition.latest = this;
      }
      start() {}
      stop() {
        this.onend?.();
      }
    }
    window.SpeechRecognition = FakeSpeechRecognition;
    const document = window.document;
    typePrompt(window, "مقدمه");
    document.querySelector("#dictate").click();
    assert.equal(document.querySelector("#dictate").classList.contains("active"), true);
    const result = [{ transcript: "این متن با صدا نوشته شد" }];
    result.isFinal = true;
    FakeSpeechRecognition.latest.onresult({ results: [result] });
    assert.equal(
      document.querySelector("#prompt").value,
      "مقدمه این متن با صدا نوشته شد",
    );
    document.querySelector("#dictate").click();
    assert.equal(document.querySelector("#dictate").classList.contains("active"), false);
    assert.equal(document.querySelector("#record-voice"), null);
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    document.querySelector("#dictate").click();
    FakeSpeechRecognition.latest.onerror({ error: "not-allowed" });
    assert.match(document.querySelector("#toasts .toast").textContent, /Gboard/);
    document.querySelector("#dictate").click();
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "projects create focused chats with shared cwd and instructions",
  { concurrency: false },
  async (t) => {
    const projects = [];
    const rpcRequests = [];
    const assignments = [];
    const now = Math.floor(Date.now() / 1000);
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
      if (path === "/api/projects" && (!options.method || options.method === "GET")) {
        return jsonResponse({ projects, threadProjects: {} });
      }
      if (path === "/api/projects" && options.method === "POST") {
        const body = JSON.parse(options.body);
        const project = { id: "project-1", ...body, createdAt: Date.now(), updatedAt: Date.now() };
        projects.push(project);
        return jsonResponse({ project }, 201);
      }
      if (path === "/api/project-threads") {
        assignments.push(JSON.parse(options.body));
        return jsonResponse(assignments.at(-1));
      }
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      rpcRequests.push(request);
      if (request.method === "model/list") return jsonResponse({ result: { data: [] } });
      if (request.method === "collaborationMode/list") {
        return jsonResponse({ result: { data: [] } });
      }
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: [], nextCursor: null } });
      }
      if (request.method === "thread/start") {
        return jsonResponse({
          result: {
            thread: {
              id: "project-thread",
              cwd: request.params.cwd,
              createdAt: now,
              updatedAt: now,
              status: { type: "idle" },
              turns: [],
            },
            cwd: request.params.cwd,
          },
        });
      }
      if (request.method === "turn/start") {
        return jsonResponse({ result: { turn: { id: "turn-project", status: "inProgress" } } });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { window } = await createHarness(t, { fetchHandler });
    const document = window.document;
    document.querySelector("#project-add").click();
    assert.equal(document.querySelector("#project-dialog").open, true);
    document.querySelector("#project-name").value = "وب‌اپ";
    document.querySelector("#project-cwd").value = "/workspace/web-app";
    document.querySelector("#project-instructions").value = "قبل از پایان تست‌ها را اجرا کن.";
    document
      .querySelector("#project-form")
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

    await waitFor(
      () => document.querySelector("[data-project-id='project-1']")?.classList.contains("active"),
      "new project was not selected",
    );
    assert.match(document.querySelector("#welcome-title").textContent, /وب‌اپ/);
    // The composer chip now names the project and keeps the folder in its title.
    assert.equal(document.querySelector("#project-chip-label").textContent, "وب‌اپ");
    assert.match(document.querySelector("#project-chip").title, /\/workspace\/web-app/);

    typePrompt(window, "پروژه را بررسی کن");
    document.querySelector("#send-message").click();
    await waitFor(() => assignments.length === 1, "new thread was not assigned to project");
    await waitFor(
      () => rpcRequests.some((request) => request.method === "turn/start"),
      "project prompt was not sent",
    );
    const start = rpcRequests.find((request) => request.method === "thread/start");
    const turn = rpcRequests.find((request) => request.method === "turn/start");
    assert.equal(start.params.cwd, "/workspace/web-app");
    assert.match(start.params.developerInstructions, /قبل از پایان تست‌ها/);
    assert.match(turn.params.developerInstructions, /قبل از پایان تست‌ها/);
    assert.deepEqual(assignments[0], {
      threadId: "project-thread",
      projectId: "project-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "shared-chat action opens an existing private read-only link",
  { concurrency: false },
  async (t) => {
    const now = Math.floor(Date.now() / 1000);
    const thread = {
      id: "share-thread",
      name: "گفتگوی قابل اشتراک",
      cwd: "/workspace",
      createdAt: now,
      updatedAt: now,
      status: { type: "idle" },
      turns: [],
    };
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
      if (path === "/api/projects") return jsonResponse({ projects: [], threadProjects: {} });
      if (path.startsWith("/api/shares?threadId=")) {
        return jsonResponse({
          share: {
            id: "11111111-1111-4111-8111-111111111111",
            threadId: thread.id,
            updatedAt: Date.now(),
            snapshot: { title: thread.name, messages: [] },
          },
        });
      }
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      if (request.method === "model/list") return jsonResponse({ result: { data: [] } });
      if (request.method === "collaborationMode/list") {
        return jsonResponse({ result: { data: [] } });
      }
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: [thread], nextCursor: null } });
      }
      if (request.method === "thread/resume") {
        return jsonResponse({ result: { thread, cwd: thread.cwd } });
      }
      if (request.method === "thread/goal/get") {
        return jsonResponse({ result: { goal: null } });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { window } = await createHarness(t, {
      fetchHandler,
      initialUrl: "http://localhost/?session=share-thread",
    });
    const document = window.document;
    await waitFor(
      () => document.querySelector("#thread-title").textContent === thread.name,
      "shared thread did not open",
    );
    document.querySelector("#share-chat").click();
    await waitFor(() => document.querySelector("#share-dialog").open, "share dialog did not open");
    assert.equal(
      document.querySelector("#share-link").value,
      "http://localhost/share/11111111-1111-4111-8111-111111111111",
    );
    assert.match(document.querySelector(".share-private-note").textContent, /خصوصی/);
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "usage indicator separates account quota from active context usage",
  { concurrency: false },
  async (t) => {
    const [index, styles] = await Promise.all([
      readFile(INDEX, "utf8"),
      readFile(STYLES, "utf8"),
    ]);
    const usageValueRule =
      styles.match(/\.usage-button bdi\s*\{(?<body>[^}]*)\}/)?.groups?.body || "";
    assert.match(index, /id="usage-percent" dir="rtl"/);
    assert.match(usageValueRule, /font-family:\s*var\(--font\)/);
    assert.doesNotMatch(usageValueRule, /var\(--mono\)/);
    assert.match(usageValueRule, /direction:\s*rtl/);

    const now = Math.floor(Date.now() / 1000);
    const thread = {
      id: "usage-thread",
      name: "Usage thread",
      cwd: "/workspace",
      createdAt: now,
      updatedAt: now,
      status: { type: "idle" },
      turns: [],
    };
    const resetAt = now + 3_600;
    const rateLimits = {
      rateLimits: {
        limitId: "codex",
        planType: "plus",
        primary: { usedPercent: 82, windowDurationMins: 300, resetsAt: resetAt },
        secondary: { usedPercent: 35, windowDurationMins: 10_080, resetsAt: resetAt + 86_400 },
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          planType: "plus",
          primary: { usedPercent: 82, windowDurationMins: 300, resetsAt: resetAt },
          secondary: {
            usedPercent: 35,
            windowDurationMins: 10_080,
            resetsAt: resetAt + 86_400,
          },
          rateLimitReachedType: null,
        },
      },
      rateLimitResetCredits: { availableCount: 1, credits: [] },
    };
    const requests = [];
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
      if (path === "/api/projects") return jsonResponse({ projects: [], threadProjects: {} });
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      requests.push(request);
      if (request.method === "account/rateLimits/read") {
        return jsonResponse({ result: rateLimits });
      }
      if (request.method === "model/list") return jsonResponse({ result: { data: [] } });
      if (request.method === "collaborationMode/list") {
        return jsonResponse({ result: { data: [] } });
      }
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: [thread], nextCursor: null } });
      }
      if (request.method === "thread/resume") {
        return jsonResponse({ result: { thread, cwd: thread.cwd } });
      }
      if (request.method === "thread/goal/get") {
        return jsonResponse({ result: { goal: null } });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { window } = await createHarness(t, {
      fetchHandler,
      initialUrl: "http://localhost/?session=usage-thread",
    });
    const document = window.document;
    await waitFor(
      () => document.querySelector("#thread-title").textContent === thread.name,
      "usage thread did not open",
    );
    await waitFor(
      () => document.querySelector("#usage-percent").textContent.includes("۸۲"),
      "usage percentage did not load",
    );
    assert.equal(document.querySelector("#usage-button").dataset.state, "warning");
    assert.equal(
      requests.some(
        (request) =>
          request.method === "account/rateLimits/read" && request.params.provider === "codex",
      ),
      true,
    );

    document.querySelector("#usage-button").click();
    assert.equal(document.querySelector("#usage-dialog").open, true);
    assert.equal(document.querySelector("#usage-dialog h2").textContent, "مصرف");
    assert.equal(document.querySelector("#usage-button span").textContent, "مصرف");
    assert.match(document.querySelector("#usage-dialog").textContent, /مصرف حساب/);
    assert.match(document.querySelector("#usage-dialog").textContent, /Context گفت‌وگو/);
    assert.match(document.querySelector("#context-usage-tooltip").textContent, /مستقل از محدودیت حساب/);
    assert.match(document.querySelector("#account-usage-tooltip").textContent, /هر بازه جداگانه/);
    assert.match(document.querySelector("#usage-dialog").textContent, /بازهٔ ۵ ساعته/);
    assert.match(document.querySelector("#usage-dialog").textContent, /۸۲٪ استفاده · ۱۸٪ باقی/);
    assert.match(document.querySelector("#usage-dialog").textContent, /بازنشانی رایگان/);
    assert.equal(document.querySelector("#usage-overview").classList.contains("hidden"), true);

    FakeEventSource.latest.emit("rpc", {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: thread.id,
        turnId: "turn-usage",
        tokenUsage: {
          total: { totalTokens: 91_000 },
          last: { totalTokens: 48_000 },
          modelContextWindow: 200_000,
        },
      },
    });
    await waitFor(
      () => document.querySelector("#context-usage-percent").textContent.includes("۲۴"),
      "context usage percentage was not rendered",
    );
    assert.equal(document.querySelector("#context-usage-percent").textContent, "۲۴٪ پر");
    assert.equal(
      document.querySelector("#context-usage-detail").textContent,
      "۴۸٬۰۰۰ مصرف · ۱۵۲٬۰۰۰ باقی · سقف ۲۰۰٬۰۰۰ توکن",
    );
    assert.equal(
      document.querySelector("#context-usage-progress").getAttribute("aria-valuenow"),
      "24",
    );

    FakeEventSource.latest.emit("rpc", {
      method: "account/rateLimits/updated",
      params: {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: resetAt },
          rateLimitReachedType: "rate_limit_reached",
        },
      },
    });
    await waitFor(
      () => document.querySelector("#usage-button").dataset.state === "reached",
      "reached usage state was not rendered",
    );
    assert.match(document.querySelector("#usage-overview").textContent, /سهمیهٔ این بازه تمام/);
    assert.match(document.querySelector("#toasts").textContent, /سهمیهٔ این بازه تمام/);
    assert.match(document.querySelector("#usage-dialog").textContent, /بازهٔ ۱ هفته‌ای/);
    document.querySelector("#usage-close").click();
    assert.equal(document.querySelector("#usage-dialog").open, false);
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "the project switcher groups conversations by folder and browses without starting a chat",
  { concurrency: false },
  async (t) => {
    const now = Math.floor(Date.now() / 1000);
    const rpcRequests = [];
    const threads = [
      {
        id: "api-1",
        name: "رفع باگ احراز هویت",
        cwd: "/workspace/api",
        provider: "codex",
        createdAt: now,
        updatedAt: now,
        status: { type: "idle" },
      },
      {
        id: "api-2",
        name: "اضافه‌کردن ایندکس",
        cwd: "/workspace/api/db",
        provider: "codex",
        createdAt: now,
        updatedAt: now - 60,
        status: { type: "idle" },
      },
      {
        id: "web-1",
        name: "بازطراحی هدر",
        cwd: "/workspace/web",
        provider: "claude",
        createdAt: now,
        updatedAt: now - 120,
        status: { type: "idle" },
      },
    ];
    const projects = [
      { id: "p-api", name: "api", cwd: "/workspace/api", instructions: "" },
      { id: "p-web", name: "web", cwd: "/workspace/web", instructions: "" },
    ];
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
      if (path === "/api/projects") {
        // Nothing is assigned by hand: grouping must come from cwd alone.
        return jsonResponse({ projects, threadProjects: {} });
      }
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      rpcRequests.push(request);
      if (request.method === "model/list") return jsonResponse({ result: { data: [] } });
      if (request.method === "collaborationMode/list") {
        return jsonResponse({ result: { data: [] } });
      }
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: threads, nextCursor: null } });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { window } = await createHarness(t, { fetchHandler });
    const document = window.document;
    const allIds = () =>
      [...document.querySelectorAll("#thread-list [data-thread-id]")].map(
        (item) => item.dataset.threadId,
      );
    const listedIds = () =>
      [...document.querySelectorAll("#thread-list [data-thread-id]")]
        .filter((item) => !item.closest(".thread-pinned"))
        .map((item) => item.dataset.threadId);
    const pinnedIds = () =>
      [...document.querySelectorAll(".thread-pinned [data-thread-id]")].map(
        (item) => item.dataset.threadId,
      );

    await waitFor(() => allIds().length === 3, "threads were not listed");
    // With no project selected every conversation is already listed below.
    assert.deepEqual(pinnedIds(), []);

    // The switcher counts conversations per project using cwd matching.
    const apiOption = document.querySelector("[data-project-id='p-api']");
    assert.equal(apiOption.querySelector(".project-item-count").textContent, "۲");
    assert.equal(
      document.querySelector("[data-project-id='p-web'] .project-item-count").textContent,
      "۱",
    );

    apiOption.click();
    await waitFor(
      () => listedIds().length === 2,
      "selecting a project did not filter the conversation list",
    );
    // A nested folder still belongs to its closest parent project.
    assert.deepEqual(listedIds(), ["api-1", "api-2"]);
    // The other project's conversation stays reachable from the board above.
    assert.deepEqual(pinnedIds(), ["web-1"]);
    assert.equal(document.querySelector("#project-switcher-name").textContent.trim(), "api");

    // Browsing a project must not create a conversation.
    assert.equal(
      rpcRequests.some((request) => request.method === "thread/start"),
      false,
      "switching projects should not start a chat",
    );

    document.querySelector("[data-project-id='p-web']").click();
    await waitFor(
      () => listedIds().join() === "web-1",
      "switching to the other project did not update the list",
    );

    document.querySelector("[data-project-id='']").click();
    await waitFor(() => listedIds().length === 3, "«همهٔ گفتگوها» did not clear the filter");
    assert.deepEqual(pinnedIds(), [], "nothing should be pinned when everything is listed");
    assert.equal(
      rpcRequests.some((request) => request.method === "thread/start"),
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "an explicit project assignment overrides folder matching",
  { concurrency: false },
  async (t) => {
    const now = Math.floor(Date.now() / 1000);
    const threads = [
      {
        id: "pinned",
        name: "گفتگوی منتسب",
        cwd: "/workspace/api",
        provider: "codex",
        createdAt: now,
        updatedAt: now,
        status: { type: "idle" },
      },
    ];
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
      if (path === "/api/projects") {
        return jsonResponse({
          projects: [
            { id: "p-api", name: "api", cwd: "/workspace/api", instructions: "" },
            { id: "p-web", name: "web", cwd: "/workspace/web", instructions: "" },
          ],
          threadProjects: { pinned: "p-web" },
        });
      }
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      if (request.method === "model/list") return jsonResponse({ result: { data: [] } });
      if (request.method === "collaborationMode/list") {
        return jsonResponse({ result: { data: [] } });
      }
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: threads, nextCursor: null } });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { window } = await createHarness(t, { fetchHandler });
    const document = window.document;
    const listedIds = () =>
      [...document.querySelectorAll("#thread-list [data-thread-id]")]
        .filter((item) => !item.closest(".thread-pinned"))
        .map((item) => item.dataset.threadId);

    await waitFor(() => listedIds().length === 1, "thread was not listed");
    await waitFor(
      () =>
        document.querySelector("[data-project-id='p-web'] .project-item-count")
          ?.textContent === "۱",
      "explicit assignment was not counted under the assigned project",
    );
    assert.equal(
      document.querySelector("[data-project-id='p-api'] .project-item-count").textContent,
      "۰",
      "the cwd-matched project should lose to the explicit assignment",
    );

    document.querySelector("[data-project-id='p-api']").click();
    await waitFor(
      () => listedIds().length === 0,
      "the thread should not appear under the cwd-matched project",
    );
    assert.deepEqual(
      [...document.querySelectorAll(".thread-pinned [data-thread-id]")].map(
        (item) => item.dataset.threadId,
      ),
      ["pinned"],
      "it should still be reachable from the board above",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "a conversation read in another project stays reachable after switching away",
  { concurrency: false },
  async (t) => {
    const now = Math.floor(Date.now() / 1000);
    const threads = [
      {
        id: "web-old",
        name: "بررسی migration",
        cwd: "/workspace/web",
        provider: "codex",
        createdAt: now - 400_000,
        // Deliberately stale: recency must come from opening it, not updatedAt.
        updatedAt: now - 400_000,
        status: { type: "idle" },
      },
      {
        id: "api-1",
        name: "رفع باگ احراز هویت",
        cwd: "/workspace/api",
        provider: "codex",
        createdAt: now,
        updatedAt: now,
        status: { type: "idle" },
      },
    ];
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
      if (path === "/api/projects") {
        return jsonResponse({
          projects: [
            { id: "p-api", name: "api", cwd: "/workspace/api", instructions: "" },
            { id: "p-web", name: "web", cwd: "/workspace/web", instructions: "" },
          ],
          threadProjects: {},
        });
      }
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      if (request.method === "model/list") return jsonResponse({ result: { data: [] } });
      if (request.method === "collaborationMode/list") {
        return jsonResponse({ result: { data: [] } });
      }
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: threads, nextCursor: null } });
      }
      if (request.method === "thread/resume") {
        const thread = threads.find((item) => item.id === request.params.threadId);
        return jsonResponse({ result: { thread: { ...thread, turns: [] }, cwd: thread.cwd } });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { window } = await createHarness(t, { fetchHandler });
    const document = window.document;
    const pinnedIds = () =>
      [...document.querySelectorAll(".thread-pinned [data-thread-id]")].map(
        (item) => item.dataset.threadId,
      );

    await waitFor(
      () => document.querySelectorAll("#thread-list [data-thread-id]").length === 2,
      "threads were not listed",
    );

    // Read the stale conversation from the web project, then move to api.
    document.querySelector("[data-thread-id='web-old']").click();
    await waitFor(
      () => window.localStorage.getItem("codex-web-last-opened")?.includes("web-old"),
      "opening a conversation was not recorded",
    );
    document.querySelector("#project-switcher").click();
    document.querySelector("[data-project-id='p-api']").click();

    await waitFor(
      () => pinnedIds().includes("web-old"),
      "the conversation just read in another project disappeared",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "the composer chip assigns a project to a draft and to an existing conversation",
  { concurrency: false },
  async (t) => {
    const now = Math.floor(Date.now() / 1000);
    const assignments = [];
    const rpcRequests = [];
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
      if (path === "/api/projects") {
        return jsonResponse({
          projects: [
            {
              id: "p-api",
              name: "api",
              cwd: "/workspace/api",
              instructions: "قبل از پایان تست‌ها را اجرا کن.",
            },
            { id: "p-web", name: "web", cwd: "/workspace/web", instructions: "" },
          ],
          threadProjects: {},
        });
      }
      if (path === "/api/project-threads") {
        assignments.push(JSON.parse(options.body));
        return jsonResponse(assignments.at(-1));
      }
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      rpcRequests.push(request);
      if (request.method === "model/list") return jsonResponse({ result: { data: [] } });
      if (request.method === "collaborationMode/list") {
        return jsonResponse({ result: { data: [] } });
      }
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: [], nextCursor: null } });
      }
      if (request.method === "thread/start") {
        return jsonResponse({
          result: {
            thread: {
              id: "chip-thread",
              cwd: request.params.cwd,
              createdAt: now,
              updatedAt: now,
              status: { type: "idle" },
              turns: [],
            },
            cwd: request.params.cwd,
          },
        });
      }
      if (request.method === "turn/start") {
        return jsonResponse({ result: { turn: { id: "turn-chip", status: "inProgress" } } });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { window } = await createHarness(t, { fetchHandler });
    const document = window.document;
    const chipLabel = () => document.querySelector("#project-chip-label").textContent;

    await waitFor(
      () => document.querySelector("#project-chip-list [data-project-id='p-api']"),
      "the chip menu was not populated",
    );
    // Rows in assign mode expose the folder, which filter mode does not need.
    assert.equal(
      document.querySelector("#project-chip-list [data-project-id='p-api'] .project-item-cwd")
        .textContent,
      "/workspace/api",
    );

    document.querySelector("#project-chip").click();
    assert.equal(
      document.querySelector("#project-chip-menu").classList.contains("hidden"),
      false,
      "clicking the chip did not open the menu",
    );

    document.querySelector("#project-chip-list [data-project-id='p-api']").click();
    // The label must update immediately, not only after the thread exists.
    await waitFor(() => chipLabel() === "api", "the chip label did not follow the assignment");
    assert.equal(
      document.querySelector("#project-chip-menu").classList.contains("hidden"),
      true,
      "picking a project should close the menu",
    );
    // Assigning a draft is local; nothing is persisted until the thread exists.
    assert.deepEqual(assignments, []);

    typePrompt(window, "بررسی کن");
    document.querySelector("#send-message").click();
    await waitFor(() => assignments.length === 1, "the new thread was not assigned");
    const start = rpcRequests.find((request) => request.method === "thread/start");
    assert.equal(start.params.cwd, "/workspace/api");
    assert.match(start.params.developerInstructions, /قبل از پایان تست‌ها/);
    assert.deepEqual(assignments[0], { threadId: "chip-thread", projectId: "p-api" });

    // Re-assigning an existing conversation goes straight to the server.
    document.querySelector("#project-chip").click();
    document.querySelector("#project-chip-list [data-project-id='p-web']").click();
    await waitFor(() => assignments.length === 2, "re-assignment was not persisted");
    assert.deepEqual(assignments[1], { threadId: "chip-thread", projectId: "p-web" });
    await waitFor(() => chipLabel() === "web", "the chip did not follow the re-assignment");
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "picking a project from the composer does not move the sidebar filter",
  { concurrency: false },
  async (t) => {
    const now = Math.floor(Date.now() / 1000);
    const threads = [
      {
        id: "web-1",
        name: "بازطراحی هدر",
        cwd: "/workspace/web",
        provider: "codex",
        createdAt: now,
        updatedAt: now,
        status: { type: "idle" },
      },
    ];
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
      if (path === "/api/projects") {
        return jsonResponse({
          projects: [
            { id: "p-api", name: "api", cwd: "/workspace/api", instructions: "" },
            { id: "p-web", name: "web", cwd: "/workspace/web", instructions: "" },
          ],
          threadProjects: {},
        });
      }
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      if (request.method === "model/list") return jsonResponse({ result: { data: [] } });
      if (request.method === "collaborationMode/list") {
        return jsonResponse({ result: { data: [] } });
      }
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: threads, nextCursor: null } });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { window } = await createHarness(t, { fetchHandler });
    const document = window.document;

    await waitFor(
      () => document.querySelector("#project-chip-list [data-project-id='p-api']"),
      "the chip menu was not populated",
    );
    // Browsing is scoped to web; the next chat is going to run in api.
    document.querySelector("#project-switcher").click();
    document.querySelector("#project-list [data-project-id='p-web']").click();
    await waitFor(
      () => document.querySelector("#project-switcher-name").textContent.trim() === "web",
      "the sidebar filter did not move",
    );

    document.querySelector("#project-chip").click();
    document.querySelector("#project-chip-list [data-project-id='p-api']").click();
    await waitFor(
      () => document.querySelector("#project-chip-label").textContent === "api",
      "the chip did not take the assignment",
    );
    assert.equal(
      document.querySelector("#project-switcher-name").textContent.trim(),
      "web",
      "assigning a chat must not change what the sidebar is browsing",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "the composer chip switches model and reasoning effort",
  { concurrency: false },
  async (t) => {
    const rpcRequests = [];
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
      if (path === "/api/projects") {
        return jsonResponse({ projects: [], threadProjects: {} });
      }
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      rpcRequests.push(request);
      if (request.method === "model/list") {
        return jsonResponse({
          result: {
            data: [
              {
                id: "gpt-5-codex",
                model: "gpt-5-codex",
                displayName: "GPT-5 Codex",
                isDefault: true,
                // Codex reports each level as an object, not a bare string.
                supportedReasoningEfforts: [
                  { reasoningEffort: "low", description: "Fast responses" },
                  { reasoningEffort: "medium", description: "Balanced" },
                  { reasoningEffort: "high", description: "Deeper reasoning" },
                ],
                defaultReasoningEffort: "low",
              },
              { id: "gpt-5", model: "gpt-5", displayName: "GPT-5" },
            ],
          },
        });
      }
      if (request.method === "collaborationMode/list") {
        return jsonResponse({ result: { data: [] } });
      }
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: [], nextCursor: null } });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { window } = await createHarness(t, { fetchHandler });
    const document = window.document;
    const label = () => document.querySelector("#model-label").textContent;
    const efforts = () =>
      [...document.querySelectorAll("#effort-options [data-effort-value]")].map(
        (option) => option.dataset.effortValue,
      );

    document.querySelector("#model-chip").click();
    await waitFor(
      () => document.querySelector("#model-options [data-model-value='gpt-5']"),
      "the model menu was not populated",
    );
    assert.equal(
      document.querySelector("#run-chip-menu").classList.contains("hidden"),
      false,
    );

    document.querySelector("#model-options [data-model-value='gpt-5']").click();
    await waitFor(() => label() === "GPT-5", "the chip did not follow the model change");
    assert.equal(
      JSON.parse(window.localStorage.getItem("codex-web-settings")).modelByProvider.codex,
      "gpt-5",
      "the model choice was not persisted",
    );

    document.querySelector("#model-chip").click();
    document.querySelector("#effort-options [data-effort-value='high']").click();
    await waitFor(
      () => label() === "GPT-5 · High",
      "the chip did not show the chosen effort",
    );
    assert.equal(
      JSON.parse(window.localStorage.getItem("codex-web-settings")).effort,
      "high",
    );

    // A model that declares its supported efforts must not offer the others.
    document.querySelector("#model-chip").click();
    document.querySelector("#model-options [data-model-value='gpt-5-codex']").click();
    document.querySelector("#model-chip").click();
    await waitFor(
      () => efforts().length === 4,
      `expected only the declared efforts, got ${efforts().join()}`,
    );
    assert.deepEqual(efforts(), ["", "low", "medium", "high"]);
    // The description from the API is worth surfacing.
    assert.equal(
      document.querySelector("#effort-options [data-effort-value='medium']").title,
      "Balanced",
    );
    // The default level the model reports is named on the fallback option.
    assert.match(
      document.querySelector("#effort-options [data-effort-value='']").textContent,
      /Low/,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "the composer chip switches provider and reloads that provider's models",
  { concurrency: false },
  async (t) => {
    const modelRequests = [];
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
      if (path === "/api/projects") {
        return jsonResponse({ projects: [], threadProjects: {} });
      }
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      if (request.method === "model/list") {
        modelRequests.push(request.params.provider);
        return jsonResponse({
          result: {
            data:
              request.params.provider === "claude"
                ? [{ id: "sonnet", model: "sonnet", displayName: "Claude Sonnet" }]
                : [{ id: "gpt-5", model: "gpt-5", displayName: "GPT-5" }],
          },
        });
      }
      if (request.method === "collaborationMode/list") {
        return jsonResponse({ result: { data: [] } });
      }
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: [], nextCursor: null } });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { window } = await createHarness(t, { fetchHandler });
    const document = window.document;

    document.querySelector("#model-chip").click();
    await waitFor(
      () => document.querySelector("#provider-options [data-provider-value='claude']"),
      "the provider options were not rendered",
    );
    assert.equal(
      document
        .querySelector("#provider-options [data-provider-value='codex']")
        .classList.contains("active"),
      true,
      "Codex should start selected",
    );
    // No conversation is open, so the new-chat caveat is not shown.
    assert.equal(
      document.querySelector("#provider-note").classList.contains("hidden"),
      true,
    );

    document.querySelector("#provider-options [data-provider-value='claude']").click();
    await waitFor(
      () => modelRequests.includes("claude"),
      "switching provider did not load that provider's models",
    );
    assert.equal(
      JSON.parse(window.localStorage.getItem("codex-web-settings")).provider,
      "claude",
      "the provider choice was not persisted",
    );

    document.querySelector("#model-chip").click();
    await waitFor(
      () => document.querySelector("#model-options [data-model-value='sonnet']"),
      "the Claude models were not offered after the switch",
    );
    assert.equal(
      document.querySelector("#model-options [data-model-value='gpt-5']"),
      null,
      "Codex models should not linger after switching provider",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "a new conversation starts in the project last chosen for a chat",
  { concurrency: false },
  async (t) => {
    const now = Math.floor(Date.now() / 1000);
    const rpcRequests = [];
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
      if (path === "/api/projects") {
        return jsonResponse({
          projects: [
            { id: "p-api", name: "api", cwd: "/workspace/api", instructions: "" },
            { id: "p-web", name: "web", cwd: "/workspace/web", instructions: "" },
          ],
          threadProjects: {},
        });
      }
      if (path === "/api/project-threads") return jsonResponse(JSON.parse(options.body));
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      rpcRequests.push(request);
      if (request.method === "model/list") return jsonResponse({ result: { data: [] } });
      if (request.method === "collaborationMode/list") {
        return jsonResponse({ result: { data: [] } });
      }
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: [], nextCursor: null } });
      }
      if (request.method === "thread/start") {
        return jsonResponse({
          result: {
            thread: {
              id: "sticky-thread",
              cwd: request.params.cwd,
              createdAt: now,
              updatedAt: now,
              status: { type: "idle" },
              turns: [],
            },
            cwd: request.params.cwd,
          },
        });
      }
      if (request.method === "turn/start") {
        return jsonResponse({ result: { turn: { id: "turn-sticky", status: "inProgress" } } });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { window } = await createHarness(t, { fetchHandler });
    const document = window.document;
    const chipLabel = () => document.querySelector("#project-chip-label").textContent;

    await waitFor(
      () => document.querySelector("#project-chip-list [data-project-id='p-web']"),
      "the chip menu was not populated",
    );

    document.querySelector("#project-chip").click();
    document.querySelector("#project-chip-list [data-project-id='p-web']").click();
    await waitFor(() => chipLabel() === "web", "the chip did not take the choice");

    // Starting another conversation must not fall back to the sidebar filter.
    document.querySelector("#new-chat").click();
    await waitFor(
      () => chipLabel() === "web",
      "a new conversation reset the project instead of keeping the last choice",
    );
    assert.equal(
      window.localStorage.getItem("codex-web-last-project"),
      "p-web",
      "the last chosen project was not persisted",
    );

    typePrompt(window, "سلام");
    document.querySelector("#send-message").click();
    await waitFor(
      () => rpcRequests.some((request) => request.method === "thread/start"),
      "the conversation was not started",
    );
    assert.equal(
      rpcRequests.find((request) => request.method === "thread/start").params.cwd,
      "/workspace/web",
      "the remembered project did not drive the working folder",
    );

    // Choosing "no project" is a choice too, and must also stick.
    document.querySelector("#new-chat").click();
    document.querySelector("#project-chip").click();
    document.querySelector("#project-chip-list [data-project-id='']").click();
    await waitFor(
      () => window.localStorage.getItem("codex-web-last-project") === "",
      "clearing the project was not remembered",
    );
    document.querySelector("#new-chat").click();
    await waitFor(
      () => chipLabel() !== "web",
      "a new conversation revived a project the user had cleared",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "a new conversation keeps the saved model and reasoning effort",
  { concurrency: false },
  async (t) => {
    const rpcRequests = [];
    const now = Math.floor(Date.now() / 1000);
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
      if (path === "/api/projects") {
        return jsonResponse({ projects: [], threadProjects: {} });
      }
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      rpcRequests.push(request);
      if (request.method === "model/list") {
        return jsonResponse({
          result: {
            data: [
              { id: "gpt-5", model: "gpt-5", displayName: "GPT-5" },
              { id: "gpt-6", model: "gpt-6", displayName: "GPT-6" },
            ],
          },
        });
      }
      if (request.method === "collaborationMode/list") {
        return jsonResponse({ result: { data: [] } });
      }
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: [], nextCursor: null } });
      }
      if (request.method === "thread/start") {
        return jsonResponse({
          result: {
            thread: {
              id: "kept-thread",
              cwd: request.params.cwd,
              createdAt: now,
              updatedAt: now,
              status: { type: "idle" },
              turns: [],
            },
            cwd: request.params.cwd,
          },
        });
      }
      if (request.method === "turn/start") {
        return jsonResponse({ result: { turn: { id: "turn-kept", status: "inProgress" } } });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { window } = await createHarness(t, {
      fetchHandler,
      savedSettings: {
        cwd: "/workspace",
        effort: "high",
        modelByProvider: { codex: "gpt-6", claude: "" },
        provider: "codex",
        version: 6,
      },
    });
    const document = window.document;

    await waitFor(
      () => document.querySelector("#model-label").textContent === "GPT-6 · High",
      "the saved model and effort were not restored",
    );

    document.querySelector("#new-chat").click();
    await waitFor(
      () => document.querySelector("#model-label").textContent === "GPT-6 · High",
      "a new conversation reset the model or effort",
    );

    typePrompt(window, "سلام");
    document.querySelector("#send-message").click();
    await waitFor(
      () => rpcRequests.some((request) => request.method === "thread/start"),
      "the conversation was not started",
    );
    assert.equal(
      rpcRequests.find((request) => request.method === "thread/start").params.model,
      "gpt-6",
      "the saved model was not used for the new conversation",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);


test(
  "the project menu leads with recent projects and picks by keyboard",
  { concurrency: false },
  async (t) => {
  const now = Math.floor(Date.now() / 1000);
  const fetchHandler = async (path, options = {}) => {
    if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
    if (path === "/api/projects") {
      return jsonResponse({
        projects: [
          { id: "p-old", name: "کهنه", cwd: "/workspace/old", instructions: "" },
          { id: "p-fresh", name: "تازه", cwd: "/workspace/fresh", instructions: "" },
        ],
        threadProjects: {},
      });
    }
    if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
    const request = JSON.parse(options.body);
    if (request.method === "model/list") return jsonResponse({ result: { data: [] } });
    if (request.method === "collaborationMode/list") {
      return jsonResponse({ result: { data: [] } });
    }
    if (request.method === "thread/list") {
      return jsonResponse({
        result: {
          data: [
            { id: "t-fresh", name: "ت", cwd: "/workspace/fresh", provider: "codex",
              createdAt: now, updatedAt: now, status: { type: "idle" } },
            { id: "t-old", name: "ک", cwd: "/workspace/old", provider: "codex",
              createdAt: now - 900000, updatedAt: now - 900000, status: { type: "idle" } },
          ],
          nextCursor: null,
        },
      });
    }
    throw new Error(`Unexpected RPC method: ${request.method}`);
  };
  const { window } = await createHarness(t, { fetchHandler });
  const document = window.document;
  const order = () =>
    [...document.querySelectorAll("#project-chip-list [data-project-id]")].map(
      (row) => row.dataset.projectId,
    );
  await waitFor(() => order().length === 3, "menu not populated");
  // Creation order is old-then-fresh; recency reverses it and "no project" trails.
  assert.deepEqual(order(), ["p-fresh", "p-old", ""]);
  const row = document.querySelector("#project-chip-list [data-project-id='p-fresh']");
  assert.equal(row.querySelector(".project-item-cwd").textContent, "/workspace/fresh");
  assert.equal(row.title, "/workspace/fresh", "the full folder stays in the tooltip");
  document.querySelector("#project-chip").click();
  const filter = document.querySelector("#project-chip-filter");
  filter.value = "کهنه";
  filter.dispatchEvent(new window.Event("input", { bubbles: true }));
  await waitFor(() => order().join() === "p-old,", "typing did not narrow");
  const enter = new window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(enter, "key", { value: "Enter" });
  filter.dispatchEvent(enter);
  await waitFor(
      () => document.querySelector("#project-chip-label").textContent === "کهنه",
      "Enter did not pick the highlighted project",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "a conversation row gives the title its own line",
  { concurrency: false },
  async (t) => {
    const now = Math.floor(Date.now() / 1000);
    const longTitle = "بازطراحی نوار کناری و انتخاب پروژه از خود composer";
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
      if (path === "/api/projects") {
        return jsonResponse({
          projects: [{ id: "p-web", name: "web", cwd: "/workspace/web", instructions: "" }],
          threadProjects: {},
        });
      }
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      if (request.method === "model/list") return jsonResponse({ result: { data: [] } });
      if (request.method === "collaborationMode/list") {
        return jsonResponse({ result: { data: [] } });
      }
      if (request.method === "thread/list") {
        return jsonResponse({
          result: {
            data: [
              {
                id: "t-long",
                name: longTitle,
                cwd: "/workspace/web",
                provider: "claude",
                createdAt: now - 7 * 3600,
                updatedAt: now - 7 * 3600,
                status: { type: "idle" },
              },
            ],
            nextCursor: null,
          },
        });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { window } = await createHarness(t, { fetchHandler });
    const document = window.document;
    await waitFor(
      () => document.querySelector("[data-thread-id='t-long']"),
      "the conversation was not listed",
    );
    const row = document.querySelector("[data-thread-id='t-long']");
    const heading = row.querySelector(".thread-item-heading");
    const meta = row.querySelector(".thread-item-meta");

    // The title must not share its line with the provider or the timestamp;
    // that is what squeezed it down to about ten characters.
    assert.equal(heading.querySelector(".thread-item-title").textContent, longTitle);
    assert.equal(heading.querySelector(".thread-provider"), null);
    assert.equal(heading.querySelector(".thread-item-time"), null);
    assert.equal(meta.querySelector(".thread-provider").textContent, "Claude");

    // Relative times follow the locale like every other number in the UI.
    assert.equal(meta.querySelector(".thread-item-time").textContent, "۷ ساعت");

    // The separator must be its own node: as a pseudo-element on the provider
    // it was absorbed by that element's isolated LTR run and came out misplaced.
    const origin = [...meta.querySelector(".thread-item-origin").children].map(
      (node) => node.className,
    );
    assert.deepEqual(origin, [
      "thread-item-project",
      "thread-item-separator",
      "thread-provider",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test(
  "messages carry the turn's clock time and the answer's duration",
  { concurrency: false },
  async (t) => {
    // 20:00:04 -> 20:03:21 local, matching the shape both providers return.
    const startedAt = Math.floor(Date.UTC(2026, 8, 23, 12, 0, 0) / 1000);
    const completedAt = startedAt + 197;
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
      if (path === "/api/projects") {
        return jsonResponse({ projects: [], threadProjects: {} });
      }
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      if (request.method === "model/list") return jsonResponse({ result: { data: [] } });
      if (request.method === "collaborationMode/list") {
        return jsonResponse({ result: { data: [] } });
      }
      if (request.method === "thread/list") {
        return jsonResponse({ result: { data: [], nextCursor: null } });
      }
      if (request.method === "thread/resume") {
        return jsonResponse({
          result: {
            thread: {
              id: "timed-thread",
              name: "زمان‌دار",
              cwd: "/workspace",
              provider: "codex",
              createdAt: startedAt,
              updatedAt: completedAt,
              status: { type: "idle" },
              turns: [
                {
                  id: "turn-1",
                  status: "completed",
                  startedAt,
                  completedAt,
                  durationMs: 197_000,
                  items: [
                    { id: "i-user", type: "userMessage", content: [{ type: "text", text: "سلام" }] },
                    {
                      id: "i-agent",
                      type: "agentMessage",
                      phase: "final_answer",
                      content: [{ type: "text", text: "پاسخ" }],
                    },
                  ],
                },
              ],
            },
          },
        });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { window } = await createHarness(t, {
      fetchHandler,
      initialUrl: "http://localhost/?session=timed-thread",
    });
    const document = window.document;
    await waitFor(
      () => document.querySelector("[data-item-id='i-agent']"),
      "the conversation was not hydrated",
    );

    const userTime = document
      .querySelector("[data-item-id='i-user'] .message-time")
      .textContent.trim();
    const agentTime = document
      .querySelector("[data-item-id='i-agent'] .message-time")
      .textContent.trim();

    // The user message is stamped with when the exchange began...
    assert.ok(userTime, "the user message has no clock time");
    // Persian digits, so match the locale's numerals rather than ASCII.
    assert.match(userTime, /^[۰-۹]{1,2}:[۰-۹]{2}$/, `expected a clock time, got ${userTime}`);
    // ...and the answer reports how long it took, not a second clock reading.
    assert.equal(agentTime, "۳ دقیقه", `expected a duration, got ${agentTime}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);

test("the conversation reserves space for the composer's real height", async () => {
  const [index, styles] = await Promise.all([
    readFile(INDEX, "utf8"),
    readFile(STYLES, "utf8"),
  ]);

  // The composer floats over the conversation, so a fixed reserve leaves the
  // last messages buried once the textarea grows.
  const messages = styles.match(/\.messages\s*\{(?<body>[^}]*)\}/)?.groups?.body || "";
  assert.match(
    messages,
    /padding:[^;]*var\(--composer-height/,
    "the messages reserve must follow --composer-height",
  );
  assert.match(
    styles,
    /\.composer-wrap\s*\{[^}]*position:\s*absolute/s,
    "the reserve only matters while the composer overlays the conversation",
  );

  // The hint moved inside the box, between the chips and the actions.
  const footer = index.match(
    /<div class="composer-footer">(?<body>[\s\S]*?)<div class="composer-actions">/,
  )?.groups?.body;
  assert.ok(footer, "composer footer markup changed shape");
  assert.match(footer, /id="composer-hint"/, "the hint should sit inside the composer");
  assert.doesNotMatch(
    index.slice(index.indexOf("</div>\n        </div>\n      </main>")),
    /composer-hint/,
    "the hint should no longer trail the composer",
  );
});

test(
  "a new conversation follows the sidebar filter over the last chip choice",
  { concurrency: false },
  async (t) => {
    const now = Math.floor(Date.now() / 1000);
    const fetchHandler = async (path, options = {}) => {
      if (path === "/api/status") return jsonResponse({ ready: true, cwd: "/workspace" });
      if (path === "/api/projects") {
        return jsonResponse({
          projects: [
            { id: "p-api", name: "api", cwd: "/workspace/api", instructions: "" },
            { id: "p-web", name: "web", cwd: "/workspace/web", instructions: "" },
          ],
          threadProjects: {},
        });
      }
      if (path === "/api/project-threads") return jsonResponse(JSON.parse(options.body));
      if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);
      const request = JSON.parse(options.body);
      if (request.method === "model/list") return jsonResponse({ result: { data: [] } });
      if (request.method === "collaborationMode/list") {
        return jsonResponse({ result: { data: [] } });
      }
      if (request.method === "thread/list") {
        return jsonResponse({
          result: {
            data: [
              {
                id: "t-web",
                name: "وب",
                cwd: "/workspace/web",
                provider: "codex",
                createdAt: now,
                updatedAt: now,
                status: { type: "idle" },
              },
            ],
            nextCursor: null,
          },
        });
      }
      throw new Error(`Unexpected RPC method: ${request.method}`);
    };

    const { window } = await createHarness(t, { fetchHandler });
    const document = window.document;
    const chipLabel = () => document.querySelector("#project-chip-label").textContent;

    await waitFor(
      () => document.querySelector("#project-chip-list [data-project-id='p-api']"),
      "the chip menu was not populated",
    );

    // Deliberately pick api from the chip, so it becomes the remembered choice.
    document.querySelector("#project-chip").click();
    document.querySelector("#project-chip-list [data-project-id='p-api']").click();
    await waitFor(() => chipLabel() === "api", "the chip did not take the choice");

    // Then narrow the sidebar to a different project and start a conversation.
    document.querySelector("#project-switcher").click();
    document.querySelector("#project-list [data-project-id='p-web']").click();
    await waitFor(
      () => document.querySelector("#project-switcher-name").textContent.trim() === "web",
      "the sidebar filter did not move",
    );
    document.querySelector("#new-chat").click();
    await waitFor(
      () => chipLabel() === "web",
      "a new conversation should start in the project being browsed",
    );

    // Clearing the filter falls back to the remembered choice.
    document.querySelector("#project-switcher").click();
    document.querySelector("#project-list [data-project-id='']").click();
    document.querySelector("#new-chat").click();
    await waitFor(
      () => chipLabel() === "api",
      "with no filter it should fall back to the last chosen project",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  },
);
