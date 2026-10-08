// Host half of dsh-turn-rollback.
//
// DSH records what each turn changed but cannot undo it. This plugin keeps its
// own journal per Session: before a `write`, `edit`, `str_replace_editor`, or
// `apply_patch` call runs, every path it names is copied into a per-Session
// temporary directory, or recorded as absent. Rolling back the newest finished
// turn then deletes the files that turn created, writes back the files it
// changed or removed, and removes the directories it created once they are
// empty - so the workspace holds the state the turn before it left behind.
//
// The journal is in-memory plus one temporary directory, like the shipped
// workspace-changes recorder: it lives as long as its Session in this Host
// process, is removed when the Session is disposed, and is never written into
// the workspace.
//
// It imports only Node built-ins and Cordis service keys, so the package
// installs as an out-of-tree bundle without resolving private packages.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, realpath, rm, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { patchMutationPaths } from "./patch-paths.js";

const name = "turn-rollback";
// Hard service dependencies (Cordis service keys, not npm packages).
const inject = ["commands", "tools"];

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TURNS = 20;
const MAX_REPORTED_PATHS = 20;

const USAGE = "Usage: /rollback (no arguments)";
const COMMAND_DESCRIPTION = "Discard the newest finished turn's file changes";
const TOOL_DESCRIPTION = [
  "Undo the file changes of the newest finished conversation turn: delete the files that turn created",
  "and restore the files it changed or deleted, so the workspace holds the state the previous turn left.",
  "Call this only when the user explicitly asks to discard, undo, or roll back an earlier turn;",
  "the turn that is running is never touched."
].join(" ");

// Windows and macOS resolve spellings that differ only by case to one file, so
// the journal must key those spellings together too.
const FOLD_CASE = process.platform === "win32" || process.platform === "darwin";

const NO_TURN = "Nothing to roll back: this session has recorded no turn yet.";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function positiveInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

function resolveOptions(config) {
  const raw = config !== null && typeof config === "object" ? config : {};
  return {
    maxFileBytes: positiveInt(raw.maxFileBytes, DEFAULT_MAX_FILE_BYTES),
    maxTurns: positiveInt(raw.maxTurns, DEFAULT_MAX_TURNS)
  };
}

function journalKey(path) {
  return FOLD_CASE ? path.toLowerCase() : path;
}

function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function absoluteOf(path, cwd) {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/**
 * Symlink-resolved spelling of a path. A path that does not exist yet resolves
 * through its nearest existing ancestor, so a file created through a directory
 * symlink keeps one identity before and after it exists.
 */
async function canonicalPath(absolute) {
  const missing = [];
  let head = absolute;
  for (;;) {
    try {
      return join(await realpath(head), ...missing);
    } catch {
      const parent = dirname(head);
      if (parent === head) return absolute;
      missing.unshift(basename(head));
      head = parent;
    }
  }
}

/** Directories between `absolute` and its nearest existing ancestor, nearest first. */
async function missingAncestors(absolute) {
  const missing = [];
  let head = dirname(absolute);
  for (;;) {
    const info = await stat(head).catch(() => undefined);
    if (info !== undefined) return missing;
    const parent = dirname(head);
    if (parent === head || parent === "") return missing;
    missing.push(head);
    head = parent;
  }
}

/**
 * The model-facing paths one pending tool call is about to mutate. Reads and
 * non-mutating `str_replace_editor` commands yield nothing.
 */
function mutationTargets(toolName, args) {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return [];
  const record = args;
  switch (toolName) {
    case "write": {
      const path = typeof record.content === "string" ? text(record.file_path) : undefined;
      return path === undefined ? [] : [path];
    }
    case "edit": {
      const path = typeof record.old_string === "string" && typeof record.new_string === "string" ? text(record.file_path) : undefined;
      return path === undefined ? [] : [path];
    }
    case "str_replace_editor": {
      const path = record.command === "create" || record.command === "str_replace" || record.command === "insert" ? text(record.path) : undefined;
      return path === undefined ? [] : [path];
    }
    case "apply_patch":
      return typeof record.command === "string" ? patchMutationPaths(record.command) : [];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// pre-images
// ---------------------------------------------------------------------------

/**
 * Store the current content of one path, or record that it is absent.
 * @returns `absent`, `other`, `oversized`, or `file` with the copy's path.
 */
async function captureFile(absolute, directory, maxBytes) {
  let handle;
  try {
    handle = await open(absolute, "r");
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") return { path: absolute, kind: "absent" };
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { path: absolute, kind: "other" };
    if (info.size > maxBytes) return { path: absolute, kind: "oversized", bytes: info.size };
    await mkdir(directory, { recursive: true });
    // Content-addressed by the path, so one path keeps exactly one pre-image
    // per turn however often it is edited again.
    const copy = join(directory, createHash("sha1").update(absolute).digest("hex"));
    await copyFile(absolute, copy);
    return { path: absolute, kind: "file", copy, bytes: info.size };
  } finally {
    await handle.close();
  }
}

function hashFile(path) {
  return new Promise((settle, fail) => {
    const hash = createHash("sha1");
    createReadStream(path)
      .on("error", fail)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => settle(hash.digest("hex")));
  });
}

/** Whether two files hold the same bytes, without reading either into memory. */
async function sameBytes(a, b) {
  const [infoA, infoB] = await Promise.all([stat(a), stat(b)]);
  if (infoA.size !== infoB.size) return false;
  return (await hashFile(a)) === (await hashFile(b));
}

// ---------------------------------------------------------------------------
// journals
// ---------------------------------------------------------------------------

class TurnJournal {
  constructor(turn) {
    this.turn = turn;
    this.entries = new Map();
    this.directories = new Set();
    this.closed = false;
  }
}

function stateFor(sessions, session, options) {
  let state = sessions.get(session.id);
  if (state === undefined) {
    state = {
      directory: mkdtemp(join(tmpdir(), "dsh-turn-rollback-")).catch(() => undefined),
      turns: [],
      current: null,
      lastTurn: 0,
      options
    };
    sessions.set(session.id, state);
  }
  return state;
}

function trim(state) {
  while (state.turns.length > state.options.maxTurns) {
    const oldest = state.turns[0];
    if (oldest === state.current) return;
    state.turns.shift();
  }
}

/**
 * Open the journal for one turn. A turn number that reappears (an interrupted
 * turn the loop resumes) keeps its existing journal, so nothing captured
 * before the interruption is lost.
 */
function beginTurn(state, turn) {
  const numeric = Number.isFinite(turn) ? turn : 0;
  state.lastTurn = Math.max(state.lastTurn, numeric);
  const existing = state.turns.find((journal) => journal.turn === numeric);
  if (existing !== undefined) {
    existing.closed = false;
    state.current = existing;
    return existing;
  }
  if (state.current !== null) state.current.closed = true;
  const journal = new TurnJournal(numeric);
  state.turns.push(journal);
  state.current = journal;
  trim(state);
  return journal;
}

function endTurn(state, turn) {
  if (state === undefined) return;
  const numeric = Number.isFinite(turn) ? turn : undefined;
  const journal = numeric === undefined
    ? state.current
    : state.turns.find((candidate) => candidate.turn === numeric) ?? state.current;
  if (journal !== null && journal !== undefined) journal.closed = true;
}

async function record(journal, state, canonical, options) {
  try {
    const directory = await state.directory;
    if (directory === undefined) return { path: canonical, kind: "failed", message: "the journal directory could not be created" };
    const image = await captureFile(canonical, join(directory, `turn-${journal.turn}`), options.maxFileBytes);
    if (image.kind === "absent") for (const ancestor of await missingAncestors(canonical)) journal.directories.add(ancestor);
    return image;
  } catch (error) {
    return { path: canonical, kind: "failed", message: messageOf(error) };
  }
}

/**
 * Journal every path a pending call names, before the call can mutate it.
 * Each entry is stored as its own promise, so a second call in the same turn
 * cannot capture the file after the first one changed it.
 */
async function capture(state, session, toolName, args) {
  const cwd = session.header === null || session.header === undefined ? undefined : session.header.cwd;
  if (typeof cwd !== "string" || cwd === "") return;
  const targets = mutationTargets(toolName, args);
  if (targets.length === 0) return;
  const journal = state.current ?? beginTurn(state, state.lastTurn);
  const pending = [];
  for (const target of targets) {
    let canonical = absoluteOf(target, cwd);
    try {
      canonical = await canonicalPath(canonical);
    } catch {
      // Keep the resolved spelling; only a realpath failure can land here.
    }
    const key = journalKey(canonical);
    if (journal.entries.has(key)) continue;
    const operation = record(journal, state, canonical, state.options);
    journal.entries.set(key, operation);
    pending.push(operation);
  }
  if (pending.length > 0) await Promise.all(pending);
}

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

/** Apply one pre-image, returning the action it took. */
async function restoreOne(image) {
  const path = image.path;
  if (image.kind === "absent") {
    const info = await stat(path).catch(() => undefined);
    if (info === undefined) return "unchanged";
    if (info.isDirectory()) return "skipped";
    await rm(path, { force: true });
    return "deleted";
  }
  if (image.kind === "file") {
    const info = await stat(path).catch(() => undefined);
    if (info !== undefined && info.isFile() && await sameBytes(path, image.copy)) return "unchanged";
    await mkdir(dirname(path), { recursive: true });
    await copyFile(image.copy, path);
    return "restored";
  }
  if (image.kind === "other") return "skipped";
  return "unrestorable";
}

async function restore(journal) {
  const actions = [];
  const failures = [];
  for (const image of await Promise.all([...journal.entries.values()])) {
    try {
      const action = await restoreOne(image);
      actions.push({ path: image.path, action });
      if (action === "unrestorable") failures.push(image);
    } catch (error) {
      actions.push({ path: image.path, action: "failed", message: messageOf(error) });
      failures.push(image);
    }
  }
  // Files are gone by now, so a directory the turn created can be removed.
  // `rmdir` refuses a directory that still holds anything.
  for (const directory of [...journal.directories].sort((a, b) => b.length - a.length)) {
    await rmdir(directory).catch(() => undefined);
  }
  return { actions, failures };
}

/**
 * Undo the newest finished turn. The turn that is still running is skipped:
 * its journal stays open until `turn/end`, so a call made from inside a turn
 * undoes the turn before it.
 */
async function executeRollback(state) {
  if (state === undefined || state.turns.length === 0) return { kind: "empty" };
  const finished = state.turns.filter((journal) => journal.closed);
  // Never touch the running turn: nothing is finished only while the session's
  // first turn is still open, and undoing that turn from inside it would delete
  // the very files it is still working on.
  if (finished.length === 0) return { kind: "running", turn: state.turns[state.turns.length - 1].turn };
  const target = finished[finished.length - 1];
  state.turns.splice(state.turns.indexOf(target), 1);
  if (state.current === target) state.current = null;
  const report = await restore(target);
  if (report.failures.length > 0) {
    // A path that could not be restored stays in the journal so another
    // invocation retries it instead of walking further back.
    const carried = new TurnJournal(target.turn);
    carried.closed = true;
    for (const image of report.failures) carried.entries.set(journalKey(image.path), Promise.resolve(image));
    for (const directory of target.directories) carried.directories.add(directory);
    state.turns.push(carried);
  }
  const remaining = state.turns.filter((journal) => journal.closed);
  return {
    kind: "done",
    turn: target.turn,
    report,
    next: remaining.length > 0 ? remaining[remaining.length - 1].turn : undefined
  };
}

const ACTION_LABELS = {
  deleted: "deleted",
  restored: "restored",
  unchanged: "unchanged",
  skipped: "skipped",
  failed: "failed",
  unrestorable: "unrestorable"
};

function renderOutcome(outcome) {
  if (outcome.kind === "empty") return { text: NO_TURN, turn: undefined, counts: {} };
  if (outcome.kind === "running") {
    return {
      text: `Turn ${outcome.turn} is still running and no earlier turn is recorded, so there is nothing to roll back yet. Run /rollback after it finishes.`,
      turn: outcome.turn,
      counts: {}
    };
  }
  const { report, turn, next } = outcome;
  const counts = {};
  for (const entry of report.actions) counts[entry.action] = (counts[entry.action] ?? 0) + 1;
  if (report.actions.length === 0) {
    return {
      text: `Turn ${turn} changed no journaled file, so there was nothing to roll back.${next === undefined ? "" : `\nRun /rollback again to undo turn ${next}.`}`,
      turn,
      counts
    };
  }
  const summary = Object.keys(ACTION_LABELS)
    .filter((action) => counts[action] !== undefined)
    .map((action) => `${counts[action]} ${ACTION_LABELS[action]}`)
    .join(", ");
  const lines = [`Rolled back turn ${turn}: ${summary}.`];
  const listed = report.actions.slice(0, MAX_REPORTED_PATHS);
  for (const entry of listed) {
    const detail = entry.message === undefined ? "" : ` (${entry.message})`;
    lines.push(`${ACTION_LABELS[entry.action] ?? entry.action}  ${entry.path}${detail}`);
  }
  if (report.actions.length > listed.length) lines.push(`... and ${report.actions.length - listed.length} more`);
  if (counts.unrestorable !== undefined || counts.failed !== undefined) {
    lines.push("A path that could not be restored stays in the journal, so another /rollback retries it.");
  }
  if (next !== undefined) lines.push(`Run /rollback again to undo turn ${next}.`);
  return { text: lines.join("\n"), turn, counts };
}

async function rollbackForSession(sessions, session, options) {
  const state = sessions.get(session.id);
  if (state === undefined) return { text: NO_TURN, turn: undefined, counts: {} };
  return renderOutcome(await executeRollback(state));
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

async function discard(state) {
  const directory = await state.directory;
  if (directory === undefined) return;
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

async function discardSession(sessions, session) {
  const state = sessions.get(session.id);
  if (state === undefined) return;
  sessions.delete(session.id);
  await discard(state);
}

function apply(ctx, config) {
  const options = resolveOptions(config);
  const sessions = new Map();

  ctx.effect(() => async () => {
    for (const state of sessions.values()) await discard(state);
    sessions.clear();
  }, "turn-rollback: journals");

  ctx.on("session/event", (session, event) => {
    if (session === undefined || event === undefined) return;
    if (event.type === "turn/start") beginTurn(stateFor(sessions, session, options), event.data?.turn);
    else if (event.type === "turn/end") endTurn(sessions.get(session.id), event.data?.turn);
  });

  ctx.on("session/disposed", (session) => {
    void discardSession(sessions, session);
  });

  ctx.on("tools/pre-execute", async (exec, next) => {
    const session = exec === undefined || exec.agent === undefined ? undefined : exec.agent.session;
    if (session !== undefined && sessions.has(session.id)) await capture(sessions.get(session.id), session, exec.name, exec.arguments);
    return next();
  });

  ctx.effect(() => ctx.commands.register({
    name: "rollback",
    description: COMMAND_DESCRIPTION,
    handler: async (invocation) => {
      if (invocation.rawInput.trim() !== "") return { kind: "error", text: USAGE };
      const session = invocation.agent === undefined ? undefined : invocation.agent.session;
      if (session === undefined) return { kind: "error", text: "This session has no working directory to roll back." };
      const { text: report } = await rollbackForSession(sessions, session, options);
      return { kind: "success", text: report };
    }
  }), "turn-rollback: /rollback");

  ctx.effect(() => ctx.tools.register({
    name: "rollback_turn",
    description: TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    output: {
      schema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          turn: { type: "number" },
          deleted: { type: "number" },
          restored: { type: "number" },
          unchanged: { type: "number" },
          failed: { type: "number" }
        },
        required: ["summary"],
        additionalProperties: false
      },
      render: (_args, value) => [{ type: "text", text: value.summary }]
    },
    async execute(_args, exec) {
      const session = exec === undefined || exec.agent === undefined ? undefined : exec.agent.session;
      if (session === undefined) throw new Error("rollback_turn needs a session with a working directory");
      const { text: report, turn, counts } = await rollbackForSession(sessions, session, options);
      return {
        summary: report,
        turn: turn ?? 0,
        deleted: counts.deleted ?? 0,
        restored: counts.restored ?? 0,
        unchanged: counts.unchanged ?? 0,
        failed: (counts.failed ?? 0) + (counts.unrestorable ?? 0)
      };
    }
  }), "turn-rollback: rollback_turn tool");
}

export { apply, inject, name };
