// Extra Claude Code profiles: the same `claude` binary run against another
// config directory (and usually another account, endpoint or proxy). Each one
// becomes its own provider next to `codex` and `claude`.
//
// Profiles are read from a JSON file, by default
// `$XDG_CONFIG_HOME/codex-web/claude-profiles.json`, or the path in
// CODEX_WEB_CLAUDE_PROFILES:
//
//   [
//     {
//       "id": "cldtorob",
//       "label": "Torob",
//       "bin": "cldtorob",
//       "configDir": "~/.claude-torob",
//       "env": { "HTTPS_PROXY": "http://127.0.0.1:2081" }
//     }
//   ]
//
// Secrets are better kept in a wrapper script used as `bin` than in `env`.
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import os from "node:os";

const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED_IDS = new Set(["codex", "claude", "all"]);

export function defaultProfilesPath(env = process.env) {
  if (env.CODEX_WEB_CLAUDE_PROFILES) return env.CODEX_WEB_CLAUDE_PROFILES;
  const configHome = env.XDG_CONFIG_HOME || join(os.homedir(), ".config");
  return join(configHome, "codex-web", "claude-profiles.json");
}

function expandHome(path) {
  if (path === "~") return os.homedir();
  if (path.startsWith("~/")) return join(os.homedir(), path.slice(2));
  return path;
}

export function parseClaudeProfiles(data, { defaultBinary = "claude" } = {}) {
  if (!Array.isArray(data)) throw new Error("Claude profiles must be a JSON array");
  const seen = new Set();
  return data.map((entry, index) => {
    const where = `Claude profile #${index + 1}`;
    if (!entry || typeof entry !== "object") throw new Error(`${where} must be an object`);
    const id = String(entry.id || "");
    if (!PROFILE_ID_PATTERN.test(id)) {
      throw new Error(`${where}: id must match ${PROFILE_ID_PATTERN}`);
    }
    if (RESERVED_IDS.has(id)) throw new Error(`${where}: id "${id}" is reserved`);
    if (seen.has(id)) throw new Error(`${where}: duplicate id "${id}"`);
    seen.add(id);
    const configDir = expandHome(String(entry.configDir || ""));
    if (!configDir || !isAbsolute(configDir)) {
      throw new Error(`${where}: configDir must be an absolute path`);
    }
    const env = entry.env && typeof entry.env === "object" ? entry.env : {};
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== "string") throw new Error(`${where}: env.${key} must be a string`);
    }
    return {
      id,
      label: String(entry.label || id),
      binary: String(entry.bin || defaultBinary),
      configDir: resolve(configDir),
      env,
    };
  });
}

export async function loadClaudeProfiles({ path, defaultBinary } = {}) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  try {
    return parseClaudeProfiles(JSON.parse(text), { defaultBinary });
  } catch (error) {
    throw new Error(`${path}: ${error.message}`);
  }
}
