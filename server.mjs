#!/usr/bin/env node

import { createServer } from "node:http";
import { createReadStream, readFileSync } from "node:fs";
import { chmod, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import {
  CLAUDE_FALLBACK_CLI_COMMANDS,
  cliCommandEntries,
  listAgentCommandsCached,
} from "./agent-commands.mjs";
import { ClaudeProvider } from "./providers/claude-provider.mjs";
import { defaultProfilesPath, loadClaudeProfiles } from "./providers/claude-profiles.mjs";
import {
  authorizeRequest,
  defaultTailscaleBinary,
  TailscaleRemoteAccess,
} from "./remote-access.mjs";
import { sharedConversationSnapshot, WebDataStore } from "./web-data-store.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log(PACKAGE.version);
  process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Codex Web ${PACKAGE.version}

Usage:
  codex-web [WEB_OPTIONS] [CODEX_OPTIONS]

Web options:
  --no-open                 Do not open a browser automatically
  --remote                  Share privately through Tailscale Serve
  -h, --help                Show this help
  -V, --version             Show the version

Codex options translated by Codex Web:
  -p, --profile NAME        Load top-level scalar settings from the named Codex profile
  -s, --sandbox MODE        Default sandbox for new and resumed threads
  -a, --ask-for-approval P  Default approval policy for new and resumed threads
  --yolo                    Disable approvals and sandboxing (dangerous)
  --search                  Enable live web search

Global Codex configuration options such as -c, --enable, --disable, and
--strict-config are forwarded. The server always listens on 127.0.0.1.

Environment:
  CODEX_WEB_PORT            HTTP port (default: 4173)
  CODEX_WEB_CWD             Default working directory (default: current directory)
  CODEX_WEB_NO_OPEN=1       Do not open a browser automatically
  CODEX_WEB_REMOTE=1        Enable private Tailscale remote access
  CODEX_WEB_REMOTE_PORT     Tailscale HTTPS port (default: CODEX_WEB_PORT)
  CODEX_WEB_REMOTE_USER     Allowed Tailscale login (default: device owner)
  CODEX_WEB_UPLOAD_DIR      File and image upload cache directory
  CODEX_WEB_DATA_DIR        Projects and shared-chat metadata directory
  TAILSCALE_BIN             Tailscale executable (default: auto-detected)
  CODEX_BIN                 Codex executable (default: codex)
  CLAUDE_BIN                Claude Code executable (default: claude)
  CODEX_HOME                Codex config directory, source of Codex skills and
                            prompts (default: ~/.codex)
  CLAUDE_CONFIG_DIR         Claude Code config/session directory, source of
                            Claude skills and commands (default: ~/.claude)
  CLAUDE_WEB_DATA_DIR       Claude Web conversation metadata directory
  CODEX_WEB_CLAUDE_PROFILES JSON file of extra Claude Code profiles, each shown
                            as its own provider (default:
                            ~/.config/codex-web/claude-profiles.json)`);
  process.exit(0);
}

const HOST = "127.0.0.1";
const PORT = parsePort(process.env.CODEX_WEB_PORT ?? "4173", "CODEX_WEB_PORT");
const REMOTE_ENABLED =
  process.argv.includes("--remote") || process.env.CODEX_WEB_REMOTE === "1";
const REMOTE_PORT = REMOTE_ENABLED
  ? parsePort(
      process.env.CODEX_WEB_REMOTE_PORT ?? String(PORT),
      "CODEX_WEB_REMOTE_PORT",
    )
  : PORT;
const REMOTE_USER = process.env.CODEX_WEB_REMOTE_USER || "";
const TAILSCALE_BIN = defaultTailscaleBinary();
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLAUDE_CONFIG_DIR = resolve(
  process.env.CLAUDE_CONFIG_DIR ||
    process.env.CLAUDE_HOME ||
    join(os.homedir(), ".claude"),
);
const DEFAULT_CWD = process.env.CODEX_WEB_CWD || process.cwd();
const WEB_ARGS = new Set([
  "--no-open",
  "--remote",
  "--help",
  "-h",
  "--version",
  "-V",
]);
const RAW_CODEX_ARGS = process.argv.slice(2).filter((arg) => !WEB_ARGS.has(arg));
const { serverArgs: CODEX_ARGS, threadDefaults: CLI_THREAD_DEFAULTS } =
  prepareCodexArgs(RAW_CODEX_ARGS);
const SHOULD_OPEN = !process.argv.includes("--no-open") && process.env.CODEX_WEB_NO_OPEN !== "1";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const CACHE_HOME =
  process.env.XDG_CACHE_HOME ||
  (process.platform === "win32" && process.env.LOCALAPPDATA) ||
  join(os.homedir(), ".cache");
const UPLOAD_DIR = resolve(
  process.env.CODEX_WEB_UPLOAD_DIR || join(CACHE_HOME, "codex-web", "uploads"),
);
const WEB_DATA_DIR = resolve(
  process.env.CODEX_WEB_DATA_DIR || join(CACHE_HOME, "codex-web", "data"),
);
const CLAUDE_DATA_DIR = resolve(
  process.env.CLAUDE_WEB_DATA_DIR || join(CACHE_HOME, "codex-web", "claude"),
);

const IMAGE_TYPES = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
  ["image/avif", ".avif"],
  ["image/bmp", ".bmp"],
]);

const RPC_ALLOWLIST = new Set([
  "account/read",
  "account/rateLimits/read",
  "collaborationMode/list",
  "model/list",
  "remoteControl/enable",
  "remoteControl/status/read",
  "remoteControl/pairing/start",
  "remoteControl/pairing/status",
  "thread/list",
  "thread/read",
  "thread/start",
  "thread/resume",
  "thread/settings/update",
  "thread/archive",
  "thread/unarchive",
  "thread/compact/start",
  "thread/setName",
  "thread/name/set",
  "thread/goal/set",
  "thread/goal/get",
  "thread/goal/clear",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
]);

const HUMAN_INTERACTION_METHODS = new Set([
  "applyPatchApproval",
  "execCommandApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

const clients = new Set();
const pendingServerRequests = new Map();

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return port;
}

function stripTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") return line.slice(0, index);
  }
  return line;
}

function readProfileOverrides(profileName) {
  if (!/^[A-Za-z0-9_-]+$/.test(profileName)) {
    throw new Error(`Invalid Codex profile name: ${profileName}`);
  }
  const codexHome = process.env.CODEX_HOME || join(os.homedir(), ".codex");
  const profilePath = join(codexHome, `${profileName}.config.toml`);
  let content;
  try {
    content = readFileSync(profilePath, "utf8");
  } catch (error) {
    throw new Error(`Could not read Codex profile ${profileName} at ${profilePath}: ${error.message}`);
  }

  const overrides = [];
  let insideTable = false;
  for (const sourceLine of content.split(/\r?\n/)) {
    const line = stripTomlComment(sourceLine).trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      insideTable = true;
      continue;
    }
    if (insideTable) continue;
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignment) continue;
    overrides.push(`${assignment[1]}=${assignment[2].trim()}`);
  }
  return overrides;
}

function prepareCodexArgs(args) {
  const serverArgs = [];
  const threadDefaults = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    let profileName = null;
    if (argument === "-p" || argument === "--profile") {
      profileName = args[index + 1];
      if (!profileName) throw new Error(`${argument} requires a profile name`);
      index += 1;
    } else if (argument.startsWith("--profile=")) {
      profileName = argument.slice("--profile=".length);
    } else if (argument.startsWith("-p") && !argument.startsWith("--") && argument.length > 2) {
      profileName = argument.slice(2);
    }

    if (profileName !== null) {
      for (const override of readProfileOverrides(profileName)) {
        serverArgs.push("-c", override);
      }
    } else if (
      argument === "--yolo" ||
      argument === "--dangerously-bypass-approvals-and-sandbox"
    ) {
      threadDefaults.approvalPolicy = "never";
      threadDefaults.sandbox = "danger-full-access";
    } else if (argument === "--search") {
      serverArgs.push("-c", 'web_search="live"');
    } else if (argument === "-s" || argument === "--sandbox") {
      const sandbox = args[index + 1];
      if (!sandbox) throw new Error(`${argument} requires a sandbox mode`);
      threadDefaults.sandbox = sandbox;
      index += 1;
    } else if (argument.startsWith("--sandbox=")) {
      threadDefaults.sandbox = argument.slice("--sandbox=".length);
    } else if (argument === "-a" || argument === "--ask-for-approval") {
      const approvalPolicy = args[index + 1];
      if (!approvalPolicy) throw new Error(`${argument} requires an approval policy`);
      threadDefaults.approvalPolicy = approvalPolicy;
      index += 1;
    } else if (argument.startsWith("--ask-for-approval=")) {
      threadDefaults.approvalPolicy = argument.slice("--ask-for-approval=".length);
    } else {
      serverArgs.push(argument);
    }
  }
  return { serverArgs, threadDefaults };
}

function applyCliThreadDefaults(method, params) {
  if (method !== "thread/start" && method !== "thread/resume") return params;
  const effective = { ...params };
  if (
    CLI_THREAD_DEFAULTS.approvalPolicy &&
    !Object.hasOwn(effective, "approvalPolicy")
  ) {
    effective.approvalPolicy = CLI_THREAD_DEFAULTS.approvalPolicy;
  }
  if (CLI_THREAD_DEFAULTS.sandbox && !Object.hasOwn(effective, "sandbox")) {
    effective.sandbox = CLI_THREAD_DEFAULTS.sandbox;
  }
  return effective;
}

function idKey(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function interactionThreadId(request) {
  const threadId = request?.params?.threadId ?? request?.params?.conversationId;
  return typeof threadId === "string" && threadId ? threadId : null;
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function ssePayload(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function broadcast(event, data) {
  const payload = ssePayload(event, data);
  for (const client of clients) {
    client.write(payload);
  }
}

function resolvePendingServerRequest(id, fallbackThreadId = null) {
  const key = idKey(id);
  const request = pendingServerRequests.get(key);
  if (!request) return false;

  pendingServerRequests.delete(key);
  broadcast("request-resolved", {
    id,
    threadId: interactionThreadId(request) ?? fallbackThreadId,
  });
  return true;
}

async function readJson(req) {
  const contentType = req.headers["content-type"] || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    const error = new Error("Content-Type must be application/json");
    error.status = 415;
    throw error;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    const error = new Error("Invalid JSON");
    error.status = 400;
    throw error;
  }
}

function requestImageType(req) {
  const contentType = req.headers["content-type"] || "";
  const type = contentType.split(";", 1)[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(type)) {
    const error = new Error("Content-Type must be a supported image type");
    error.status = 415;
    throw error;
  }
  return type;
}

function requestUploadType(req) {
  const contentType = req.headers["content-type"] || "application/octet-stream";
  const type = contentType.split(";", 1)[0].trim().toLowerCase();
  if (!type || type.length > 127 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) {
    const error = new Error("Content-Type is invalid");
    error.status = 415;
    throw error;
  }
  return type;
}

function requestUploadName(req) {
  const header = req.headers["x-file-name"];
  if (typeof header !== "string" || !header || header.length > 1024) {
    const error = new Error("X-File-Name header is required");
    error.status = 400;
    throw error;
  }

  let name;
  try {
    name = decodeURIComponent(header);
  } catch {
    const error = new Error("X-File-Name must be URL-encoded");
    error.status = 400;
    throw error;
  }

  const leaf = name.replaceAll("\\", "/").split("/").pop()?.trim() || "";
  if (!leaf) {
    const error = new Error("File name is invalid");
    error.status = 400;
    throw error;
  }
  return leaf;
}

async function readUpload(req) {
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined) {
    const declaredSize = Number(contentLength);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
      const error = new Error("Content-Length is invalid");
      error.status = 400;
      throw error;
    }
    if (declaredSize > MAX_UPLOAD_BYTES) {
      const error = new Error("Upload is larger than 25 MiB");
      error.status = 413;
      throw error;
    }
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) {
      const error = new Error("Upload is larger than 25 MiB");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    const error = new Error("Upload body is empty");
    error.status = 400;
    throw error;
  }
  return Buffer.concat(chunks, size);
}

function imageBytesMatchType(type, bytes) {
  if (type === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    );
  }
  if (type === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (type === "image/webp") {
    return (
      bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP"
    );
  }
  if (type === "image/gif") {
    const signature = bytes.toString("ascii", 0, 6);
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (type === "image/avif") {
    if (bytes.length < 16 || bytes.toString("ascii", 4, 8) !== "ftyp") return false;
    const boxSize = bytes.readUInt32BE(0);
    const brandEnd = Math.min(bytes.length, boxSize >= 16 ? boxSize : bytes.length);
    for (let offset = 8; offset + 4 <= brandEnd; offset += 4) {
      if (["avif", "avis"].includes(bytes.toString("ascii", offset, offset + 4))) {
        return true;
      }
    }
    return false;
  }
  if (type === "image/bmp") {
    return bytes.length >= 2 && bytes.toString("ascii", 0, 2) === "BM";
  }
  return false;
}

function safeUploadStem(originalName, fallback) {
  const originalExtension = extname(originalName);
  const originalStem = originalName.slice(0, originalName.length - originalExtension.length);
  const sanitizedStem = originalStem
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  let safeStem = "";
  let safeStemBytes = 0;
  for (const character of sanitizedStem) {
    const characterBytes = Buffer.byteLength(character);
    if (safeStemBytes + characterBytes > 160) break;
    safeStem += character;
    safeStemBytes += characterBytes;
  }
  return safeStem || fallback;
}

function imageUploadName(originalName, type) {
  return `${randomUUID()}-${safeUploadStem(originalName, "image")}${IMAGE_TYPES.get(type)}`;
}

function fileUploadName(originalName) {
  const extension = extname(originalName).normalize("NFKC");
  const safeExtension = /^\.[\p{L}\p{N}]{1,16}$/u.test(extension) ? extension : "";
  return `${randomUUID()}-${safeUploadStem(originalName, "file")}${safeExtension}`;
}

async function persistUpload(bytes, name) {
  await mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
  await chmod(UPLOAD_DIR, 0o700);
  const path = join(UPLOAD_DIR, name);
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") await unlink(path).catch(() => {});
    throw error;
  }
  return path;
}

class CodexBridge {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.starting = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderrTail = [];
    this.stopping = false;
  }

  async start() {
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = this.#start();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async #start() {
    this.stopping = false;
    this.stderrTail = [];
    const proc = spawn(CODEX_BIN, [...CODEX_ARGS, "app-server", "--stdio"], {
      cwd: DEFAULT_CWD,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.on("error", (error) => this.#handleExit(error));
    proc.on("exit", (code, signal) => {
      if (this.proc !== proc) return;
      const detail = this.stderrTail.join("\n");
      this.#handleExit(
        new Error(
          `codex app-server exited (${signal || (code ?? "unknown")})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });

    createInterface({ input: proc.stdout }).on("line", (line) => {
      if (this.proc === proc) this.#handleLine(line);
    });
    createInterface({ input: proc.stderr }).on("line", (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 12) this.stderrTail.shift();
      broadcast("log", { level: "stderr", message: line });
    });

    try {
      await this.rpc("initialize", {
        clientInfo: {
          name: "codex_web",
          title: "Codex Web",
          version: PACKAGE.version,
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      this.notify("initialized", {});
      this.ready = true;
      broadcast("status", {
        ready: true,
        message: "Codex app-server connected",
        provider: "codex",
      });
    } catch (error) {
      if (this.proc === proc) {
        this.proc = null;
        proc.kill("SIGTERM");
      }
      throw error;
    }
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      broadcast("log", { level: "warning", message: `Invalid app-server JSON: ${line}` });
      return;
    }

    if (message.method === "currentTime/read" && Object.hasOwn(message, "id")) {
      this.sendResponse(message.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
      return;
    }

    if (message.method && Object.hasOwn(message, "id")) {
      if (HUMAN_INTERACTION_METHODS.has(message.method)) {
        if (!interactionThreadId(message)) {
          this.write({
            id: message.id,
            error: {
              code: -32602,
              message: "User interaction is missing threadId/conversationId",
            },
          });
          return;
        }
        pendingServerRequests.set(idKey(message.id), message);
      } else {
        this.write({
          id: message.id,
          error: {
            code: -32601,
            message: `Codex Web does not provide the client method ${message.method}`,
          },
        });
        broadcast("log", {
          level: "warning",
          message: `Unsupported app-server request rejected: ${message.method}`,
        });
        return;
      }
    }

    if (message.method === "serverRequest/resolved") {
      const requestId = message.params?.requestId;
      if (requestId !== undefined) {
        resolvePendingServerRequest(requestId, message.params?.threadId ?? null);
      }
    }

    if (Object.hasOwn(message, "id") && !message.method) {
      const key = idKey(message.id);
      const pending = this.pending.get(key);
      if (pending) {
        this.pending.delete(key);
        clearTimeout(pending.timer);
        if (message.error) {
          const error = new Error(message.error.message || "Codex RPC error");
          error.rpcError = message.error;
          pending.reject(error);
        } else {
          pending.resolve(message.result);
        }
      }
    }

    broadcast("rpc", message);
  }

  #handleExit(error) {
    if (!this.proc && !this.starting) return;
    this.ready = false;
    this.proc = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    pendingServerRequests.clear();
    broadcast("pending-interactions", { requests: [] });
    broadcast("status", {
      ready: false,
      message: error.message,
      provider: "codex",
    });
  }

  write(message) {
    if (!this.proc?.stdin?.writable) throw new Error("Codex app-server is not running");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  rpc(method, params = {}, timeoutMs = 60_000) {
    if (!this.proc?.stdin?.writable) return Promise.reject(new Error("Codex app-server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(idKey(id));
        reject(new Error(`Codex RPC timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(idKey(id), { resolve, reject, timer });
      this.write({ method, id, params });
    });
  }

  notify(method, params = {}) {
    this.write({ method, params });
  }

  sendResponse(id, result) {
    this.write({ id, result });
    resolvePendingServerRequest(id);
  }

  async restart() {
    this.ready = false;
    const restartError = new Error("Codex app-server is restarting");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(restartError);
    }
    this.pending.clear();
    pendingServerRequests.clear();
    broadcast("pending-interactions", { requests: [] });
    if (this.proc) {
      const old = this.proc;
      this.proc = null;
      old.kill("SIGTERM");
    }
    await this.start();
  }

  stop() {
    this.stopping = true;
    this.proc?.kill("SIGTERM");
    this.proc = null;
    this.ready = false;
  }
}

const bridge = new CodexBridge();
const webData = new WebDataStore(WEB_DATA_DIR);
const CLAUDE_PROFILES = await loadClaudeProfiles({
  path: defaultProfilesPath(),
  defaultBinary: CLAUDE_BIN,
}).catch((error) => {
  console.error(`Ignoring Claude profiles: ${error.message}`);
  return [];
});
// Every Claude-family provider, keyed by id: the default `claude` plus one per
// configured profile. They share one implementation and differ only in config.
const claudeProviders = new Map(
  [
    { id: "claude", label: "Claude", binary: CLAUDE_BIN, configDir: CLAUDE_CONFIG_DIR, env: {} },
    ...CLAUDE_PROFILES,
  ].map((profile) => [
    profile.id,
    new ClaudeProvider({
      id: profile.id,
      label: profile.label,
      env: profile.env,
      binary: profile.binary,
      cacheDir:
        profile.id === "claude"
          ? CLAUDE_DATA_DIR
          : join(CACHE_HOME, "codex-web", "claude-profiles", profile.id),
      claudeConfigDir: profile.configDir,
      emit: (message) => broadcast("rpc", message),
      log: (message) => broadcast("log", { level: "stderr", message }),
    }),
  ]),
);
const remoteAccess = REMOTE_ENABLED
  ? new TailscaleRemoteAccess({
      localPort: PORT,
      remotePort: REMOTE_PORT,
      binary: TAILSCALE_BIN,
      expectedUser: REMOTE_USER,
      onOutput: (text, stream) => {
        (stream === "stderr" ? process.stderr : process.stdout).write(text);
      },
      onUnexpectedExit: (error) => {
        console.error(`Remote access stopped: ${error.message}`);
        void shutdown(1);
      },
    })
  : null;

function providerForRequest(method, params = {}) {
  if (params.provider === "codex") return "codex";
  if (claudeProviders.has(params.provider)) return params.provider;
  if (typeof params.threadId === "string") {
    const prefix = params.threadId.split(":", 1)[0];
    if (params.threadId.includes(":") && claudeProviders.has(prefix)) return prefix;
  }
  return method === "thread/list" ? "all" : "codex";
}

// Ordered as the UI lists them: Codex first, then each Claude profile.
async function providerStatuses() {
  const statuses = { codex: { ready: bridge.ready, binary: CODEX_BIN, label: "Codex", family: "codex" } };
  for (const [id, provider] of claudeProviders) statuses[id] = await provider.status();
  return statuses;
}

function withoutProvider(params = {}) {
  const copy = { ...params };
  delete copy.provider;
  return copy;
}

async function providerRpc(method, params = {}) {
  const provider = providerForRequest(method, params);
  if (claudeProviders.has(provider)) {
    return claudeProviders.get(provider).rpc(method, withoutProvider(params));
  }
  await bridge.start();
  return bridge.rpc(method, applyCliThreadDefaults(method, withoutProvider(params)));
}

async function listAllThreads(params = {}) {
  const results = await Promise.allSettled([
    providerRpc("thread/list", { ...params, provider: "codex" }),
    ...[...claudeProviders.values()].map((provider) =>
      provider.rpc("thread/list", withoutProvider(params)),
    ),
  ]);
  const listed = results.map((result) =>
    result.status === "fulfilled" ? result.value : { data: [] },
  );
  const [codex, ...claudeLists] = listed;
  if (results.every((result) => result.status === "rejected")) {
    throw results[0].reason;
  }
  return {
    data: [
      ...(codex.data || []).map((thread) => ({
        ...thread,
        provider: thread.provider || "codex",
        providerThreadId: thread.providerThreadId || thread.id,
      })),
      ...claudeLists.flatMap((list) => list.data || []),
    ].sort(
      (left, right) => (right.updatedAt || 0) - (left.updatedAt || 0),
    ),
    nextCursor: null,
  };
}

async function serveStatic(req, res, url) {
  const requestPath =
    url.pathname === "/"
      ? "/index.html"
      : /^\/share\/[0-9a-f-]{36}$/i.test(url.pathname)
        ? "/share.html"
        : url.pathname;
  const decoded = decodeURIComponent(requestPath);
  const filePath = resolve(PUBLIC_DIR, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  const relativePath = relative(PUBLIC_DIR, filePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return json(res, 403, { error: "Forbidden" });
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": extname(filePath) === ".html" ? "no-store" : "no-cache",
      "Content-Security-Policy":
        "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; connect-src 'self'; script-src 'self'; style-src 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    createReadStream(filePath).pipe(res);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

const server = createServer(async (req, res) => {
  try {
    const access = authorizeRequest(req, remoteAccess?.authorization());
    if (!access.ok) {
      return json(res, 403, { error: "This request is not allowed" });
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`retry: 1000\nevent: status\ndata: ${JSON.stringify({
        ready: bridge.ready,
        message: bridge.ready ? "connected" : "starting",
        providers: await providerStatuses(),
        remote: remoteAccess?.status() || { enabled: false, ready: false, url: null },
      })}\n\n`);
      res.write(
        ssePayload("pending-interactions", {
          requests: [...pendingServerRequests.values()],
        }),
      );
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      return json(res, 200, {
        ready: bridge.ready,
        codexBin: CODEX_BIN,
        claudeBin: CLAUDE_BIN,
        providers: await providerStatuses(),
        cwd: DEFAULT_CWD,
        port: PORT,
        remote: remoteAccess?.status() || { enabled: false, ready: false, url: null },
      });
    }

    if (req.method === "GET" && url.pathname === "/api/agent-commands") {
      const requested = url.searchParams.get("provider");
      const provider = claudeProviders.has(requested) ? requested : "codex";
      const requestedCwd = url.searchParams.get("cwd") || "";
      const cwd = isAbsolute(requestedCwd) ? resolve(requestedCwd) : DEFAULT_CWD;
      const claude = claudeProviders.get(provider);
      // A copy: the cached list must not grow with the CLI entries below.
      const commands = [
        ...(await listAgentCommandsCached({
          cwd,
          provider: claude ? "claude" : "codex",
          claudeConfigDir: claude?.claudeConfigDir,
        })),
      ];
      if (claude) {
        // Skills and prompt files found on disk keep their richer metadata;
        // everything else the CLI reported (built-ins, plugin skills) follows.
        const names = (await claude.cliCommandNames()) || CLAUDE_FALLBACK_CLI_COMMANDS;
        const exclude = new Set(commands.map((command) => command.name.toLowerCase()));
        commands.push(...cliCommandEntries(names, { exclude }));
      }
      return json(res, 200, {
        // `path` stays on the server: the composer only needs name and copy.
        commands: commands.map(({ path, ...command }) => command),
        cwd,
        provider,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/projects") {
      return json(res, 200, await webData.workspace());
    }

    if (req.method === "POST" && url.pathname === "/api/projects") {
      const project = await webData.createProject(await readJson(req));
      return json(res, 201, { project });
    }

    const projectRoute = url.pathname.match(
      /^\/api\/projects\/([0-9a-f]{8}-[0-9a-f-]{27})$/i,
    );
    if (projectRoute && req.method === "PATCH") {
      const project = await webData.updateProject(projectRoute[1], await readJson(req));
      return json(res, 200, { project });
    }
    if (projectRoute && req.method === "DELETE") {
      await webData.deleteProject(projectRoute[1]);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/project-threads") {
      const body = await readJson(req);
      const assignment = await webData.assignThread(body.threadId, body.projectId);
      return json(res, 200, assignment);
    }

    if (req.method === "GET" && url.pathname === "/api/shares") {
      const threadId = url.searchParams.get("threadId");
      if (!threadId) return json(res, 400, { error: "threadId is required" });
      return json(res, 200, { share: await webData.findShareForThread(threadId) });
    }

    if (req.method === "POST" && url.pathname === "/api/shares") {
      const body = await readJson(req);
      const threadId = String(body.threadId || "").trim();
      if (!threadId) return json(res, 400, { error: "threadId is required" });
      const result = await providerRpc("thread/read", {
        threadId,
        includeTurns: true,
      });
      const thread = result?.thread;
      if (!thread) return json(res, 404, { error: "Conversation not found" });
      const snapshot = sharedConversationSnapshot(thread);
      if (!snapshot.messages.length) {
        return json(res, 409, { error: "Conversation has no messages to share" });
      }
      const share = await webData.upsertShare(threadId, snapshot);
      return json(res, 201, { share });
    }

    const shareRoute = url.pathname.match(
      /^\/api\/shares\/([0-9a-f]{8}-[0-9a-f-]{27})$/i,
    );
    if (shareRoute && req.method === "GET") {
      const share = await webData.getShare(shareRoute[1]);
      if (!share) return json(res, 404, { error: "Shared conversation not found" });
      return json(res, 200, { share });
    }
    if (shareRoute && req.method === "DELETE") {
      await webData.deleteShare(shareRoute[1]);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/uploads/images") {
      const type = requestImageType(req);
      const originalName = requestUploadName(req);
      const bytes = await readUpload(req);
      if (!imageBytesMatchType(type, bytes)) {
        return json(res, 415, { error: "Image bytes do not match Content-Type" });
      }

      const name = imageUploadName(originalName, type);
      const path = await persistUpload(bytes, name);
      return json(res, 201, { path, name, size: bytes.length, type });
    }

    if (req.method === "POST" && url.pathname === "/api/uploads/files") {
      const type = requestUploadType(req);
      const originalName = requestUploadName(req);
      const bytes = await readUpload(req);
      const name = fileUploadName(originalName);
      const path = await persistUpload(bytes, name);
      return json(res, 201, { path, name, size: bytes.length, type });
    }

    if (req.method === "POST" && url.pathname === "/api/rpc") {
      const body = await readJson(req);
      if (!RPC_ALLOWLIST.has(body.method)) {
        return json(res, 403, { error: `RPC method is not allowed: ${body.method}` });
      }
      const params = applyCliThreadDefaults(body.method, body.params || {});
      const provider = providerForRequest(body.method, params);
      const result =
        body.method === "thread/list" && provider === "all"
          ? await listAllThreads(params)
          : await providerRpc(body.method, params);
      return json(res, 200, { result });
    }

    if (req.method === "POST" && url.pathname === "/api/respond") {
      const body = await readJson(req);
      if (!Object.hasOwn(body, "id")) {
        return json(res, 400, { error: "Interaction id is required" });
      }
      const request = pendingServerRequests.get(idKey(body.id));
      if (!request) return json(res, 404, { error: "Approval/input request is no longer pending" });
      if (!HUMAN_INTERACTION_METHODS.has(request.method)) {
        return json(res, 409, { error: "Pending request is not a user interaction" });
      }
      const requestThreadId = interactionThreadId(request);
      if (typeof body.threadId !== "string" || !body.threadId) {
        return json(res, 400, { error: "threadId is required" });
      }
      if (!requestThreadId) {
        return json(res, 409, { error: "Pending interaction has no valid threadId" });
      }
      if (body.threadId !== requestThreadId) {
        return json(res, 409, { error: "Interaction belongs to another thread" });
      }
      bridge.sendResponse(
        body.id,
        Object.hasOwn(body, "result") ? body.result : {},
      );
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/restart") {
      await readJson(req);
      await bridge.restart();
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" || req.method === "HEAD") {
      return serveStatic(req, res, url);
    }

    json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    const status = error.status || 500;
    json(res, status, {
      error: error.message || "Unexpected server error",
      details: error.rpcError || undefined,
    });
  }
});

server.on("error", (error) => {
  console.error(`Could not start Codex Web: ${error.message}`);
  process.exitCode = 1;
});

server.listen(PORT, HOST, async () => {
  const localUrl = `http://${HOST}:${PORT}`;
  let browserUrl = localUrl;
  console.log(`Codex Web is available locally at ${localUrl}`);
  console.log(`Working directory default: ${DEFAULT_CWD}`);

  bridge.start().catch((error) => {
    console.error(`Could not connect to Codex app-server: ${error.message}`);
  });

  if (remoteAccess) {
    console.log("Starting private Tailscale remote access…");
    try {
      const remote = await remoteAccess.start();
      browserUrl = remote.url;
      console.log(`Codex Web is available privately at ${remote.url}`);
      console.log("Only the authorized Tailscale account can open this URL.");
      if (!remote.secureContext) {
        console.warn(
          "Private HTTP is active. Android Chrome may ask for microphone permission each time; use the keyboard microphone if browser Dictation is blocked.",
        );
      }
    } catch (error) {
      console.error(`Could not start remote access: ${error.message}`);
      await shutdown(1);
      return;
    }
  }

  if (SHOULD_OPEN) {
    const command =
      process.platform === "darwin"
        ? ["open", [browserUrl]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", browserUrl]]
          : ["xdg-open", [browserUrl]];
    const opener = spawn(command[0], command[1], { detached: true, stdio: "ignore" });
    opener.on("error", () => {});
    opener.unref();
  }
});

const heartbeat = setInterval(() => {
  for (const client of clients) client.write(": heartbeat\n\n");
}, 20_000);
heartbeat.unref();

let shuttingDown = false;

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  const forceExit = setTimeout(() => process.exit(exitCode), 3_500);
  forceExit.unref();
  const serverClosed = new Promise((resolveClosed) => {
    server.close(resolveClosed);
  });
  for (const client of clients) client.end();
  clients.clear();
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await remoteAccess?.stop();
  bridge.stop();
  await Promise.all([...claudeProviders.values()].map((provider) => provider.stop()));
  await serverClosed;
  clearTimeout(forceExit);
  process.exit(exitCode);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
