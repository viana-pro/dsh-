// Isolated exercise of the dsh-chat-branch client bundle: loads the real
// browser bundle under a stub module loader, mounts it on a stub Cordis client
// context, and drives the pure model reads the controls are built from against
// synthetic Chat snapshots shaped like the shipped `useChat` snapshots.
// Run with the bundled Node.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, "..", "plugins", "dsh-chat-branch", "lib", "client.js");
const source = readFileSync(bundlePath, "utf8");

// ---------------------------------------------------------------------------
// stub browser module system / React
// ---------------------------------------------------------------------------

const loaded = [];
const fakeWindow = {
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  getComputedStyle: () => ({ overflowY: "visible", position: "static" }),
  __ModuleLoader__: {
    load(entry) {
      loaded.push(entry);
    }
  }
};

const hookStub = () => undefined;
const reactStub = {
  createElement: () => null,
  Fragment: {},
  useCallback: hookStub,
  useEffect: hookStub,
  useMemo: hookStub,
  useRef: hookStub,
  useState: hookStub
};

function fakeRequire(spec) {
  if (spec === "react") return reactStub;
  if (spec === "react-dom") return { createPortal: () => null };
  if (spec === "@deepseek-ai/dsh-client-ui-primitives") {
    return { IconBranchOutlineRegular: () => null, Tooltip: () => null };
  }
  throw new Error(`unexpected require: ${spec}`);
}

globalThis.window = fakeWindow;
globalThis.document = undefined;
new Function("window", source)(fakeWindow);

const cases = [];
function check(label, ok, detail) {
  cases.push({ label, ok, detail });
}

check("one bundle registered", loaded.length === 1 && loaded[0].id === "dsh-chat-branch", String(loaded.length));
const exports_ = loaded[0].factory(fakeRequire);
check("name/inject", exports_.name === "chat-branch" && exports_.inject.join() === "slots,locale,sessions,uiWorkspace", `${exports_.name} ${exports_.inject.join()}`);
const internals = exports_.__internals;

// ---------------------------------------------------------------------------
// stub client Cordis context
// ---------------------------------------------------------------------------

const registrations = [];
const localeRegistrations = [];
const disposers = [];

function applyPlugin() {
  const ctx = {
    effect(callback) {
      const dispose = callback();
      disposers.push(dispose);
    },
    locale: {
      register(ns, dicts) {
        localeRegistrations.push({ ns, dicts });
        return () => {};
      }
    },
    slots: {
      inject(key, callback) {
        const before = registrations.length;
        callback();
        if (registrations.length === before) throw new Error(`inject(${key}) registered nothing`);
        return () => {};
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      }
    },
    sessions: {
      calls: [],
      fork(input) {
        this.calls.push(input);
        return Promise.resolve(`session-child-${this.calls.length}`);
      }
    },
    uiWorkspace: {
      opened: [],
      openSession(id) {
        this.opened.push(id);
      }
    }
  };
  exports_.apply(ctx);
  return ctx;
}

const ctx = applyPlugin();
check("two slot registrations", registrations.length === 2, String(registrations.length));
const byId = new Map(registrations.map((entry) => [entry.options.id, entry]));
check("action-row registration", byId.has("chat-branch-row") && byId.get("chat-branch-row").options.name === "conversation.chat.assistant-actions");
check("turn-tail registration", byId.has("chat-branch-nodes") && byId.get("chat-branch-nodes").options.name === "conversation.chat.turnTail");
check("locale namespace", registrations.every((entry) => entry.options.locale === "chat-branch"));
check("components are functions", typeof byId.get("chat-branch-row").component === "function" && typeof byId.get("chat-branch-nodes").component === "function");
check("locale dictionaries", localeRegistrations.length === 1 && localeRegistrations[0].ns === "chat-branch" && localeRegistrations[0].dicts.zh["node.user"].length > 0 && localeRegistrations[0].dicts.en["node.user"].length > 0);

// The injected fork must be the shipped shape: atSeq boundary, inherited title
// increment, then the child opens in place.
const injected = byId.get("chat-branch-nodes").options.inject("session-1");
const childId = await injected.forkAt(42);
check("fork input", ctx.sessions.calls.length === 1 && ctx.sessions.calls[0].sessionId === "session-1" && ctx.sessions.calls[0].atSeq === 42 && ctx.sessions.calls[0].increaseTitle === true, JSON.stringify(ctx.sessions.calls[0]));
check("child opened", childId === "session-child-1" && ctx.uiWorkspace.opened.join() === "session-child-1", JSON.stringify(ctx.uiWorkspace.opened));

// ---------------------------------------------------------------------------
// synthetic Chat snapshots
// ---------------------------------------------------------------------------

function node(kind, anchorSeq, extra = {}) {
  return { key: `${kind}:${anchorSeq}`, kind, anchorSeq, ...extra };
}

function turnRecord(turn, tail, nodesInOrder) {
  const data = new Map();
  if (tail !== null) data.set("turn-tail", tail);
  return { turn, data, nodesInOrder };
}

function chatFixture(records) {
  const turns = new Map();
  const nodes = new Map();
  const order = new Map();
  for (const record of records) {
    turns.set(record.turn, record);
    order.set(record.turn, record.nodesInOrder.map((entry) => entry.key));
    for (const entry of record.nodesInOrder) nodes.set(entry.key, entry);
  }
  return {
    timeline: { turns, turnOrder: records.map((record) => record.turn) },
    nodes: { get: (key) => nodes.get(key), values: () => nodes.values() },
    locations: { getTurn: (turn) => order.get(turn) ?? [] }
  };
}

const userNode = node("user", 10);
const firstReply = node("assistant-step", 20, { data: { finalNode: { seq: 25, messageId: "m1" } } });
const toolNode = node("tool-call", 30);
const secondReply = node("assistant-step", 40, { data: { finalNode: { seq: 45, messageId: "m2" } } });
const coveredTail = { turn: 1, seq: 50, branchUnavailable: false, closing: { finalNode: { seq: 45, messageId: "m2" } } };
const coveredTurn = turnRecord(1, coveredTail, [userNode, firstReply, toolNode, secondReply]);

const openReply = node("assistant-step", 60, { data: { finalNode: { seq: 62, messageId: "m3" } } });
const trailingCall = node("tool-call", 70);
const hiddenReply = node("assistant-step", 64, { data: { finalNode: { seq: 66, messageId: "m4" } }, visibility: "hidden" });
// The host refuses this turn because a Tool call follows the closing reply, so
// `branchUnavailable` is set while the closing message - and its action row -
// still exist.
const uncoveredTail = { turn: 2, seq: 80, branchUnavailable: true, closing: { finalNode: { seq: 62, messageId: "m3" } } };
const uncoveredTurn = turnRecord(2, uncoveredTail, [openReply, trailingCall, hiddenReply]);

const emptyTail = { turn: 3, seq: 5, branchUnavailable: false, closing: null };
const chat = chatFixture([coveredTurn, uncoveredTurn, turnRecord(3, emptyTail, [])]);

check("turnTailOf reads the footer", internals.turnTailOf(chat, 1) === coveredTail);
check("turnTailOf misses without a footer", internals.turnTailOf(chat, 9) === null);

check("host branch enabled on a text-closing turn", internals.hostBranchEnabled(chat, coveredTail) === true);
check("host branch refused when the closing message is not last", internals.hostBranchEnabled(chat, uncoveredTail) === false);
check("host branch refused for an empty closing", internals.hostBranchEnabled(chat, emptyTail) === false);

check("assistant step forks at its message event", internals.branchSeqOfNode(firstReply) === 25);
check("user message forks at its event", internals.branchSeqOfNode(userNode) === 10);
check("tool call forks at its event", internals.branchSeqOfNode(toolNode) === 30);
check("unsettled assistant has no boundary", internals.branchSeqOfNode(node("assistant-step", 5, { data: {} })) === undefined);

const coveredTargets = internals.targetsOfTurn(chat, 1);
check("covered turn targets", coveredTargets.map((target) => `${target.kind}@${target.seq}`).join(",") === "user@10,assistant-step@25,tool-call@30", JSON.stringify(coveredTargets));
check("covered turn order", coveredTargets.every((target, index) => index === 0 || coveredTargets[index - 1].key !== target.key));

const uncoveredTargets = internals.targetsOfTurn(chat, 2);
check("host-refused turn covers its reply and its trailing call", uncoveredTargets.map((target) => `${target.kind}@${target.seq}`).join(",") === "assistant-step@62,tool-call@70", JSON.stringify(uncoveredTargets));
check("hidden nodes are skipped", uncoveredTargets.every((target) => target.key !== hiddenReply.key));
check("unknown turn yields nothing", internals.targetsOfTurn(chat, 7).length === 0);
check("non-numeric turn yields nothing", internals.targetsOfTurn(chat, undefined).length === 0);

check("row action hidden where the host works", internals.rowStateOf(chat, "m2").visible === false);
check("row action shown where the host refuses", internals.rowStateOf(chat, "m3").visible === true && internals.rowStateOf(chat, "m3").seq === 62);
check("row action hidden for an unknown message", internals.rowStateOf(chat, "nope").visible === false);

check("turnForMessage finds the closing turn", internals.turnForMessage(chat, "m2") === coveredTurn);
check("turnForMessage misses", internals.turnForMessage(chat, "m9") === null);

check("seat comparison is by identity", internals.sameSeats(new Map([["a", 1]]), new Map([["a", 1]])) === true && internals.sameSeats(new Map([["a", 1]]), new Map([["a", 2]])) === false);

// Seat selection: one pass over the seats a scope already rendered, keeping
// only wanted keys that are live and visible.
function fakeSeat(attributes, options = {}) {
  return {
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null),
    hasAttribute: (name) => name === "hidden" && options.hidden === true,
    getClientRects: () => new Array(options.rects ?? 1)
  };
}

const wanted = new Set(["a", "b", "c"]);
const selected = internals.selectSeats([
  fakeSeat({ "data-chat-node-key": "a" }),
  fakeSeat({ "data-chat-node-key": "b" }, { hidden: true }),
  fakeSeat({ "data-chat-node-key": "c" }, { rects: 0 }),
  fakeSeat({ "data-chat-node-key": "other" }),
  fakeSeat({ "data-chat-node-key": "a" }),
  fakeSeat({}),
  null
], wanted);
check("only live visible wanted seats are kept", selected.size === 1 && selected.get("a").getAttribute("data-chat-node-key") === "a", String(selected.size));
check("first seat wins for a repeated key", selected.get("a") !== null && internals.selectSeats([fakeSeat({ "data-chat-node-key": "a" }), fakeSeat({ "data-chat-node-key": "a" })], wanted).size === 1);
check("empty wanted set selects nothing", internals.selectSeats([fakeSeat({ "data-chat-node-key": "a" })], new Set()).size === 0);

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

for (const dispose of disposers) if (typeof dispose === "function") dispose();

let failed = 0;
for (const item of cases) {
  if (!item.ok) failed += 1;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.label}${item.detail ? "  -> " + item.detail : ""}`);
}
console.log(failed === 0 ? `\nall ${cases.length} checks passed` : `\n${failed}/${cases.length} checks FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
