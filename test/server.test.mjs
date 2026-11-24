import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER = join(ROOT, "server.mjs");
const FAKE_CODEX = join(ROOT, "test-support", "fake-codex.mjs");
const FAKE_CLAUDE = join(ROOT, "test-support", "fake-claude.mjs");

async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  listener.close();
  await once(listener, "close");
  return port;
}

async function waitForReady(baseUrl, child) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Codex Web exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok && (await response.json()).ready) return;
    } catch {
      // The HTTP listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("Timed out waiting for Codex Web");
}

async function stopChild(child) {
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      if (child.exitCode === null) child.kill(signal);
    }
  };

  signalGroup("SIGTERM");
  if (child.exitCode === null) {
    let stopTimer;
    try {
      await Promise.race([
        once(child, "exit"),
        new Promise((_, reject) => {
          stopTimer = setTimeout(
            () => reject(new Error("Codex Web did not stop")),
            4_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(stopTimer);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  signalGroup("SIGKILL");
}

async function waitFor(check, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("Timed out waiting for condition");
}

test("CLI exposes help and version without starting the server", async () => {
  const packageInfo = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));

  const version = spawn(process.execPath, [SERVER, "--version"]);
  let versionOutput = "";
  version.stdout.on("data", (chunk) => {
    versionOutput += chunk;
  });
  assert.equal((await once(version, "exit"))[0], 0);
  assert.equal(versionOutput.trim(), packageInfo.version);

  const help = spawn(process.execPath, [SERVER, "--help"]);
  let helpOutput = "";
  help.stdout.on("data", (chunk) => {
    helpOutput += chunk;
  });
  assert.equal((await once(help, "exit"))[0], 0);
  assert.match(helpOutput, /Usage:\s+codex-web/);
  assert.match(helpOutput, /always listens on 127\.0\.0\.1/);
  assert.match(helpOutput, /--remote\s+Share privately through Tailscale Serve/);
  assert.match(helpOutput, /CODEX_WEB_REMOTE_PORT/);
});

test("server starts with a fake Codex bridge and enforces local security boundaries", async (t) => {
  const temporaryRoot = await mkdtemp(join(os.tmpdir(), "codex-web-test-"));
  const codexHome = join(temporaryRoot, "codex-home");
  const cacheHome = join(temporaryRoot, "cache");
  const argsFile = join(temporaryRoot, "args.json");
  const messagesFile = join(temporaryRoot, "messages.ndjson");
  const profilePath = join(codexHome, "test.config.toml");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  await mkdir(codexHome, { recursive: true });
  await writeFile(
    profilePath,
    'model = "test-model"\nmodel_reasoning_effort = "low"\n\n[features]\nexample = true\n',
  );
  await chmod(FAKE_CODEX, 0o755);

  const child = spawn(
    process.execPath,
    [SERVER, "--no-open", "-p", "test", "--yolo", "--search"],
    {
      cwd: temporaryRoot,
      env: {
        ...process.env,
        CODEX_BIN: FAKE_CODEX,
        CODEX_HOME: codexHome,
        CODEX_WEB_CWD: temporaryRoot,
        CODEX_WEB_PORT: String(port),
        XDG_CACHE_HOME: cacheHome,
        FAKE_CODEX_ARGS_FILE: argsFile,
        FAKE_CODEX_MESSAGES_FILE: messagesFile,
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(async () => {
    await stopChild(child);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  await waitForReady(baseUrl, child);

  const statusResponse = await fetch(`${baseUrl}/api/status`);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.ready, true);
  assert.equal(status.cwd, temporaryRoot);

  await mkdir(join(codexHome, "skills", "weekly-report"), { recursive: true });
  await writeFile(
    join(codexHome, "skills", "weekly-report", "SKILL.md"),
    "---\nname: weekly-report\ndescription: گزارش هفتگی\n---\n",
  );
  const commandsResponse = await fetch(
    `${baseUrl}/api/agent-commands?provider=codex&cwd=${encodeURIComponent(temporaryRoot)}`,
  );
  assert.equal(commandsResponse.status, 200);
  const commands = await commandsResponse.json();
  assert.equal(commands.cwd, temporaryRoot);
  assert.deepEqual(
    commands.commands.map(({ name, kind, scope }) => ({ name, kind, scope })),
    [{ name: "weekly-report", kind: "skill", scope: "user" }],
  );

  const relativeCwdResponse = await fetch(
    `${baseUrl}/api/agent-commands?provider=claude&cwd=../escape`,
  );
  assert.equal(relativeCwdResponse.status, 200);
  assert.equal((await relativeCwdResponse.json()).cwd, temporaryRoot);

  const pageResponse = await fetch(`${baseUrl}/`);
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /Codex Web/);

  const traversalResponse = await fetch(`${baseUrl}/..%2Fserver.mjs`);
  assert.equal(traversalResponse.status, 403);

  const crossOriginResponse = await fetch(`${baseUrl}/api/status`, {
    headers: { Origin: "https://attacker.example" },
  });
  assert.equal(crossOriginResponse.status, 403);

  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
  ]);
  const uploadResponse = await fetch(`${baseUrl}/api/uploads/images`, {
    method: "POST",
    headers: {
      "Content-Type": "image/png",
      "X-File-Name": encodeURIComponent("نمونه.png"),
    },
    body: png,
  });
  assert.equal(uploadResponse.status, 201);
  const upload = await uploadResponse.json();
  assert.equal(upload.path.startsWith(join(cacheHome, "codex-web", "uploads")), true);
  assert.deepEqual(await readFile(upload.path), png);
  assert.equal((await stat(upload.path)).mode & 0o777, 0o600);

  const markdownFile = Buffer.from("# dropped notes\n", "utf8");
  const fileUploadResponse = await fetch(`${baseUrl}/api/uploads/files`, {
    method: "POST",
    headers: {
      "Content-Type": "text/markdown",
      "X-File-Name": encodeURIComponent("یادداشت‌ها.md"),
    },
    body: markdownFile,
  });
  assert.equal(fileUploadResponse.status, 201);
  const fileUpload = await fileUploadResponse.json();
  assert.equal(fileUpload.path.startsWith(join(cacheHome, "codex-web", "uploads")), true);
  assert.equal(fileUpload.path.endsWith(".md"), true);
  assert.deepEqual(await readFile(fileUpload.path), markdownFile);
  assert.equal((await stat(fileUpload.path)).mode & 0o777, 0o600);

  const invalidUploadResponse = await fetch(`${baseUrl}/api/uploads/images`, {
    method: "POST",
    headers: {
      "Content-Type": "image/png",
      "X-File-Name": "invalid.png",
    },
    body: Buffer.from("not a png"),
  });
  assert.equal(invalidUploadResponse.status, 415);

  const threadResponse = await fetch(`${baseUrl}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "thread/start", params: { cwd: temporaryRoot } }),
  });
  assert.equal(threadResponse.status, 200);
  assert.equal((await threadResponse.json()).result.thread.id, "test-thread");

  const compactResponse = await fetch(`${baseUrl}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "thread/compact/start",
      params: { threadId: "test-thread" },
    }),
  });
  assert.equal(compactResponse.status, 200);
  assert.deepEqual(await compactResponse.json(), { result: {} });

  for (const [method, params] of [
    ["collaborationMode/list", {}],
    ["thread/settings/update", { threadId: "test-thread", collaborationMode: null }],
    ["thread/goal/get", { threadId: "test-thread" }],
    ["thread/goal/set", { threadId: "test-thread", objective: "هدف تست", status: "active" }],
    ["thread/goal/clear", { threadId: "test-thread" }],
  ]) {
    const response = await fetch(`${baseUrl}/api/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
    assert.equal(response.status, 200);
  }

  const rejectedMethod = "thread/delete";
  const rejectedRpcResponse = await fetch(`${baseUrl}/api/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: rejectedMethod,
      params: { threadId: "test-thread" },
    }),
  });
  assert.equal(rejectedRpcResponse.status, 403);
  assert.deepEqual(await rejectedRpcResponse.json(), {
    error: `RPC method is not allowed: ${rejectedMethod}`,
  });

  const childArgs = JSON.parse(await readFile(argsFile, "utf8"));
  assert.deepEqual(childArgs.slice(-2), ["app-server", "--stdio"]);
  assert.equal(childArgs.includes('model="test-model"'), true);
  assert.equal(childArgs.includes('model_reasoning_effort="low"'), true);
  assert.equal(childArgs.includes('web_search="live"'), true);
  assert.equal(childArgs.includes("features.example=true"), false);

  const messages = (await readFile(messagesFile, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  const threadStart = messages.find((message) => message.method === "thread/start");
  assert.equal(threadStart.params.approvalPolicy, "never");
  assert.equal(threadStart.params.sandbox, "danger-full-access");
  const compactStart = messages.find(
    (message) => message.method === "thread/compact/start",
  );
  assert.deepEqual(compactStart?.params, { threadId: "test-thread" });
  for (const method of [
    "collaborationMode/list",
    "thread/settings/update",
    "thread/goal/get",
    "thread/goal/set",
    "thread/goal/clear",
  ]) {
    assert.equal(messages.some((message) => message.method === method), true);
  }
  assert.equal(
    messages.some((message) => message.method === rejectedMethod),
    false,
  );
});

test("Claude provider supports sessions, streaming, resume, and merged thread listing", async (t) => {
  const temporaryRoot = await mkdtemp(join(os.tmpdir(), "codex-web-claude-test-"));
  const cacheHome = join(temporaryRoot, "cache");
  const claudeDataDir = join(temporaryRoot, "claude-data");
  const claudeHome = join(temporaryRoot, "claude-home");
  const nativeProjectDir = join(claudeHome, "projects", "fake-project");
  const nativeSessionId = "11111111-1111-4111-8111-111111111111";
  const nativeTranscriptPath = join(nativeProjectDir, `${nativeSessionId}.jsonl`);
  const argsFile = join(temporaryRoot, "claude-args.json");
  const messagesFile = join(temporaryRoot, "claude-messages.ndjson");
  const profileHome = join(temporaryRoot, "torob-home");
  const profileArgsFile = join(temporaryRoot, "torob-args.json");
  const profilesFile = join(temporaryRoot, "claude-profiles.json");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  await chmod(FAKE_CODEX, 0o755);
  await chmod(FAKE_CLAUDE, 0o755);
  await mkdir(nativeProjectDir, { recursive: true });
  await mkdir(profileHome, { recursive: true });
  await writeFile(
    profilesFile,
    JSON.stringify([
      {
        id: "torob",
        label: "Torob",
        bin: FAKE_CLAUDE,
        configDir: profileHome,
        env: { FAKE_CLAUDE_ARGS_FILE: profileArgsFile },
      },
    ]),
  );
  await writeFile(
    nativeTranscriptPath,
    [
      {
        type: "user",
        uuid: "native-user",
        cwd: temporaryRoot,
        sessionId: nativeSessionId,
        timestamp: "2026-07-26T10:00:00.000Z",
        message: { role: "user", content: "پیام قبلی Claude" },
      },
      { type: "ai-title", sessionId: nativeSessionId, aiTitle: "گفتگوی قبلی Claude" },
      {
        type: "assistant",
        uuid: "native-assistant",
        message: {
          role: "assistant",
          content: "پاسخ قبلی Claude",
        },
      },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  const child = spawn(process.execPath, [SERVER, "--no-open"], {
    cwd: temporaryRoot,
    env: {
      ...process.env,
      CODEX_BIN: FAKE_CODEX,
      CLAUDE_BIN: FAKE_CLAUDE,
      CODEX_WEB_CWD: temporaryRoot,
      // CLAUDE_CONFIG_DIR wins over CLAUDE_HOME, so an inherited one (a shell
      // running under a non-default Claude profile) must not leak in.
      CLAUDE_CONFIG_DIR: claudeHome,
      CLAUDE_HOME: claudeHome,
      CLAUDE_WEB_DATA_DIR: claudeDataDir,
      CODEX_WEB_CLAUDE_PROFILES: profilesFile,
      CODEX_WEB_PORT: String(port),
      XDG_CACHE_HOME: cacheHome,
      FAKE_CLAUDE_ARGS_FILE: argsFile,
      FAKE_CLAUDE_MESSAGES_FILE: messagesFile,
      FAKE_CLAUDE_TRANSCRIPT_FILE: nativeTranscriptPath,
      FAKE_CLAUDE_NATIVE_SESSION_ID: nativeSessionId,
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    await stopChild(child);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  await waitForReady(baseUrl, child);
  const rpc = async (method, params = {}) => {
    const response = await fetch(`${baseUrl}/api/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };

  const started = await rpc("thread/start", {
    provider: "claude",
    cwd: temporaryRoot,
    model: "sonnet",
    permissionMode: "acceptEdits",
  });
  const threadId = started.thread.id;
  assert.match(threadId, /^claude:/);

  const firstClientUserMessageId = "claude-client-message-1";
  const firstTurn = await rpc("turn/start", {
    provider: "claude",
    threadId,
    clientUserMessageId: firstClientUserMessageId,
    input: [{ type: "text", text: "سلام" }],
  });
  assert.equal(firstTurn.turn.status, "inProgress");
  assert.equal(firstTurn.turn.items[0].clientId, firstClientUserMessageId);

  const firstRead = await waitFor(async () => {
    const result = await rpc("thread/read", { provider: "claude", threadId });
    return result.thread.turns.at(-1)?.status === "completed" ? result : null;
  });
  assert.match(firstRead.thread.turns.at(-1).items.at(-1).text, /سلام/);
  assert.equal(
    firstRead.thread.turns.at(-1).items[0].clientId,
    firstClientUserMessageId,
  );
  const firstArgs = JSON.parse(await readFile(argsFile, "utf8"));
  assert.equal(firstArgs.includes("--session-id"), true);
  assert.equal(firstArgs.includes("--output-format"), true);
  assert.equal(firstArgs.includes("stream-json"), true);

  await rpc("turn/start", {
    provider: "claude",
    threadId,
    input: [{ type: "text", text: "دوباره" }],
  });
  await waitFor(async () => {
    const result = await rpc("thread/read", { provider: "claude", threadId });
    return result.thread.turns.length === 2 && result.thread.turns.at(-1)?.status === "completed";
  });
  const secondArgs = JSON.parse(await readFile(argsFile, "utf8"));
  assert.equal(secondArgs.includes("--resume"), true);

  const merged = await rpc("thread/list");
  assert.equal(merged.data.some((thread) => thread.id === threadId), true);
  const nativeThreadId = `claude:${nativeSessionId}`;
  assert.equal(merged.data.some((thread) => thread.id === nativeThreadId), true);

  const nativeRead = await rpc("thread/read", {
    provider: "claude",
    threadId: nativeThreadId,
  });
  assert.equal(nativeRead.thread.name, "گفتگوی قبلی Claude");
  assert.match(nativeRead.thread.turns.at(-1).items.at(-1).text, /پاسخ قبلی/);

  await rpc("turn/start", {
    provider: "claude",
    threadId: nativeThreadId,
    input: [{ type: "text", text: "ادامه بده" }],
  });
  await waitFor(async () => {
    const result = await rpc("thread/read", {
      provider: "claude",
      threadId: nativeThreadId,
    });
    return result.thread.turns.length >= 2 && result.thread.turns.at(-1)?.status === "completed";
  });
  const nativeArgs = JSON.parse(await readFile(argsFile, "utf8"));
  assert.equal(nativeArgs.includes("--resume"), true);

  // The command list the CLI reported on its run is offered in the composer.
  const commandList = await (
    await fetch(`${baseUrl}/api/agent-commands?provider=claude&cwd=${encodeURIComponent(temporaryRoot)}`)
  ).json();
  const listed = commandList.commands.map((command) => command.name);
  assert.ok(listed.includes("init"));
  assert.ok(listed.includes("anthropic-skills:pdf"));
  assert.ok(!listed.includes("heapdump") && !listed.includes("__internal"));
  // A profile that has not run yet falls back to the headless built-ins.
  const profileCommands = await (
    await fetch(`${baseUrl}/api/agent-commands?provider=torob&cwd=${encodeURIComponent(temporaryRoot)}`)
  ).json();
  assert.equal(profileCommands.provider, "torob");
  assert.ok(profileCommands.commands.some((command) => command.name === "security-review"));
  assert.ok(!profileCommands.commands.some((command) => command.name === "anthropic-skills:pdf"));

  // A configured profile is its own provider: own ids, own env, own transcripts.
  const status = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.deepEqual(Object.keys(status.providers), ["codex", "claude", "torob"]);
  assert.equal(status.providers.torob.label, "Torob");
  assert.equal(status.providers.torob.family, "claude");

  const profileThread = await rpc("thread/start", { provider: "torob", cwd: temporaryRoot });
  const profileThreadId = profileThread.thread.id;
  assert.match(profileThreadId, /^torob:/);
  assert.equal(profileThread.thread.provider, "torob");
  // No `provider` param: the thread id prefix alone routes the request.
  await rpc("turn/start", { threadId: profileThreadId, input: [{ type: "text", text: "سلام" }] });
  await waitFor(async () => {
    const result = await rpc("thread/read", { threadId: profileThreadId });
    return result.thread.turns.at(-1)?.status === "completed";
  });
  assert.equal(Array.isArray(JSON.parse(await readFile(profileArgsFile, "utf8"))), true);

  const mergedWithProfile = await rpc("thread/list");
  const profileListed = mergedWithProfile.data.find((thread) => thread.id === profileThreadId);
  assert.equal(profileListed?.provider, "torob");
  assert.equal(mergedWithProfile.data.some((thread) => thread.id === threadId), true);
  assert.equal(
    mergedWithProfile.data.some((thread) => thread.id === `torob:${nativeSessionId}`),
    false,
    "the profile must not discover the default profile's transcripts",
  );
});
