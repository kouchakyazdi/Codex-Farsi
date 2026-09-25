import { constants as fsConstants, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const PUBLIC_PREFIX = "claude:";
const STORE_FILE = "conversations.json";
const STORE_LOCK_FILE = ".conversations.lock";
const TURN_LOCK_DIR = "turn-locks";
const DISCOVERY_CACHE_MS = 30_000;
const LOCK_WAIT_MS = 25;
const STORE_LOCK_TIMEOUT_MS = 5_000;
const TURN_LOCK_TIMEOUT_MS = 250;
const PROCESS_EXIT_GRACE_MS = 3_000;
const BINARY_STATUS_CACHE_MS = 5_000;

const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERMISSION_MODES = new Set([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
]);
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
// Placeholder used until Claude Code writes a title into the session file.
const DEFAULT_THREAD_NAME = "گفتگوی Claude";
const GOAL_STATUSES = new Set(["active", "paused"]);

const MODEL_OPTIONS = [
  { id: "sonnet", model: "sonnet", displayName: "Claude Sonnet" },
  { id: "opus", model: "opus", displayName: "Claude Opus" },
  { id: "haiku", model: "haiku", displayName: "Claude Haiku" },
];

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function executableAvailable(binary) {
  if (!binary) return false;
  const hasPathSeparator = binary.includes("/") || binary.includes("\\");
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  const candidates =
    hasPathSeparator || isAbsolute(binary)
      ? [binary]
      : (process.env.PATH || "")
          .split(delimiter)
          .filter(Boolean)
          .flatMap((directory) =>
            extensions.map((extension) => join(directory, `${binary}${extension}`)),
          );
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return true;
    } catch {
      // Keep searching PATH.
    }
  }
  return false;
}

async function readLock(path) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return { content: "", instanceId: "", pid: 0, token: "" };
  }
  try {
    const value = JSON.parse(content);
    return {
      content,
      instanceId: typeof value.instanceId === "string" ? value.instanceId : "",
      pid: Number(value.pid),
      token: typeof value.token === "string" ? value.token : "",
    };
  } catch {
    return { content, instanceId: "", pid: 0, token: "" };
  }
}

async function removeLockIfUnchanged(path, lock) {
  try {
    const current = await readFile(path, "utf8");
    if (current !== lock.content) return false;
    await unlink(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    return false;
  }
}

async function acquireFileLock(path, { instanceId, timeoutMs }) {
  const token = randomUUID();
  const content = JSON.stringify({
    createdAt: Date.now(),
    instanceId,
    pid: process.pid,
    token,
  });
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      await writeFile(path, content, { flag: "wx", mode: 0o600 });
      return async () => {
        const lock = await readLock(path);
        if (lock?.token === token && lock.instanceId === instanceId) {
          await removeLockIfUnchanged(path, lock);
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }

    const lock = await readLock(path);
    if (!lock || !isProcessAlive(lock.pid)) {
      const removed = !lock || (await removeLockIfUnchanged(path, lock));
      if (!removed) {
        if (Date.now() >= deadline) {
          const error = new Error("قفل Claude در دسترس نیست");
          error.status = 409;
          throw error;
        }
        await delay(LOCK_WAIT_MS);
      }
      continue;
    }
    if (Date.now() >= deadline) {
      const error = new Error("این گفتگوی Claude در یک پردازش دیگر در حال اجراست");
      error.status = 409;
      throw error;
    }
    await delay(LOCK_WAIT_MS);
  }
}

async function lockIsActive(path) {
  const lock = await readLock(path);
  if (!lock) return false;
  if (isProcessAlive(lock.pid)) return true;
  await removeLockIfUnchanged(path, lock);
  return false;
}

function validStoredThread(thread) {
  return (
    thread &&
    typeof thread === "object" &&
    SESSION_ID_PATTERN.test(String(thread.id || "")) &&
    typeof thread.cwd === "string" &&
    thread.cwd.length > 0
  );
}

function storedThread(thread) {
  const copy = JSON.parse(JSON.stringify(thread));
  delete copy.native;
  delete copy.transcriptPath;
  return copy;
}

function storedNativeMetadata(thread) {
  return {
    id: thread.id,
    ...(thread.nativeName ? { name: thread.nativeName } : {}),
    ...(thread.goal ? { goal: thread.goal } : {}),
    archived: Boolean(thread.archived),
    updatedAt: thread.updatedAt || nowSeconds(),
  };
}

// Claude Code has no persistent goal RPC, so an active goal is restated as a
// system prompt on every turn of the conversation.
function goalInstruction(objective) {
  return [
    "Persistent goal for this conversation:",
    objective,
    "Keep working toward this goal on every turn until it is met, even when the user's message does not mention it. Say so explicitly once it is met.",
  ].join("\n");
}

function normalizeGoal(value) {
  const objective = String(value?.objective || "").trim();
  if (!objective) return null;
  return {
    objective,
    status: GOAL_STATUSES.has(value?.status) ? value.status : "active",
    tokensUsed: Math.max(0, Math.trunc(Number(value?.tokensUsed) || 0)),
    timeUsedSeconds: Math.max(0, Math.trunc(Number(value?.timeUsedSeconds) || 0)),
  };
}

function validatePermissionMode(value) {
  if (value === undefined || value === null || value === "") return "";
  const permissionMode = String(value);
  if (!PERMISSION_MODES.has(permissionMode)) {
    throw new Error(`Claude permission mode نامعتبر است: ${permissionMode}`);
  }
  return permissionMode;
}

function validateEffort(value) {
  if (value === undefined || value === null || value === "") return "";
  const effort = String(value);
  if (!EFFORT_LEVELS.has(effort)) {
    throw new Error(`Claude effort نامعتبر است: ${effort}`);
  }
  return effort;
}

function publicId(rawId) {
  return rawId.startsWith(PUBLIC_PREFIX) ? rawId : `${PUBLIC_PREFIX}${rawId}`;
}

function rawId(value) {
  return String(value || "").startsWith(PUBLIC_PREFIX)
    ? String(value).slice(PUBLIC_PREFIX.length)
    : String(value || "");
}

function threadView(thread) {
  return {
    id: publicId(thread.id),
    provider: "claude",
    providerThreadId: thread.id,
    name: thread.name || DEFAULT_THREAD_NAME,
    cwd: thread.cwd,
    model: thread.model || "",
    permissionMode: thread.permissionMode || "",
    effort: thread.effort || "",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: thread.status || { type: "idle" },
    archived: Boolean(thread.archived),
  };
}

const RATE_LIMIT_WINDOW_MINUTES = {
  five_hour: 300,
  seven_day: 10_080,
  monthly: 43_200,
  opus_seven_day: 10_080,
};

// Claude Code reports which quota window is active and when it resets, but no
// percentage, so the snapshot carries no usage windows for the UI to chart.
function rateLimitsFromEvent(info) {
  if (!info || typeof info !== "object") return null;
  const resetsAt = Number(info.resetsAt);
  const rateLimitType = String(info.rateLimitType || "");
  const allowed = String(info.status || "allowed") === "allowed";
  return {
    rateLimitsByLimitId: {
      claude: {
        limitId: "claude",
        limitName: "Claude",
        usageUnavailable: true,
        allowed,
        isUsingOverage: Boolean(info.isUsingOverage),
        ...(rateLimitType ? { rateLimitType } : {}),
        ...(RATE_LIMIT_WINDOW_MINUTES[rateLimitType]
          ? { windowDurationMins: RATE_LIMIT_WINDOW_MINUTES[rateLimitType] }
          : {}),
        ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
        ...(allowed ? {} : { rateLimitReachedType: "rate_limit_reached" }),
      },
    },
  };
}

// Maps the `usage` block of a stream-json `result` message onto the token
// usage shape the web UI already renders for Codex.
function tokenUsageFromResult(message) {
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") return null;
  const totalTokens =
    (Number(usage.input_tokens) || 0) +
    (Number(usage.cache_creation_input_tokens) || 0) +
    (Number(usage.cache_read_input_tokens) || 0) +
    (Number(usage.output_tokens) || 0);
  if (totalTokens <= 0) return null;
  const contextWindows = Object.values(message.modelUsage || {})
    .map((entry) => Number(entry?.contextWindow) || 0)
    .filter((value) => value > 0);
  return {
    last: { totalTokens },
    ...(contextWindows.length
      ? { modelContextWindow: Math.max(...contextWindows) }
      : {}),
  };
}

function normalizeTokenUsage(value) {
  const totalTokens = Number(value?.last?.totalTokens);
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return null;
  const windowSize = Number(value?.modelContextWindow);
  return {
    last: { totalTokens },
    ...(Number.isFinite(windowSize) && windowSize > 0
      ? { modelContextWindow: windowSize }
      : {}),
  };
}

function textFromInput(input) {
  return (input || [])
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text || "";
      if (part?.type === "image" || part?.type === "localImage") {
        return `[تصویر: ${part.path || part.url || "image"}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function messageContentBlocks(content) {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  return Array.isArray(content) ? content : [];
}

function messageText(content) {
  return messageContentBlocks(content)
    .filter((part) => part?.type === "text")
    .map((part) => part.text || "")
    .filter(Boolean)
    .join("\n");
}

function turnUserText(turn) {
  const userItem = (turn?.items || []).find((item) => item?.type === "userMessage");
  return userItem ? messageText(userItem.content) : "";
}

async function transcriptSummary(filePath) {
  let firstPrompt = "";
  let title = "";
  let cwd = "";
  let createdAt = 0;
  try {
    const info = await stat(filePath);
    const input = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    });
    let lines = 0;
    for await (const line of input) {
      if (++lines > 120) break;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!createdAt && entry.timestamp) {
        const timestamp = Date.parse(entry.timestamp);
        if (Number.isFinite(timestamp)) createdAt = Math.floor(timestamp / 1000);
      }
      cwd ||= entry.cwd || "";
      if (entry.type === "ai-title" && entry.aiTitle) title = entry.aiTitle;
      if (entry.type === "custom-title" && entry.customTitle) title = entry.customTitle;
      if (
        !firstPrompt &&
        entry.type === "user" &&
        !entry.isMeta &&
        !entry.isCompactSummary
      ) {
        firstPrompt = messageText(entry.message?.content);
      }
      if (title && firstPrompt && cwd) break;
    }
    input.close();
    return {
      cwd,
      createdAt: createdAt || Math.floor(info.birthtimeMs / 1000),
      firstPrompt,
      title,
      updatedAt: Math.floor(info.mtimeMs / 1000),
    };
  } catch {
    return null;
  }
}

async function findTranscripts(root, output = []) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    if (entry.name === "subagents") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await findTranscripts(path, output);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".jsonl") &&
      SESSION_ID_PATTERN.test(basename(entry.name, ".jsonl"))
    ) {
      output.push(path);
    }
  }
  return output;
}

export class ClaudeProvider {
  constructor({
    binary,
    cacheDir,
    claudeConfigDir,
    claudeHome,
    emit,
    log,
    processExitGraceMs = PROCESS_EXIT_GRACE_MS,
    turnLockTimeoutMs = TURN_LOCK_TIMEOUT_MS,
  }) {
    this.binary = binary;
    this.cacheDir = cacheDir;
    this.claudeConfigDir = claudeConfigDir || claudeHome;
    this.emit = emit;
    this.log = log;
    this.processExitGraceMs = processExitGraceMs;
    this.turnLockTimeoutMs = turnLockTimeoutMs;
    this.instanceId = randomUUID();
    this.threads = new Map();
    this.nativeMetadata = new Map();
    this.processes = new Map();
    this.dirtyThreadFields = new Map();
    this.dirtyNativeFields = new Map();
    this.threadRevisions = new Map();
    this.nativeRevisions = new Map();
    this.loadPromise = null;
    this.loaded = false;
    this.writeChain = Promise.resolve();
    this.discoveryPromise = null;
    this.lastDiscoveryAt = 0;
    this.binaryCheck = { at: 0, available: false, promise: null };
    this.rateLimits = null;
    this.stopping = false;
  }

  async #readStore() {
    try {
      const content = await readFile(join(this.cacheDir, STORE_FILE), "utf8");
      const data = JSON.parse(content);
      if (!data || typeof data !== "object") throw new Error("Invalid Claude store");
      return data;
    } catch (error) {
      if (error.code === "ENOENT") {
        return { version: 2, threads: [], nativeMetadata: [] };
      }
      throw error;
    }
  }

  #normalizeThread(value) {
    if (!validStoredThread(value)) return null;
    const thread = JSON.parse(JSON.stringify(value));
    thread.id = String(thread.id);
    thread.cwd = String(thread.cwd);
    thread.name = String(thread.name || DEFAULT_THREAD_NAME);
    thread.model = typeof thread.model === "string" ? thread.model : "";
    try {
      thread.permissionMode = validatePermissionMode(thread.permissionMode);
    } catch {
      thread.permissionMode = "";
    }
    try {
      thread.effort = validateEffort(thread.effort);
    } catch {
      thread.effort = "";
    }
    thread.tokenUsage = normalizeTokenUsage(thread.tokenUsage);
    if (!thread.tokenUsage) delete thread.tokenUsage;
    thread.goal = normalizeGoal(thread.goal);
    if (!thread.goal) delete thread.goal;
    thread.turns = Array.isArray(thread.turns) ? thread.turns : [];
    thread.createdAt = Number(thread.createdAt) || nowSeconds();
    thread.updatedAt = Number(thread.updatedAt) || thread.createdAt;
    thread.status =
      thread.status?.type === "active" ? { type: "active" } : { type: "idle" };
    thread.archived = Boolean(thread.archived);
    thread.sessionInitialized =
      typeof thread.sessionInitialized === "boolean"
        ? thread.sessionInitialized
        : thread.turns.length > 0;
    delete thread.native;
    delete thread.transcriptPath;
    return thread;
  }

  #mergeStoreData(data, { initial = false, onlyThreadId = null } = {}) {
    for (const value of Array.isArray(data.threads) ? data.threads : []) {
      const incoming = this.#normalizeThread(value);
      if (!incoming || (onlyThreadId && incoming.id !== onlyThreadId)) continue;
      const current = this.threads.get(incoming.id);
      if (
        !current ||
        initial ||
        (!current.native &&
          !this.processes.has(incoming.id) &&
          !this.dirtyThreadFields.has(incoming.id))
      ) {
        if (current && !current.native) Object.assign(current, incoming);
        else this.threads.set(incoming.id, incoming);
      }
    }

    if (onlyThreadId) return;
    for (const value of Array.isArray(data.nativeMetadata) ? data.nativeMetadata : []) {
      if (!SESSION_ID_PATTERN.test(String(value?.id || ""))) continue;
      const id = String(value.id);
      const goal = normalizeGoal(value.goal);
      const incoming = {
        id,
        ...(typeof value.name === "string" && value.name ? { name: value.name } : {}),
        ...(goal ? { goal } : {}),
        archived: Boolean(value.archived),
        updatedAt: Number(value.updatedAt) || 0,
      };
      const dirtyFields = initial ? null : this.dirtyNativeFields.get(id);
      const current = this.nativeMetadata.get(id);
      const metadata =
        dirtyFields && current
          ? (() => {
              const merged = { ...incoming };
              for (const field of dirtyFields) {
                if (Object.hasOwn(current, field)) merged[field] = current[field];
                else delete merged[field];
              }
              return merged;
            })()
          : incoming;
      this.nativeMetadata.set(id, metadata);
      const nativeThread = this.threads.get(id);
      if (nativeThread?.native) {
        nativeThread.nativeName =
          typeof metadata.name === "string" && metadata.name ? metadata.name : "";
        nativeThread.name =
          nativeThread.nativeName || nativeThread.name || DEFAULT_THREAD_NAME;
        if (metadata.goal) nativeThread.goal = metadata.goal;
        else delete nativeThread.goal;
        nativeThread.archived = Boolean(metadata.archived);
        nativeThread.updatedAt = Math.max(
          nativeThread.updatedAt || 0,
          Number(metadata.updatedAt) || 0,
        );
      }
    }
  }

  async #refreshPlaceholderName(thread) {
    if (thread.nativeName) return;
    if (thread.name && thread.name !== DEFAULT_THREAD_NAME) return;
    try {
      if (thread.transcriptPath) {
        this.#adoptTranscriptName(thread, await transcriptSummary(thread.transcriptPath));
      }
      if (thread.name === DEFAULT_THREAD_NAME) {
        await this.discoverNativeThreads({ force: true });
      }
      if (thread.name !== DEFAULT_THREAD_NAME) await this.persist();
    } catch (error) {
      this.log(`Could not read the Claude conversation title: ${error.message}`);
    }
  }

  #adoptTranscriptName(thread, summary) {
    if (thread.nativeName) return;
    if (thread.name && thread.name !== DEFAULT_THREAD_NAME) return;
    const name = String(summary?.title || summary?.firstPrompt || "").trim();
    if (!name || name === thread.name) return;
    thread.name = name.length > 80 ? `${name.slice(0, 80)}…` : name;
    this.#markThreadDirty(thread, ["name"]);
    this.notify("thread/name/updated", {
      threadId: publicId(thread.id),
      name: thread.name,
      threadName: thread.name,
    });
  }

  #markThreadDirty(thread, fields = ["*"]) {
    const current = this.dirtyThreadFields.get(thread.id) || new Set();
    for (const field of fields) current.add(field);
    this.dirtyThreadFields.set(thread.id, current);
    this.threadRevisions.set(thread.id, (this.threadRevisions.get(thread.id) || 0) + 1);
  }

  #markNativeDirty(thread, fields = ["*"]) {
    this.nativeMetadata.set(thread.id, storedNativeMetadata(thread));
    const current = this.dirtyNativeFields.get(thread.id) || new Set();
    for (const field of fields) current.add(field);
    this.dirtyNativeFields.set(thread.id, current);
    this.nativeRevisions.set(thread.id, (this.nativeRevisions.get(thread.id) || 0) + 1);
  }

  #turnLockPath(threadId) {
    return join(this.cacheDir, TURN_LOCK_DIR, `${threadId}.lock`);
  }

  async #recoverOrphanedThreads() {
    for (const thread of this.threads.values()) {
      if (thread.native) continue;
      const hasRunningTurn = (thread.turns || []).some(
        (turn) => turn?.status === "inProgress",
      );
      if (thread.status?.type !== "active" && !hasRunningTurn) continue;
      if (await lockIsActive(this.#turnLockPath(thread.id))) continue;

      const completedAt = nowSeconds();
      for (const turn of thread.turns || []) {
        if (turn?.status !== "inProgress") continue;
        turn.status = "interrupted";
        turn.completedAt = completedAt;
        turn.error = {
          message: "پردازش Claude پیش از پایان گفتگو متوقف شده است",
        };
        for (const item of turn.items || []) {
          if (item?.status === "inProgress") item.status = "interrupted";
        }
      }
      thread.status = { type: "idle" };
      thread.updatedAt = completedAt;
      delete thread.activeOwner;
      this.#markThreadDirty(thread, [
        "turns",
        "status",
        "updatedAt",
        "activeOwner",
      ]);
    }
  }

  async #loadInternal() {
    try {
      this.#mergeStoreData(await this.#readStore(), { initial: true });
    } catch (error) {
      this.log(`Could not load Claude conversations: ${error.message}`);
    }
    await this.discoverNativeThreads({ force: true });
    await this.#recoverOrphanedThreads();
    this.loaded = true;
    if (this.dirtyThreadFields.size || this.dirtyNativeFields.size) {
      try {
        await this.#queuePersist();
      } catch (error) {
        this.log(`Could not persist recovered Claude conversations: ${error.message}`);
      }
    }
  }

  async load() {
    if (!this.loadPromise) {
      this.loadPromise = this.#loadInternal().catch((error) => {
        this.loadPromise = null;
        throw error;
      });
    }
    return this.loadPromise;
  }

  async #refreshStore({ onlyThreadId = null } = {}) {
    try {
      this.#mergeStoreData(await this.#readStore(), { onlyThreadId });
    } catch (error) {
      this.log(`Could not refresh Claude conversations: ${error.message}`);
    }
  }

  async #writeDirtyStore() {
    if (!this.dirtyThreadFields.size && !this.dirtyNativeFields.size) return;
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    await chmod(this.cacheDir, 0o700);
    const releaseLock = await acquireFileLock(join(this.cacheDir, STORE_LOCK_FILE), {
      instanceId: this.instanceId,
      timeoutMs: STORE_LOCK_TIMEOUT_MS,
    });
    let temporary = "";
    try {
      const disk = await this.#readStore();
      const diskThreads = new Map();
      for (const value of Array.isArray(disk.threads) ? disk.threads : []) {
        const normalized = this.#normalizeThread(value);
        if (normalized) diskThreads.set(normalized.id, normalized);
      }
      const diskNativeMetadata = new Map();
      for (const value of Array.isArray(disk.nativeMetadata) ? disk.nativeMetadata : []) {
        if (SESSION_ID_PATTERN.test(String(value?.id || ""))) {
          diskNativeMetadata.set(String(value.id), value);
        }
      }

      const threadSnapshot = new Map(
        [...this.dirtyThreadFields.entries()].map(([id, fields]) => [
          id,
          {
            fields: new Set(fields),
            revision: this.threadRevisions.get(id) || 0,
          },
        ]),
      );
      const nativeSnapshot = new Map(
        [...this.dirtyNativeFields.entries()].map(([id, fields]) => [
          id,
          {
            fields: new Set(fields),
            revision: this.nativeRevisions.get(id) || 0,
          },
        ]),
      );

      for (const [id, snapshot] of threadSnapshot) {
        const thread = this.threads.get(id);
        if (!thread || thread.native) continue;
        const current = storedThread(thread);
        if (snapshot.fields.has("*") || !diskThreads.has(id)) {
          diskThreads.set(id, current);
          continue;
        }
        const merged = { ...diskThreads.get(id) };
        for (const field of snapshot.fields) {
          if (Object.hasOwn(current, field)) merged[field] = current[field];
          else delete merged[field];
        }
        diskThreads.set(id, merged);
      }
      for (const [id, snapshot] of nativeSnapshot) {
        const metadata = this.nativeMetadata.get(id);
        if (!metadata) continue;
        if (snapshot.fields.has("*") || !diskNativeMetadata.has(id)) {
          diskNativeMetadata.set(id, metadata);
          continue;
        }
        const merged = { ...diskNativeMetadata.get(id) };
        for (const field of snapshot.fields) {
          if (Object.hasOwn(metadata, field)) merged[field] = metadata[field];
          else delete merged[field];
        }
        diskNativeMetadata.set(id, merged);
      }

      temporary = join(
        this.cacheDir,
        `${STORE_FILE}.${process.pid}.${randomUUID()}.tmp`,
      );
      await writeFile(
        temporary,
        JSON.stringify(
          {
            version: 2,
            threads: [...diskThreads.values()],
            nativeMetadata: [...diskNativeMetadata.values()],
          },
          null,
          2,
        ),
        { flag: "wx", mode: 0o600 },
      );
      await rename(temporary, join(this.cacheDir, STORE_FILE));
      temporary = "";

      for (const [id, snapshot] of threadSnapshot) {
        if ((this.threadRevisions.get(id) || 0) === snapshot.revision) {
          this.dirtyThreadFields.delete(id);
        }
      }
      for (const [id, snapshot] of nativeSnapshot) {
        if ((this.nativeRevisions.get(id) || 0) === snapshot.revision) {
          this.dirtyNativeFields.delete(id);
        }
      }
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      await releaseLock().catch((error) => {
        this.log(`Could not release Claude store lock: ${error.message}`);
      });
    }
  }

  #queuePersist() {
    const operation = this.writeChain
      .catch(() => {})
      .then(() => this.#writeDirtyStore());
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  async persist() {
    await this.load();
    return this.#queuePersist();
  }

  async #binaryAvailable() {
    const now = Date.now();
    if (
      this.binaryCheck.promise ||
      now - this.binaryCheck.at < BINARY_STATUS_CACHE_MS
    ) {
      return this.binaryCheck.promise || this.binaryCheck.available;
    }
    const promise = executableAvailable(this.binary);
    this.binaryCheck.promise = promise;
    try {
      this.binaryCheck.available = await promise;
      this.binaryCheck.at = Date.now();
      return this.binaryCheck.available;
    } finally {
      this.binaryCheck.promise = null;
    }
  }

  async status() {
    const available = await this.#binaryAvailable();
    return {
      ready: available,
      available,
      binary: this.binary,
      message: available ? "Claude Code CLI آماده است" : "Claude Code CLI پیدا نشد",
    };
  }

  async rpc(method, params = {}) {
    await this.load();
    switch (method) {
      case "account/read":
        return { account: null };
      case "account/rateLimits/read":
        return this.rateLimits || { rateLimitsByLimitId: {} };
      case "model/list":
        return { data: MODEL_OPTIONS, nextCursor: null };
      case "thread/list":
        return this.listThreads(params);
      case "thread/read":
      case "thread/resume":
        return this.readThread(params.threadId);
      case "thread/start":
        return this.startThread(params);
      case "thread/archive":
      case "thread/unarchive":
        return this.archiveThread(params, method === "thread/archive");
      case "thread/setName":
        return this.setName(params);
      case "thread/compact/start":
        return this.compactThread(params);
      case "thread/goal/get":
        return { goal: this.#requireThread(params.threadId).goal || null };
      case "thread/goal/set":
        return this.setGoal(params);
      case "thread/goal/clear":
        return this.clearGoal(params);
      case "turn/start":
        return this.startTurn(params);
      case "turn/interrupt":
        return this.interruptTurn(params);
      case "turn/steer":
        throw new Error("Claude Code Web هنوز steer کردن turn را پشتیبانی نمی‌کند");
      default:
        throw new Error(`Claude provider does not support ${method}`);
    }
  }

  async listThreads(params) {
    await this.#refreshStore();
    await this.#recoverOrphanedThreads();
    if (this.dirtyThreadFields.size) {
      await this.#queuePersist().catch((error) => {
        this.log(`Could not persist recovered Claude conversations: ${error.message}`);
      });
    }
    await this.discoverNativeThreads();
    const search = String(params.searchTerm || "").trim().toLowerCase();
    const data = [...this.threads.values()]
      .filter((thread) => params.archived ? thread.archived : !thread.archived)
      .filter((thread) => {
        if (!search) return true;
        return `${thread.name} ${thread.cwd}`.toLowerCase().includes(search);
      })
      .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
      .slice(0, Number(params.limit) || 100)
      .map(threadView);
    return { data, nextCursor: null };
  }

  async readThread(value) {
    const id = rawId(value);
    let thread = this.threads.get(id);
    if (!thread) {
      await this.#refreshStore({ onlyThreadId: id });
      thread = this.threads.get(id);
    }
    if (!thread) {
      await this.discoverNativeThreads({ force: true });
      thread = this.threads.get(id);
    }
    if (!thread) throw new Error("گفتگوی Claude پیدا نشد");
    const processState = this.processes.get(thread.id);
    if (processState?.finalizing) await processState.done;
    const nativeTurns = thread.native
      ? await this.readNativeTurns(thread.transcriptPath)
      : null;
    const activeNativeTurns = thread.native
      ? (thread.turns || []).filter((turn) => turn?.status === "inProgress")
      : [];
    const turns = thread.native ? [...nativeTurns] : thread.turns || [];
    for (const activeTurn of activeNativeTurns) {
      const lastNativeTurn = turns.at(-1);
      if (
        lastNativeTurn &&
        turnUserText(lastNativeTurn) &&
        turnUserText(lastNativeTurn) === turnUserText(activeTurn)
      ) {
        turns[turns.length - 1] = activeTurn;
      } else {
        turns.push(activeTurn);
      }
    }
    return {
      thread: { ...threadView(thread), turns },
      tokenUsage: thread.tokenUsage || null,
    };
  }

  async discoverNativeThreads({ force = false } = {}) {
    if (this.discoveryPromise) return this.discoveryPromise;
    if (!force && Date.now() - this.lastDiscoveryAt < DISCOVERY_CACHE_MS) return;
    this.discoveryPromise = (async () => {
      const paths = await findTranscripts(join(this.claudeConfigDir, "projects"));
      const summaries = await Promise.all(
        paths.map(async (transcriptPath) => ({
          transcriptPath,
          summary: await transcriptSummary(transcriptPath),
        })),
      );
      for (const { transcriptPath, summary } of summaries) {
        if (!summary) continue;
        const id = basename(transcriptPath, ".jsonl");
        const existing = this.threads.get(id);
        if (existing && !existing.native) {
          if (!existing.sessionInitialized) {
            existing.sessionInitialized = true;
            this.#markThreadDirty(existing, ["sessionInitialized"]);
          }
          // Conversations started here keep the placeholder name, because only
          // natively discovered ones used to read the title Claude writes into
          // the session file. Adopt it too, without touching a chosen name.
          this.#adoptTranscriptName(existing, summary);
          continue;
        }

        const metadata = this.nativeMetadata.get(id);
        const defaultName =
          summary.title || summary.firstPrompt || DEFAULT_THREAD_NAME;
        if (existing) {
          existing.transcriptPath = transcriptPath;
          existing.cwd = summary.cwd || existing.cwd || process.cwd();
          existing.createdAt ||= summary.createdAt;
          existing.updatedAt = Math.max(
            existing.updatedAt || 0,
            summary.updatedAt || 0,
            metadata?.updatedAt || 0,
          );
          existing.nativeName = metadata?.name || existing.nativeName || "";
          existing.name = existing.nativeName || defaultName;
          if (metadata?.goal) existing.goal = metadata.goal;
          existing.archived = metadata?.archived ?? existing.archived;
          existing.sessionInitialized = true;
          continue;
        }

        this.threads.set(id, {
          id,
          native: true,
          nativeName: metadata?.name || "",
          name: metadata?.name || defaultName,
          ...(metadata?.goal ? { goal: metadata.goal } : {}),
          cwd: summary.cwd || process.cwd(),
          model: "",
          permissionMode: "",
          effort: "",
          sessionInitialized: true,
          createdAt: summary.createdAt,
          updatedAt: Math.max(summary.updatedAt || 0, metadata?.updatedAt || 0),
          status: { type: "idle" },
          archived: Boolean(metadata?.archived),
          transcriptPath,
        });
      }
      this.lastDiscoveryAt = Date.now();
    })();
    try {
      await this.discoveryPromise;
    } finally {
      this.discoveryPromise = null;
    }
  }

  async readNativeTurns(transcriptPath) {
    const turns = [];
    let currentTurn = null;
    let input;
    try {
      input = createInterface({
        input: createReadStream(transcriptPath),
        crlfDelay: Infinity,
      });
      for await (const line of input) {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.isSidechain) continue;
        if (entry.type === "ai-title" || entry.type === "custom-title") continue;
        if (entry.type === "user") {
          if (entry.isMeta || entry.isCompactSummary) continue;
          const content = messageContentBlocks(entry.message?.content);
          const text = messageText(content);
          const hasToolResult = content.some((part) => part?.type === "tool_result");
          if (!text || hasToolResult) continue;
          currentTurn = {
            id: entry.uuid || randomUUID(),
            status: "completed",
            items: [
              {
                id: `${entry.uuid || randomUUID()}:user`,
                type: "userMessage",
                content: [{ type: "text", text }],
              },
            ],
          };
          turns.push(currentTurn);
          continue;
        }
        if (entry.type !== "assistant" || !currentTurn) continue;
        const content = messageContentBlocks(entry.message?.content);
        for (const block of content) {
          if (block?.type === "text" && block.text) {
            currentTurn.items.push({
              id: `${entry.uuid || randomUUID()}:assistant`,
              type: "agentMessage",
              text: block.text,
            });
          } else if (block?.type === "tool_use") {
            currentTurn.items.push({
              id: `${entry.uuid || randomUUID()}:${block.id || randomUUID()}`,
              type: "commandExecution",
              command: block.name || "Claude tool",
              status: "completed",
              input: block.input || {},
            });
          }
        }
      }
      input.close();
    } catch (error) {
      this.log(`Could not read Claude transcript ${transcriptPath}: ${error.message}`);
    }
    return turns;
  }

  async startThread(params) {
    const id = params.sessionId || randomUUID();
    if (!SESSION_ID_PATTERN.test(String(id))) {
      throw new Error("Claude session id باید UUID معتبر باشد");
    }
    await this.#refreshStore({ onlyThreadId: String(id) });
    if (this.threads.has(String(id))) {
      throw new Error("گفتگوی Claude با این session id از قبل وجود دارد");
    }

    const cwd = resolve(
      typeof params.cwd === "string" && params.cwd ? params.cwd : process.cwd(),
    );
    let cwdInfo;
    try {
      cwdInfo = await stat(cwd);
    } catch (error) {
      throw new Error(`پوشهٔ کاری Claude در دسترس نیست: ${error.message}`);
    }
    if (!cwdInfo.isDirectory()) {
      throw new Error("پوشهٔ کاری Claude باید یک directory باشد");
    }

    const permissionMode = validatePermissionMode(params.permissionMode);
    const effort = validateEffort(params.effort);
    const timestamp = nowSeconds();
    const thread = {
      id: String(id),
      provider: "claude",
      name: params.name || DEFAULT_THREAD_NAME,
      cwd,
      model: params.model || "",
      permissionMode,
      effort,
      sessionInitialized: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: { type: "idle" },
      archived: false,
      turns: [],
    };
    this.threads.set(thread.id, thread);
    this.#markThreadDirty(thread);
    try {
      await this.persist();
    } catch (error) {
      if (this.threads.get(thread.id) === thread) this.threads.delete(thread.id);
      this.dirtyThreadFields.delete(thread.id);
      this.threadRevisions.delete(thread.id);
      throw error;
    }
    return { thread: { ...threadView(thread), turns: [] } };
  }

  async archiveThread(params, archived) {
    const thread = this.threads.get(rawId(params.threadId));
    if (!thread) throw new Error("گفتگوی Claude پیدا نشد");
    thread.archived = archived;
    thread.updatedAt = nowSeconds();
    if (thread.native) {
      this.#markNativeDirty(thread, ["archived", "updatedAt"]);
    } else {
      this.#markThreadDirty(thread, ["archived", "updatedAt"]);
    }
    await this.persist();
    return { thread: threadView(thread) };
  }

  async setName(params) {
    const thread = this.threads.get(rawId(params.threadId));
    if (!thread) throw new Error("گفتگوی Claude پیدا نشد");
    thread.name = String(params.name || params.threadName || DEFAULT_THREAD_NAME).trim();
    if (!thread.name) thread.name = DEFAULT_THREAD_NAME;
    thread.updatedAt = nowSeconds();
    if (thread.native) {
      thread.nativeName = thread.name;
      this.#markNativeDirty(thread, ["name", "updatedAt"]);
    } else {
      this.#markThreadDirty(thread, ["name", "updatedAt"]);
    }
    await this.persist();
    this.notify("thread/name/updated", {
      threadId: publicId(thread.id),
      name: thread.name,
      threadName: thread.name,
    });
    return { thread: threadView(thread) };
  }

  #requireThread(value) {
    const thread = this.threads.get(rawId(value));
    if (!thread) throw new Error("گفتگوی Claude پیدا نشد");
    return thread;
  }

  async #persistGoal(thread) {
    if (thread.native) this.#markNativeDirty(thread, ["goal"]);
    else this.#markThreadDirty(thread, ["goal"]);
    await this.#queuePersist();
    this.notify("thread/goal/updated", {
      threadId: publicId(thread.id),
      goal: thread.goal || null,
    });
  }

  async setGoal(params) {
    const thread = this.#requireThread(params.threadId);
    const objective =
      params.objective === undefined
        ? thread.goal?.objective || ""
        : String(params.objective || "").trim();
    if (!objective) throw new Error("هدف نمی‌تواند خالی باشد");
    const status =
      params.status === undefined ? thread.goal?.status || "active" : params.status;
    if (!GOAL_STATUSES.has(status)) {
      throw new Error(`وضعیت هدف نامعتبر است: ${status}`);
    }
    // Editing the objective restarts the budget the same way Codex does.
    const carryUsage = objective === thread.goal?.objective ? thread.goal : null;
    thread.goal = normalizeGoal({ ...carryUsage, objective, status });
    await this.#persistGoal(thread);
    return { goal: thread.goal };
  }

  async clearGoal(params) {
    const thread = this.#requireThread(params.threadId);
    delete thread.goal;
    await this.#persistGoal(thread);
    return {};
  }

  async compactThread(params) {
    const thread = this.#requireThread(params.threadId);
    if (!thread.native && !thread.sessionInitialized) {
      throw new Error("این گفتگو هنوز پیامی ندارد که فشرده شود");
    }
    await this.startTurn(
      { threadId: params.threadId, input: [{ type: "text", text: "/compact" }] },
      { controlItemType: "contextCompaction" },
    );
    return {};
  }

  // `controlItemType` runs the turn as a CLI control command (for example
  // `/compact`): the prompt and the reply are not shown as chat messages, the
  // turn is represented by a single activity item of that type instead.
  async startTurn(params, { controlItemType = "" } = {}) {
    const thread = this.threads.get(rawId(params.threadId));
    if (!thread) throw new Error("گفتگوی Claude پیدا نشد");
    if (this.processes.has(thread.id)) throw new Error("این گفتگوی Claude در حال اجراست");
    if (this.stopping) throw new Error("Claude provider در حال توقف است");

    if (!Array.isArray(params.input)) throw new Error("ورودی Claude باید یک آرایه باشد");
    const text = textFromInput(params.input);
    if (!text.trim()) throw new Error("پیام خالی است");
    const permissionMode = validatePermissionMode(
      params.permissionMode === undefined
        ? thread.permissionMode
        : params.permissionMode,
    );
    const effort = validateEffort(
      params.effort === undefined ? thread.effort : params.effort,
    );
    const turn = {
      id: randomUUID(),
      status: "inProgress",
      items: [],
      startedAt: nowSeconds(),
    };
    const userItem = {
      clientId:
        typeof params.clientUserMessageId === "string" && params.clientUserMessageId
          ? params.clientUserMessageId
          : null,
      id: `${turn.id}:user`,
      type: "userMessage",
      content: [{ type: "text", text }],
    };
    const assistantItem = controlItemType
      ? {
          id: `${turn.id}:${controlItemType}`,
          type: controlItemType,
          status: "inProgress",
          text: "",
        }
      : {
          id: `${turn.id}:assistant`,
          type: "agentMessage",
          text: "",
        };
    if (controlItemType) turn.items.push(assistantItem);
    else turn.items.push(userItem, assistantItem);

    let resolveDone;
    const done = new Promise((resolveDonePromise) => {
      resolveDone = resolveDonePromise;
    });
    const processState = {
      assistantItem,
      child: null,
      done,
      interrupted: false,
      killTimer: null,
      releaseTurnLock: null,
      resultError: null,
      resultSeen: false,
      resultStatus: null,
      stderr: [],
      partialTextSeen: false,
      textSeen: false,
      toolItems: new Map(),
      turn,
      turnId: turn.id,
      resolveDone,
      finalizing: null,
    };

    // Reserve synchronously before the first await so two browser tabs cannot
    // pass the same-thread guard while persistence or lock acquisition yields.
    this.processes.set(thread.id, processState);
    try {
      await mkdir(join(this.cacheDir, TURN_LOCK_DIR), {
        recursive: true,
        mode: 0o700,
      });
      await chmod(join(this.cacheDir, TURN_LOCK_DIR), 0o700);
      processState.releaseTurnLock = await acquireFileLock(
        this.#turnLockPath(thread.id),
        {
          instanceId: this.instanceId,
          timeoutMs: this.turnLockTimeoutMs,
        },
      );
      if (!(await this.#binaryAvailable())) {
        throw new Error("Claude Code CLI پیدا نشد؛ CLAUDE_BIN را تنظیم کنید");
      }

      if (!thread.native) {
        let diskThread = null;
        try {
          const disk = await this.#readStore();
          const value = (Array.isArray(disk.threads) ? disk.threads : []).find(
            (candidate) => String(candidate?.id || "") === thread.id,
          );
          diskThread = this.#normalizeThread(value);
        } catch (error) {
          this.log(`Could not refresh Claude thread ${thread.id}: ${error.message}`);
        }
        if (diskThread) Object.assign(thread, diskThread);
        const orphanedTurns = (thread.turns || []).filter(
          (candidate) => candidate?.status === "inProgress",
        );
        if (thread.status?.type === "active" || orphanedTurns.length) {
          const completedAt = nowSeconds();
          for (const orphaned of orphanedTurns) {
            orphaned.status = "interrupted";
            orphaned.completedAt = completedAt;
            orphaned.error = {
              message: "پردازش قبلی Claude پیش از پایان متوقف شده است",
            };
            for (const item of orphaned.items || []) {
              if (item?.status === "inProgress") item.status = "interrupted";
            }
          }
          thread.status = { type: "idle" };
          thread.updatedAt = completedAt;
          delete thread.activeOwner;
        }
      }

      processState.resumeSession =
        Boolean(thread.native) || Boolean(thread.sessionInitialized);
      const previousState = {
        activeOwner: thread.activeOwner,
        status: thread.status,
        turnsLength: Array.isArray(thread.turns) ? thread.turns.length : 0,
        updatedAt: thread.updatedAt,
      };
      processState.previousState = previousState;
      thread.turns ||= [];
      thread.turns.push(turn);
      thread.updatedAt = nowSeconds();
      thread.status = { type: "active" };
      thread.activeOwner = {
        instanceId: this.instanceId,
        pid: process.pid,
        turnId: turn.id,
      };
      if (!thread.native) {
        this.#markThreadDirty(thread, [
          "turns",
          "status",
          "updatedAt",
          "activeOwner",
        ]);
        await this.persist();
      }
    } catch (error) {
      if (processState.previousState) {
        thread.turns.length = processState.previousState.turnsLength;
        thread.status = processState.previousState.status;
        thread.updatedAt = processState.previousState.updatedAt;
        if (processState.previousState.activeOwner === undefined) {
          delete thread.activeOwner;
        } else {
          thread.activeOwner = processState.previousState.activeOwner;
        }
        if (!thread.native) {
          this.#markThreadDirty(thread, [
            "turns",
            "status",
            "updatedAt",
            "activeOwner",
          ]);
        }
      }
      if (this.processes.get(thread.id) === processState) {
        this.processes.delete(thread.id);
      }
      await processState.releaseTurnLock?.().catch(() => {});
      processState.resolveDone();
      throw error;
    }

    this.notify("thread/status/changed", { threadId: publicId(thread.id), status: thread.status });
    this.notify("turn/started", {
      threadId: publicId(thread.id),
      turn: { id: turn.id, status: "inProgress" },
    });
    if (!controlItemType) {
      this.notify("item/started", {
        threadId: publicId(thread.id),
        turnId: turn.id,
        item: userItem,
      });
    }
    this.notify("item/started", {
      threadId: publicId(thread.id),
      turnId: turn.id,
      item: assistantItem,
    });

    processState.controlItemType = controlItemType;
    this.runTurn(thread, turn, assistantItem, text, {
      ...params,
      effort,
      permissionMode,
    }, processState);
    return { turn: { id: turn.id, status: "inProgress", items: turn.items } };
  }

  buildArgs(thread, params, resumeSession = Boolean(thread.native || thread.sessionInitialized)) {
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--input-format",
      "text",
    ];
    if (resumeSession) args.push("--resume", thread.id);
    else args.push("--session-id", thread.id);
    const model = params.model || thread.model;
    if (model) args.push("--model", model);
    const permissionMode = validatePermissionMode(
      params.permissionMode === undefined ? thread.permissionMode : params.permissionMode,
    );
    if (permissionMode) args.push("--permission-mode", permissionMode);
    if (permissionMode === "bypassPermissions") {
      args.push("--allow-dangerously-skip-permissions");
    }
    const effort = validateEffort(
      params.effort === undefined ? thread.effort : params.effort,
    );
    if (effort) args.push("--effort", effort);
    const systemPrompt = [
      String(params.developerInstructions || "").trim(),
      thread.goal?.status === "active" ? goalInstruction(thread.goal.objective) : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
    return args;
  }

  runTurn(thread, turn, assistantItem, text, params, processState) {
    if (processState.interrupted) {
      void this.finishTurn(
        thread,
        turn,
        assistantItem,
        "interrupted",
        null,
        processState,
      );
      return;
    }
    try {
      const child = spawn(
        this.binary,
        this.buildArgs(thread, params, processState.resumeSession),
        {
          cwd: thread.cwd,
          env: {
            ...process.env,
            CLAUDE_CONFIG_DIR: this.claudeConfigDir,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      processState.child = child;

      child.on("error", (error) => {
        processState.spawnError = error;
        this.log(`Claude Code error: ${error.message}`);
      });
      createInterface({ input: child.stderr }).on("line", (line) => {
        processState.stderr.push(line);
        if (processState.stderr.length > 12) processState.stderr.shift();
        this.log(`[claude] ${line}`);
      });
      createInterface({ input: child.stdout }).on("line", (line) => {
        this.handleLine(thread, turn, assistantItem, processState, line);
      });
      child.on("close", (code, signal) => {
        if (processState.killTimer) {
          clearTimeout(processState.killTimer);
          processState.killTimer = null;
        }
        const detail = processState.stderr.join("\n");
        const status = processState.interrupted
          ? "interrupted"
          : processState.resultSeen
            ? processState.resultStatus
            : "failed";
        const reportedErrors = [
          processState.resultError,
          detail && detail !== processState.resultError ? detail : "",
        ]
          .filter(Boolean)
          .join("\n");
        const errorMessage =
          status === "failed"
            ? reportedErrors ||
              processState.spawnError?.message ||
              (code === 0
                ? "Claude Code بدون پیام نتیجه بسته شد"
                : `Claude Code exited (${signal || code})`)
            : null;
        void this.finishTurn(
          thread,
          turn,
          assistantItem,
          status,
          errorMessage,
          processState,
        ).catch((error) => {
          this.log(`Could not finalize Claude turn: ${error.message}`);
        });
      });
      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") this.log(`Claude Code stdin error: ${error.message}`);
      });
      if (child.stdin.writable) child.stdin.end(text);
    } catch (error) {
      void this.finishTurn(
        thread,
        turn,
        assistantItem,
        "failed",
        error.message,
        processState,
      ).catch((finishError) => {
        this.log(`Could not finalize Claude turn: ${finishError.message}`);
      });
    }
  }

  handleLine(thread, turn, assistantItem, processState, line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.log(`[claude] invalid JSON: ${line}`);
      return;
    }
    if (message.session_id && message.session_id !== thread.id) {
      processState.resultSeen = true;
      processState.resultStatus = "failed";
      processState.resultError = "Claude Code یک session id ناسازگار برگرداند";
      this.#signalProcess(processState, "SIGTERM");
      return;
    }
    if (message.type === "system" && message.subtype === "init") {
      if (!thread.sessionInitialized) {
        thread.sessionInitialized = true;
        if (!thread.native) {
          this.#markThreadDirty(thread, ["sessionInitialized"]);
          void this.#queuePersist().catch((error) => {
            this.log(`Could not persist Claude session initialization: ${error.message}`);
          });
        }
      }
      return;
    }
    if (message.type === "rate_limit_event") {
      const rateLimits = rateLimitsFromEvent(message.rate_limit_info);
      if (rateLimits) {
        this.rateLimits = rateLimits;
        this.notify("account/rateLimits/updated", rateLimits);
      }
      return;
    }
    if (message.type === "stream_event") {
      const delta = message.event?.delta || {};
      if (delta.type === "text_delta" && delta.text) {
        processState.partialTextSeen = true;
        this.appendAssistantText(thread, turn, assistantItem, processState, delta.text);
      }
      return;
    }
    if (message.type === "assistant") {
      for (const block of message.message?.content || []) {
        if (block.type === "text" && block.text && !processState.partialTextSeen) {
          this.appendAssistantText(thread, turn, assistantItem, processState, block.text);
        }
        if (block.type === "tool_use") this.notifyTool(thread, turn, block, processState);
      }
      return;
    }
    if (message.type === "user") {
      for (const block of message.message?.content || []) {
        if (block.type === "tool_result") {
          const toolItem = processState.toolItems.get(block.tool_use_id);
          const output =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content || "");
          if (toolItem) {
            toolItem.status = block.is_error ? "failed" : "completed";
            toolItem.aggregatedOutput = output;
            this.notify("item/completed", {
              threadId: publicId(thread.id),
              turnId: turn.id,
              item: toolItem,
            });
            processState.toolItems.delete(block.tool_use_id);
            continue;
          }
          this.notify("item/commandExecution/outputDelta", {
            threadId: publicId(thread.id),
            turnId: turn.id,
            itemId: `${turn.id}:${block.tool_use_id || "tool"}`,
            delta: output,
          });
        }
      }
      return;
    }
    if (message.type === "result") {
      processState.resultSeen = true;
      processState.resultStatus = message.is_error ? "failed" : "completed";
      const errors = Array.isArray(message.errors)
        ? message.errors.filter((value) => typeof value === "string" && value)
        : [];
      processState.resultError = message.is_error
        ? [
            message.result == null ? "" : String(message.result),
            ...errors,
            message.subtype ? String(message.subtype) : "",
          ]
            .filter(Boolean)
            .filter((value, index, values) => values.indexOf(value) === index)
            .join("\n") || "Claude Code failed"
        : null;
      if (message.session_id === thread.id && !thread.sessionInitialized) {
        thread.sessionInitialized = true;
        if (!thread.native) this.#markThreadDirty(thread, ["sessionInitialized"]);
      }
      const tokenUsage = tokenUsageFromResult(message);
      if (tokenUsage) {
        thread.tokenUsage = tokenUsage;
        if (!thread.native) this.#markThreadDirty(thread, ["tokenUsage"]);
        this.notify("thread/tokenUsage/updated", {
          threadId: publicId(thread.id),
          tokenUsage,
        });
      }
      if (thread.goal?.status === "active" && !processState.controlItemType) {
        thread.goal.tokensUsed += tokenUsage?.last.totalTokens || 0;
        thread.goal.timeUsedSeconds += Math.max(
          0,
          Math.round((Number(message.duration_ms) || 0) / 1000),
        );
        void this.#persistGoal(thread).catch((error) => {
          this.log(`Could not persist Claude goal progress: ${error.message}`);
        });
      }
      if (!processState.textSeen && message.result) {
        this.appendAssistantText(
          thread,
          turn,
          assistantItem,
          processState,
          String(message.result),
        );
      }
    }
  }

  // Control turns (for example `/compact`) collect the CLI reply but never
  // stream it into the transcript as an agent message.
  appendAssistantText(thread, turn, assistantItem, processState, delta) {
    processState.textSeen = true;
    assistantItem.text += delta;
    if (processState.controlItemType) return;
    this.notify("item/agentMessage/delta", {
      threadId: publicId(thread.id),
      turnId: turn.id,
      itemId: assistantItem.id,
      delta,
    });
  }

  notifyTool(thread, turn, block, processState) {
    const toolId = block.id || randomUUID();
    if (processState.toolItems.has(toolId)) return;
    const item = {
      id: `${turn.id}:${toolId}`,
      type: "commandExecution",
      command: block.name || "Claude tool",
      status: "inProgress",
      input: block.input || {},
    };
    processState.toolItems.set(toolId, item);
    turn.items.push(item);
    this.notify("item/started", {
      threadId: publicId(thread.id),
      turnId: turn.id,
      item,
    });
  }

  async finishTurn(thread, turn, assistantItem, status, errorMessage, processState) {
    if (processState.finalizing) return processState.finalizing;
    processState.finalizing = (async () => {
      if (processState.killTimer) {
        clearTimeout(processState.killTimer);
        processState.killTimer = null;
      }
      if (turn.status === "inProgress") {
        turn.status = status;
        turn.completedAt = nowSeconds();
        if (errorMessage) turn.error = { message: errorMessage };
        for (const toolItem of processState.toolItems.values()) {
          toolItem.status = status === "interrupted" ? "interrupted" : "failed";
          this.notify("item/completed", {
            threadId: publicId(thread.id),
            turnId: turn.id,
            item: toolItem,
          });
        }
        processState.toolItems.clear();

        if (processState.controlItemType) {
          assistantItem.status = status;
        } else if (!assistantItem.text) {
          if (status === "interrupted") assistantItem.text = "پاسخ متوقف شد.";
          else if (status === "failed") assistantItem.text = "اجرای Claude با خطا متوقف شد.";
        }
        thread.status = { type: "idle" };
        thread.updatedAt = nowSeconds();
        if (thread.activeOwner?.turnId === turn.id) delete thread.activeOwner;
        if (!thread.native) {
          this.#markThreadDirty(thread, [
            "turns",
            "status",
            "updatedAt",
            "activeOwner",
            "sessionInitialized",
          ]);
          try {
            await this.persist();
          } catch (error) {
            this.log(`Could not persist completed Claude turn: ${error.message}`);
          }
        }

        this.notify("item/completed", {
          threadId: publicId(thread.id),
          turnId: turn.id,
          item: assistantItem,
        });
        this.notify("turn/completed", {
          threadId: publicId(thread.id),
          turn: { id: turn.id, status, error: turn.error },
        });
        // Claude writes the title into the session file as the turn lands, so
        // look for it now rather than leaving the placeholder up until the
        // next discovery sweep.
        await this.#refreshPlaceholderName(thread);
        this.notify("thread/status/changed", {
          threadId: publicId(thread.id),
          status: thread.status,
        });
      }
    })();

    try {
      await processState.finalizing;
    } finally {
      await processState.releaseTurnLock?.().catch((error) => {
        this.log(`Could not release Claude turn lock: ${error.message}`);
      });
      if (this.processes.get(thread.id) === processState) {
        this.processes.delete(thread.id);
      }
      processState.resolveDone();
    }
  }

  #signalProcess(processState, signal) {
    const child = processState.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return false;
    const signaled = child.kill(signal);
    if (
      signaled &&
      signal === "SIGTERM" &&
      !processState.killTimer &&
      this.processExitGraceMs >= 0
    ) {
      processState.killTimer = setTimeout(() => {
        processState.killTimer = null;
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, this.processExitGraceMs);
      processState.killTimer.unref?.();
    }
    return signaled;
  }

  async interruptTurn(params) {
    const thread = this.threads.get(rawId(params.threadId));
    const processState = thread && this.processes.get(thread.id);
    if (!processState) return { turn: null };
    if (
      typeof params.turnId !== "string" ||
      !params.turnId ||
      params.turnId !== processState.turnId
    ) {
      const error = new Error("درخواست توقف به turn فعال این گفتگو تعلق ندارد");
      error.status = 409;
      throw error;
    }
    if (processState.finalizing) {
      return { turn: { id: processState.turnId, status: processState.turn.status } };
    }
    processState.interrupted = true;
    this.#signalProcess(processState, "SIGTERM");
    return { ok: true, turn: { id: processState.turnId, status: "inProgress" } };
  }

  notify(method, params) {
    this.emit({ method, params: { ...params, provider: "claude" } });
  }

  async stop() {
    this.stopping = true;
    const processStates = [...this.processes.values()];
    for (const processState of processStates) {
      processState.interrupted = true;
      this.#signalProcess(processState, "SIGTERM");
    }
    await Promise.allSettled(
      processStates.map((processState) =>
        Promise.race([
          processState.done,
          delay(this.processExitGraceMs + 1_000),
        ]),
      ),
    );
  }
}
