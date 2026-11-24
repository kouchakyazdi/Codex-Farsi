import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ClaudeProvider } from "../providers/claude-provider.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLAUDE = join(ROOT, "test-support", "fake-claude-lifecycle.mjs");

async function waitFor(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("Timed out waiting for Claude provider state");
}

async function readLog(path) {
  try {
    const content = await readFile(path, "utf8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function providerOptions(root, events = [], overrides = {}) {
  return {
    binary: FAKE_CLAUDE,
    cacheDir: join(root, "cache"),
    claudeConfigDir: join(root, "claude-config"),
    emit: (message) => events.push(message),
    log: () => {},
    processExitGraceMs: 100,
    turnLockTimeoutMs: 75,
    ...overrides,
  };
}

function configureFake(t, root) {
  const previousLog = process.env.FAKE_CLAUDE_LIFECYCLE_LOG;
  const previousSessions = process.env.FAKE_CLAUDE_SESSION_DIR;
  process.env.FAKE_CLAUDE_LIFECYCLE_LOG = join(root, "claude.ndjson");
  process.env.FAKE_CLAUDE_SESSION_DIR = join(root, "sessions");
  t.after(() => {
    if (previousLog === undefined) delete process.env.FAKE_CLAUDE_LIFECYCLE_LOG;
    else process.env.FAKE_CLAUDE_LIFECYCLE_LOG = previousLog;
    if (previousSessions === undefined) delete process.env.FAKE_CLAUDE_SESSION_DIR;
    else process.env.FAKE_CLAUDE_SESSION_DIR = previousSessions;
  });
  return process.env.FAKE_CLAUDE_LIFECYCLE_LOG;
}

async function waitForTurn(provider, threadId, expectedStatus) {
  return waitFor(async () => {
    const result = await provider.rpc("thread/read", { threadId });
    const turn = result.thread.turns.at(-1);
    return turn?.status === expectedStatus ? turn : null;
  });
}

test("status probes the executable without loading conversation storage", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "codex-web-claude-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = new ClaudeProvider(
    providerOptions(root, [], { binary: join(root, "missing-claude") }),
  );

  const status = await provider.status();
  assert.equal(status.ready, false);
  assert.equal(status.available, false);
  await assert.rejects(access(join(root, "cache")), { code: "ENOENT" });
});

test("same-thread starts reserve before await and forward validated CLI settings", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "codex-web-claude-reserve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logFile = configureFake(t, root);
  const events = [];
  const provider = new ClaudeProvider(providerOptions(root, events));
  t.after(() => provider.stop());
  await provider.load();
  const { thread } = await provider.rpc("thread/start", {
    cwd: root,
    effort: "high",
    permissionMode: "acceptEdits",
  });

  const starts = await Promise.allSettled([
    provider.rpc("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "first" }],
    }),
    provider.rpc("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "second" }],
    }),
  ]);
  assert.deepEqual(starts.map((result) => result.status).sort(), [
    "fulfilled",
    "rejected",
  ]);
  await waitForTurn(provider, thread.id, "completed");

  const start = (await readLog(logFile)).find((entry) => entry.event === "start");
  assert.equal(start.args.includes("--session-id"), true);
  assert.equal(start.args.includes("--resume"), false);
  assert.deepEqual(
    start.args.slice(start.args.indexOf("--permission-mode"), start.args.indexOf("--permission-mode") + 2),
    ["--permission-mode", "acceptEdits"],
  );
  assert.deepEqual(
    start.args.slice(start.args.indexOf("--effort"), start.args.indexOf("--effort") + 2),
    ["--effort", "high"],
  );
  assert.equal(start.configDir, join(root, "claude-config"));

  await assert.rejects(
    provider.rpc("turn/start", {
      threadId: thread.id,
      effort: "extreme",
      input: [{ type: "text", text: "invalid" }],
    }),
    /effort نامعتبر/,
  );
});

test("a result is not terminal until the Claude child closes", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "codex-web-claude-close-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  configureFake(t, root);
  const events = [];
  const provider = new ClaudeProvider(providerOptions(root, events));
  t.after(() => provider.stop());
  await provider.load();
  const { thread } = await provider.rpc("thread/start", { cwd: root });
  const first = await provider.rpc("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "__delay_result__" }],
  });

  await waitFor(() =>
    events.some(
      (message) =>
        message.method === "item/agentMessage/delta" &&
        message.params.turnId === first.turn.id,
    ),
  );
  await assert.rejects(
    provider.rpc("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "too early" }],
    }),
    /در حال اجراست/,
  );
  await waitForTurn(provider, thread.id, "completed");

  const second = await provider.rpc("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "after close" }],
  });
  await waitForTurn(provider, thread.id, "completed");
  assert.notEqual(second.turn.id, first.turn.id);
});

test("complete assistant events preserve every text block without duplicating result text", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "codex-web-claude-blocks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  configureFake(t, root);
  const provider = new ClaudeProvider(providerOptions(root));
  t.after(() => provider.stop());
  await provider.load();
  const { thread } = await provider.rpc("thread/start", { cwd: root });
  await provider.rpc("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "__assistant_blocks__" }],
  });

  const turn = await waitForTurn(provider, thread.id, "completed");
  const assistant = turn.items.find((item) => item.type === "agentMessage");
  assert.equal(assistant.text, "بخش اول\nبخش دوم");
});

test("interrupt validates turnId and escalates a stuck child", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "codex-web-claude-interrupt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logFile = configureFake(t, root);
  const provider = new ClaudeProvider(providerOptions(root));
  t.after(() => provider.stop());
  await provider.load();
  const { thread } = await provider.rpc("thread/start", { cwd: root });
  const started = await provider.rpc("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "__ignore_term__" }],
  });
  await waitFor(async () =>
    (await readLog(logFile)).some((entry) => entry.event === "start"),
  );

  await assert.rejects(
    provider.rpc("turn/interrupt", {
      threadId: thread.id,
      turnId: "wrong-turn",
    }),
    (error) => error.status === 409,
  );
  const active = await provider.rpc("thread/read", { threadId: thread.id });
  assert.equal(active.thread.status.type, "active");

  await provider.rpc("turn/interrupt", {
    threadId: thread.id,
    turnId: started.turn.id,
  });
  const interrupted = await waitForTurn(provider, thread.id, "interrupted");
  assert.match(interrupted.items.at(-1).text, /متوقف شد/);
  await assert.rejects(
    access(join(root, "cache", "turn-locks", `${thread.id.slice("claude:".length)}.lock`)),
    { code: "ENOENT" },
  );
});

test("cross-instance locks isolate a thread and dirty writes preserve other threads", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "codex-web-claude-multi-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  configureFake(t, root);
  const first = new ClaudeProvider(providerOptions(root));
  const second = new ClaudeProvider(providerOptions(root));
  t.after(() => Promise.all([first.stop(), second.stop()]));
  await Promise.all([first.load(), second.load()]);

  const [one, two] = await Promise.all([
    first.rpc("thread/start", { cwd: root }),
    second.rpc("thread/start", { cwd: root }),
  ]);
  const stored = JSON.parse(
    await readFile(join(root, "cache", "conversations.json"), "utf8"),
  );
  assert.deepEqual(
    stored.threads.map((thread) => thread.id).sort(),
    [one.thread.providerThreadId, two.thread.providerThreadId].sort(),
  );

  await second.rpc("thread/list");
  const running = await first.rpc("turn/start", {
    threadId: one.thread.id,
    input: [{ type: "text", text: "__hold__" }],
  });
  await assert.rejects(
    second.rpc("turn/start", {
      threadId: one.thread.id,
      input: [{ type: "text", text: "must not overlap" }],
    }),
    (error) => error.status === 409,
  );
  await first.rpc("turn/interrupt", {
    threadId: one.thread.id,
    turnId: running.turn.id,
  });
  await waitForTurn(first, one.thread.id, "interrupted");
});

test("load recovers an orphaned active turn and persists the repair", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "codex-web-claude-recover-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheDir = join(root, "cache");
  await mkdir(cacheDir, { recursive: true });
  const id = "11111111-1111-4111-8111-111111111111";
  await writeFile(
    join(cacheDir, "conversations.json"),
    JSON.stringify({
      version: 1,
      threads: [
        {
          id,
          cwd: root,
          name: "orphan",
          status: { type: "active" },
          turns: [
            {
              id: "turn",
              status: "inProgress",
              items: [
                {
                  id: "tool",
                  type: "commandExecution",
                  status: "inProgress",
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  const provider = new ClaudeProvider(providerOptions(root));
  t.after(() => provider.stop());
  await provider.load();

  const result = await provider.rpc("thread/read", { threadId: `claude:${id}` });
  assert.equal(result.thread.status.type, "idle");
  assert.equal(result.thread.turns[0].status, "interrupted");
  assert.equal(result.thread.turns[0].items[0].status, "interrupted");
  const stored = JSON.parse(
    await readFile(join(cacheDir, "conversations.json"), "utf8"),
  );
  assert.equal(stored.threads[0].status.type, "idle");
  assert.equal(stored.threads[0].turns[0].status, "interrupted");
  assert.equal(stored.threads[0].turns[0].items[0].status, "interrupted");
});

test("native rename and archive metadata survive a provider restart", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "codex-web-claude-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = "22222222-2222-4222-8222-222222222222";
  const projectDir = join(root, "claude-config", "projects", "project");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, `${id}.jsonl`),
    `${JSON.stringify({
      type: "user",
      uuid: "user",
      cwd: root,
      timestamp: "2026-07-27T00:00:00.000Z",
      message: { content: "native prompt" },
    })}\n`,
  );

  const first = new ClaudeProvider(providerOptions(root));
  await first.load();
  await first.rpc("thread/setName", {
    threadId: `claude:${id}`,
    name: "نام پایدار",
  });
  await first.rpc("thread/archive", { threadId: `claude:${id}` });
  await first.stop();

  const second = new ClaudeProvider(providerOptions(root));
  t.after(() => second.stop());
  await second.load();
  const result = await second.rpc("thread/read", { threadId: `claude:${id}` });
  assert.equal(result.thread.name, "نام پایدار");
  assert.equal(result.thread.archived, true);
  assert.equal(result.thread.permissionMode, "");
});

test("concurrent native rename and archive preserve each other's fields", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "codex-web-claude-native-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = "44444444-4444-4444-8444-444444444444";
  const projectDir = join(root, "claude-config", "projects", "project");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, `${id}.jsonl`),
    `${JSON.stringify({
      type: "user",
      uuid: "native-race-user",
      cwd: root,
      timestamp: "2026-07-27T00:00:00.000Z",
      message: { content: "native prompt" },
    })}\n`,
  );

  const first = new ClaudeProvider(providerOptions(root));
  const second = new ClaudeProvider(providerOptions(root));
  t.after(() => Promise.all([first.stop(), second.stop()]));
  await Promise.all([first.load(), second.load()]);
  await Promise.all([
    first.rpc("thread/setName", {
      threadId: `claude:${id}`,
      name: "نام هم‌زمان",
    }),
    second.rpc("thread/archive", { threadId: `claude:${id}` }),
  ]);

  const restarted = new ClaudeProvider(providerOptions(root));
  t.after(() => restarted.stop());
  await restarted.load();
  const result = await restarted.rpc("thread/read", {
    threadId: `claude:${id}`,
  });
  assert.equal(result.thread.name, "نام هم‌زمان");
  assert.equal(result.thread.archived, true);
});

test("an active native turn replaces the matching transcript tail instead of duplicating it", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "codex-web-claude-native-active-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logFile = configureFake(t, root);
  const id = "33333333-3333-4333-8333-333333333333";
  const projectDir = join(root, "claude-config", "projects", "project");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, `${id}.jsonl`),
    `${JSON.stringify({
      type: "user",
      uuid: "native-active-user",
      cwd: root,
      timestamp: "2026-07-27T00:00:00.000Z",
      message: { content: "__hold__" },
    })}\n`,
  );
  await mkdir(join(root, "sessions"), { recursive: true });
  await writeFile(join(root, "sessions", id), "");

  const events = [];
  const provider = new ClaudeProvider(providerOptions(root, events));
  t.after(() => provider.stop());
  await provider.load();
  const started = await provider.rpc("turn/start", {
    threadId: `claude:${id}`,
    input: [{ type: "text", text: "__hold__" }],
  });
  await waitFor(async () =>
    (await readLog(logFile)).some((entry) => entry.event === "start"),
  );

  const active = await provider.rpc("thread/read", { threadId: `claude:${id}` });
  assert.equal(active.thread.turns.length, 1);
  assert.equal(active.thread.turns[0].id, started.turn.id);
  assert.equal(active.thread.turns[0].status, "inProgress");

  await provider.rpc("turn/interrupt", {
    threadId: `claude:${id}`,
    turnId: started.turn.id,
  });
  await waitFor(() =>
    events.some(
      (message) =>
        message.method === "turn/completed" &&
        message.params.turn.id === started.turn.id,
    ),
  );
});

test("a pre-init failure retries with session-id, then resumes after init", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "codex-web-claude-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logFile = configureFake(t, root);
  const provider = new ClaudeProvider(providerOptions(root));
  t.after(() => provider.stop());
  await provider.load();
  const { thread } = await provider.rpc("thread/start", { cwd: root });

  await provider.rpc("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "__before_init_fail__" }],
  });
  await waitForTurn(provider, thread.id, "failed");
  await provider.rpc("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "initialized" }],
  });
  await waitForTurn(provider, thread.id, "completed");
  await provider.rpc("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "resumed" }],
  });
  await waitForTurn(provider, thread.id, "completed");

  const starts = (await readLog(logFile)).filter((entry) => entry.event === "start");
  assert.equal(starts.length, 3);
  assert.equal(starts[0].args.includes("--session-id"), true);
  assert.equal(starts[1].args.includes("--session-id"), true);
  assert.equal(starts[2].args.includes("--resume"), true);
});

test("thread creation rejects malformed IDs, permissions, and non-directories", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "codex-web-claude-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "not-a-directory");
  await writeFile(file, "");
  const provider = new ClaudeProvider(providerOptions(root));
  t.after(() => provider.stop());
  await provider.load();

  await assert.rejects(
    provider.rpc("thread/start", {
      cwd: root,
      sessionId: "------------------------------------",
    }),
    /UUID معتبر/,
  );
  await assert.rejects(
    provider.rpc("thread/start", {
      cwd: root,
      permissionMode: "unsafe",
    }),
    /permission mode نامعتبر/,
  );
  await assert.rejects(
    provider.rpc("thread/start", { cwd: file }),
    /directory/,
  );
});

test("a completed turn reports context usage and the active rate limit window", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "codex-web-claude-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  configureFake(t, root);
  const events = [];
  const provider = new ClaudeProvider(providerOptions(root, events));
  t.after(() => provider.stop());
  await provider.load();
  const { thread } = await provider.rpc("thread/start", { cwd: root });

  await provider.rpc("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "سلام" }],
  });
  await waitForTurn(provider, thread.id, "completed");

  const usageEvent = events.find(
    (event) => event.method === "thread/tokenUsage/updated",
  );
  assert.equal(usageEvent.params.tokenUsage.last.totalTokens, 1_250);
  assert.equal(usageEvent.params.tokenUsage.modelContextWindow, 200_000);
  assert.equal(usageEvent.params.provider, "claude");

  // The snapshot survives a reload so an already-open conversation keeps its bar.
  const reread = await provider.rpc("thread/read", { threadId: thread.id });
  assert.equal(reread.tokenUsage.last.totalTokens, 1_250);

  const limits = await provider.rpc("account/rateLimits/read", {});
  const bucket = limits.rateLimitsByLimitId.claude;
  assert.equal(bucket.usageUnavailable, true);
  assert.equal(bucket.windowDurationMins, 300);
  assert.equal(bucket.resetsAt, 1_786_119_000);
  assert.equal(bucket.rateLimitReachedType, undefined);
});

test("compact runs as a control turn without adding chat messages", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "codex-web-claude-compact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logFile = configureFake(t, root);
  const events = [];
  const provider = new ClaudeProvider(providerOptions(root, events));
  t.after(() => provider.stop());
  await provider.load();
  const { thread } = await provider.rpc("thread/start", { cwd: root });

  await assert.rejects(
    provider.rpc("thread/compact/start", { threadId: thread.id }),
    /هنوز پیامی ندارد/,
  );

  await provider.rpc("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "سلام" }],
  });
  await waitForTurn(provider, thread.id, "completed");

  await provider.rpc("thread/compact/start", { threadId: thread.id });
  const compactTurn = await waitFor(async () => {
    const result = await provider.rpc("thread/read", { threadId: thread.id });
    const turn = result.thread.turns.at(-1);
    return turn?.status === "completed" && turn.items[0]?.type === "contextCompaction"
      ? turn
      : null;
  });

  assert.deepEqual(
    compactTurn.items.map((item) => item.type),
    ["contextCompaction"],
  );
  assert.equal(compactTurn.items[0].status, "completed");
  const deltas = events.filter(
    (event) =>
      event.method === "item/agentMessage/delta" &&
      event.params.itemId === compactTurn.items[0].id,
  );
  assert.deepEqual(deltas, []);

  const prompts = (await readLog(logFile))
    .filter((entry) => entry.event === "start")
    .map((entry) => entry.prompt);
  assert.equal(prompts.at(-1), "/compact");
});

test("an active goal is restated to the CLI and accumulates progress", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "codex-web-claude-goal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logFile = configureFake(t, root);
  const events = [];
  const provider = new ClaudeProvider(providerOptions(root, events));
  t.after(() => provider.stop());
  await provider.load();
  const { thread } = await provider.rpc("thread/start", { cwd: root });

  assert.deepEqual(await provider.rpc("thread/goal/get", { threadId: thread.id }), {
    goal: null,
  });
  await assert.rejects(
    provider.rpc("thread/goal/set", { threadId: thread.id, objective: "   " }),
    /خالی/,
  );
  await assert.rejects(
    provider.rpc("thread/goal/set", { threadId: thread.id, objective: "x", status: "done" }),
    /وضعیت هدف نامعتبر/,
  );

  const { goal } = await provider.rpc("thread/goal/set", {
    threadId: thread.id,
    objective: "همهٔ تست‌ها سبز شوند",
    status: "active",
  });
  assert.equal(goal.status, "active");
  assert.equal(goal.tokensUsed, 0);

  await provider.rpc("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "ادامه بده" }],
    developerInstructions: "به فارسی پاسخ بده",
  });
  await waitForTurn(provider, thread.id, "completed");

  const start = (await readLog(logFile)).filter((entry) => entry.event === "start").at(-1);
  const appended = start.args[start.args.indexOf("--append-system-prompt") + 1];
  assert.match(appended, /به فارسی پاسخ بده/);
  assert.match(appended, /همهٔ تست‌ها سبز شوند/);

  const progressed = await waitFor(async () => {
    const result = await provider.rpc("thread/goal/get", { threadId: thread.id });
    return result.goal?.tokensUsed > 0 ? result.goal : null;
  });
  assert.equal(progressed.tokensUsed, 1_250);
  assert.equal(progressed.timeUsedSeconds, 4);

  // A paused goal stops shaping the conversation.
  await provider.rpc("thread/goal/set", { threadId: thread.id, status: "paused" });
  await provider.rpc("turn/start", {
    threadId: thread.id,
    input: [{ type: "text", text: "فقط یک سؤال" }],
  });
  await waitForTurn(provider, thread.id, "completed");
  const paused = (await readLog(logFile)).filter((entry) => entry.event === "start").at(-1);
  assert.equal(paused.args.includes("--append-system-prompt"), false);

  await provider.rpc("thread/goal/clear", { threadId: thread.id });
  assert.deepEqual(await provider.rpc("thread/goal/get", { threadId: thread.id }), {
    goal: null,
  });

  // The goal survives a provider restart from the same store.
  await provider.rpc("thread/goal/set", { threadId: thread.id, objective: "دوباره" });
  await provider.stop();
  const restarted = new ClaudeProvider(providerOptions(root, []));
  t.after(() => restarted.stop());
  await restarted.load();
  const restored = await restarted.rpc("thread/goal/get", { threadId: thread.id });
  assert.equal(restored.goal.objective, "دوباره");
});

test("a conversation started here adopts the title Claude writes to its transcript", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "codex-web-claude-title-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  configureFake(t, root);
  const events = [];
  const provider = new ClaudeProvider(providerOptions(root, events));
  await provider.load();

  const started = await provider.rpc("thread/start", { cwd: root });
  const id = started.thread.id.replace(/^claude:/, "");
  assert.equal(started.thread.name, "گفتگوی Claude");

  // Claude Code writes the session file; only native threads used to read it.
  const projectDir = join(root, "claude-config", "projects", "project");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, `${id}.jsonl`),
    [
      JSON.stringify({
        type: "user",
        uuid: "user",
        cwd: root,
        timestamp: "2026-07-27T00:00:00.000Z",
        message: { content: "رفع باگ احراز هویت" },
      }),
      JSON.stringify({ type: "ai-title", aiTitle: "رفع باگ لاگین در سرویس auth" }),
    ].join("\n") + "\n",
  );

  await provider.rpc("turn/start", {
    threadId: `claude:${id}`,
    input: [{ type: "text", text: "رفع باگ احراز هویت" }],
  });
  await waitForTurn(provider, `claude:${id}`, "completed");

  const listed = await provider.rpc("thread/list", { limit: 10 });
  const thread = listed.data.find((candidate) => candidate.id === `claude:${id}`);
  assert.equal(thread.name, "رفع باگ لاگین در سرویس auth");
  assert.ok(
    events.some(
      (event) =>
        event.method === "thread/name/updated" &&
        event.params.name === "رفع باگ لاگین در سرویس auth",
    ),
    "renaming should be announced so the open conversation updates",
  );
  await provider.stop();
});

test("adopting a transcript title never overwrites a name the user chose", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "codex-web-claude-title-keep-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = new ClaudeProvider(providerOptions(root));
  await provider.load();

  const started = await provider.rpc("thread/start", { cwd: root });
  const id = started.thread.id.replace(/^claude:/, "");
  await provider.rpc("thread/setName", {
    threadId: `claude:${id}`,
    name: "نام دستی",
  });

  const projectDir = join(root, "claude-config", "projects", "project");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, `${id}.jsonl`),
    `${JSON.stringify({ type: "ai-title", aiTitle: "عنوان خودکار" })}\n`,
  );

  const listed = await provider.rpc("thread/list", { limit: 10 });
  const thread = listed.data.find((candidate) => candidate.id === `claude:${id}`);
  assert.equal(thread.name, "نام دستی");
  await provider.stop();
});
