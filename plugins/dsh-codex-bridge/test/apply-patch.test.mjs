/**
 * Functional test for the `apply_patch` tool handler.
 *
 * Runs the real plugin `apply()` against a mocked Cordis context and the real
 * `LocalFileSystem` provider from the extracted DSH tree, then drives the
 * registered tool through add / update / delete / move / failure paths and
 * asserts the resulting files on disk plus the rendered model-facing text.
 *
 * Run:
 *   node --import ./test/register-hook.mjs test/apply-patch.test.mjs
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { FsError } from '@deepseek-ai/dsh-fs';
import { apply as applyBridge } from '../src/index.js';

/**
 * Filesystem test double matching the `ctx.fs` contract the plugin consumes
 * (`resolve`, `stat`, `readText`, `writeText`, `processPath`) and the same
 * version-guard semantics as `dsh-fs-local`, so the intent waterfall is
 * exercised for real. It is a plain object carrying a real Cordis `Context` so
 * the service references other plugins would hold stay well-formed.
 * `dsh-fs-local` itself cannot be imported here because its `chokidar`
 * dependency is not present in the extracted tree.
 */
function makeStubFileSystem(root) {
  const base = new Context();
  const versions = new Map();
  return Object.assign(base, {
    root,
    versions,
    async resolve(path, opts) {
      void opts;
      return { targetKey: join(root, path), displayPath: path };
    },
    async stat(target) {
      const present = existsSync(target.targetKey);
      if (process.env.BRIDGE_DEBUG === '1') {
        console.error(`[stat] ${target.displayPath} -> ${target.targetKey} present=${present}`);
      }
      if (!present) return undefined;
      return { type: 'file', version: versions.get(target.targetKey) ?? 'v0' };
    },
    async readText(target) {
      return (await readFile(target.targetKey, 'utf8')).replace(/\r\n/gu, '\n');
    },
    processPath(target) {
      return target.targetKey;
    },
    async writeText(target, content, expected, signal) {
      void signal;
      const existing = existsSync(target.targetKey);
      if (expected?.kind === 'replaceIfVersion') {
        if (!existing) {
          throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION');
        }
        if ((versions.get(target.targetKey) ?? 'v0') !== expected.version) {
          throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION');
        }
      } else if (expected?.kind === 'createIfAbsent' && existing) {
        throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED');
      }
      const before = existing ? await readFile(target.targetKey, 'utf8') : null;
      await mkdir(join(target.targetKey, '..'), { recursive: true });
      await writeFile(target.targetKey, content);
      const version = `w${versions.size + 1}`;
      versions.set(target.targetKey, version);
      return { operation: existing ? 'update' : 'create', version, before, after: content };
    },
  });
}

const results = [];
let failures = 0;

function check(label, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === undefined ? '' : `\n      ${detail}`}`);
}

/**
 * Minimal Cordis-context double exposing only what the plugin touches.
 * @param fs - The filesystem provider instance.
 * @returns A context double plus the registries the test inspects.
 */
function makeContext(fs) {
  const tools = new Map();
  const sections = [];
  return {
    fs,
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
      },
      get(toolName) {
        return tools.get(toolName);
      },
    },
    systemPrompt: {
      getSectionOrder() {
        return 1300;
      },
      section(section) {
        sections.push(section);
      },
    },
    get(service) {
      return service === 'sandboxPolicy' ? undefined : undefined;
    },
    emit() {},
    async waterfall(_name, _target, _exec, fallback) {
      return fallback();
    },
    _tools: tools,
    _sections: sections,
  };
}

/**
 * Minimal exec double: session cwd plus an unaborted signal.
 * @param cwd - The workspace root the tool should resolve relative paths against.
 */
function makeExec(cwd) {
  return {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd } } },
  };
}

const root = await mkdtemp(join(tmpdir(), 'codex-bridge-'));
const tracked = [];

try {
  await mkdir(join(root, 'pkg'), { recursive: true });
  tracked.push(root);

  const ctx = makeContext(makeStubFileSystem(root));
  await applyBridge(ctx, { maxPatchBytes: 1_000_000, maxFiles: 50 });

  const tool = ctx._tools.get('apply_patch');
  check('registers the apply_patch tool', tool !== undefined);
  check('registers exactly one prompt section', ctx._sections.length === 1, `got ${ctx._sections.length}`);
  check(
    'prompt section renders when the tool is visible',
    ctx._sections[0]?.text({ scope: undefined })?.includes('*** Begin Patch'),
  );
  // Wire shape: the harness must expose a valid object schema with `command`
  // as an array-entry `required`, which is what the model actually receives.
  check(
    'parameters describe command as a required string',
    tool.parameters?.type === 'object' &&
      tool.parameters.properties.command.type === 'string' &&
      Array.isArray(tool.parameters.required) &&
      tool.parameters.required.includes('command'),
    JSON.stringify(tool.parameters),
  );
  check(
    'output schema is an object requiring files[]',
    tool.output?.schema?.type === 'object' &&
      tool.output.schema.properties.files.type === 'array' &&
      Array.isArray(tool.output.schema.required) &&
      tool.output.schema.required.includes('files'),
    JSON.stringify(tool.output?.schema),
  );
  check('tool is not marked concurrency-safe', tool.isConcurrencySafe === undefined || tool.isConcurrencySafe() !== true);
  const exec = makeExec(root);

  // ---- case 1: multi-file add + update + delete in one patch -----------------
  await writeFile(join(root, 'pkg', 'keep.txt'), 'alpha\nbeta\ngamma\n');
  await writeFile(join(root, 'pkg', 'gone.txt'), 'delete me\n');

  const multi = `*** Begin Patch
*** Add File: pkg/new.txt
+first line
+second line
*** Update File: pkg/keep.txt
@@
 alpha
-beta
+BETA
 gamma
*** Delete File: pkg/gone.txt
*** End Patch`;

  const first = await tool.execute({ command: multi }, exec);
  check('multi-file patch reports 3 files', first.files.length === 3, JSON.stringify(first.files.map((f) => f.operation)));
  check('add created the file with one trailing newline', (await readFile(join(root, 'pkg', 'new.txt'), 'utf8')) === 'first line\nsecond line\n');
  check('update applied the replacement', (await readFile(join(root, 'pkg', 'keep.txt'), 'utf8')) === 'alpha\nBETA\ngamma\n');
  check('delete removed the file', !existsSync(join(root, 'pkg', 'gone.txt')));
  const rendered = tool.output.render({ command: multi }, first);
  check(
    'success text lists all three files',
    rendered[0].text === 'Success. Updated the following files:\nA pkg/new.txt\nM pkg/keep.txt\nD pkg/gone.txt',
    JSON.stringify(rendered[0].text),
  );
  const meta = tool.output.presentationMeta({ command: multi }, first);
  check('diff meta carries before/after for the update', meta.diffs.some((d) => d.oldText === 'alpha\nbeta\ngamma\n' && d.newText === 'alpha\nBETA\ngamma\n'));

  // ---- case 2: fuzzy context (trailing whitespace + curly quotes + em dash) ---
  await writeFile(join(root, 'fuzzy.txt'), 'name: \u201cAda\u201d \nsection \u2014 one   \ntail\n');
  const fuzzy = `*** Begin Patch
*** Update File: fuzzy.txt
@@
-name: "Ada"
+name: "Grace"
 section - one
*** End Patch`;
  let fuzzyOutcome;
  try {
    fuzzyOutcome = await tool.execute({ command: fuzzy }, exec);
  } catch (error) {
    fuzzyOutcome = error;
  }
  check(
    'fuzzy context (smart quotes + em dash + trailing spaces) still applies',
    !(fuzzyOutcome instanceof Error),
    fuzzyOutcome instanceof Error ? fuzzyOutcome.message : undefined,
  );
  if (!(fuzzyOutcome instanceof Error)) {
    const text = await readFile(join(root, 'fuzzy.txt'), 'utf8');
    check('fuzzy update rewrote the name line', text.includes('name: "Grace"'), JSON.stringify(text));
  }

  // ---- case 3: end-of-file anchor -------------------------------------------
  await writeFile(join(root, 'eof.txt'), 'one\ntwo\nthree\n');
  const eof = `*** Begin Patch
*** Update File: eof.txt
@@
-three
+THREE
*** End of File
*** End Patch`;
  await tool.execute({ command: eof }, exec);
  check('end-of-file anchor replaced the tail', (await readFile(join(root, 'eof.txt'), 'utf8')) === 'one\ntwo\nTHREE\n');

  // ---- case 4: move ---------------------------------------------------------
  await writeFile(join(root, 'moved.txt'), 'payload\n');
  const move = `*** Begin Patch
*** Update File: moved.txt
*** Move to: target/relocated.txt
@@
-payload
+payload v2
*** End Patch`;
  const moved = await tool.execute({ command: move }, exec);
  check('move reports the destination', moved.files.some((file) => file.moveTo === 'target/relocated.txt'), JSON.stringify(moved.files));
  check('move removed the source', !existsSync(join(root, 'moved.txt')));
  check('move wrote the destination', (await readFile(join(root, 'target', 'relocated.txt'), 'utf8')) === 'payload v2\n');

  // ---- case 4b: several hunks for ONE file batch into one read/write -------
  await writeFile(join(root, 'batched.txt'), 'one\ntwo\nthree\n');
  const before4b = ctx.fs.versions.get(join(root, 'batched.txt'));
  const batched = `*** Begin Patch
*** Update File: batched.txt
@@
-one
+ONE
*** Update File: batched.txt
@@
-three
+THREE
*** End Patch`;
  await tool.execute({ command: batched }, exec);
  check(
    'two hunks on one file apply in sequence',
    (await readFile(join(root, 'batched.txt'), 'utf8')) === 'ONE\ntwo\nTHREE\n',
    await readFile(join(root, 'batched.txt'), 'utf8'),
  );
  const after4b = ctx.fs.versions.get(join(root, 'batched.txt'));
  check('two hunks on one file cost a single version bump', before4b !== after4b && after4b?.startsWith('w'));

  // ---- case 5: failures -----------------------------------------------------
  await writeFile(join(root, 'pkg', 'nomatch.txt'), 'present content\n');

  const noMatch = `*** Begin Patch
*** Update File: pkg/nomatch.txt
@@
-this line does not exist
+anything
*** End Patch`;
  let noMatchError;
  try {
    await tool.execute({ command: noMatch }, exec);
  } catch (error) {
    noMatchError = error;
  }
  check('non-matching context fails', noMatchError instanceof Error);
  check(
    'failure text is the Codex verification message',
    typeof noMatchError?.message === 'string' && noMatchError.message.includes('apply_patch verification failed'),
    noMatchError?.message,
  );

  const badGrammar = 'not a patch at all';
  let grammarError;
  try {
    await tool.execute({ command: badGrammar }, exec);
  } catch (error) {
    grammarError = error;
  }
  check('garbage input fails without crashing', grammarError instanceof Error, grammarError?.message);

  const emptyPatch = '*** Begin Patch\n*** End Patch';
  let emptyError;
  try {
    await tool.execute({ command: emptyPatch }, exec);
  } catch (error) {
    emptyError = error;
  }
  check('empty patch reports "No files were modified."', emptyError?.message === 'No files were modified.', emptyError?.message);

  const addExisting = `*** Begin Patch
*** Add File: pkg/nomatch.txt
+nope
*** End Patch`;
  let addError;
  try {
    await tool.execute({ command: addExisting }, exec);
  } catch (error) {
    addError = error;
  }
  check('adding an existing file fails', addError instanceof Error, addError?.message);
  check(
    'the failed add did not truncate the existing file',
    (await readFile(join(root, 'pkg', 'nomatch.txt'), 'utf8')) === 'present content\n',
  );

  // ---- case 6: partial progress and per-file atomicity ----------------------
  await writeFile(join(root, 'pkg', 'partial.txt'), 'alpha\nbeta\n');
  const sameFile = `*** Begin Patch
*** Update File: pkg/partial.txt
@@
-alpha
+ALPHA
*** Update File: pkg/partial.txt
@@
-this line does not exist
+nope
*** End Patch`;
  let sameFileError;
  try {
    await tool.execute({ command: sameFile }, exec);
  } catch (error) {
    sameFileError = error;
  }
  check('a patch failing mid-way still throws', sameFileError instanceof Error);
  check(
    'two hunks on one file are atomic: nothing is written',
    (await readFile(join(root, 'pkg', 'partial.txt'), 'utf8')) === 'alpha\nbeta\n',
    await readFile(join(root, 'pkg', 'partial.txt'), 'utf8'),
  );
  check(
    'the atomic failure reports no partial modification',
    typeof sameFileError?.message === 'string' && !sameFileError.message.includes('after modifying'),
    sameFileError?.message,
  );

  await writeFile(join(root, 'pkg', 'first.txt'), 'one\n');
  const multiFilePartial = `*** Begin Patch
*** Update File: pkg/first.txt
@@
-one
+ONE
*** Update File: pkg/missing.txt
@@
-absent
+present
*** End Patch`;
  let partialError;
  try {
    await tool.execute({ command: multiFilePartial }, exec);
  } catch (error) {
    partialError = error;
  }
  check('a later file failing makes the whole call fail', partialError instanceof Error);
  check(
    'partial progress across files is named in the failure',
    typeof partialError?.message === 'string' && partialError.message.includes('after modifying: pkg/first.txt'),
    partialError?.message,
  );
  check('the earlier file stayed modified', (await readFile(join(root, 'pkg', 'first.txt'), 'utf8')) === 'ONE\n');

  // ---- case 7: heredoc wrapper ---------------------------------------------
  const heredoc = `<<'EOF'
*** Begin Patch
*** Add File: heredoc.txt
+from heredoc
*** End Patch
EOF`;
  await tool.execute({ command: heredoc }, exec);
  check('heredoc-wrapped patch applies', (await readFile(join(root, 'heredoc.txt'), 'utf8')) === 'from heredoc\n');

  // ---- case 8: presentCall survives a malformed logged argument -------------
  const call = tool.presentCall({ command: 12345 });
  check('presentCall is replay-safe on a malformed argument', call === undefined || Array.isArray(call.locations));
  const goodCall = tool.presentCall({ command: multi });
  check('presentCall lists the patched paths', goodCall?.locations?.length === 3, JSON.stringify(goodCall?.locations));
} finally {
  for (const dir of tracked) await rm(dir, { recursive: true, force: true });
}

console.log(results.join('\n'));
console.log(`\n${results.length - failures}/${results.length} checks passed`);
if (failures > 0) {
  console.error(`\n${failures} FAILED`);
  process.exitCode = 1;
}
