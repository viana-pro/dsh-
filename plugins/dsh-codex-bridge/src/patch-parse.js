/**
 * patch-parse.js — pure parser and line matcher for OpenAI Codex `apply_patch` semantics.
 *
 * This module performs no I/O. It is a faithful JavaScript port of the relevant pieces of
 * `codex-rs/apply-patch` (`parser.rs`, `streaming_parser.rs`, `seek_sequence.rs`,
 * `file_update.rs`), restricted to the default `NormalizeToLf` file-update mode.
 *
 * ## Exported API
 *
 * ```js
 * parsePatch(text)                       // -> { hunks: Hunk[] }                 (throws PatchParseError)
 * seekSequence(lines, pattern, start, eof) // -> number (index) | -1              (never throws)
 * applyChunksToText(before, chunks, eof)   // -> string                           (throws Error)
 * class PatchParseError extends Error      // constructor(message, line)
 * ```
 *
 * ## Data shapes (stable; the tool layer depends on them)
 *
 * ```js
 * Hunk =
 *   | { kind: 'add',    path: string, content: string }   // content always ends with "\n" unless empty
 *   | { kind: 'delete', path: string }
 *   | { kind: 'update', path: string, moveTo?: string, chunks: Chunk[] }
 *
 * Chunk = { eof: boolean, lines: Array<{ type: 'context' | 'remove' | 'add', text: string }> }
 * ```
 *
 * `parsePatch` returns exactly `{ hunks }`. Hunks appear in patch order. Line numbers reported by
 * `PatchParseError` are 1-based and relative to the (heredoc-stripped, trimmed) patch text; the
 * error message follows Codex's `Display` formatting:
 *   - `invalid patch: <detail>`                       (no line number known)
 *   - `invalid hunk at line <n>, <detail>`            (`error.line` is set)
 *
 * ## Deliberate, documented choices
 *  - `applyChunksToText` follows Codex exactly for a chunk with an empty match pattern
 *    (only `+` lines): Codex appends those additions at end-of-file, so we do too.
 *  - A `*** End of File` marker ends the *available* update body only in the sense that Codex
 *    then accepts blank lines (ignored) or a fresh `@@` chunk; any `*** …` header or `*** End Patch`
 *    still closes the file section. This is Codex behaviour, and matches the documented grammar.
 *  - `seekSequence(..., eof=true)` first tries the end-of-file position, then also falls back to the
 *    normal forward search from `start` (Codex only tries the end position). See the function docs.
 */

/** @typedef {{ type: 'context' | 'remove' | 'add', text: string }} ChunkLine */
/** @typedef {{ eof: boolean, lines: ChunkLine[] }} Chunk */
/** @typedef {{ kind: 'add', path: string, content: string }} AddHunk */
/** @typedef {{ kind: 'delete', path: string }} DeleteHunk */
/** @typedef {{ kind: 'update', path: string, moveTo?: string, chunks: Chunk[] }} UpdateHunk */
/** @typedef {AddHunk | DeleteHunk | UpdateHunk} Hunk */

const BEGIN_PATCH_MARKER = '*** Begin Patch';
const END_PATCH_MARKER = '*** End Patch';
const ADD_FILE_MARKER = '*** Add File: ';
const DELETE_FILE_MARKER = '*** Delete File: ';
const UPDATE_FILE_MARKER = '*** Update File: ';
const MOVE_TO_MARKER = '*** Move to: ';
const EOF_MARKER = '*** End of File';
const CHANGE_CONTEXT_MARKER = '@@ ';
const EMPTY_CHANGE_CONTEXT_MARKER = '@@';
const ENVIRONMENT_ID_MARKER = '*** Environment ID:';

const INVALID_HEADER_HINT =
  "Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'";

/** Heredoc openers accepted in lenient mode, mirroring Codex's `check_patch_boundaries_lenient`. */
const HEREDOC_OPENERS = new Set(['<<EOF', "<<'EOF'", '<<"EOF"']);

/** Error raised for every parse-time failure. Mirrors Codex's `ParseError`. */
export class PatchParseError extends Error {
  /**
   * @param {string} message Human-readable detail (Codex's `message` field).
   * @param {number | null} [line] 1-based offending line, when known.
   */
  constructor(message, line) {
    const detail = message === undefined || message === null ? 'malformed patch' : String(message);
    const hasLine = Number.isInteger(line) && line > 0;
    super(hasLine ? `invalid hunk at line ${line}, ${detail}` : `invalid patch: ${detail}`);
    this.name = 'PatchParseError';
    /** @type {string} Raw detail without Codex's message formatting. */
    this.detail = detail;
    /** @type {number | null} 1-based offending line, or null when not applicable. */
    this.line = hasLine ? line : null;
  }
}

/**
 * Normalise Unicode punctuation so ASCII-authored contexts can match typographic source text.
 * Mirrors `normalise` in Codex's `seek_sequence.rs` (a superset of the dash/quote/NBSP set).
 * @param {unknown} value
 * @returns {string}
 */
function normalizeForCompare(value) {
  return String(value)
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
}

/**
 * Find `pattern` inside `lines` beginning at or after `start`, using Codex's decreasing-strictness
 * passes: exact, trailing-whitespace-insensitive, both-sides-trimmed, Unicode-normalised.
 *
 * Special cases (defensive, never throws and never indexes out of bounds):
 *  - empty `pattern` -> `start` when `0 <= start <= lines.length`, otherwise -1;
 *  - `pattern.length > lines.length` -> -1.
 *
 * When `eof` is true the end-of-file position (`lines.length - pattern.length`) is tried first at
 * every strictness level, then the normal forward search from `start` runs as a fallback.
 *
 * @param {readonly unknown[]} lines
 * @param {readonly unknown[]} pattern
 * @param {number} start
 * @param {boolean} [eof]
 * @returns {number} Matching start index, or -1.
 */
export function seekSequence(lines, pattern, start, eof) {
  const haystack = Array.isArray(lines) ? lines : [];
  const needle = Array.isArray(pattern) ? pattern : [];
  let from = Number.isFinite(start) ? Math.trunc(Number(start)) : 0;
  if (from < 0) from = 0;

  if (needle.length === 0) {
    return from <= haystack.length ? from : -1;
  }
  if (needle.length > haystack.length) {
    return -1;
  }

  const last = haystack.length - needle.length;

  /** @param {number} i @param {number} mode @returns {boolean} */
  const matches = (i, mode) => {
    for (let k = 0; k < needle.length; k += 1) {
      const a = haystack[i + k];
      const b = needle[k];
      if (mode === 0) {
        if (a !== b) return false;
      } else if (mode === 1) {
        if (String(a).trimEnd() !== String(b).trimEnd()) return false;
      } else if (mode === 2) {
        if (String(a).trim() !== String(b).trim()) return false;
      } else if (normalizeForCompare(a) !== normalizeForCompare(b)) {
        return false;
      }
    }
    return true;
  };

  for (let mode = 0; mode < 4; mode += 1) {
    if (eof && last >= 0 && matches(last, mode)) return last;
    for (let i = from; i <= last; i += 1) {
      if (matches(i, mode)) return i;
    }
  }
  return -1;
}

/**
 * Split patch text into lines the way Codex does: `patch.trim().lines()`.
 * Strips a leading BOM, trims the whole text, then drops one trailing `\r` per line.
 * @param {unknown} text
 * @returns {string[]}
 */
function splitPatchLines(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/u, '');
  const trimmed = raw.trim();
  if (trimmed === '') return [];
  return trimmed.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/**
 * Validate the patch envelope and return the inner patch lines.
 * Mirrors `check_patch_boundaries_strict` + `check_patch_boundaries_lenient`.
 * @param {string[]} lines
 * @returns {string[]}
 */
function checkPatchBoundaries(lines) {
  const first = lines.length > 0 ? lines[0].trim() : undefined;
  const last = lines.length > 0 ? lines[lines.length - 1].trim() : undefined;

  if (first === BEGIN_PATCH_MARKER && last === END_PATCH_MARKER) return lines;

  const isHeredoc =
    first !== undefined &&
    HEREDOC_OPENERS.has(first) &&
    last !== undefined &&
    last.endsWith('EOF') &&
    lines.length >= 4;

  if (isHeredoc) {
    const inner = lines.slice(1, lines.length - 1);
    const innerFirst = inner.length > 0 ? inner[0].trim() : undefined;
    const innerLast = inner.length > 0 ? inner[inner.length - 1].trim() : undefined;
    if (innerFirst === BEGIN_PATCH_MARKER && innerLast === END_PATCH_MARKER) return inner;
    if (innerFirst !== BEGIN_PATCH_MARKER) {
      throw new PatchParseError("The first line of the patch must be '*** Begin Patch'", 1);
    }
    throw new PatchParseError("The last line of the patch must be '*** End Patch'", inner.length);
  }

  if (first !== BEGIN_PATCH_MARKER) {
    throw new PatchParseError("The first line of the patch must be '*** Begin Patch'", lines.length > 0 ? 1 : null);
  }
  throw new PatchParseError("The last line of the patch must be '*** End Patch'", lines.length);
}

/**
 * Parse and validate a Codex `apply_patch` body. Pure; performs no I/O and never panics.
 * @param {unknown} text Raw patch text, optionally wrapped in a `<<'EOF' … EOF` heredoc.
 * @returns {{ hunks: Hunk[] }}
 * @throws {PatchParseError} On any malformed input.
 */
export function parsePatch(text) {
  const lines = checkPatchBoundaries(splitPatchLines(text));

  /** @type {Hunk[]} */
  const hunks = [];
  /** @type {'notStarted' | 'started' | 'add' | 'delete' | 'update' | 'ended'} */
  let mode = 'notStarted';
  let lineNumber = 0;
  let updateHunkLineNumber = 0;
  /** @type {string | null} */
  let environmentId = null;

  /** @returns {Hunk | null} */
  const lastHunk = () => (hunks.length > 0 ? hunks[hunks.length - 1] : null);
  /** @returns {UpdateHunk | null} */
  const lastUpdateHunk = () => {
    const hunk = lastHunk();
    return hunk !== null && hunk.kind === 'update' ? hunk : null;
  };
  /** @returns {Chunk | null} */
  const lastChunk = () => {
    const hunk = lastUpdateHunk();
    return hunk !== null && hunk.chunks.length > 0 ? hunk.chunks[hunk.chunks.length - 1] : null;
  };
  const currentChunk = () => {
    const hunk = lastUpdateHunk();
    /* istanbul ignore next -- callers only reach here in update mode with a live update hunk */
    if (hunk === null) throw new PatchParseError('internal parser state error', lineNumber);
    if (hunk.chunks.length === 0) hunk.chunks.push({ eof: false, lines: [] });
    return hunk.chunks[hunk.chunks.length - 1];
  };

  /**
   * Codex's `ensure_update_hunk_is_not_empty`: reject empty update sections and stray lines in a
   * just-opened chunk when a header/end marker arrives.
   * @param {string} line The trimmed line that triggered the check.
   */
  const ensureUpdateHunkNotEmpty = (line) => {
    const hunk = lastUpdateHunk();
    if (hunk === null) return;
    if (hunk.chunks.length === 0 && mode === 'update') {
      throw new PatchParseError(`Update file hunk for path '${hunk.path}' is empty`, updateHunkLineNumber);
    }
    const chunk = lastChunk();
    if (chunk !== null && chunk.lines.length === 0) {
      if (line === END_PATCH_MARKER) {
        throw new PatchParseError('Update hunk does not contain any lines', lineNumber);
      }
      throw new PatchParseError(
        `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        lineNumber,
      );
    }
  };

  /**
   * Codex's `handle_hunk_headers_and_end_patch`. Returns true when the trimmed line was consumed.
   * @param {string} trimmed
   * @returns {boolean}
   */
  const handleHeaders = (trimmed) => {
    if (mode === 'started' && trimmed.startsWith(ENVIRONMENT_ID_MARKER)) {
      if (environmentId !== null) {
        throw new PatchParseError('apply_patch environment_id cannot be specified more than once', null);
      }
      const value = trimmed.slice(ENVIRONMENT_ID_MARKER.length).trim();
      if (value === '') throw new PatchParseError('apply_patch environment_id cannot be empty', null);
      environmentId = value;
      return true;
    }
    if (trimmed === END_PATCH_MARKER) {
      ensureUpdateHunkNotEmpty(trimmed);
      mode = 'ended';
      return true;
    }
    if (trimmed.startsWith(ADD_FILE_MARKER)) {
      ensureUpdateHunkNotEmpty(trimmed);
      hunks.push({ kind: 'add', path: trimmed.slice(ADD_FILE_MARKER.length), content: '' });
      mode = 'add';
      return true;
    }
    if (trimmed.startsWith(DELETE_FILE_MARKER)) {
      ensureUpdateHunkNotEmpty(trimmed);
      hunks.push({ kind: 'delete', path: trimmed.slice(DELETE_FILE_MARKER.length) });
      mode = 'delete';
      return true;
    }
    if (trimmed.startsWith(UPDATE_FILE_MARKER)) {
      ensureUpdateHunkNotEmpty(trimmed);
      hunks.push({ kind: 'update', path: trimmed.slice(UPDATE_FILE_MARKER.length), chunks: [] });
      mode = 'update';
      updateHunkLineNumber = lineNumber;
      return true;
    }
    return false;
  };

  /**
   * Process one patch line exactly like `StreamingPatchParser::process_line`.
   * @param {string} line Line without its terminator.
   */
  const processLine = (line) => {
    const trimmed = line.trim();

    if (mode === 'notStarted') {
      if (trimmed === BEGIN_PATCH_MARKER) {
        mode = 'started';
        return;
      }
      throw new PatchParseError("The first line of the patch must be '*** Begin Patch'", null);
    }

    if (mode === 'started') {
      if (handleHeaders(trimmed)) return;
      throw new PatchParseError(`'${trimmed}' is not a valid hunk header. ${INVALID_HEADER_HINT}`, lineNumber);
    }

    if (mode === 'add') {
      if (handleHeaders(trimmed)) return;
      if (line.startsWith('+')) {
        const hunk = lastHunk();
        if (hunk !== null && hunk.kind === 'add') {
          // Codex always terminates each added line, i.e. the written content ends with "\n".
          hunk.content += `${line.slice(1)}\n`;
          return;
        }
      }
      throw new PatchParseError(`'${trimmed}' is not a valid hunk header. ${INVALID_HEADER_HINT}`, lineNumber);
    }

    if (mode === 'delete') {
      if (handleHeaders(trimmed)) return;
      throw new PatchParseError(`'${trimmed}' is not a valid hunk header. ${INVALID_HEADER_HINT}`, lineNumber);
    }

    if (mode === 'update') {
      const updateLine = line.trimEnd();
      if (handleHeaders(updateLine)) return;

      const hunk = lastUpdateHunk();
      /* istanbul ignore next -- structure guarantees an update hunk while in update mode */
      if (hunk === null) throw new PatchParseError('internal parser state error', lineNumber);
      const chunk = lastChunk();

      // After `*** End of File`: ignore blank lines, otherwise require a new `@@` chunk.
      if (chunk !== null && chunk.eof) {
        if (updateLine === '') return;
        if (updateLine !== EMPTY_CHANGE_CONTEXT_MARKER && !updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
          throw new PatchParseError(
            `Expected update hunk to start with a @@ context marker, got: '${line}'`,
            lineNumber,
          );
        }
      }

      if (hunk.chunks.length === 0 && hunk.moveTo === undefined && updateLine.startsWith(MOVE_TO_MARKER)) {
        hunk.moveTo = updateLine.slice(MOVE_TO_MARKER.length);
        return;
      }

      const isContextMarker =
        updateLine === EMPTY_CHANGE_CONTEXT_MARKER || updateLine.startsWith(CHANGE_CONTEXT_MARKER);
      if (isContextMarker && chunk !== null && chunk.lines.length === 0) {
        throw new PatchParseError(
          `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
          lineNumber,
        );
      }

      if (updateLine === EMPTY_CHANGE_CONTEXT_MARKER || updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
        // The rest of the `@@` header is an ignored section locator.
        hunk.chunks.push({ eof: false, lines: [] });
        return;
      }

      if (updateLine === EOF_MARKER) {
        if (chunk !== null && chunk.lines.length === 0) {
          throw new PatchParseError('Update hunk does not contain any lines', lineNumber);
        }
        if (chunk !== null) chunk.eof = true;
        return;
      }

      // A completely empty line is treated as a context line containing "".
      if (line === '') {
        currentChunk().lines.push({ type: 'context', text: '' });
        return;
      }
      if (line.startsWith(' ')) {
        currentChunk().lines.push({ type: 'context', text: line.slice(1) });
        return;
      }
      if (line.startsWith('+')) {
        currentChunk().lines.push({ type: 'add', text: line.slice(1) });
        return;
      }
      if (line.startsWith('-')) {
        currentChunk().lines.push({ type: 'remove', text: line.slice(1) });
        return;
      }

      if (chunk !== null && chunk.lines.length > 0) {
        throw new PatchParseError(
          `Expected update hunk to start with a @@ context marker, got: '${line}'`,
          lineNumber,
        );
      }
      throw new PatchParseError(
        `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        lineNumber,
      );
    }

    // mode === 'ended'
    if (trimmed === '') return;
    throw new PatchParseError("The last line of the patch must be '*** End Patch'", null);
  };

  for (let i = 0; i < lines.length; i += 1) {
    lineNumber = i + 1;
    processLine(lines[i]);
  }

  if (mode !== 'ended') {
    // Codex's `finish()`: the final line must have been `*** End Patch`.
    throw new PatchParseError("The last line of the patch must be '*** End Patch'", null);
  }

  return { hunks };
}

/**
 * Apply a single update hunk's chunks to the text of a file. Pure: returns the new text and
 * throws on failure. Mirrors Codex's `compute_replacements` + `apply_replacements` in the default
 * `NormalizeToLf` mode.
 *
 * Locating each chunk: the match pattern is the chunk's `remove` + `context` lines in order
 * (`add` lines never contribute to the match), searched forward from a rolling index. The matched
 * span is replaced by the chunk's `context` + `add` lines. A chunk with an empty pattern is an
 * addition-only chunk and is appended at end-of-file (Codex behaviour).
 *
 * If the pattern is not found and it ends with an empty line (the trailing-newline sentinel), the
 * search is retried without that final empty element (Codex's end-of-file tolerance).
 *
 * @param {string} before Existing file text.
 * @param {readonly Chunk[]} chunks Chunks of one `update` hunk, in order.
 * @param {boolean} [eof] When true, the final chunk may match at end-of-file even without its own
 *   `chunk.eof` flag.
 * @returns {string} New file text; always terminated by "\n" unless the result is empty.
 * @throws {Error} With an `invalid patch: …` message when a chunk cannot be located.
 */
export function applyChunksToText(before, chunks, eof) {
  if (typeof before !== 'string') {
    throw new Error('invalid patch: the existing file content must be a string');
  }
  if (!Array.isArray(chunks)) {
    throw new Error('invalid patch: chunks must be an array');
  }

  const lines = before.split('\n');
  // Drop the trailing empty element produced by a final newline, like Codex's NormalizeToLf mode.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let lineIndex = 0;

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    if (chunk === null || typeof chunk !== 'object' || !Array.isArray(chunk.lines)) {
      throw new Error(`invalid patch: chunk ${chunkIndex + 1} is not a valid chunk object`);
    }
    const chunkEof = chunk.eof === true || (eof === true && chunkIndex === chunks.length - 1);

    /** @type {string[]} */
    const pattern = [];
    /** @type {string[]} */
    let replacement = [];
    for (const entry of chunk.lines) {
      const type = entry !== null && typeof entry === 'object' ? entry.type : undefined;
      const text = entry !== null && typeof entry === 'object' ? String(entry.text ?? '') : '';
      if (type === 'remove') {
        pattern.push(text);
      } else if (type === 'context') {
        pattern.push(text);
        replacement.push(text);
      } else if (type === 'add') {
        replacement.push(text);
      } else {
        throw new Error(`invalid patch: chunk ${chunkIndex + 1} has unknown line type '${String(type)}'`);
      }
    }

    if (pattern.length === 0) {
      // Addition-only chunk: Codex appends these at the end of the file.
      const insertionIndex = lines.length;
      lines.splice(insertionIndex, 0, ...replacement);
      lineIndex = insertionIndex + replacement.length;
      continue;
    }

    let searchPattern = pattern;
    let found = seekSequence(lines, searchPattern, lineIndex, chunkEof);
    if (found === -1 && pattern[pattern.length - 1] === '') {
      // Tolerate a trailing empty line that represents the file's terminating newline.
      searchPattern = pattern.slice(0, -1);
      if (replacement.length > 0 && replacement[replacement.length - 1] === '') {
        replacement = replacement.slice(0, -1);
      }
      found = seekSequence(lines, searchPattern, lineIndex, chunkEof);
    }

    if (found === -1) {
      throw new Error(
        `invalid patch: Failed to find expected lines in file (chunk ${chunkIndex + 1}):\n${pattern.join('\n')}`,
      );
    }

    lines.splice(found, searchPattern.length, ...replacement);
    lineIndex = found + searchPattern.length;
  }

  // Codex always terminates the reconstructed file (empty results stay empty).
  if (lines.length === 0 || lines[lines.length - 1] !== '') lines.push('');
  return lines.join('\n');
}
