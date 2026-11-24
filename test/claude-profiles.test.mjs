import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import test from "node:test";
import {
  defaultProfilesPath,
  loadClaudeProfiles,
  parseClaudeProfiles,
} from "../providers/claude-profiles.mjs";

test("Claude profiles normalize ids, binaries, config dirs and env", () => {
  const [profile] = parseClaudeProfiles(
    [{ id: "cldtorob", label: "Torob", configDir: "~/.claude-torob", env: { A: "1" } }],
    { defaultBinary: "/usr/bin/claude" },
  );
  assert.deepEqual(profile, {
    id: "cldtorob",
    label: "Torob",
    binary: "/usr/bin/claude",
    configDir: join(os.homedir(), ".claude-torob"),
    env: { A: "1" },
  });
});

test("Claude profiles reject reserved, duplicate and malformed entries", () => {
  const valid = { configDir: "/tmp/claude-x" };
  assert.throws(() => parseClaudeProfiles({}), /JSON array/);
  for (const id of ["claude", "codex", "all"]) {
    assert.throws(() => parseClaudeProfiles([{ ...valid, id }]), /reserved/);
  }
  assert.throws(() => parseClaudeProfiles([{ ...valid, id: "Bad:Id" }]), /id must match/);
  assert.throws(
    () => parseClaudeProfiles([{ ...valid, id: "x" }, { ...valid, id: "x" }]),
    /duplicate/,
  );
  assert.throws(() => parseClaudeProfiles([{ id: "x", configDir: "relative" }]), /absolute/);
  assert.throws(() => parseClaudeProfiles([{ ...valid, id: "x", env: { A: 1 } }]), /string/);
});

test("Claude profiles load from a file and default to none", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "codex-web-profiles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await loadClaudeProfiles({ path: join(root, "missing.json") }), []);

  const path = join(root, "profiles.json");
  await writeFile(path, JSON.stringify([{ id: "work", configDir: root }]));
  const profiles = await loadClaudeProfiles({ path, defaultBinary: "claude" });
  assert.deepEqual(profiles.map((profile) => profile.id), ["work"]);

  await writeFile(path, "not json");
  await assert.rejects(loadClaudeProfiles({ path }), new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.equal(defaultProfilesPath({ CODEX_WEB_CLAUDE_PROFILES: "/x.json" }), "/x.json");
  assert.equal(
    defaultProfilesPath({ XDG_CONFIG_HOME: "/cfg" }),
    join("/cfg", "codex-web", "claude-profiles.json"),
  );
});
