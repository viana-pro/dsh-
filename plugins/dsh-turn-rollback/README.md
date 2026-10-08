# dsh-turn-rollback

A DeepSeek Harness plugin that adds the one thing DSH's turn record cannot do:
**undo it**. When a turn is declared void, `/rollback` deletes the files that
turn created and restores the files it changed or deleted, so the workspace
holds the state the turn before it left behind.

## What it adds

- **`/rollback`** - a human command that rolls back the newest *finished* turn
  and prints what it did. Running it again walks one turn further back.
- **`rollback_turn`** - the same operation as a tool, so "撤销上一轮" in plain
  language reaches it. It never touches the turn that is running: a call made
  from inside a turn undoes the turn before it.

## How it works

One journal per turn and Session. Before a mutating call runs,
`tools/pre-execute` resolves every path the call names and copies that path into
a per-Session temporary directory - or records it as absent, which is the fact
that later allows a safe delete. A path is captured once per turn, before the
turn's first mutation of it, and the capture is awaited before the call is
allowed to proceed, so no mutation can outrun its pre-image.

`turn/start` opens a journal and `turn/end` closes it. Rolling back the newest
closed journal applies each pre-image. The turn that is still running is never
touched - while a session's first turn is open there is nothing to undo, and the
report says so instead of deleting the files that turn is still working on:

| Pre-image | File now | Action |
|---|---|---|
| absent | absent | unchanged |
| absent | present | **deleted** (the turn created it) |
| present | absent | **restored** (the turn deleted it) |
| present | identical bytes | unchanged |
| present | different bytes | **restored** to the pre-image |

Directories the turn created are removed afterwards, deepest first, and only
while they are still empty. Files are compared and restored byte for byte, so
binary content survives.

Covered mutating calls: `write`, `edit`, `str_replace_editor`
(`create`/`str_replace`/`insert`), and `apply_patch` - including its
`*** Add File:`, `*** Delete File:`, `*** Update File:`, and `*** Move to:`
sections, whose header positions are parsed with the same column rules the tool
itself applies.

## What it deliberately does not do

- **Shell writes are not journaled.** A file created by a `pwsh`/`bash` command
  is invisible to this plugin, because no pre-execute hook names its paths. The
  shipped `workspace-changes` recorder lists those changes when the workspace is
  a git repository, but it serves a diff, not a restorable pre-image. Use git
  for shell-heavy work you may need to discard.
- **It is not a conversation rewind.** The session log is append-only; nothing
  here removes the voided turn's messages. The rollback is recorded in the log
  as an ordinary command run.
- **The journal lives in this Host process.** It is in memory plus a temporary
  directory removed when the Session is disposed (or the plugin unloads), so a
  conversation reopened after a restart cannot roll back its earlier turns. Only
  the newest `maxTurns` turns are kept.
- **A file larger than `maxFileBytes` gets no copy.** A file the turn created is
  still deleted (that needs no content), but one that existed before cannot be
  restored; the report says so and the entry stays for a retry.
- **Restores are not fenced by the session sandbox mode.** The filesystem seam
  exposes no byte-exact write, no delete, and no directory removal, so restores
  use Node's filesystem API directly. A rollback is an explicit user action
  against paths the voided turn itself touched.
- **A rollback cannot know who changed a file since.** A file the user edited
  after the turn is restored to its pre-turn content; the report lists every
  path it restored.

## Install

The package declares `dsh.bundle.patch`, so it installs as an ordinary profile
bundle. From the Web client's plugin page, or through the `plugin_manager` tool:

```
plugin_manager install_bundle
  target: link:<克隆路径>/plugins/dsh-turn-rollback
```

The bundle's `cordis.patch.yml` layer then registers the `turn-rollback` row,
which is what makes it toggleable from the Web client's plugin page and
manageable through `plugin_manager`. This is the route that was verified here:
the row composes as `include:turn-rollback` and the `rollback_turn` tool appears
in the agent's tool schema without a restart.

The bundled CLI can do the same thing (`<install>\resources\runtime\cli\bin\dsh.cmd
plugin --profile desktop add <path to this package>`); the `link:` spec is what
makes the loaded code the working copy.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxFileBytes` | `2097152` | Byte cap on one stored pre-image; a larger file is listed as unrestorable |
| `maxTurns` | `20` | Journals kept per Session, oldest evicted first |

## Test

The suite drives the real `apply()` against a stub Cordis context (capturing the
event listeners and registrations) and a real temporary directory:

```powershell
node tools\turn-rollback-host.test.mjs
```

Covered: created-file deletion, directory cleanup, content restore, byte-exact
binary restore, unchanged files, turn-by-turn walk-back, open-turn skipping,
`apply_patch` add/update/delete/move extraction and its column rules,
`str_replace_editor` create, oversized pre-images, the empty-journal report, and
the usage error.
