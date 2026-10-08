// Isolated exercise of the dsh-prompt-polish host half: mounts the plugin on a
// stub Cordis context, captures the route it registers, and drives that route
// with real Request/Response objects. Run with the bundled Node.
import { apply, inject, name } from "../plugins/dsh-prompt-polish/lib/index.js";

let captured = null;
const warnings = [];

function makeCtx(streamFactory, selection) {
  return {
    connection: {
      fetch: {
        register(route) {
          captured = route;
          return async () => {};
        }
      }
    },
    llm: { stream: streamFactory },
    agentDefaultModel: { currentSelection: () => selection },
    logger: { warn: (message) => warnings.push(message) },
    effect(callback) {
      const dispose = callback();
      return () => dispose?.();
    }
  };
}

function request(text) {
  return new Request("http://127.0.0.1/api/prompt-polish/optimize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text })
  });
}

async function* goodStream() {
  yield { type: "block-start", index: 0, blockType: "text" };
  yield { type: "text-delta", index: 0, text: "```\n" };
  yield { type: "text-delta", index: 0, text: "把登录页做出来" };
  yield { type: "text-delta", index: 0, text: "，包含邮箱密码校验。\n```" };
  yield { type: "block-end", index: 0, block: { type: "text", text: "```\n把登录页做出来，包含邮箱密码校验。\n```" } };
  yield { type: "finish", reason: { kind: "stop" } };
}

const cases = [];
function check(label, ok, detail) {
  cases.push({ label, ok, detail });
}

// 1. happy path: fenced output is unwrapped, deltas win over block text.
apply(makeCtx(goodStream, { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" }), {});
check("route registered", captured !== null && captured.path === "/api/prompt-polish/optimize" && captured.methods.join() === "POST");
const okResponse = await captured.fetch(request("  帮我写个登录页  "));
const okJson = await okResponse.json();
check("happy path ok", okResponse.status === 200 && okJson.ok === true, JSON.stringify(okJson));
check("unwrap + no duplicate", okJson.text === "把登录页做出来，包含邮箱密码校验。", JSON.stringify(okJson.text));
check("route reported", okJson.provider === "deepseek-official" && okJson.model === "deepseek-flash", JSON.stringify(okJson));

// 2. empty draft is refused before any model call.
let streamCalls = 0;
apply(makeCtx(function* () { streamCalls += 1; }, { provider: "p", model: "m" }), {});
const emptyResponse = await captured.fetch(request("   \n  "));
const emptyJson = await emptyResponse.json();
check("empty draft refused", emptyResponse.status === 400 && emptyJson.error.code === "prompt-polish/empty-draft", JSON.stringify(emptyJson));
check("no model call for empty draft", streamCalls === 0, String(streamCalls));

// 3. malformed body.
const badResponse = await captured.fetch(new Request("http://x/api/prompt-polish/optimize", { method: "POST", body: "not json" }));
check("bad body refused", badResponse.status === 400, String(badResponse.status));

// 4. length limit honors config.
apply(makeCtx(goodStream, { provider: "p", model: "m" }), { maxInputChars: 4 });
const longResponse = await captured.fetch(request("0123456789"));
const longJson = await longResponse.json();
check("maxInputChars enforced", longResponse.status === 413 && longJson.error.code === "prompt-polish/draft-too-long", JSON.stringify(longJson));

// 5. terminal failure becomes a failure reply, not a crash.
async function* errorStream() {
  yield { type: "text-delta", index: 0, text: "partial" };
  yield { type: "finish", reason: { kind: "error", failure: { message: "provider exploded", code: "X" } } };
}
apply(makeCtx(errorStream, { provider: "p", model: "m" }), {});
const errResponse = await captured.fetch(request("hi"));
const errJson = await errResponse.json();
check("model failure mapped", errResponse.status === 502 && errJson.ok === false && errJson.error.message === "provider exploded", JSON.stringify(errJson));

// 6. a thrown stream becomes a failure reply too.
async function* throwingStream() {
  yield { type: "text-delta", index: 0, text: "x" };
  throw new Error("socket closed");
}
apply(makeCtx(throwingStream, { provider: "p", model: "m" }), {});
const thrownResponse = await captured.fetch(request("hi"));
const thrownJson = await thrownResponse.json();
check("thrown stream mapped", thrownResponse.status === 502 && thrownJson.error.message === "socket closed", JSON.stringify(thrownJson));

// 7. no default route is a clear 500.
apply(makeCtx(goodStream, null), {});
const noRouteResponse = await captured.fetch(request("hi"));
const noRouteJson = await noRouteResponse.json();
check("missing route reported", noRouteResponse.status === 500 && noRouteJson.error.code === "prompt-polish/no-route", JSON.stringify(noRouteJson));

// 8. block text is the fallback when the adapter sends no deltas.
async function* blockOnlyStream() {
  yield { type: "block-end", index: 0, block: { type: "text", text: "  plain reply  " } };
  yield { type: "finish", reason: { kind: "stop" } };
}
apply(makeCtx(blockOnlyStream, { provider: "p", model: "m" }), {});
const blockJson = await (await captured.fetch(request("hi"))).json();
check("block fallback", blockJson.text === "plain reply", JSON.stringify(blockJson));

// 9. manifest surface.
check("plugin name/inject", name === "prompt-polish" && inject.join() === "connection,llm,agentDefaultModel", `${name} ${inject.join()}`);

let failed = 0;
for (const item of cases) {
  if (!item.ok) failed += 1;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.label}${item.detail ? "  -> " + item.detail : ""}`);
}
console.log(failed === 0 ? `\nall ${cases.length} checks passed` : `\n${failed}/${cases.length} checks FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
