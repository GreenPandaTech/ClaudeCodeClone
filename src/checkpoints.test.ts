import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  hashContent,
  recordChange,
  listTurns,
  nextTurnId,
  pruneCheckpoints,
  viewChanges,
  undoLastChange,
  undoLastTurn,
  withCheckpoints,
  CHECKPOINT_SCHEMA_VERSION,
  DEFAULT_KEEP_TURNS,
} from "./checkpoints.js";
import { executeTool } from "./tools.js";
import { runAgenticLoop, type AgentContext, type LlmClient, type LlmStream, type Message } from "./agent.js";
import type Anthropic from "@anthropic-ai/sdk";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mentor-ckpt-"));
}

/** A checkpointer over the real tool executor, scoped to a temp dir. */
function makeCheckpointer(dir: string, keepTurns?: number) {
  return withCheckpoints(executeTool, { cwd: () => dir, keepTurns });
}

async function writeVia(
  cp: ReturnType<typeof withCheckpoints>,
  file: string,
  content: string
) {
  const result = await cp.execute("write_file", { file_path: file, content });
  assert.equal(result.isError, undefined, result.output);
  return result;
}

// ─── hashing and raw store ────────────────────────────────────────────────────

test("hashContent is a deterministic sha256 hex digest", () => {
  assert.match(hashContent("abc"), /^[0-9a-f]{64}$/);
  assert.equal(hashContent("abc"), hashContent("abc"));
  assert.notEqual(hashContent("abc"), hashContent("abd"));
});

test("recordChange stores the pre-image and post-hash, grouped by turn", () => {
  const dir = tmpDir();
  const file = path.join(dir, "a.txt");
  recordChange(dir, 1, {
    file,
    tool: "write_file",
    existedBefore: true,
    before: "old content",
    afterHash: hashContent("new content"),
  });
  const turns = listTurns(dir);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].version, CHECKPOINT_SCHEMA_VERSION);
  assert.equal(turns[0].turn, 1);
  assert.equal(turns[0].changes[0].before, "old content");
  assert.equal(turns[0].changes[0].afterHash, hashContent("new content"));
});

test("the checkpoint store makes .mentor self-ignoring like sessions do", () => {
  const dir = tmpDir();
  recordChange(dir, 1, {
    file: path.join(dir, "x"),
    tool: "write_file",
    existedBefore: false,
    before: "",
    afterHash: hashContent("x"),
  });
  const ignore = fs.readFileSync(path.join(dir, ".mentor", ".gitignore"), "utf-8");
  assert.match(ignore, /\*/);
});

test("listTurns returns turns sorted ascending and empty when none", () => {
  const dir = tmpDir();
  assert.deepEqual(listTurns(dir), []);
  for (const t of [3, 1, 2]) {
    recordChange(dir, t, {
      file: path.join(dir, `f${t}`),
      tool: "write_file",
      existedBefore: false,
      before: "",
      afterHash: hashContent("c"),
    });
  }
  assert.deepEqual(listTurns(dir).map((t) => t.turn), [1, 2, 3]);
});

test("a malformed checkpoint file fails loud", () => {
  const dir = tmpDir();
  const store = path.join(dir, ".mentor", "checkpoints");
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, "turn-000001.json"), "{ broken", "utf-8");
  assert.throws(() => listTurns(dir), /checkpoint|json/i);
});

// ─── the checkpointing execute wrapper ────────────────────────────────────────

test("an approved write_file to a new file records a did-not-exist marker", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "new.txt");
  const cp = makeCheckpointer(dir);
  await writeVia(cp, file, "hello");

  const turns = listTurns(dir);
  assert.equal(turns.length, 1);
  const ch = turns[0].changes[0];
  assert.equal(ch.existedBefore, false);
  assert.equal(ch.before, "");
  assert.equal(ch.afterHash, hashContent("hello"));
  assert.equal(ch.tool, "write_file");
});

test("overwriting an existing file records the full pre-image", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "original\ncontent\n", "utf-8");
  const cp = makeCheckpointer(dir);
  await writeVia(cp, file, "replaced");

  const ch = listTurns(dir)[0].changes[0];
  assert.equal(ch.existedBefore, true);
  assert.equal(ch.before, "original\ncontent\n");
  assert.equal(ch.afterHash, hashContent("replaced"));
});

test("edit_file changes are checkpointed with the pre-image", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "alpha beta gamma", "utf-8");
  const cp = makeCheckpointer(dir);
  const result = await cp.execute("edit_file", {
    file_path: file,
    old_string: "beta",
    new_string: "BETA",
  });
  assert.equal(result.isError, undefined, result.output);

  const ch = listTurns(dir)[0].changes[0];
  assert.equal(ch.tool, "edit_file");
  assert.equal(ch.before, "alpha beta gamma");
  assert.equal(ch.afterHash, hashContent("alpha BETA gamma"));
});

test("changes in one turn share a group and beginTurn starts a new one", async () => {
  const dir = tmpDir();
  const cp = makeCheckpointer(dir);
  cp.beginTurn();
  await writeVia(cp, path.join(dir, "a.txt"), "a");
  await writeVia(cp, path.join(dir, "b.txt"), "b");
  cp.beginTurn();
  await writeVia(cp, path.join(dir, "c.txt"), "c");

  const turns = listTurns(dir);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].changes.length, 2);
  assert.equal(turns[1].changes.length, 1);
  assert.deepEqual(cp.sessionTurns(), [turns[0].turn, turns[1].turn]);
});

test("failed tool calls and non-file tools are not checkpointed", async () => {
  const dir = tmpDir();
  const cp = makeCheckpointer(dir);
  // edit_file on a missing file fails — nothing to record
  const bad = await cp.execute("edit_file", {
    file_path: path.join(dir, "missing.txt"),
    old_string: "x",
    new_string: "y",
  });
  assert.equal(bad.isError, true);
  // a read is not a change
  fs.writeFileSync(path.join(dir, "r.txt"), "readable", "utf-8");
  await cp.execute("read_file", { file_path: path.join(dir, "r.txt") });
  assert.deepEqual(listTurns(dir), []);
});

test("turn ids continue across restarts instead of colliding", async () => {
  const dir = tmpDir();
  const first = makeCheckpointer(dir);
  await writeVia(first, path.join(dir, "a.txt"), "a");
  const second = makeCheckpointer(dir); // a new session in the same directory
  second.beginTurn();
  await writeVia(second, path.join(dir, "b.txt"), "b");

  const ids = listTurns(dir).map((t) => t.turn);
  assert.equal(new Set(ids).size, ids.length, "turn ids must be unique");
  assert.equal(nextTurnId(dir), Math.max(...ids) + 1);
});

// ─── /undo ────────────────────────────────────────────────────────────────────

test("undoLastChange restores the recorded pre-image", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "original", "utf-8");
  const cp = makeCheckpointer(dir);
  await writeVia(cp, file, "changed");

  const res = undoLastChange(dir);
  assert.ok(res);
  assert.deepEqual(res.undone, [{ file, action: "restored" }]);
  assert.deepEqual(res.refused, []);
  assert.equal(fs.readFileSync(file, "utf-8"), "original");
});

test("undoLastChange deletes a file that did not exist before", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "new.txt");
  const cp = makeCheckpointer(dir);
  await writeVia(cp, file, "created");

  const res = undoLastChange(dir);
  assert.ok(res);
  assert.deepEqual(res.undone, [{ file, action: "deleted" }]);
  assert.equal(fs.existsSync(file), false);
});

test("undoLastChange refuses when the file was edited since, and leaves it alone", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "original", "utf-8");
  const cp = makeCheckpointer(dir);
  await writeVia(cp, file, "mentor version");
  fs.writeFileSync(file, "user edited this afterwards", "utf-8");

  const res = undoLastChange(dir);
  assert.ok(res);
  assert.deepEqual(res.undone, []);
  assert.equal(res.refused.length, 1);
  assert.match(res.refused[0].reason, /edited/i);
  assert.equal(res.refused[0].before, "original");
  assert.equal(res.refused[0].current, "user edited this afterwards");
  // the file is untouched and the checkpoint is kept for a later retry
  assert.equal(fs.readFileSync(file, "utf-8"), "user edited this afterwards");
  assert.equal(listTurns(dir).length, 1);
});

test("undoLastChange refuses when the file was deleted since", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "original", "utf-8");
  const cp = makeCheckpointer(dir);
  await writeVia(cp, file, "mentor version");
  fs.unlinkSync(file);

  const res = undoLastChange(dir);
  assert.ok(res);
  assert.deepEqual(res.undone, []);
  assert.match(res.refused[0].reason, /no longer exists|deleted/i);
});

test("undoing change by change walks backwards through the turn", async () => {
  const dir = tmpDir();
  const a = path.join(dir, "a.txt");
  const b = path.join(dir, "b.txt");
  const cp = makeCheckpointer(dir);
  await writeVia(cp, a, "a1");
  await writeVia(cp, b, "b1");

  const res1 = undoLastChange(dir);
  assert.deepEqual(res1?.undone, [{ file: b, action: "deleted" }]);
  const res2 = undoLastChange(dir);
  assert.deepEqual(res2?.undone, [{ file: a, action: "deleted" }]);
  assert.equal(undoLastChange(dir), null); // store is empty again
});

test("undoLastTurn reverts every change of the last turn in reverse order", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "v0", "utf-8");
  const cp = makeCheckpointer(dir);
  cp.beginTurn();
  await writeVia(cp, file, "v1");
  await writeVia(cp, file, "v2"); // same file changed twice in one turn

  const res = undoLastTurn(dir);
  assert.ok(res);
  assert.equal(res.undone.length, 2);
  assert.deepEqual(res.refused, []);
  assert.equal(fs.readFileSync(file, "utf-8"), "v0");
  assert.equal(listTurns(dir).length, 0);
});

test("undoLastTurn only reverts the LAST turn, leaving earlier turns intact", async () => {
  const dir = tmpDir();
  const a = path.join(dir, "a.txt");
  const b = path.join(dir, "b.txt");
  const cp = makeCheckpointer(dir);
  cp.beginTurn();
  await writeVia(cp, a, "turn one");
  cp.beginTurn();
  await writeVia(cp, b, "turn two");

  const res = undoLastTurn(dir);
  assert.deepEqual(res?.undone, [{ file: b, action: "deleted" }]);
  assert.equal(fs.readFileSync(a, "utf-8"), "turn one");
  assert.equal(listTurns(dir).length, 1);
});

test("undoLastTurn refuses per file: intact files revert, edited ones are kept", async () => {
  const dir = tmpDir();
  const a = path.join(dir, "a.txt");
  const b = path.join(dir, "b.txt");
  const cp = makeCheckpointer(dir);
  cp.beginTurn();
  await writeVia(cp, a, "a-mentor");
  await writeVia(cp, b, "b-mentor");
  fs.writeFileSync(b, "b-user-edit", "utf-8");

  const res = undoLastTurn(dir);
  assert.ok(res);
  assert.deepEqual(res.undone, [{ file: a, action: "deleted" }]);
  assert.equal(res.refused.length, 1);
  assert.equal(res.refused[0].file, b);
  assert.equal(fs.readFileSync(b, "utf-8"), "b-user-edit");
  // the refused change stays recorded so it can be retried after a manual fix
  assert.equal(listTurns(dir)[0].changes.length, 1);
});

test("undo returns null when there is nothing recorded", () => {
  const dir = tmpDir();
  assert.equal(undoLastChange(dir), null);
  assert.equal(undoLastTurn(dir), null);
});

// ─── pruning ──────────────────────────────────────────────────────────────────

test("pruneCheckpoints keeps only the last N turns", () => {
  const dir = tmpDir();
  for (let t = 1; t <= 5; t++) {
    recordChange(dir, t, {
      file: path.join(dir, `f${t}`),
      tool: "write_file",
      existedBefore: false,
      before: "",
      afterHash: hashContent("c"),
    });
  }
  const removed = pruneCheckpoints(dir, 2);
  assert.equal(removed, 3);
  assert.deepEqual(listTurns(dir).map((t) => t.turn), [4, 5]);
});

test("the wrapper prunes automatically to keepTurns", async () => {
  const dir = tmpDir();
  const cp = makeCheckpointer(dir, 2);
  for (let i = 0; i < 4; i++) {
    cp.beginTurn();
    await writeVia(cp, path.join(dir, `f${i}.txt`), String(i));
  }
  assert.equal(listTurns(dir).length, 2);
});

test("DEFAULT_KEEP_TURNS is a sensible positive default", () => {
  assert.ok(Number.isInteger(DEFAULT_KEEP_TURNS) && DEFAULT_KEEP_TURNS > 0);
});

// ─── /changes view ────────────────────────────────────────────────────────────

test("viewChanges pairs each pre-image with the current on-disk content", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "a.txt");
  fs.writeFileSync(file, "before text", "utf-8");
  const cp = makeCheckpointer(dir);
  await writeVia(cp, file, "after text");

  const turns = viewChanges(dir);
  assert.equal(turns.length, 1);
  const ch = turns[0].changes[0];
  assert.equal(ch.before, "before text");
  assert.equal(ch.current, "after text");
  assert.equal(ch.intact, true);
});

test("viewChanges marks a file edited outside Mentor as not intact", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "a.txt");
  const cp = makeCheckpointer(dir);
  await writeVia(cp, file, "mentor wrote this");
  fs.writeFileSync(file, "user rewrote this", "utf-8");

  const ch = viewChanges(dir)[0].changes[0];
  assert.equal(ch.intact, false);
  assert.equal(ch.current, "user rewrote this");
});

// ─── through the agentic loop (DI seam, fake client, no network) ─────────────

interface ScriptedTurn {
  text?: string;
  toolUses?: { id: string; name: string; input: Record<string, unknown> }[];
}

function scriptedClient(turns: ScriptedTurn[]): LlmClient {
  let idx = 0;
  return {
    stream(): LlmStream {
      const turn = turns[idx++] ?? {};
      const content: unknown[] = [];
      if (turn.text) content.push({ type: "text", text: turn.text });
      for (const tu of turn.toolUses ?? []) {
        content.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
      }
      const final = {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: "fake",
        content,
        stop_reason: (turn.toolUses ?? []).length > 0 ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      } as unknown as Anthropic.Message;
      return {
        async *[Symbol.asyncIterator]() {},
        async finalMessage() {
          return final;
        },
      };
    },
  };
}

test("the loop drives approved writes through the checkpointing seam and /undo reverts them", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "hello.txt");
  const cp = makeCheckpointer(dir);
  const client = scriptedClient([
    { toolUses: [{ id: "t1", name: "write_file", input: { file_path: file, content: "from mentor" } }] },
    { text: "done" },
  ]);
  const ctx: AgentContext = {
    client,
    io: {
      onText: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      confirm: async () => true,
    },
    execute: cp.execute,
    tools: [],
    model: "fake-model",
    maxTokens: 1000,
    system: [{ type: "text", text: "sys" }],
    autoApprove: false,
    destructiveTools: new Set(["bash", "write_file", "edit_file"]),
  };

  cp.beginTurn();
  const messages: Message[] = [{ role: "user", content: "write hello" }];
  await runAgenticLoop(messages, ctx);

  assert.equal(fs.readFileSync(file, "utf-8"), "from mentor");
  assert.equal(viewChanges(dir).length, 1);

  const res = undoLastChange(dir);
  assert.deepEqual(res?.undone, [{ file, action: "deleted" }]);
  assert.equal(fs.existsSync(file), false);
});

test("a DECLINED write never reaches execute, so nothing is checkpointed", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "declined.txt");
  const cp = makeCheckpointer(dir);
  const client = scriptedClient([
    { toolUses: [{ id: "t1", name: "write_file", input: { file_path: file, content: "nope" } }] },
    { text: "ok" },
  ]);
  const ctx: AgentContext = {
    client,
    io: {
      onText: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      confirm: async () => false, // user declines
    },
    execute: cp.execute,
    tools: [],
    model: "fake-model",
    maxTokens: 1000,
    system: [{ type: "text", text: "sys" }],
    autoApprove: false,
    destructiveTools: new Set(["bash", "write_file", "edit_file"]),
  };

  cp.beginTurn();
  await runAgenticLoop([{ role: "user", content: "write it" }], ctx);

  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(listTurns(dir), []);
});
