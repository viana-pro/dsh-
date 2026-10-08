/**
 * Codex-experience bridge for DeepSeek Harness.
 *
 * Adds the one capability DSH has no equivalent for — an `apply_patch` tool with
 * OpenAI Codex's patch grammar and matching semantics — and its prompt guidance.
 *
 * The tool is the executor: it owns parsing, context search, diff production and
 * model-facing rendering. Whether a mutation is *authorized* stays where DSH puts
 * it: this plugin asks the `fs/write-intent` / `fs/edit-intent` waterfall for a
 * guard exactly like `dsh-tool-fs` does, so `dsh-fs-observation-policy`,
 * `dsh-fs-sandbox` and any deployment policy keep deciding. Nothing here
 * bypasses the sandbox.
 *
 * @module dsh-codex-bridge
 */

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { FsError } from '@deepseek-ai/dsh-fs';
import { applyChunksToText, parsePatch, PatchParseError } from './patch-parse.js';

/** Cordis plugin name used by loader diagnostics. */
const name = 'codex-bridge';

/**
 * Services required by this plugin. `sandboxPolicy` is read through
 * `ctx.get()` rather than `inject` so a composition without it still mounts.
 */
const inject = ['tools', 'fs', 'systemPrompt'];

/**
 * The `tool:apply_patch` guidance section. Deliberately mirrors the job Codex's
 * own apply-patch instructions do: it establishes that the tool exists, that it
 * is the preferred single-file edit path, and exactly which envelope to emit.
 */
const APPLY_PATCH_GUIDANCE = `Editing files: prefer the \`apply_patch\` tool for edits to existing files. Emit a patch as one string using exactly this envelope:
\`\`\`
*** Begin Patch
*** Update File: relative/path/to/file.ext
@@ optional section header
 context line
-removed line
+added line
*** End Patch
\`\`\`
Also supported: \`*** Add File: <path>\` (every body line prefixed with \`+\`) and \`*** Delete File: <path>\`, plus \`*** Move to: <path>\` directly under an Update File header. One patch may touch several files. Paths are relative to the working directory, never absolute. Context lines must match the file; leading whitespace is significant but trailing whitespace and smart-quote/dash substitutions are tolerated. Indent every line of a hunk by exactly the one-character prefix; never add extra indentation to the envelope lines.`;

const APPLY_PATCH_DESCRIPTION = `Edit files with a single patch. The \`command\` argument is a FREEFORM patch string, not JSON — do not wrap it in quotes beyond the string itself.

Envelope:
*** Begin Patch
*** Update File: <path>
@@ <optional context anchor>
<unchanged line>
-<removed line>
+<added line>
*** End Patch

Supported file operations: \`*** Update File: <path>\` (with an optional \`*** Move to: <path>\` line right after it), \`*** Add File: <path>\` (every body line starts with \`+\`), \`*** Delete File: <path>\`.

Rules:
- One patch may contain several file sections; they are applied in order.
- Prefer this tool over a full-file write for edits to existing files: it touches only the lines you name.
- Paths are workspace-relative. Absolute paths and \`file://\` URIs are rejected.
- Context lines are matched with Codex's tolerance: exact first, then ignoring trailing whitespace, then ignoring surrounding whitespace, then after normalizing curly quotes and unicode dashes. Otherwise the patch fails with the offending line.
- Use \`*** End of File\` as the last line of a hunk to anchor it at the end of the file.
- A patch is not a transaction across files: files touched before a failure stay modified, and the result names them.`;

const ESCALATION_MODES = ['workspace-write', 'danger-full-access'];

/** Standard DSH sandbox denial marker, matched to add the same-turn escalation hint. */
const SANDBOX_DENIAL = /\[sandbox: file access denied under ([a-z-]+) mode\]/u;

/**
 * Build the model-facing success report from the applied operations.
 * Wording follows Codex's own apply-patch output so the model's learned
 * expectations transfer.
 * @param operations - Per-file operations in patch order.
 * @returns The `<path>`-bearing summary text.
 */
function formatApplyPatchOutput(operations) {
  const symbols = { add: 'A', update: 'M', delete: 'D' };
  const lines = operations.map((operation) => `${symbols[operation.operation]} ${operation.path}`);
  return `Success. Updated the following files:\n${lines.join('\n')}`;
}

/**
 * Describe a failed prefix of the patch.
 * @param operations - Operations that completed before the failure.
 * @param error - The thrown failure.
 * @returns The model-facing failure text, including partial progress.
 */
function formatApplyPatchFailure(operations, error) {
  const detail = error instanceof Error ? error.message : String(error);
  if (operations.length === 0) return `apply_patch failed: ${detail}`;
  const applied = operations.map((operation) => operation.path).join(', ');
  return `apply_patch failed after modifying: ${applied}\napply_patch failed: ${detail}`;
}

/**
 * Register the plugin.
 * @param ctx - The plugin context; registrations are effects scoped to it.
 * @param config - Validated plugin configuration.
 */
function apply(ctx, config) {
  const maxPatchBytes = config.maxPatchBytes;
  const maxFiles = config.maxFiles;

  // Keep the `dsh-tool-fs` error wording: the model should not need to learn a
  // second vocabulary for the same two failure modes.
  ctx.systemPrompt.section({
    name: 'tool:apply_patch',
    order: ctx.systemPrompt.getSectionOrder('TOOL_EDIT') + 1,
    text: ({ scope }) => (ctx.tools.get('apply_patch', scope) === undefined ? '' : APPLY_PATCH_GUIDANCE),
  });

  ctx.tools.register(
    defineTool({
      name: 'apply_patch',
      description: APPLY_PATCH_DESCRIPTION,
      parameters: {
        command: {
          type: 'string',
          required: true,
          description:
            'The patch text: a *** Begin Patch ... *** End Patch envelope. Raw text, not JSON-encoded.',
        },
        ...(ctx.fs.sandboxMode === undefined ? {} : {
          sandbox_permissions: {
            type: 'string',
            enum: ESCALATION_MODES,
            description:
              'The narrowest wider sandbox mode for a one-shot retry of the exact patch the sandbox just denied; the retry asks the user for approval.',
          },
          justification: {
            type: 'string',
            description:
              'Required with sandbox_permissions: one sentence for the user explaining why this exact patch needs the wider access. Use the language of the user’s current request.',
          },
        }),
      },
      /**
       * Object output schema. Keeping it structured (rather than a bare string)
       * is what lets the UI render a real diff card via `presentationMeta`.
       */
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            files: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', required: true },
                  operation: { type: 'string', required: true, enum: ['add', 'update', 'delete'] },
                  moveTo: { type: 'string' },
                  before: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                  after: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: formatApplyPatchOutput(
              value.files.map((file) => ({ path: file.moveTo ?? file.path, operation: file.operation })),
            ),
          },
        ],
        presentationMeta: (_args, value) => ({
          diffs: value.files.map((file) => ({
            path: file.moveTo ?? file.path,
            oldText: file.before,
            newText: file.after,
          })),
        }),
      },
      presentCall(args) {
        return {
          card: 'generic',
          title: 'Apply patch',
          kind: 'edit',
          locations: patchPaths(args.command).map((path) => ({ path })),
        };
      },
      presentResult(args, result) {
        if (result.isError) return undefined;
        const diffs = (result.meta?.diffs ?? [])
          .filter((diff) => diff.oldText !== diff.newText)
          .map((diff) => ({ path: diff.path, oldText: diff.oldText, newText: diff.newText }));
        if (diffs.length === 0) return undefined;
        return {
          card: 'diff',
          title: `Apply patch (${diffs.length} file${diffs.length === 1 ? '' : 's'})`,
          diffs,
        };
      },
      async execute(args, exec) {
        const text = args.command;
        if (typeof text !== 'string' || text.trim().length === 0) {
          throw new Error('command must be a non-empty patch string');
        }
        if (Buffer.byteLength(text, 'utf8') > maxPatchBytes) {
          throw new Error(`patch exceeds the ${maxPatchBytes}-byte limit`);
        }

        let parsed;
        try {
          parsed = parsePatch(text);
        } catch (error) {
          if (error instanceof PatchParseError) throw new Error(`apply_patch verification failed: ${error.message}`);
          throw error;
        }
        if (parsed.hunks.length === 0) throw new Error('No files were modified.');
        if (parsed.hunks.length > maxFiles) {
          throw new Error(`patch touches ${parsed.hunks.length} files, above the ${maxFiles}-file limit`);
        }

        const sandbox = await resolveSandboxPolicy(ctx, args, exec);
        const groups = await groupHunks(ctx, exec, parsed.hunks, sandbox);
        const operations = [];
        const files = [];

        try {
          for (const group of groups) {
            const outcome = await applyHunkGroup(ctx, exec, group, sandbox);
            for (const file of outcome) {
              operations.push({ path: file.path, operation: file.operation });
              files.push(file);
            }
          }
        } catch (error) {
          throw new Error(formatApplyPatchFailure(operations, error));
        }

        return { files };
      },
    }),
  );
}

/**
 * Resolve one model-supplied path against the session workspace, or the
 * sandbox's canonical workspace root when one is in force.
 * @param ctx - The plugin context.
 * @param exec - The current tool execution.
 * @param path - The raw path from the patch header.
 * @param sandboxPolicy - The per-call sandbox policy, when confined.
 * @returns The resolved filesystem target.
 */
async function resolveTarget(ctx, exec, path, sandboxPolicy) {
  const workspaceRoot = sandboxPolicy?.workspaceRoot;
  const cwd = workspaceRoot ?? exec.agent?.session.header.cwd;
  return ctx.fs.resolve(path, { ...(cwd === undefined ? {} : { cwd }), signal: exec.signal });
}

/**
 * Resolve every patch hunk, then batch hunks that touch the same file, so a
 * patch carrying several hunks for one file costs one read and one atomic
 * write instead of one per hunk. Hunk order inside a group is preserved;
 * group order follows the first hunk that named each file.
 * @param ctx - The plugin context.
 * @param exec - The current tool execution.
 * @param hunks - The parsed hunks, in patch order.
 * @param sandboxPolicy - The per-call sandbox policy, when confined.
 * @returns One group per distinct target, each with its hunks in order.
 */
async function groupHunks(ctx, exec, hunks, sandboxPolicy) {
  const groups = new Map();
  const order = [];
  for (const hunk of hunks) {
    const target = await resolveTarget(ctx, exec, hunk.path, sandboxPolicy);
    const key = target.targetKey;
    let group = groups.get(key);
    if (group === undefined) {
      group = { path: hunk.path, target, hunks: [] };
      groups.set(key, group);
      order.push(group);
    } else if (group.hunks.length === 1 && group.hunks[0].kind !== 'update') {
      throw new Error(`"${target.displayPath}" has more than one non-update section in one patch`);
    }
    group.hunks.push(hunk);
  }
  return order;
}

/**
 * Apply one file's batched hunks.
 * @param ctx - The plugin context.
 * @param exec - The current tool execution.
 * @param group - The resolved target and its hunks, in patch order.
 * @param sandboxPolicy - The per-call sandbox policy, when confined.
 * @returns The per-file outcomes, in patch order.
 */
async function applyHunkGroup(ctx, exec, group, sandboxPolicy) {
  const { target, hunks } = group;
  const first = hunks[0];
  const info = await ctx.fs.stat(target, exec.signal);

  if (first.kind === 'add') {
    if (info !== undefined) throw new Error(`cannot add "${target.displayPath}": the file already exists`);
    return [await writeFile(ctx, exec, target, first.content, { kind: 'createIfAbsent' }, sandboxPolicy, 'add')];
  }

  if (first.kind === 'delete') {
    if (info === undefined) throw new FsError(`cannot delete "${target.displayPath}": not found`, 'FS_NOT_FOUND');
    if (info.type !== 'file') {
      throw new FsError(`cannot delete "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE');
    }
    const before = await ctx.fs.readText(target, exec.signal);
    await removeResolved(ctx, target);
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec);
    return [{ path: target.displayPath, operation: 'delete', before, after: null }];
  }

  if (info === undefined) throw new FsError(`cannot update "${target.displayPath}": not found`, 'FS_NOT_FOUND');
  if (info.type !== 'file') {
    throw new FsError(`cannot update "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE');
  }

  const before = await ctx.fs.readText(target, exec.signal);
  let after = before;
  for (const hunk of hunks) {
    try {
      after = applyChunksToText(after, hunk.chunks);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`apply_patch verification failed: ${target.displayPath}: ${detail}`);
    }
  }

  const written = await writeFile(
    ctx,
    exec,
    target,
    after,
    { kind: 'replaceIfVersion', version: info.version },
    sandboxPolicy,
    'update',
  );
  const results = [written];

  const moveTo = hunks.find((hunk) => hunk.moveTo !== undefined)?.moveTo;
  if (moveTo === undefined) return results;

  const moveTarget = await resolveTarget(ctx, exec, moveTo, sandboxPolicy);
  const moveInfo = await ctx.fs.stat(moveTarget, exec.signal);
  if (moveInfo !== undefined) {
    throw new Error(`cannot move to "${moveTarget.displayPath}": the destination already exists`);
  }
  const moved = await writeFile(
    ctx,
    exec,
    moveTarget,
    after,
    moveInfo === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: moveInfo.version },
    sandboxPolicy,
    'add',
  );
  await removeResolved(ctx, target);
  ctx.emit('fs/observed', target, { kind: 'absent' }, exec);
  return [written, { ...moved, path: moveTarget.displayPath, moveTo: moveTarget.displayPath }];
}

/**
 * Best-effort list of file paths named by a patch, for the pre-execution card.
 * Replay-only: it never throws, so an obsolete or malformed logged argument
 * degrades to a card without locations instead of failing the replay.
 * @param command - The raw patch text.
 * @returns Every distinct path named by a file header, in order.
 */
function patchPaths(command) {
  if (typeof command !== 'string') return [];
  const seen = new Set();
  for (const match of command.matchAll(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/gmu)) {
    const path = match[1].trim();
    if (path.length > 0) seen.add(path);
  }
  return [...seen];
}

/**
 * Same-turn sandbox escalation, mirroring `dsh-tool-fs`: the caller may stamp a
 * strictly wider mode for exactly one call, and only when the user approves.
 * @param ctx - The plugin context.
 * @param args - Raw tool arguments carrying the optional escalation pair.
 * @param exec - The current tool execution.
 * @returns The sandbox policy for this call, or undefined when unconfined.
 */
async function resolveSandboxPolicy(ctx, args, exec) {
  const sandboxPolicy = ctx.get('sandboxPolicy');
  if (sandboxPolicy === undefined) return undefined;
  const requested = args.sandbox_permissions;
  if (requested === undefined) return sandboxPolicy.resolve({ session: exec.agent?.session });
  if (args.justification === undefined || args.justification.trim().length === 0) {
    throw new Error('justification is required with sandbox_permissions');
  }
  const standing = sandboxPolicy.resolve({ session: exec.agent?.session });
  if (!ESCALATION_MODES.includes(requested) || !ESCALATION_MODES.includes(standing.mode)) {
    throw new Error(`sandbox_permissions must be one of ${ESCALATION_MODES.join(', ')}`);
  }
  if (ESCALATION_MODES.indexOf(requested) <= ESCALATION_MODES.indexOf(standing.mode)) {
    throw new Error(`sandbox_permissions must be strictly wider than the standing "${standing.mode}" mode`);
  }
  const approval = ctx.get('approval');
  if (approval === undefined) throw new Error('sandbox_permissions requires an approval service');
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: 'apply_patch',
    reason: args.justification,
    signal: exec.signal,
    ...(exec.callId === undefined ? {} : { callId: exec.callId }),
  });
  if (outcome !== 'allowed-once') {
    throw new Error(
      outcome === 'rejected'
        ? `the user rejected escalating this patch to "${requested}"; it stays denied, so stop and explain instead of working around it`
        : `escalating this patch to "${requested}" requires approval, but no approval channel was available`,
    );
  }
  return sandboxPolicy.resolve({ session: exec.agent?.session, mode: requested });
}

/**
 * Write one resolved target through the shared intent waterfall so every
 * mounted policy (`fs-observation-policy`, sandbox, audit) still decides.
 * @param ctx - The plugin context.
 * @param exec - The current tool execution.
 * @param target - The resolved file target.
 * @param content - The full new content.
 * @param expected - The guard this mutation asks the intent slot for.
 * @param sandboxPolicy - The per-call sandbox policy, when confined.
 * @param operation - The reported operation kind.
 * @returns The recorded outcome, including before/after text.
 */
async function writeFile(ctx, exec, target, content, expected, sandboxPolicy, operation) {
  const intent = await ctx.waterfall('fs/write-intent', target, exec, () => expected);
  let outcome;
  try {
    outcome = await ctx.fs.writeText(
      target,
      content,
      intent ?? expected,
      exec.signal,
      ...(sandboxPolicy === undefined ? [] : [sandboxPolicy]),
    );
  } catch (error) {
    throw remediate(ctx, ctx.get('sandboxPolicy'), error, sandboxPolicy, target.displayPath);
  }
  ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec);
  return {
    path: target.displayPath,
    operation,
    before: outcome.before,
    after: outcome.after,
  };
}

/**
 * Remove one resolved target. The filesystem seam has no delete operation, so
 * this is the one place the plugin touches the process filesystem directly; it
 * still uses the provider's mapped process path, so a remote or sandboxed
 * backend sees its own path spelling rather than a host path.
 * @param ctx - The plugin context.
 * @param target - The resolved file target.
 */
async function removeResolved(ctx, target) {
  const processPath = typeof ctx.fs.processPath === 'function' ? ctx.fs.processPath(target) : undefined;
  if (typeof processPath !== 'string' || processPath.length === 0) {
    throw new Error('the mounted filesystem backend cannot delete files (no process path mapping)');
  }
  const { unlink } = await import('node:fs/promises');
  try {
    await unlink(processPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot delete "${target.displayPath}": ${detail}`);
  }
}

/**
 * Normalize a filesystem failure the way `dsh-tool-fs` does, and attach the
 * sandbox escalation hint when this call was the unconfined one.
 * @param ctx - The plugin context.
 * @param sandboxPolicyService - The `ctx.sandboxPolicy` service, when mounted.
 * @param error - The thrown provider or policy error.
 * @param sandboxPolicy - The per-call policy, when confined.
 * @param displayPath - The model-facing path.
 * @returns The error to throw.
 */
function remediate(ctx, sandboxPolicyService, error, sandboxPolicy, displayPath) {
  const code = error?.code;
  if (code === 'FS_NOT_OBSERVED') {
    return new FsError(`cannot modify "${displayPath}": file has not been read — read the file, then retry`, code, {
      cause: error,
    });
  }
  if (code === 'FS_STALE_VERSION') {
    const reason = error instanceof Error ? error.message : String(error);
    return new FsError(`${reason} — re-read the file, then retry`, code, { cause: error });
  }
  if (code === 'FS_SANDBOX_DENIED' && sandboxPolicy !== undefined) {
    const match = SANDBOX_DENIAL.exec(error instanceof Error ? error.message : '');
    const mode = match?.[1] ?? sandboxPolicy.mode;
    const hint =
      codexBridgeEscalationHint(ctx) ??
      'retry this exact patch once with sandbox_permissions plus a justification';
    return new FsError(`[sandbox: file access denied under ${mode} mode]\n${hint}`, code, { cause: error });
  }
  return error;
}

/**
 * Whether this composition advertises the escalation fields, matching
 * `dsh-tool-fs`: only a confining backend does.
 * @param ctx - The plugin context.
 * @returns The escalation hint line, or undefined when escalation is unavailable.
 */
function codexBridgeEscalationHint(ctx) {
  if (ctx.fs.sandboxMode === undefined) return undefined;
  return '[sandbox: escalation available — retry this exact patch once with sandbox_permissions plus a justification]';
}

/** Per-plugin configuration. */
const Config = z.object({
  /** Byte cap on one patch command; oversized patches are rejected before parsing. */
  maxPatchBytes: z.number().default(1_000_000),
  /** Cap on one patch's file-section count, so a runaway patch cannot fan out. */
  maxFiles: z.number().default(50),
});

export { Config, apply, inject, name };
