// Discovery of user-defined agent commands (skills and prompt files) that both
// Codex CLI and Claude Code CLI expand when a prompt starts with their name.
// Codex Web only lists them; the CLI stays the source of truth for running them.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

const MAX_COMMANDS_PER_PROVIDER = 200;
const MAX_DESCRIPTION_LENGTH = 240;
const MAX_FRONTMATTER_BYTES = 64 * 1024;
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]*$/i;
const CACHE_TTL_MS = 5_000;

const cache = new Map();

function homeDir() {
  return os.homedir();
}

export function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || env.CLAUDE_HOME || join(homeDir(), ".claude");
}

export function codexHomeDir(env = process.env) {
  return env.CODEX_HOME || join(homeDir(), ".codex");
}

// Each root contributes `skills/<name>/SKILL.md` plus flat `<promptsDir>/<name>.md`
// files. Project roots win over user roots when both define the same name.
export function agentCommandRoots({ provider, cwd, env = process.env, claudeConfigDir: configDir } = {}) {
  const roots = [];
  if (provider === "claude") {
    roots.push({ dir: configDir || claudeConfigDir(env), promptsDir: "commands", scope: "user" });
    if (cwd) roots.push({ dir: join(cwd, ".claude"), promptsDir: "commands", scope: "project" });
  } else {
    roots.push({ dir: codexHomeDir(env), promptsDir: "prompts", scope: "user" });
    if (cwd) roots.push({ dir: join(cwd, ".codex"), promptsDir: "prompts", scope: "project" });
  }
  return roots;
}

function unquote(value) {
  const text = value.trim();
  if (text.length > 1 && /^(".*"|'.*')$/s.test(text)) return text.slice(1, -1);
  return text;
}

// Deliberately tiny: only the scalar keys SKILL.md and command files are
// documented to carry. Nested maps are flattened one level ("metadata.title"),
// lists and deeper structures are ignored.
export function parseFrontmatter(text) {
  const normalized = String(text || "").replace(/^﻿/, "");
  if (!/^---\r?\n/.test(normalized)) return {};
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return {};
  const lines = normalized.slice(4, end).split(/\r?\n/);
  const fields = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#") || /^\s/.test(line)) continue;
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (/^[|>][-+]?$/.test(rawValue.trim())) {
      const block = [];
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) {
        index += 1;
        block.push(lines[index].trim());
      }
      fields[key] = block.join(" ").trim();
      continue;
    }
    if (!rawValue.trim()) {
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) {
        index += 1;
        const nested = lines[index].trim().match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
        if (nested) fields[`${key}.${nested[1]}`] = unquote(nested[2]);
      }
      continue;
    }
    fields[key] = unquote(rawValue);
  }
  return fields;
}

function cleanDescription(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_DESCRIPTION_LENGTH
    ? `${text.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`
    : text;
}

async function readFrontmatter(path) {
  try {
    const text = await readFile(path, "utf8");
    return parseFrontmatter(text.slice(0, MAX_FRONTMATTER_BYTES));
  } catch {
    return null;
  }
}

async function readDirectory(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function collectSkills(root, provider, into) {
  const entries = await readDirectory(join(root.dir, "skills"));
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const path = join(root.dir, "skills", entry.name, "SKILL.md");
    const fields = await readFrontmatter(path);
    if (!fields) continue;
    const name = (fields.name || entry.name).trim();
    if (!COMMAND_NAME_PATTERN.test(name)) continue;
    into.set(name.toLowerCase(), {
      description: cleanDescription(
        fields["metadata.short-description"] || fields.description,
      ),
      kind: "skill",
      name,
      path,
      provider,
      scope: root.scope,
    });
  }
}

async function collectPrompts(root, provider, into) {
  const dir = join(root.dir, root.promptsDir);
  const entries = await readDirectory(dir);
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!entry.name.toLowerCase().endsWith(".md")) continue;
    const name = entry.name.slice(0, -3).trim();
    if (!COMMAND_NAME_PATTERN.test(name)) continue;
    const path = join(dir, entry.name);
    const fields = await readFrontmatter(path);
    if (!fields) continue;
    into.set(name.toLowerCase(), {
      description: cleanDescription(fields.description || fields["argument-hint"]),
      kind: "prompt",
      name,
      path,
      provider,
      scope: root.scope,
    });
  }
}

export async function listAgentCommands({
  provider,
  cwd = "",
  env = process.env,
  claudeConfigDir: configDir,
} = {}) {
  const normalizedProvider = provider === "claude" ? "claude" : "codex";
  const found = new Map();
  const roots = agentCommandRoots({ provider: normalizedProvider, cwd, env, claudeConfigDir: configDir });
  for (const root of roots) {
    await collectSkills(root, normalizedProvider, found);
    await collectPrompts(root, normalizedProvider, found);
  }
  return [...found.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_COMMANDS_PER_PROVIDER);
}

export async function listAgentCommandsCached(options = {}) {
  const key = [
    options.provider === "claude" ? "claude" : "codex",
    options.claudeConfigDir || "",
    options.cwd || "",
  ].join("\u0000");
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.commands;
  const commands = await listAgentCommands(options);
  cache.set(key, { at: now, commands });
  return commands;
}

export function clearAgentCommandCache() {
  cache.clear();
}

// Commands Claude Code itself reports (see ClaudeProvider#cliCommandNames).
// They run inside the CLI exactly as typed, so the web only lists them.
// Until a profile has run once, this short list of built-ins that work in
// headless mode stands in.
export const CLAUDE_FALLBACK_CLI_COMMANDS = [
  "init",
  "security-review",
  "context",
  "insights",
  "recap",
  "mcp",
  "agents",
];

// Built-ins that only make sense in the terminal UI, or are internal.
const HIDDEN_CLI_COMMANDS = new Set([
  "heapdump",
  "color",
  "focus",
  "workflow-launch-exec",
]);

const CLI_COMMAND_DESCRIPTIONS = {
  agents: "فهرست subagentهای تعریف‌شده",
  "list-agents": "فهرست subagentهای تعریف‌شده",
  config: "نمایش تنظیمات Claude Code",
  context: "نمایش مصرف context گفتگو به تفکیک بخش‌ها",
  effort: "تغییر سطح استدلال در خود Claude Code",
  "extra-usage": "مصرف اضافه بر سهمیه",
  fast: "روشن/خاموش‌کردن حالت سریع",
  import: "وارد کردن تنظیمات و حافظه از ابزار دیگر",
  init: "ساخت CLAUDE.md با مستندات این مخزن",
  insights: "گزارش تحلیلی از جلسه‌های Claude Code",
  mcp: "وضعیت سرورهای MCP",
  "output-style": "تغییر سبک خروجی پاسخ‌ها",
  recap: "خلاصهٔ کارهای انجام‌شده در این گفتگو",
  "reload-plugins": "بارگذاری دوبارهٔ پلاگین‌ها",
  "reload-skills": "بارگذاری دوبارهٔ مهارت‌ها",
  "security-review": "بازبینی امنیتی تغییرات شاخهٔ فعلی",
  "usage-credits": "اعتبار باقی‌ماندهٔ حساب",
};

export function cliCommandEntries(names, { exclude = new Set() } = {}) {
  const entries = [];
  for (const raw of names || []) {
    const name = String(raw || "");
    const key = name.toLowerCase();
    if (!name || name.startsWith("_") || HIDDEN_CLI_COMMANDS.has(key) || exclude.has(key)) continue;
    entries.push({
      description: CLI_COMMAND_DESCRIPTIONS[key] || "",
      kind: "cli",
      name,
      scope: name.includes(":") ? "plugin" : "cli",
    });
  }
  return entries;
}
