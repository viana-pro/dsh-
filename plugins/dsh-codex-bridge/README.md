# dsh-codex-bridge

A DeepSeek Harness plugin that closes the largest capability gap between DSH and
OpenAI Codex: an `apply_patch` tool with Codex's own patch grammar, matching
semantics, and model-facing wording — plus the prompt section that teaches it.

It does not replace DSH's edit tools. It adds the one operation DSH has no
equivalent for, and leaves authorization exactly where DSH already puts it.

## What it adds

- **`apply_patch(command)`** — one freeform patch string, one or many files:
  `*** Update File:`, `*** Add File:`, `*** Delete File:`, `*** Move to:`, `*** End of File`.
  Context is matched with Codex's four-pass tolerance: exact, then ignoring
  trailing whitespace, then ignoring surrounding whitespace, then after
  normalizing curly quotes and unicode dashes.
- **`tool:apply_patch` prompt section** — registered only while the tool is
  visible to that agent, so a restricted agent pays no tokens for it.
- **Diff cards** — the tool returns structured `before`/`after` per file, so the
  UI renders a real diff rather than a text blob.
- **Failure wording that matches Codex** — `apply_patch verification failed: …`,
  and a partial failure names the files that were already written.

## What it deliberately does not do

- **It does not bypass the sandbox.** Every write goes through the shared
  `fs/write-intent` waterfall and the same `ctx.fs.writeText` entry point that
  `dsh-tool-fs` uses. `dsh-fs-observation-policy`, `dsh-fs-sandbox` and any
  deployment policy keep deciding. Read-before-write and `FS_STALE_VERSION`
  therefore apply to patches exactly as they do to `write`/`edit`.
- **It does not add persistent approval rules.** That gap is structural in DSH
  (`dsh-user-approval` has only `allowed-once`), so the plugin reuses DSH's
  existing one-shot `sandbox_permissions` + `justification` escalation and
  nothing more.
- **It does not make a multi-file patch one transaction.** Like Codex, files
  written before a later failure stay written, and the result says which.

## Install

This package declares `dsh.bundle.patch`, so it installs as an ordinary
**profile bundle** — no hand-editing required:

```powershell
dsh plugin --profile <name> add <absolute path to this package>
```

That adds the dependency, links the package into the profile, and appends
`dsh-codex-bridge` to `dsh.profile.bundles`. The bundle's `cordis.patch.yml`
layer then registers the `codex-bridge` row in the composed tree, which is what
makes the plugin toggleable from the Web client's plugin page and manageable
through `plugin_manager`.

Two things to know:

- Node's ESM resolver reads a symlink's *real* path, so the package's own
  dependencies must sit next to the real path. This package vendors
  `@deepseek-ai/schemastery` and `@deepseek-ai/cosmokit` under its own
  `node_modules/` for exactly that reason.
- A deployment that prefers the manual route can instead insert the same row
  from `<profile>/cordis.patch.yml`:

  ```yaml
  - insert:
      - id: codex-bridge
        name: dsh-codex-bridge
        config:
          maxPatchBytes: 1000000
          maxFiles: 50
  ```

  Both routes produce the same row; the bundle route additionally makes it a
  selectable, listed bundle. To roll back, deselect the bundle (or remove that
  patch block) and restart.

### Verify it loaded

```powershell
$env:DSH_HOME="$env:USERPROFILE\.dsh"
dsh --profile <name> --dump-config-schema
```

A healthy load reports one entry with `"name": "dsh-codex-bridge"` and
`"status": "schema"` pointing at a config definition containing
`maxPatchBytes` and `maxFiles`.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxPatchBytes` | `1000000` | Byte cap on one patch string, checked before parsing |
| `maxFiles` | `50` | Cap on file sections in one patch, so a runaway patch cannot fan out |

Because the package is now a declared bundle, it appears on the Web client's
plugin page like any other bundle. What the user actually notices, however, is
the tool: a new session's `apply_patch` definition plus the `tool:apply_patch`
system-prompt section. The composed tree is built at boot, so any profile-layer
change needs a full application restart before the tool appears.

## Test

The suite drives the real `apply()` against a mocked Cordis context and a
filesystem double that carries `dsh-fs-local`'s version-guard semantics:

```powershell
node test/register-hook.mjs
```

`test/register-hook.mjs` installs an ESM resolve hook that maps
`@deepseek-ai/*` to the read-only extracted package tree, because those packages
normally live inside `app.asar`, which plain Node cannot read. The hook is
test-only; the plugin never uses it.

Covered: multi-file add/update/delete, fuzzy context, end-of-file anchoring,
moves, several hunks batched into one read/write per file, per-file atomicity,
cross-file partial failure reporting, heredoc wrappers, malformed input,
`No files were modified.`, replay-safe `presentCall`, and the wire schema.

## Layout

```
src/index.js        plugin entry: tool registration, prompt section, fs plumbing
src/patch-parse.js  pure parser + Codex seekSequence (no I/O, no imports)
test/               functional suite + the test-only resolve hook
AGENTS.md           companion working-style guidance (see below)
```

## Companion AGENTS.md

`AGENTS.md` in this package is the other half of the port. DSH has no central
developer-instruction block, so the working-style contract Codex ships in its
base prompt — autonomy, preamble and progress cadence, plan discipline, change
scope, validation policy, and final-message shape — has to arrive as workspace
guidance instead. Install it where DSH reads instruction files, for example:

- user-global: `$DSH_HOME/AGENTS.md`
- per project: the project root's `AGENTS.md`

It is 11.5 KB against DSH's 65,536-byte instruction budget, and it deliberately
does not restate tool mechanics DSH already puts in the system prompt.

## Memory: what DSH has, and what this plugin does not add

Recorded here because it is a natural question about this package, and the
answer is not what the plugin does.

DSH has no dedicated memory package. A survey of every shipped `@deepseek-ai`
package finds nothing whose description or README claims long-term memory or
recall. What exists instead:

- **Session persistence** — `dsh-session-persistence-jsonl` writes each session
  as an append-only, replayable log under `$DSH_HOME/sessions/`. History is
  reconstructed from it, and it survives resume, fork and restart.
- **Workspace instructions** — `dsh-agent-instructions` loads `$DSH_HOME/AGENTS.md`
  plus the project chain from the project root down to the session cwd. This is
  the durable, cross-session channel, and it is the one this package's companion
  `AGENTS.md` uses.
- **Host-side key-value storage** — `dsh-storage-domain` gives plugins
  schema-validated durable domains, but its own README states it "does not add
  tools, prompts, or session events, so it remains invisible to the model".

So: persistence exists, and explicit memory exists in file form. What is absent
is **automatic** memory — extraction, ranking, conflict resolution, or
injection on the model's own initiative.

### Can a plugin add automatic memory?

The seams all exist, and the hooks bridges are the wrong tool for it:

- The two `hooks.json` bridges wire `SessionStart` to awaited `agent/created`
  initialization before turn 1 — the load path a memory file would use — but
  they run **command** hooks only. The `prompt` and `agent` handler types,
  which are what an LLM-backed extractor would need, are explicitly skipped
  with a warning. An extractor therefore cannot live in a `hooks.json`.
- A plugin can. Every required seam already ships and is used in production:
  `ctx.llm.stream()` for an auxiliary model call (`dsh-compaction-basic` uses it
  for summarisation), durable sourced `user/message` injection at
  `agent/pre-step` (`dsh-agent-instructions` uses it for the instruction
  baseline), and `agent/turn-stopping` / `turn/end` to decide when extraction
  runs. `dsh-storage-domain` gives a durable place to keep the result.

The honest summary: automatic memory is **absent but buildable** on existing
seams. It is not implemented here, and no part of it has been built or
tested — this section records feasibility, not a capability.
