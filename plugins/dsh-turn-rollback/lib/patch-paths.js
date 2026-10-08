// Path extraction from an `apply_patch` command string.
//
// The tool's grammar is Codex's own: one freeform patch text whose file
// sections start with `*** Update File: `, `*** Add File: `, or
// `*** Delete File: `, and whose `*** Move to: ` names a second path. The
// rollback journal must hold the pre-image of every path a call mutates, so
// this module reports exactly the paths the real parser would treat as headers
// - no more.
//
// The distinction matters: headers outside an update section may be indented,
// while inside one they must sit at column zero, because a line such as
// ` *** Move to: notes.md` is that file's hunk *content*, not a header. A
// looser scan would journal a path the patch never touches, and rolling that
// journal back could delete an unrelated file.

const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const END_PATCH = "*** End Patch";

/** The file-section header one candidate line carries, if any. */
function headerOf(line) {
  if (line.startsWith(UPDATE_FILE)) return { kind: "update", path: line.slice(UPDATE_FILE.length) };
  if (line.startsWith(ADD_FILE)) return { kind: "add", path: line.slice(ADD_FILE.length) };
  if (line.startsWith(DELETE_FILE)) return { kind: "delete", path: line.slice(DELETE_FILE.length) };
  return undefined;
}

/**
 * Every path one `apply_patch` command names, in patch order, deduplicated.
 * A `*** Move to:` contributes its destination as well as the source.
 * @param command - the tool's freeform patch string, however malformed.
 * @returns the model-facing paths the call is about to mutate.
 */
export function patchMutationPaths(command) {
  const paths = [];
  const seen = new Set();
  const push = (value) => {
    const path = value.trim();
    if (path === "" || seen.has(path)) return;
    seen.add(path);
    paths.push(path);
  };
  // Start in the body: a wrapper-less patch is tolerated because a malformed
  // patch is refused by the tool itself, and over-reporting a header is safe
  // only while the reported path really is a header.
  let mode = "started";
  let chunkStarted = false;
  for (const raw of String(command ?? "").split(/\r?\n/u)) {
    if (mode === "ended") continue;
    const trimmed = raw.trim();
    const candidate = mode === "update" ? raw.trimEnd() : trimmed;
    if (candidate === END_PATCH) {
      mode = "ended";
      continue;
    }
    const header = headerOf(candidate);
    if (header !== undefined) {
      push(header.path);
      mode = header.kind;
      chunkStarted = false;
      continue;
    }
    if (mode === "update" && !chunkStarted && candidate.startsWith(MOVE_TO)) {
      push(candidate.slice(MOVE_TO.length));
      continue;
    }
    if (mode === "update" && candidate.startsWith("@@")) chunkStarted = true;
  }
  return paths;
}
