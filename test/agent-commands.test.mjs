import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  agentCommandRoots,
  cliCommandEntries,
  listAgentCommands,
  parseFrontmatter,
} from "../agent-commands.mjs";

async function writeSkill(root, name, frontmatter) {
  await mkdir(join(root, "skills", name), { recursive: true });
  await writeFile(
    join(root, "skills", name, "SKILL.md"),
    `---\n${frontmatter}\n---\n\n# ${name}\n`,
  );
}

test("frontmatter parsing keeps scalars and one level of nesting", () => {
  const fields = parseFrontmatter(
    [
      "---",
      "name: weekly-report",
      'description: "گزارش هفتگی"',
      "metadata:",
      "  short-description: خلاصه",
      "  type: user",
      "folded: >-",
      "  first line",
      "  second line",
      "---",
      "body: not-frontmatter",
    ].join("\n"),
  );

  assert.equal(fields.name, "weekly-report");
  assert.equal(fields.description, "گزارش هفتگی");
  assert.equal(fields["metadata.short-description"], "خلاصه");
  assert.equal(fields.folded, "first line second line");
  assert.equal(fields.body, undefined);
  assert.deepEqual(parseFrontmatter("# no frontmatter"), {});
  assert.deepEqual(parseFrontmatter("---\nname: unterminated\n"), {});
});

test("each provider reads its own user and project command roots", () => {
  const env = { CLAUDE_CONFIG_DIR: "/config/claude", CODEX_HOME: "/config/codex" };
  assert.deepEqual(agentCommandRoots({ provider: "claude", cwd: "/work", env }), [
    { dir: "/config/claude", promptsDir: "commands", scope: "user" },
    { dir: "/work/.claude", promptsDir: "commands", scope: "project" },
  ]);
  assert.deepEqual(agentCommandRoots({ provider: "codex", cwd: "/work", env }), [
    { dir: "/config/codex", promptsDir: "prompts", scope: "user" },
    { dir: "/work/.codex", promptsDir: "prompts", scope: "project" },
  ]);
});

test("skills and prompt files are discovered per provider", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "codex-web-commands-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const claudeHome = join(root, "claude-home");
  const codexHome = join(root, "codex-home");
  const cwd = join(root, "workspace");

  await writeSkill(
    claudeHome,
    "weekly-report",
    "name: weekly-report\ndescription: گزارش کامل\nmetadata:\n  short-description: گزارش هفتگی",
  );
  await writeSkill(join(cwd, ".claude"), "weekly-report", "name: weekly-report\ndescription: نسخهٔ پروژه");
  await writeSkill(claudeHome, "Bad Name", "description: ignored");
  await mkdir(join(claudeHome, "commands"), { recursive: true });
  await writeFile(join(claudeHome, "commands", "triage.md"), "---\ndescription: تریاژ\n---\nbody\n");
  await writeFile(join(claudeHome, "commands", "notes.txt"), "ignored");

  await writeSkill(codexHome, "release", "name: release\ndescription: انتشار");
  await mkdir(join(cwd, ".codex", "prompts"), { recursive: true });
  await writeFile(join(cwd, ".codex", "prompts", "standup.md"), "no frontmatter\n");

  const claudeCommands = await listAgentCommands({
    provider: "claude",
    cwd,
    env: { CLAUDE_CONFIG_DIR: claudeHome },
  });
  assert.deepEqual(
    claudeCommands.map(({ name, kind, scope, description }) => ({
      name,
      kind,
      scope,
      description,
    })),
    [
      { name: "triage", kind: "prompt", scope: "user", description: "تریاژ" },
      // The project skill shadows the user skill with the same name.
      { name: "weekly-report", kind: "skill", scope: "project", description: "نسخهٔ پروژه" },
    ],
  );

  const codexCommands = await listAgentCommands({
    provider: "codex",
    cwd,
    env: { CODEX_HOME: codexHome },
  });
  assert.deepEqual(
    codexCommands.map(({ name, kind, scope }) => ({ name, kind, scope })),
    [
      { name: "release", kind: "skill", scope: "user" },
      { name: "standup", kind: "prompt", scope: "project" },
    ],
  );

  assert.deepEqual(
    await listAgentCommands({
      provider: "claude",
      cwd: join(root, "missing"),
      env: { CLAUDE_CONFIG_DIR: join(root, "missing") },
    }),
    [],
  );
});

test("CLI-reported commands are listed, minus internal and terminal-only ones", () => {
  const entries = cliCommandEntries(
    ["init", "heapdump", "__remote", "anthropic-skills:pdf", "weekly-report"],
    { exclude: new Set(["weekly-report"]) },
  );
  assert.deepEqual(
    entries.map(({ name, kind, scope }) => [name, kind, scope]),
    [
      ["init", "cli", "cli"],
      ["anthropic-skills:pdf", "cli", "plugin"],
    ],
  );
  assert.match(entries[0].description, /CLAUDE\.md/);
});
