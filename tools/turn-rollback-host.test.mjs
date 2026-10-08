// Isolated exercise of the dsh-turn-rollback host half: mounts the plugin on a
// stub Cordis context, captures the listeners and registrations it installs,
// drives a real temporary workspace through turn boundaries and mutating tool
// calls, and checks what /rollback restores. Run with the bundled Node.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, inject, name } from "../plugins/dsh-turn-rollback/lib/index.js";
import { patchMutationPaths } from "../plugins/dsh-turn-rollback/lib/patch-paths.js";

// Keep the failure mode of an unexpected throw visible instead of a silent exit 0.
process.on("unhandledRejection", (error) => {
  console.log(`FAIL  unhandled rejection  -> ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

const cases = [];
function check(label, ok, detail) {
  cases.push({ label, ok, detail });
}

// ---------------------------------------------------------------------------
// stub Cordis context
// ---------------------------------------------------------------------------

function makeCtx() {
  const handlers = new Map();
  const registrations = { command: null, tool: null };
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    effect(callback) {
      const dispose = callback();
      return () => {
        if (typeof dispose === "function") dispose();
      };
    },
    commands: {
      register(definition) {
        registrations.command = definition;
        return () => {};
      }
    },
    tools: {
      register(definition) {
        registrations.tool = definition;
        return () => {};
      }
    },
    logger: { warn() {}, info() {} }
  };
  return { ctx, handlers, registrations };
}

function harness(config) {
  const { ctx, handlers, registrations } = makeCtx();
  apply(ctx, config ?? {});
  const signal = new AbortController().signal;
  return {
    registrations,
    start(session, turn) {
      handlers.get("session/event")(session, { type: "turn/start", data: { turn } });
    },
    end(session, turn) {
      handlers.get("session/event")(session, { type: "turn/end", data: { turn } });
    },
    async beforeTool(session, tool, args) {
      return handlers.get("tools/pre-execute")({ name: tool, arguments: args, agent: { session } }, async () => ({ kind: "allow" }));
    },
    command(session, rawInput = "") {
      return registrations.command.handler({ commandId: "command-1", agent: { session }, rawInput, attachments: [], signal });
    },
    tool(session) {
      return registrations.tool.execute({}, { agent: { session }, signal });
    }
  };
}

let workCounter = 0;
async function workspace() {
  workCounter += 1;
  const path = await mkdtemp(join(tmpdir(), `turn-rollback-test-${workCounter}-`));
  return { path, session: { id: `session-${workCounter}`, header: { cwd: path, origin: "user" } } };
}

function visible(text, needle) {
  return typeof text === "string" && text.includes(needle);
}

// ---------------------------------------------------------------------------
// 1. a file the turn created is deleted, and the directories it created go too
// ---------------------------------------------------------------------------

{
  const { path, session } = await workspace();
  const host = harness();
  try {
    host.start(session, 1);
    await host.beforeTool(session, "write", { file_path: "pkg/src/new.txt", content: "hello" });
    await mkdir(join(path, "pkg/src"), { recursive: true });
    await writeFile(join(path, "pkg/src/new.txt"), "hello");
    host.end(session, 1);

    const result = await host.command(session);
    check("created file deleted", result.kind === "success" && !existsSync(join(path, "pkg/src/new.txt")), result.text);
    check("created directories removed", !existsSync(join(path, "pkg")), result.text);
    check("deletion reported", visible(result.text, "Rolled back turn 1: 1 deleted."), result.text);
    check("deleted path listed", visible(result.text, "new.txt"), result.text);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 2. a format change is restored, byte for byte
// ---------------------------------------------------------------------------

{
  const { path, session } = await workspace();
  const host = harness();
  try {
    await writeFile(join(path, "a.txt"), "original\n");
    host.start(session, 1);
    await host.beforeTool(session, "edit", { file_path: "a.txt", old_string: "original", new_string: "changed" });
    await writeFile(join(path, "a.txt"), "changed\n");
    host.end(session, 1);

    const result = await host.command(session);
    check("edited file restored", (await readFile(join(path, "a.txt"), "utf8")) === "original\n", result.text);
    check("restore reported", visible(result.text, "1 restored"), result.text);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 3. binary content survives the round trip
// ---------------------------------------------------------------------------

{
  const { path, session } = await workspace();
  const host = harness();
  try {
    const original = Buffer.from([0, 1, 2, 255, 254, 0, 65, 66]);
    await writeFile(join(path, "blob.bin"), original);
    host.start(session, 1);
    await host.beforeTool(session, "write", { file_path: "blob.bin", content: "not binary" });
    await writeFile(join(path, "blob.bin"), Buffer.from([9, 9, 9]));
    host.end(session, 1);

    const result = await host.command(session);
    check("binary file restored exactly", Buffer.compare(await readFile(join(path, "blob.bin")), original) === 0, result.text);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 4. an unchanged pre-image is reported, not rewritten
// ---------------------------------------------------------------------------

{
  const { path, session } = await workspace();
  const host = harness();
  try {
    await writeFile(join(path, "same.txt"), "same\n");
    const before = await stat(join(path, "same.txt"));
    host.start(session, 1);
    await host.beforeTool(session, "write", { file_path: "same.txt", content: "same\n" });
    host.end(session, 1);

    const result = await host.tool(session);
    check("unchanged file counted", result.unchanged === 1 && result.restored === 0 && result.deleted === 0, JSON.stringify(result));
    const after = await stat(join(path, "same.txt"));
    check("unchanged file left alone", after.mtimeMs === before.mtimeMs, `${before.mtimeMs} ${after.mtimeMs}`);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5. repeated invocations walk one turn further back
// ---------------------------------------------------------------------------

{
  const { path, session } = await workspace();
  const host = harness();
  try {
    host.start(session, 1);
    await host.beforeTool(session, "write", { file_path: "one.txt", content: "1" });
    await writeFile(join(path, "one.txt"), "1");
    host.end(session, 1);

    host.start(session, 2);
    await host.beforeTool(session, "write", { file_path: "two.txt", content: "2" });
    await writeFile(join(path, "two.txt"), "2");
    host.end(session, 2);

    const first = await host.command(session);
    check("newest turn rolled back first", !existsSync(join(path, "two.txt")) && existsSync(join(path, "one.txt")), first.text);
    check("next turn offered", visible(first.text, "undo turn 1"), first.text);

    const second = await host.command(session);
    check("earlier turn follows", !existsSync(join(path, "one.txt")), second.text);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 6. a turn that changed nothing is consumed, not skipped over
// ---------------------------------------------------------------------------

{
  const { path, session } = await workspace();
  const host = harness();
  try {
    host.start(session, 1);
    await host.beforeTool(session, "write", { file_path: "kept.txt", content: "k" });
    await writeFile(join(path, "kept.txt"), "k");
    host.end(session, 1);

    host.start(session, 2);
    host.end(session, 2);

    const empty = await host.command(session);
    check("empty turn reported", visible(empty.text, "changed no journaled file"), empty.text);
    check("empty turn did not touch files", existsSync(join(path, "kept.txt")), empty.text);

    const real = await host.command(session);
    check("rollback continues past the empty turn", !existsSync(join(path, "kept.txt")), real.text);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 7. apply_patch: add, update, move, delete
// ---------------------------------------------------------------------------

{
  const { path, session } = await workspace();
  const host = harness();
  const patch = [
    "*** Begin Patch",
    "*** Add File: created.txt",
    "+created",
    "*** Update File: keep.md",
    "*** Move to: renamed.md",
    "@@",
    "-old",
    "+new",
    "*** Delete File: doomed.txt",
    "*** End Patch"
  ].join("\n");
  try {
    await writeFile(join(path, "keep.md"), "old\n");
    await writeFile(join(path, "doomed.txt"), "doomed\n");
    host.start(session, 1);
    await host.beforeTool(session, "apply_patch", { command: patch });
    await writeFile(join(path, "created.txt"), "created\n");
    await rm(join(path, "keep.md"));
    await writeFile(join(path, "renamed.md"), "new\n");
    await rm(join(path, "doomed.txt"));
    host.end(session, 1);

    const result = await host.command(session);
    check("patch-added file deleted", !existsSync(join(path, "created.txt")), result.text);
    check("patch-created move target deleted", !existsSync(join(path, "renamed.md")), result.text);
    check("patch-moved source restored", (await readFile(join(path, "keep.md"), "utf8")) === "old\n", result.text);
    check("patch-deleted file restored", (await readFile(join(path, "doomed.txt"), "utf8")) === "doomed\n", result.text);
    check("patch actions counted", visible(result.text, "2 deleted") && visible(result.text, "2 restored"), result.text);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 8. apply_patch path extraction follows the tool's own column rules
// ---------------------------------------------------------------------------

{
  const moved = patchMutationPaths([
    "*** Begin Patch",
    "*** Update File: doc.md",
    "@@",
    " *** Move to: not-a-header.md",
    "*** End Patch"
  ].join("\n"));
  check("context line is not a header", moved.join() === "doc.md", moved.join());

  const heredoc = patchMutationPaths([
    "<<'EOF'",
    "*** Begin Patch",
    "*** Add File: x.txt",
    "+a",
    "*** End Patch",
    "EOF"
  ].join("\n"));
  check("heredoc wrapper tolerated", heredoc.join() === "x.txt", heredoc.join());

  const indented = patchMutationPaths([
    "*** Begin Patch",
    "  *** Delete File: y.txt",
    "*** End Patch"
  ].join("\n"));
  check("indented header outside an update is a header", indented.join() === "y.txt", indented.join());

  const deduped = patchMutationPaths("*** Update File: a\n*** Update File: a\n*** End Patch");
  check("repeated sections deduplicate", deduped.join() === "a", deduped.join());

  const none = patchMutationPaths("*** Begin Patch\n*** End Patch");
  check("empty patch names no path", none.length === 0, none.join());
}

// ---------------------------------------------------------------------------
// 9. str_replace_editor create is journaled
// ---------------------------------------------------------------------------

{
  const { path, session } = await workspace();
  const host = harness();
  try {
    host.start(session, 1);
    await host.beforeTool(session, "str_replace_editor", { command: "create", path: "made.txt", file_text: "made" });
    await writeFile(join(path, "made.txt"), "made");
    host.end(session, 1);
    await host.command(session);
    check("str_replace_editor create deleted", !existsSync(join(path, "made.txt")));
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 10. an oversized pre-image is reported and retried, not silently skipped
// ---------------------------------------------------------------------------

{
  const { path, session } = await workspace();
  const host = harness({ maxFileBytes: 4 });
  try {
    await writeFile(join(path, "big.txt"), "0123456789");
    host.start(session, 1);
    await host.beforeTool(session, "edit", { file_path: "big.txt", old_string: "0123456789", new_string: "x" });
    await writeFile(join(path, "big.txt"), "x");
    host.end(session, 1);

    const result = await host.tool(session);
    check("oversized pre-image reported", result.failed === 1 && visible(result.summary, "unrestorable"), JSON.stringify(result));
    check("oversized file left changed", (await readFile(join(path, "big.txt"), "utf8")) === "x", result.summary);
    check("retry advice printed", visible(result.summary, "retries it"), result.summary);

    const retry = await host.tool(session);
    check("failed entry is retried", retry.turn === 1 && retry.failed === 1, JSON.stringify(retry));
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 11. an oversized file the turn created is still deleted
// ---------------------------------------------------------------------------

{
  const { path, session } = await workspace();
  const host = harness({ maxFileBytes: 4 });
  try {
    host.start(session, 1);
    await host.beforeTool(session, "write", { file_path: "fresh.txt", content: "0123456789" });
    await writeFile(join(path, "fresh.txt"), "0123456789");
    host.end(session, 1);
    await host.command(session);
    check("oversized created file deleted", !existsSync(join(path, "fresh.txt")));
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 12. an unfinished turn is skipped; the finished one before it is rolled back
// ---------------------------------------------------------------------------

{
  const { path, session } = await workspace();
  const host = harness();
  try {
    host.start(session, 1);
    await host.beforeTool(session, "write", { file_path: "first.txt", content: "1" });
    await writeFile(join(path, "first.txt"), "1");
    host.end(session, 1);

    host.start(session, 2);
    await host.beforeTool(session, "write", { file_path: "second.txt", content: "2" });
    await writeFile(join(path, "second.txt"), "2");

    const result = await host.tool(session);
    check("running turn is skipped", result.turn === 1 && result.deleted === 1, JSON.stringify(result));
    check("running turn's file untouched", existsSync(join(path, "second.txt")) && !existsSync(join(path, "first.txt")), result.summary);

    host.end(session, 2);
    const rest = await host.tool(session);
    check("finished turn rolls back next", result.turn === 1 && rest.turn === 2 && !existsSync(join(path, "second.txt")), JSON.stringify(rest));
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 13. the running turn is never rolled back, even when no turn has finished
// ---------------------------------------------------------------------------

{
  const { path, session } = await workspace();
  const host = harness();
  try {
    host.start(session, 1);
    await host.beforeTool(session, "write", { file_path: "open.txt", content: "open" });
    await writeFile(join(path, "open.txt"), "open");

    const command = await host.command(session);
    check("command refuses while the first turn runs", command.kind === "success" && visible(command.text, "still running"), command.text);
    check("running turn's file kept by the command", existsSync(join(path, "open.txt")), command.text);

    const tool = await host.tool(session);
    check("tool refuses while the first turn runs", visible(tool.summary, "still running"), tool.summary);
    check("running turn's file kept by the tool", existsSync(join(path, "open.txt")), tool.summary);

    host.end(session, 1);
    const after = await host.tool(session);
    check("the same turn rolls back once it finishes", after.deleted === 1 && !existsSync(join(path, "open.txt")), JSON.stringify(after));
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 14. argument handling, empty history, and the manifest surface
// ---------------------------------------------------------------------------

{
  const { path, session } = await workspace();
  const host = harness();
  try {
    const untouched = await host.command(session);
    check("no history reported", untouched.kind === "success" && visible(untouched.text, "Nothing to roll back"), untouched.text);

    host.start(session, 1);
    host.end(session, 1);
    const usage = await host.command(session, "now");
    check("arguments refused", usage.kind === "error" && visible(usage.text, "Usage: /rollback"), usage.text);

    const stillThere = await host.command(session);
    check("refused invocation consumed nothing", visible(stillThere.text, "Turn 1 changed no journaled file"), stillThere.text);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

check("plugin name and inject", name === "turn-rollback" && inject.join() === "commands,tools", `${name} ${inject.join()}`);
{
  const host = harness();
  check("command registered", host.registrations.command !== null && host.registrations.command.name === "rollback", host.registrations.command?.name);
  check("tool registered", host.registrations.tool !== null && host.registrations.tool.name === "rollback_turn", host.registrations.tool?.name);
  check("tool declares an output schema", host.registrations.tool?.output?.schema?.type === "object", JSON.stringify(host.registrations.tool?.output?.schema));
}

let failed = 0;
for (const item of cases) {
  if (!item.ok) failed += 1;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.label}${item.detail ? "  -> " + item.detail : ""}`);
}
console.log(failed === 0 ? `\nall ${cases.length} checks passed` : `\n${failed}/${cases.length} checks FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
