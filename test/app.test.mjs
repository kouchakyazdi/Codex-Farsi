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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

function installDomGlobals(dom) {
  const nativeSetTimeout = globalThis.setTimeout;
  const globals = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    crypto: { randomUUID },
    document: dom.window.document,
    EventSource: FakeEventSource,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    setTimeout(callback, delay = 0, ...args) {
      return nativeSetTimeout(callback, delay >= 4_000 ? 0 : delay, ...args);
    },
    window: dom.window,
  };
  const originalDescriptors = new Map(
    [...Object.keys(globals), "fetch"].map((name) => [
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
  dom.window.HTMLElement.prototype.scrollTo = function scrollTo(options = {}) {
    if (typeof options.top === "number") this.scrollTop = options.top;
  };
  return () => {
    for (const [name, descriptor] of originalDescriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

test("submitted user message stays visible while the assistant is streaming", async (t) => {
  const html = await readFile(INDEX, "utf8");
  const { window } = parseHTML(html);
  const values = new Map();
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
  Object.defineProperty(window.HTMLSelectElement.prototype, "value", {
    configurable: true,
    get() {
      return this.__testValue ?? this.querySelector("option")?.value ?? "";
    },
    set(value) {
      this.__testValue = String(value);
    },
  });
  Object.defineProperty(window.Node, "DOCUMENT_POSITION_FOLLOWING", {
    configurable: true,
    value: 4,
  });
  const dom = { window };
  const restoreGlobals = installDomGlobals(dom);
  t.after(() => {
    FakeEventSource.latest?.close();
    restoreGlobals();
    dom.window.close();
  });

  const now = Math.floor(Date.now() / 1000);
  const threadSummary = {
    id: "thread-1",
    name: "Regression test",
    cwd: "/workspace",
    createdAt: now,
    updatedAt: now,
    status: { type: "idle" },
  };
  const otherThreadSummary = {
    ...threadSummary,
    id: "thread-2",
    name: "Other thread",
  };
  const resumedThread = {
    ...threadSummary,
    turns: [
      {
        id: "turn-old",
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "user-old",
            clientId: null,
            content: [{ type: "text", text: "پیام قبلی" }],
          },
          {
            type: "agentMessage",
            id: "commentary-old",
            text: "در حال بررسی سابقه",
            phase: "commentary",
          },
          {
            type: "reasoning",
            id: "reasoning-old",
            summary: [{ text: "بررسی خلاصه" }],
          },
          {
            type: "reasoning",
            id: "reasoning-empty",
            summary: [],
          },
          {
            type: "commandExecution",
            id: "command-old",
            command: "pwd",
            status: "completed",
            exitCode: 0,
          },
          {
            type: "plan",
            id: "plan-old",
            text: "## برنامهٔ اجرا\n\n- گام اول",
          },
          {
            type: "plan",
            id: "plan-old-duplicate",
            text: "## برنامهٔ اجرا\n\n- گام اول",
          },
          {
            type: "agentMessage",
            id: "agent-old",
            text: "پاسخ قبلی",
            phase: "final_answer",
          },
        ],
      },
      {
        id: "rollout-continuation",
        status: "completed",
        items: [
          {
            type: "agentMessage",
            id: "rollout-final",
            text: "ادامهٔ خودکار همان پاسخ",
            phase: "final_answer",
          },
        ],
      },
    ],
  };
  const otherResumedThread = {
    ...otherThreadSummary,
    turns: [
      {
        id: "other-turn",
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "other-user",
            clientId: null,
            content: [{ type: "text", text: "پیام گفتگوی دیگر" }],
          },
          {
            type: "agentMessage",
            id: "other-agent",
            text: "پاسخ گفتگوی دیگر",
            phase: "final_answer",
          },
        ],
      },
    ],
  };
  const turnStartRequests = [];
  const attachmentUploadRequests = [];
  let resolveAcceptedTurnFailure;
  let resolveTurnStart;

  globalThis.fetch = async (path, options = {}) => {
    if (path === "/api/status") {
      return jsonResponse({ ready: true, cwd: "/workspace" });
    }
    if (path === "/api/uploads/files") {
      attachmentUploadRequests.push({ options, path });
      return jsonResponse({
        path: "C:\\uploads\\notes.md",
        name: "notes.md",
        size: options.body.size,
        type: options.headers["Content-Type"],
      }, 201);
    }
    if (path !== "/api/rpc") throw new Error(`Unexpected request: ${path}`);

    const { method, params } = JSON.parse(options.body);
    if (method === "model/list") return jsonResponse({ result: { data: [] } });
    if (method === "thread/list") {
      return jsonResponse({
        result: { data: [threadSummary, otherThreadSummary], nextCursor: null },
      });
    }
    if (method === "thread/resume") {
      return jsonResponse({
        result: {
          thread: params.threadId === "thread-2" ? otherResumedThread : resumedThread,
          cwd: "/workspace",
          model: "test-model",
        },
      });
    }
    if (method === "turn/start") {
      turnStartRequests.push(params);
      if (turnStartRequests.length === 2) {
        return jsonResponse({ error: "simulated turn/start failure" }, 500);
      }
      if (turnStartRequests.length === 3) {
        return new Promise((resolve) => {
          resolveAcceptedTurnFailure = () =>
            resolve(
              jsonResponse(
                { error: "simulated response loss after acceptance" },
                500,
              ),
            );
        });
      }
      return new Promise((resolve) => {
        resolveTurnStart = () =>
          resolve(
            jsonResponse({
              result: {
                turn: {
                  id: "turn-new",
                  status: "inProgress",
                  items: [],
                  error: null,
                },
              },
            }),
          );
      });
    }
    throw new Error(`Unexpected RPC method: ${method}`);
  };

  await import(`${pathToFileURL(APP).href}?test=${Date.now()}`);
  await waitFor(
    () => document.querySelector("[data-thread-id='thread-1']"),
    "thread list was not rendered",
  );

  document.querySelector("[data-thread-id='thread-1']").click();
  await waitFor(
    () => document.querySelector("[data-item-id='agent-old']"),
    "thread history was not rendered",
  );
  assert.equal(document.querySelectorAll(".message-avatar").length, 0);
  const process = document.querySelector(".turn-process[data-turn-id='turn-old']");
  const commentary = document.querySelector("[data-item-id='commentary-old']");
  const finalAnswer = document.querySelector("[data-item-id='agent-old']");
  assert.ok(process);
  assert.equal(process.hasAttribute("open"), false);
  assert.equal(process.querySelector(".turn-process-label").textContent, "روند کار");
  assert.equal(commentary.closest(".turn-process"), process);
  assert.equal(commentary.querySelector(".message-actions"), null);
  assert.equal(finalAnswer.closest(".turn-process"), null);
  assert.equal(finalAnswer.classList.contains("final-answer"), true);
  assert.equal(finalAnswer.dataset.phase, "final_answer");
  const rolloutFinal = document.querySelector("[data-item-id='rollout-final']");
  assert.equal(rolloutFinal.classList.contains("continuation"), true);
  assert.equal(
    rolloutFinal.querySelector(".message-continuation-label").textContent,
    "ادامهٔ پاسخ",
  );
  assert.equal(rolloutFinal.getAttribute("aria-label"), "ادامهٔ پاسخ قبلی");
  assert.equal(document.querySelector("[data-item-id='reasoning-old']").hasAttribute("open"), false);
  assert.equal(document.querySelector("[data-item-id='reasoning-old'] summary").textContent, "تفکر");
  assert.equal(document.querySelector("[data-item-id='reasoning-empty']").hidden, true);
  assert.equal(document.querySelector("[data-item-id='command-old']").classList.contains("completed"), true);
  const plan = document.querySelector("[data-item-id='plan-old']");
  assert.equal(plan.closest(".turn-process"), null);
  assert.equal(plan.dataset.phase, "plan");
  assert.equal(plan.getAttribute("aria-label"), "برنامه");
  assert.equal(plan.querySelector("h2").textContent, "برنامهٔ اجرا");
  assert.match(plan.textContent, /گام اول/);
  assert.equal(document.querySelector("[data-item-id='plan-old-duplicate']"), null);
  assert.equal(document.querySelectorAll("[data-phase='plan']").length, 1);

  const prompt = document.querySelector("#prompt");
  prompt.setSelectionRange = (start, end) => {
    prompt.selectionStart = start;
    prompt.selectionEnd = end;
  };
  const composer = document.querySelector(".composer");
  const dropOverlay = document.querySelector("#composer-drop-overlay");
  const attachment = { name: "notes.md", size: 4, type: "text/markdown" };
  const dragEvent = (type, files = []) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { dropEffect: "none", files, types: ["Files"] },
    });
    return event;
  };
  composer.dispatchEvent(dragEvent("dragenter"));
  assert.equal(composer.classList.contains("drop-active"), true);
  assert.equal(dropOverlay.classList.contains("hidden"), false);
  composer.dispatchEvent(dragEvent("dragleave"));
  assert.equal(composer.classList.contains("drop-active"), false);
  composer.dispatchEvent(dragEvent("dragenter"));
  composer.dispatchEvent(dragEvent("drop", [attachment]));
  await waitFor(() => attachmentUploadRequests.length === 1, "dropped file was not uploaded");
  await waitFor(
    () =>
      prompt.value.includes("C:\\uploads\\notes.md") &&
      document.querySelector("#upload-status").classList.contains("hidden"),
    "uploaded path was not inserted",
  );
  assert.equal(attachmentUploadRequests[0].options.headers["Content-Type"], "text/markdown");
  assert.equal(composer.classList.contains("drop-active"), false);

  prompt.value = "پیام تازه";
  prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  document.querySelector("#send-message").click();

  const userRowsBeforeStream = [
    ...document.querySelectorAll(".message-row.user"),
  ];
  assert.equal(userRowsBeforeStream.length, 2);
  assert.equal(userRowsBeforeStream.at(-1).textContent.trim(), "پیام تازه");
  assert.equal(prompt.value, "");

  await waitFor(() => turnStartRequests.length, "turn/start was not requested");
  const clientId = turnStartRequests[0].clientUserMessageId;
  assert.equal(typeof clientId, "string");
  assert.notEqual(clientId, "");
  assert.notEqual(clientId, "user-from-server");
  assert.match(
    turnStartRequests[0].developerInstructions,
    /use a compact Markdown table by default/,
  );
  assert.match(turnStartRequests[0].developerInstructions, /Selectively bold key terms/);

  FakeEventSource.latest.emit("rpc", {
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-new",
      itemId: "agent-streaming",
      delta: "پاسخ در حال استریم",
    },
  });

  const userRowsBeforeServerItem = [
    ...document.querySelectorAll(".message-row.user"),
  ];
  assert.equal(userRowsBeforeServerItem.length, 2);
  assert.equal(userRowsBeforeServerItem.at(-1), userRowsBeforeStream.at(-1));
  assert.notEqual(
    userRowsBeforeServerItem.at(-1).dataset.itemId,
    "user-from-server",
  );
  const streamingReply = document.querySelector(
    "[data-item-id='agent-streaming']",
  );
  assert.match(streamingReply.textContent, /پاسخ در حال استریم/);
  assert.equal(
    userRowsBeforeServerItem.at(-1).compareDocumentPosition(streamingReply) &
      dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
  );

  FakeEventSource.latest.emit("rpc", {
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-new",
      item: {
        type: "userMessage",
        id: "user-from-server",
        clientId,
        content: [{ type: "text", text: "پیام تازه" }],
      },
    },
  });
  const userRowsDuringStream = [
    ...document.querySelectorAll(".message-row.user"),
  ];
  assert.equal(userRowsDuringStream.length, 2);
  assert.equal(userRowsDuringStream.at(-1), userRowsBeforeStream.at(-1));
  assert.equal(
    userRowsDuringStream.at(-1).dataset.itemId,
    "user-from-server",
  );
  assert.equal(
    document.querySelectorAll("[data-item-id='user-from-server']").length,
    1,
  );

  FakeEventSource.latest.emit("rpc", {
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-new",
      item: {
        type: "userMessage",
        id: "user-from-server",
        clientId,
        content: [{ type: "text", text: "پیام تازه" }],
      },
    },
  });
  assert.equal(document.querySelectorAll(".message-row.user").length, 2);
  resolveTurnStart();
  await waitFor(
    () => document.querySelector("#stop-turn").disabled === false,
    "turn/start response was not handled",
  );
  FakeEventSource.latest.emit("rpc", {
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-new",
        status: "completed",
        items: [],
        error: null,
      },
    },
  });
  resumedThread.turns.push({
    id: "turn-new",
    status: "completed",
    items: [
      {
        type: "userMessage",
        id: "user-from-server",
        clientId,
        content: [{ type: "text", text: "پیام تازه" }],
      },
      {
        type: "agentMessage",
        id: "agent-streaming",
        text: "پاسخ در حال استریم",
        phase: "final_answer",
      },
    ],
  });

  prompt.value = "پیامی که ارسال نشد";
  prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    document.querySelector("#send-message").click();
    assert.equal(document.querySelectorAll(".message-row.user").length, 3);

    await waitFor(
      () =>
        document.querySelectorAll(".message-row.user").length === 2 &&
        prompt.value === "پیامی که ارسال نشد",
      "failed optimistic message was not removed and restored to the draft",
    );
  } finally {
    console.error = originalConsoleError;
  }

  prompt.value = "پیام پذیرفته‌شده";
  prompt.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  let acceptedFailureLogged = false;
  console.error = () => {
    acceptedFailureLogged = true;
  };
  try {
    document.querySelector("#send-message").click();
    assert.equal(document.querySelectorAll(".message-row.user").length, 3);
    await waitFor(
      () => turnStartRequests.length === 3,
      "accepted turn/start was not requested",
    );

    const acceptedClientId = turnStartRequests[2].clientUserMessageId;
    FakeEventSource.latest.emit("rpc", {
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: {
          id: "turn-accepted",
          status: "inProgress",
          items: [],
          error: null,
        },
      },
    });
    FakeEventSource.latest.emit("rpc", {
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-accepted",
        item: {
          type: "userMessage",
          id: "accepted-user-from-server",
          clientId: acceptedClientId,
          content: [{ type: "text", text: "پیام پذیرفته‌شده" }],
        },
      },
    });
    resolveAcceptedTurnFailure();
    await waitFor(
      () => acceptedFailureLogged,
      "accepted response failure was not handled",
    );

    assert.equal(prompt.value, "");
    assert.equal(document.querySelectorAll(".message-row.user").length, 3);
    assert.equal(
      document.querySelectorAll(
        "[data-item-id='accepted-user-from-server']",
      ).length,
      1,
    );
    assert.equal(document.querySelector("#stop-turn").disabled, false);

    resumedThread.turns.push({
      id: "turn-accepted",
      status: "completed",
      items: [
        {
          type: "agentMessage",
          id: "accepted-agent-from-history",
          text: "پاسخ ذخیره‌شده بدون پیام کاربر",
          phase: "final_answer",
        },
      ],
    });
    document.querySelector("[data-thread-id='thread-2']").click();
    await waitFor(
      () => document.querySelector("[data-item-id='other-agent']"),
      "other thread was not rendered",
    );
    document.querySelector("[data-thread-id='thread-1']").click();
    await waitFor(
      () => document.querySelector("[data-item-id='accepted-agent-from-history']"),
      "original thread was not rendered again",
    );

    const restoredUser = [...document.querySelectorAll(".message-row.user")].find(
      (row) => row.textContent.trim() === "پیام پذیرفته‌شده",
    );
    const restoredAnswer = document.querySelector(
      "[data-item-id='accepted-agent-from-history']",
    );
    assert.ok(restoredUser, "accepted user message disappeared after history refresh");
    assert.equal(
      restoredUser.compareDocumentPosition(restoredAnswer) &
        dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
      dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    console.error = originalConsoleError;
  }
});
