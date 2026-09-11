import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HermesTranscriptSource,
  hermesJournal,
  isHermesSessionId,
  parseHermesTranscript,
} from "./hermes.ts";

const SID = "20260909_154520_9e0b91";

describe("Hermes session ids", () => {
  test("accepts Hermes ids and rejects path-shaped input", () => {
    expect(isHermesSessionId(SID)).toBe(true);
    expect(isHermesSessionId("../../state.db")).toBe(false);
    expect(isHermesSessionId("2026_bad")).toBe(false);
  });
});

describe("parseHermesTranscript", () => {
  test("renders user, assistant, reasoning, tool call, and tool result rows", () => {
    const text = [
      JSON.stringify({ id: 1, role: "user", content: "show history", timestamp: 1 }),
      JSON.stringify({
        id: 2,
        role: "assistant",
        content: "I will inspect it.",
        reasoning: "Need read-only history.",
        tool_calls: JSON.stringify([{ id: "call-1", function: { name: "terminal", arguments: '{"command":"pwd"}' } }]),
        timestamp: 2,
      }),
      JSON.stringify({
        id: 3,
        role: "tool",
        tool_call_id: "call-1",
        tool_name: "terminal",
        content: "/home/james",
        timestamp: 3,
      }),
    ].join("\n");

    expect(parseHermesTranscript(text)).toEqual([
      { uuid: "1", ts: "1970-01-01T00:00:01.000Z", role: "user", parts: [{ kind: "text", text: "show history" }] },
      {
        uuid: "2",
        ts: "1970-01-01T00:00:02.000Z",
        role: "assistant",
        parts: [
          { kind: "thinking", text: "Need read-only history." },
          { kind: "text", text: "I will inspect it." },
          { kind: "tool", name: "terminal", summary: "pwd" },
        ],
      },
      {
        uuid: "3",
        ts: "1970-01-01T00:00:03.000Z",
        role: "note",
        parts: [{ kind: "tool", name: "terminal", summary: "", result: { text: "/home/james" } }],
      },
    ]);
  });
});

describe("HermesTranscriptSource", () => {
  test("reads every valid tool call in order despite malformed calls and preserves result rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "collie-hermes-multiple-tools-"));
    try {
      const db = new Database(join(root, "state.db"));
      try {
        db.run("create table sessions (id text primary key, parent_session_id text)");
        db.run("create table messages (id integer primary key, session_id text, role text, content text, tool_call_id text, tool_calls text, tool_name text, timestamp real, reasoning text, reasoning_content text, active integer default 1, compacted integer default 0, display_kind text)");
        db.run("insert into sessions (id) values (?)", [SID]);
        db.run(
          "insert into messages (id, session_id, role, content, reasoning, tool_calls, tool_name, timestamp) values (1, ?, 'assistant', 'Inspecting both paths.', 'Use read-only tools.', ?, 'fallback', 1)",
          [SID, JSON.stringify([
            null,
            "not a call",
            [],
            {},
            { id: "call-1", function: { name: "terminal", arguments: '{"command":"pwd"}' } },
            { function: null },
            { function: [] },
            { function: "invalid" },
            { id: "call-2", function: { name: "read_file", arguments: { path: "/tmp/notes.txt" } } },
            { id: "call-3", function: { arguments: "{invalid json" } },
            false,
          ])],
        );
        db.run(
          "insert into messages (id, session_id, role, tool_call_id, tool_name, content, timestamp) values (2, ?, 'tool', 'call-1', 'terminal', '/tmp', 2), (3, ?, 'tool', 'call-2', 'read_file', 'Saved notes.', 3), (4, ?, 'tool', 'call-3', 'fallback', 'Invalid arguments.', 4)",
          [SID, SID, SID],
        );
      } finally {
        db.close();
      }

      const journal = hermesJournal(root);
      const key = await journal.source.resolve({ kind: "id", value: SID });
      if (key === null) throw new Error("Temporary Hermes session did not resolve");
      const loaded = await journal.source.load(key);
      expect(journal.parse(loaded.text)).toEqual([
        {
          uuid: "1",
          ts: "1970-01-01T00:00:01.000Z",
          role: "assistant",
          parts: [
            { kind: "thinking", text: "Use read-only tools." },
            { kind: "text", text: "Inspecting both paths." },
            { kind: "tool", name: "terminal", summary: "pwd" },
            { kind: "tool", name: "read_file", summary: "/tmp/notes.txt" },
            { kind: "tool", name: "fallback", summary: "" },
          ],
        },
        {
          uuid: "2",
          ts: "1970-01-01T00:00:02.000Z",
          role: "note",
          parts: [{ kind: "tool", name: "terminal", summary: "", result: { text: "/tmp" } }],
        },
        {
          uuid: "3",
          ts: "1970-01-01T00:00:03.000Z",
          role: "note",
          parts: [{ kind: "tool", name: "read_file", summary: "", result: { text: "Saved notes." } }],
        },
        {
          uuid: "4",
          ts: "1970-01-01T00:00:04.000Z",
          role: "note",
          parts: [{ kind: "tool", name: "fallback", summary: "", result: { text: "Invalid arguments." } }],
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolves and reads one session from state.db read-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "collie-hermes-"));
    const db = new Database(join(root, "state.db"));
    db.run("create table sessions (id text primary key, source text, started_at real, parent_session_id text)");
    db.run("create table messages (id integer primary key, session_id text, role text, content text, tool_call_id text, tool_calls text, tool_name text, timestamp real, reasoning text, reasoning_content text, active integer default 1, compacted integer default 0, display_kind text)");
    db.run("insert into sessions (id, source, started_at, parent_session_id) values (?, 'tui', 1, null)", [SID]);
    db.run("insert into messages (id, session_id, role, content, timestamp) values (1, ?, 'user', 'older turn', 1)", [SID]);
    db.close();

    const source = new HermesTranscriptSource(root);
    const key = await source.resolve({ kind: "id", value: SID });
    expect(key).toContain("#" + SID);
    const loaded = await source.load(key!);
    expect(parseHermesTranscript(loaded.text)[0]?.parts[0]).toEqual({ kind: "text", text: "older turn" });

    await rm(root, { recursive: true, force: true });
  });
});