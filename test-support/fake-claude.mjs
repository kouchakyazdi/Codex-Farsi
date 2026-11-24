#!/usr/bin/env node

import { appendFileSync, writeFileSync } from "node:fs";

if (process.env.FAKE_CLAUDE_ARGS_FILE) {
  writeFileSync(
    process.env.FAKE_CLAUDE_ARGS_FILE,
    JSON.stringify(process.argv.slice(2)),
  );
}

const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session-id");
const resumeIndex = args.indexOf("--resume");
const sessionId =
  sessionIndex >= 0 ? args[sessionIndex + 1] : resumeIndex >= 0 ? args[resumeIndex + 1] : "fake-session";

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  if (process.env.FAKE_CLAUDE_MESSAGES_FILE) {
    appendFileSync(
      process.env.FAKE_CLAUDE_MESSAGES_FILE,
      `${JSON.stringify({ sessionId, prompt })}\n`,
    );
  }

  const text = `پاسخ Claude به: ${prompt}`;
  if (
    process.env.FAKE_CLAUDE_TRANSCRIPT_FILE &&
    sessionId === process.env.FAKE_CLAUDE_NATIVE_SESSION_ID
  ) {
    appendFileSync(
      process.env.FAKE_CLAUDE_TRANSCRIPT_FILE,
      `${JSON.stringify({
        type: "user",
        uuid: `fake-user-${Date.now()}`,
        cwd: process.cwd(),
        sessionId,
        message: { role: "user", content: [{ type: "text", text: prompt }] },
      })}\n${JSON.stringify({
        type: "assistant",
        uuid: `fake-assistant-${Date.now()}`,
        message: { role: "assistant", content: [{ type: "text", text }] },
      })}\n`,
    );
  }
  const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  emit({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "sonnet",
    slash_commands: ["clear", "init", "heapdump", "anthropic-skills:pdf", "__internal"],
  });
  emit({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    session_id: sessionId,
  });
});

process.on("SIGTERM", () => process.exit(0));
