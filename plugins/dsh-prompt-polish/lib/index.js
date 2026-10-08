// Host half of dsh-prompt-polish.
//
// Rewrites one composer draft into a clearer, more executable instruction by
// calling the profile's default model through `ctx.llm`, and serves the result
// to the browser half (./client.js) over one authenticated `/api` route.
//
// It imports only Node built-ins (none here) and Cordis service keys, so the
// package can be installed as an out-of-tree bundle without resolving private
// packages - the same contract dsh-token-heatmap and dsh-session-cost use.

const name = "prompt-polish";
// Hard service dependencies (Cordis service keys, not npm packages).
const inject = ["connection", "llm", "agentDefaultModel"];

const ROUTE_PATH = "/api/prompt-polish/optimize";

const DEFAULT_MAX_INPUT_CHARS = 8000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 90000;

const SYSTEM_PROMPT = [
  "You rewrite one draft instruction that a human is about to send to an AI coding assistant.",
  "Return only the rewritten instruction: no preamble, no explanation, no Markdown fence, no surrounding quotes.",
  "Keep the language of the draft.",
  "Preserve the author's intent exactly. Never add requirements, files, technologies, or constraints the draft does not already imply.",
  "Make the intent explicit: state the goal and the expected deliverable, mark the scope, and replace vague references with concrete ones.",
  "Keep every code fragment, path, command, flag, identifier, and URL exactly as written.",
  "Stay concise: no filler, no flattery, and never restate the same point twice.",
  "When the draft is already clear, make only the smallest necessary edit."
].join("\n");

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
  const provider = typeof raw.provider === "string" && raw.provider !== "" ? raw.provider : undefined;
  const model = typeof raw.model === "string" && raw.model !== "" ? raw.model : undefined;
  return {
    provider,
    model,
    instruction: typeof raw.instruction === "string" && raw.instruction.trim() !== "" ? raw.instruction.trim() : undefined,
    maxInputChars: positiveInt(raw.maxInputChars, DEFAULT_MAX_INPUT_CHARS),
    maxOutputTokens: positiveInt(raw.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS),
    timeoutMs: positiveInt(raw.timeoutMs, DEFAULT_TIMEOUT_MS)
  };
}

/** The explicit route from Config, or the profile's default model selection. */
function resolveRoute(ctx, options) {
  if (options.provider !== undefined && options.model !== undefined) {
    return { provider: options.provider, model: options.model };
  }
  let selected;
  try {
    selected = ctx.agentDefaultModel.currentSelection();
  } catch (error) {
    throw new Error(`could not read the default model selection: ${messageOf(error)}`);
  }
  if (selected === null || typeof selected !== "object" || typeof selected.provider !== "string" || typeof selected.model !== "string") {
    throw new Error("no default model is configured; set provider and model in the prompt-polish plugin config");
  }
  const route = { provider: selected.provider, model: selected.model };
  if (typeof selected.reasoningEffort === "string" && selected.reasoningEffort !== "") {
    route.reasoningEffort = selected.reasoningEffort;
  }
  return route;
}

/** Frame the draft as JSON data so its own text cannot break the request shape. */
function frameDraft(text) {
  return `Rewrite the instruction held in this JSON string.\n${JSON.stringify(text)}`;
}

/** Translate a terminal finish reason into a failure message, or undefined on success. */
function finishFailure(finish) {
  if (finish === undefined || finish === null) return undefined;
  switch (finish.kind) {
    case "stop":
      return undefined;
    case "error":
    case "aborted":
      return finish.failure && typeof finish.failure.message === "string"
        ? finish.failure.message
        : `the model call settled as ${finish.kind}`;
    case "max-tokens":
      return "the model reached maxOutputTokens; raise it in the prompt-polish plugin config";
    case "tool-calls":
      return "the model unexpectedly requested a tool";
    default:
      return `unsupported finish reason "${String(finish.kind)}"`;
  }
}

/** Strip a wrapping Markdown fence or quote pair the model may have added. */
function normalizeOutput(raw) {
  let text = String(raw === null || raw === undefined ? "" : raw).trim();
  const fenced = /^```[A-Za-z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/.exec(text);
  if (fenced !== null) text = fenced[1].trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === "\u201c" && last === "\u201d")) {
      text = text.slice(1, -1).trim();
    }
  }
  return text;
}

function failure(status, code, message) {
  return Response.json({ ok: false, error: { code, message } }, { status });
}

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------

async function handleOptimize(ctx, options, request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return failure(400, "prompt-polish/invalid-body", "the request body must be JSON");
  }
  const draft = payload !== null && typeof payload === "object" && typeof payload.text === "string" ? payload.text.trim() : "";
  if (draft === "") return failure(400, "prompt-polish/empty-draft", "there is no draft text to polish");
  if (draft.length > options.maxInputChars) {
    return failure(413, "prompt-polish/draft-too-long", `the draft is ${draft.length} characters, over maxInputChars ${options.maxInputChars}`);
  }

  let route;
  try {
    route = resolveRoute(ctx, options);
  } catch (error) {
    return failure(500, "prompt-polish/no-route", messageOf(error));
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const forwardAbort = () => controller.abort();
  if (request.signal !== undefined && request.signal !== null) request.signal.addEventListener("abort", forwardAbort);

  try {
    const call = {
      provider: route.provider,
      model: route.model,
      system: options.instruction === undefined ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}\nDeployment instruction:\n${options.instruction}`,
      messages: [{ role: "user", content: [{ type: "text", text: frameDraft(draft) }] }],
      maxTokens: options.maxOutputTokens,
      signal: controller.signal
    };
    if (route.reasoningEffort !== undefined) call.reasoningEffort = route.reasoningEffort;

    // Deltas and settled blocks can both carry the text; prefer deltas and fall
    // back to block text so the reply is never counted twice.
    let deltaText = "";
    let blockText = "";
    let finish;
    for await (const chunk of ctx.llm.stream(call)) {
      if (chunk === null || typeof chunk !== "object") continue;
      if (chunk.type === "text-delta") deltaText += typeof chunk.text === "string" ? chunk.text : "";
      else if (chunk.type === "block-end" && chunk.block !== null && typeof chunk.block === "object" && chunk.block.type === "text") {
        blockText += typeof chunk.block.text === "string" ? chunk.block.text : "";
      } else if (chunk.type === "finish") finish = chunk.reason;
    }

    const terminalFailure = finishFailure(finish);
    if (terminalFailure !== undefined) {
      bestEffortWarn(ctx, `prompt-polish: model call failed: ${terminalFailure}`);
      return failure(timedOut ? 504 : 502, "prompt-polish/model-failed", terminalFailure);
    }
    const polished = normalizeOutput(deltaText !== "" ? deltaText : blockText);
    if (polished === "") return failure(502, "prompt-polish/empty-result", "the model returned no instruction text");
    return Response.json({ ok: true, text: polished, provider: route.provider, model: route.model });
  } catch (error) {
    const message = timedOut ? `the model call exceeded ${options.timeoutMs} ms` : messageOf(error);
    bestEffortWarn(ctx, `prompt-polish: model call failed: ${message}`);
    return failure(timedOut ? 504 : 502, "prompt-polish/model-failed", message);
  } finally {
    clearTimeout(timer);
    if (request.signal !== undefined && request.signal !== null) request.signal.removeEventListener("abort", forwardAbort);
  }
}

function bestEffortWarn(ctx, message) {
  try {
    ctx.logger?.warn?.(message);
  } catch {
    // Logging must never change the reply.
  }
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  const options = resolveOptions(config);

  ctx.effect(
    () => ctx.connection.fetch.register({
      path: ROUTE_PATH,
      methods: ["POST"],
      requestBody: "buffered",
      fetch: (request) => handleOptimize(ctx, options, request)
    }),
    "prompt-polish: optimize route"
  );
}

export { name, inject, apply };
