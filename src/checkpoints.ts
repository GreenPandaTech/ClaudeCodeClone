import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import type { ToolResult } from "./tools.js";

// Turn-level checkpoints for /undo and /changes. Before each APPROVED
// write_file / edit_file is applied, the pre-image (the file's full prior
// content, or an explicit did-not-exist marker) is snapshotted together with a
// hash of the post-image, grouped per user turn, under .mentor/checkpoints/ in
// the working directory. The .mentor directory is made self-ignoring exactly
// the way .mentor/sessions/ already is, so checkpoints never land in git.
//
// The safety rule for /undo: a change is only reverted when the file's current
// content still hashes to the recorded post-image. If the user edited the file
// since, the revert is REFUSED and the caller shows a diff instead of
// clobbering their edits.

export const CHECKPOINT_SCHEMA_VERSION = 1;

/** Turns kept on disk before pruning (override via checkpointTurns in .mentorrc.json). */
export const DEFAULT_KEEP_TURNS = 20;

export interface FileChange {
  /** Absolute path of the changed file, as resolved at write time. */
  file: string;
  /** The tool that made the change (write_file | edit_file). */
  tool: string;
  /** False = the did-not-exist marker: the write created this file. */
  existedBefore: boolean;
  /** Full pre-image ("" when existedBefore is false). */
  before: string;
  /** sha256 hex of the content the tool left on disk. */
  afterHash: string;
}

export interface TurnCheckpoint {
  version: number;
  turn: number;
  changes: FileChange[];
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

// ─── The on-disk store ────────────────────────────────────────────────────────

function checkpointsDir(cwd: string): string {
  return path.join(cwd, ".mentor", "checkpoints");
}

function turnFile(cwd: string, turn: number): string {
  return path.join(checkpointsDir(cwd), `turn-${String(turn).padStart(6, "0")}.json`);
}

/** Ensure .mentor exists and self-ignores (same mechanism as the session store). */
function ensureStore(cwd: string): void {
  fs.mkdirSync(checkpointsDir(cwd), { recursive: true });
  const gitignore = path.join(cwd, ".mentor", ".gitignore");
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, "*\n", "utf-8");
  }
}

/** Parse the raw text of a turn checkpoint file, fail-loud. */
export function parseTurnCheckpoint(text: string): TurnCheckpoint {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid checkpoint file: not valid JSON (${String(err)})`, { cause: err });
  }
  if (raw === null || typeof raw !== "object") {
    throw new Error("Invalid checkpoint file: expected a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== CHECKPOINT_SCHEMA_VERSION) {
    throw new Error(`Unsupported checkpoint version: ${String(obj.version)} (expected ${CHECKPOINT_SCHEMA_VERSION})`);
  }
  if (typeof obj.turn !== "number" || !Number.isInteger(obj.turn)) {
    throw new Error("Invalid checkpoint file: turn must be an integer");
  }
  if (!Array.isArray(obj.changes)) {
    throw new Error("Invalid checkpoint file: changes must be an array");
  }
  for (const ch of obj.changes as Record<string, unknown>[]) {
    if (
      ch === null || typeof ch !== "object" ||
      typeof ch.file !== "string" || typeof ch.tool !== "string" ||
      typeof ch.existedBefore !== "boolean" ||
      typeof ch.before !== "string" || typeof ch.afterHash !== "string"
    ) {
      throw new Error("Invalid checkpoint file: malformed change entry");
    }
  }
  return { version: CHECKPOINT_SCHEMA_VERSION, turn: obj.turn, changes: obj.changes as FileChange[] };
}

/** All recorded turns, sorted ascending by turn id. Empty when none. */
export function listTurns(cwd: string): TurnCheckpoint[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(checkpointsDir(cwd));
  } catch {
    return [];
  }
  return entries
    .filter((e) => /^turn-\d+\.json$/.test(e))
    .map((e) => parseTurnCheckpoint(fs.readFileSync(path.join(checkpointsDir(cwd), e), "utf-8")))
    .filter((t) => t.changes.length > 0)
    .sort((a, b) => a.turn - b.turn);
}

/** The next unused turn id (existing max + 1), so restarts never collide. */
export function nextTurnId(cwd: string): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(checkpointsDir(cwd));
  } catch {
    return 1;
  }
  let max = 0;
  for (const e of entries) {
    const m = e.match(/^turn-(\d+)\.json$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** Append a change to the given turn's checkpoint file. Returns the file path. */
export function recordChange(cwd: string, turn: number, change: FileChange): string {
  ensureStore(cwd);
  const file = turnFile(cwd, turn);
  let data: TurnCheckpoint;
  if (fs.existsSync(file)) {
    data = parseTurnCheckpoint(fs.readFileSync(file, "utf-8"));
  } else {
    data = { version: CHECKPOINT_SCHEMA_VERSION, turn, changes: [] };
  }
  data.changes.push(change);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
  return file;
}

/** Delete the oldest turns beyond keepTurns. Returns how many were removed. */
export function pruneCheckpoints(cwd: string, keepTurns: number): number {
  const turns = listTurns(cwd);
  const excess = turns.length - keepTurns;
  if (excess <= 0) return 0;
  for (const t of turns.slice(0, excess)) {
    fs.unlinkSync(turnFile(cwd, t.turn));
  }
  return excess;
}

// ─── /changes view ────────────────────────────────────────────────────────────

export interface ChangeView extends FileChange {
  /** What is on disk right now ("" when the file is gone). */
  current: string;
  /** True while the on-disk content still matches the recorded post-image. */
  intact: boolean;
}

export interface TurnView {
  turn: number;
  changes: ChangeView[];
}

function readCurrent(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/** Every recorded change paired with the file's current on-disk content, so the
 *  caller can render before/current diffs with the existing diff renderer. */
export function viewChanges(cwd: string): TurnView[] {
  return listTurns(cwd).map((t) => ({
    turn: t.turn,
    changes: t.changes.map((ch) => {
      const current = readCurrent(ch.file);
      return {
        ...ch,
        current: current ?? "",
        intact: current !== null && hashContent(current) === ch.afterHash,
      };
    }),
  }));
}

// ─── /undo ────────────────────────────────────────────────────────────────────

export interface UndoRefusal {
  file: string;
  reason: string;
  /** The recorded pre-image (what /undo would have restored). */
  before: string;
  /** What is on disk right now ("" when the file is gone). */
  current: string;
}

export interface UndoResult {
  turn: number;
  undone: { file: string; action: "restored" | "deleted" }[];
  refused: UndoRefusal[];
}

/** Revert one change if — and only if — the file still matches its recorded
 *  post-image. On mismatch the file is left untouched and a refusal is added. */
function revertOne(change: FileChange, result: UndoResult): boolean {
  const current = readCurrent(change.file);
  if (current === null) {
    result.refused.push({
      file: change.file,
      reason: "the file no longer exists on disk (deleted or unreadable since Mentor changed it)",
      before: change.before,
      current: "",
    });
    return false;
  }
  if (hashContent(current) !== change.afterHash) {
    result.refused.push({
      file: change.file,
      reason: "the file was edited since Mentor changed it - refusing to clobber those edits",
      before: change.before,
      current,
    });
    return false;
  }
  if (change.existedBefore) {
    fs.writeFileSync(change.file, change.before, "utf-8");
    result.undone.push({ file: change.file, action: "restored" });
  } else {
    fs.unlinkSync(change.file);
    result.undone.push({ file: change.file, action: "deleted" });
  }
  return true;
}

/** Rewrite a turn's checkpoint file, or remove it once every change is undone. */
function writeTurnOrRemove(cwd: string, turn: TurnCheckpoint): void {
  const file = turnFile(cwd, turn.turn);
  if (turn.changes.length === 0) {
    fs.unlinkSync(file);
  } else {
    fs.writeFileSync(file, JSON.stringify(turn, null, 2), "utf-8");
  }
}

/** Revert the most recent recorded change. Returns null when nothing is
 *  recorded. A refused change stays recorded so it can be retried after the
 *  user restores the file by hand. */
export function undoLastChange(cwd: string): UndoResult | null {
  const turns = listTurns(cwd);
  if (turns.length === 0) return null;
  const last = turns[turns.length - 1];
  const change = last.changes[last.changes.length - 1];
  const result: UndoResult = { turn: last.turn, undone: [], refused: [] };
  if (revertOne(change, result)) {
    last.changes.pop();
    writeTurnOrRemove(cwd, last);
  }
  return result;
}

/** Revert every change of the most recent turn, newest first (so a file changed
 *  twice in one turn walks back to its original content). Refusals are per
 *  file: intact files revert, edited ones are kept recorded and left alone. */
export function undoLastTurn(cwd: string): UndoResult | null {
  const turns = listTurns(cwd);
  if (turns.length === 0) return null;
  const last = turns[turns.length - 1];
  const result: UndoResult = { turn: last.turn, undone: [], refused: [] };
  const kept: FileChange[] = [];
  for (let i = last.changes.length - 1; i >= 0; i--) {
    if (!revertOne(last.changes[i], result)) kept.unshift(last.changes[i]);
  }
  last.changes = kept;
  writeTurnOrRemove(cwd, last);
  return result;
}

// ─── The checkpointing execute wrapper (the DI seam) ─────────────────────────

export interface CheckpointerOptions {
  /** Where the store lives; a function because /cwd can move the working dir. */
  cwd?: () => string;
  /** Turns kept before pruning (default DEFAULT_KEEP_TURNS). */
  keepTurns?: number;
}

export interface Checkpointer {
  /** Drop-in replacement for the tool executor that snapshots file changes. */
  execute: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  /** Mark the start of a new user turn; the next change starts a new group. */
  beginTurn(): void;
  /** Turn ids allocated by THIS session, oldest first (drives /changes). */
  sessionTurns(): number[];
}

const CHECKPOINTED_TOOLS = new Set(["write_file", "edit_file"]);

/** Wrap a tool executor so every successful write_file / edit_file is
 *  checkpointed. Sits on the existing execute seam, so the agentic loop only
 *  ever hands it APPROVED calls (declined tools never reach execute). */
export function withCheckpoints(
  inner: (name: string, input: Record<string, unknown>) => Promise<ToolResult>,
  opts: CheckpointerOptions = {}
): Checkpointer {
  const cwd = opts.cwd ?? (() => process.cwd());
  const keepTurns = opts.keepTurns ?? DEFAULT_KEEP_TURNS;
  let turnId: number | null = null; // allocated lazily on the turn's first change
  const allocated: number[] = [];

  return {
    beginTurn() {
      turnId = null;
    },
    sessionTurns() {
      return [...allocated];
    },
    async execute(name, input) {
      if (!CHECKPOINTED_TOOLS.has(name)) return inner(name, input);

      const file = path.resolve(String(input.file_path ?? ""));

      // Snapshot the pre-image BEFORE the tool runs. A missing file is the
      // did-not-exist marker; any other read failure means the pre-image cannot
      // be trusted, so the change is applied but honestly left unrecorded.
      let existedBefore = false;
      let before = "";
      let snapshotFailed = false;
      try {
        before = fs.readFileSync(file, "utf-8");
        existedBefore = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") snapshotFailed = true;
      }

      const result = await inner(name, input);
      if (result.isError) return result; // nothing changed — nothing to record

      try {
        if (snapshotFailed) throw new Error("could not read the pre-image before the change");
        const after = fs.readFileSync(file, "utf-8");
        if (turnId === null) {
          turnId = nextTurnId(cwd());
          allocated.push(turnId);
        }
        recordChange(cwd(), turnId, {
          file,
          tool: name,
          existedBefore,
          before,
          afterHash: hashContent(after),
        });
        pruneCheckpoints(cwd(), keepTurns);
      } catch (err) {
        // The write itself succeeded; say so, but be honest that /undo will
        // not cover it rather than failing the tool call.
        return {
          ...result,
          output: `${result.output}\n(warning: checkpoint not recorded - /undo will not cover this change: ${
            err instanceof Error ? err.message : String(err)
          })`,
        };
      }
      return result;
    },
  };
}
