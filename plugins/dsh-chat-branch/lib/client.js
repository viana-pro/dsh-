// dsh-chat-branch client bundle - ChatGPT-style branching for the DeepSeek
// Harness Web chat: start a new branch from any node of the conversation.
//
// Two additive contributions, both through slots the shipped client declares:
//
// 1. `conversation.chat.assistant-actions` - a branch icon inside the shipped
//    action row of a completed turn, rendered only while the host's own branch
//    action is unavailable for that turn (a turn whose last transcript event is
//    not the closing Assistant message). The host action stays the single one
//    everywhere it works, so a turn never shows two branch buttons.
//
// 2. `conversation.chat.turnTail` - one hover branch control per node of the
//    completed turn, portalled into that node's own render seat, which is what
//    makes "branch from any node" true: user/steering/waking messages have no
//    branch affordance in the shipped client at all, and intermediate Assistant
//    steps, Tool calls, and turns the host refuses are covered too.
//
// Both call the same public Session service the shipped chat action calls
// (`ctx.sessions.fork({ atSeq })`) and open the child with
// `ctx.uiWorkspace.openSession`, so a branch is an ordinary forked Session.

window.__ModuleLoader__.load({
  id: "dsh-chat-branch",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var ReactDOM = require("react-dom");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    var createElement = React.createElement;
    var Fragment = React.Fragment;
    var useCallback = React.useCallback;
    var useEffect = React.useEffect;
    var useMemo = React.useMemo;
    var useRef = React.useRef;
    var useState = React.useState;

    var NS = "chat-branch";

    // Node kinds that get a hover branch control. Messages first: `user`,
    // `steering`, and `turn-trigger` are the human-authored nodes the shipped
    // client never offers a branch action for. `assistant-step` and `tool-call`
    // are included so an intermediate node inside a long turn is branchable too.
    var NODE_KINDS = {
      "user": true,
      "steering": true,
      "turn-trigger": true,
      "assistant-step": true,
      "tool-call": true
    };

    var SEAT_SELECTOR = "[data-chat-node-key]";
    var SEAT_ATTR = "data-chat-node-key";
    var SEAT_CLASS = "dsh-chat-branch-seat";
    var ROW_CLASS = "dsh-chat-branch-row";
    var MARKER_CLASS = "dsh-chat-branch-marker";
    var MARKER_CSS_ID = "dsh-chat-branch/styles";
    var EMPTY_SEATS = new Map();
    var EMPTY_TARGETS = [];

    var zh = {
      "row.branch": "从这条回复开启新分支",
      "row.branching": "正在创建分支…",
      "row.failed": "分支失败：{message}",
      "node.user": "从这条消息开启新分支",
      "node.steering": "从这条指令开启新分支",
      "node.turn-trigger": "从这条通知开启新分支",
      "node.assistant-step": "从这条回复开启新分支",
      "node.tool-call": "从这次工具调用开启新分支",
      "node.branch": "从这里开启新分支",
      "node.branching": "正在创建分支…",
      "node.failed": "分支失败:{message}"
    };

    var en = {
      "row.branch": "Branch from this reply",
      "row.branching": "Creating branch…",
      "row.failed": "Branch failed: {message}",
      "node.user": "Branch from this message",
      "node.steering": "Branch from this instruction",
      "node.turn-trigger": "Branch from this notification",
      "node.assistant-step": "Branch from this reply",
      "node.tool-call": "Branch from this tool call",
      "node.branch": "Branch from here",
      "node.branching": "Creating branch…",
      "node.failed": "Branch failed: {message}"
    };

    // ------------------------------------------------------------------
    // styles (theme tokens only, so light and dark both follow the host)
    // ------------------------------------------------------------------

    var CSS = [
      ".dsh-chat-branch-marker{display:none}",
      // Geometry mirrors the shipped MessageIconActions button
      // (28px, --dsw-radius-sm, tertiary label, hover wash).
      ".dsh-chat-branch-row{box-sizing:border-box;width:calc(28px + var(--dsh-content-font-delta,0px));",
      "height:calc(28px + var(--dsh-content-font-delta,0px));padding:6px;display:inline-flex;",
      "align-items:center;justify-content:center;border:none;border-radius:var(--dsw-radius-sm);",
      "background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}",
      ".dsh-chat-branch-row svg{width:calc(15px + var(--dsh-content-font-delta,0px));",
      "height:calc(15px + var(--dsh-content-font-delta,0px))}",
      ".dsh-chat-branch-row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);",
      "color:var(--dsw-alias-label-primary)}",
      ".dsh-chat-branch-row:disabled{cursor:default}",
      ".dsh-chat-branch-row[data-state=error]{color:var(--dsw-alias-state-error-primary)}",
      ".dsh-chat-branch-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
      // The hover control sits at the message's own corner, revealed exactly
      // like the shipped action row (`:hover` / `:focus-within` on the seat).
      ".dsh-chat-branch-seat{position:absolute;top:2px;inset-inline-end:4px;z-index:3;box-sizing:border-box;",
      "width:24px;height:24px;padding:4px;display:inline-flex;align-items:center;justify-content:center;",
      "border:none;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base,transparent);",
      "color:var(--dsw-alias-label-tertiary);cursor:pointer;opacity:0;transition:opacity 80ms}",
      ".dsh-chat-branch-seat svg{width:15px;height:15px}",
      SEAT_SELECTOR + ":hover > .dsh-chat-branch-seat,",
      SEAT_SELECTOR + ":focus-within > .dsh-chat-branch-seat{opacity:1}",
      ".dsh-chat-branch-seat:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);",
      "color:var(--dsw-alias-label-primary)}",
      ".dsh-chat-branch-seat:disabled{cursor:default}",
      ".dsh-chat-branch-seat[data-state=error]{color:var(--dsw-alias-state-error-primary);opacity:1}",
      ".dsh-chat-branch-seat:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);opacity:1}",
      "@media (hover:none){.dsh-chat-branch-seat{opacity:1}}",
      "@keyframes dsh-chat-branch-spin{to{transform:rotate(360deg)}}",
      ".dsh-chat-branch-spin{animation:dsh-chat-branch-spin .9s linear infinite}"
    ].join("");

    // ------------------------------------------------------------------
    // model reads (pure - also the unit under tools/chat-branch-client.test.mjs)
    // ------------------------------------------------------------------

    function isRecord(value) {
      return typeof value === "object" && value !== null;
    }

    /** The `turn-tail` data of one turn, or null when the turn has no footer yet. */
    function turnTailOf(chat, turn) {
      if (!isRecord(chat) || !isRecord(chat.timeline) || typeof turn !== "number") return null;
      var turns = chat.timeline.turns;
      if (turns === undefined || turns === null || typeof turns.get !== "function") return null;
      var record = turns.get(turn);
      var data = isRecord(record) ? record.data : undefined;
      if (data === undefined || data === null || typeof data.get !== "function") return null;
      return data.get("turn-tail") ?? null;
    }

    function finalNodeOf(tail) {
      var closing = isRecord(tail) ? tail.closing : undefined;
      return isRecord(closing) && isRecord(closing.finalNode) ? closing.finalNode : null;
    }

    /**
     * The turn whose closing Assistant message is `messageId`, mirroring the
     * shipped chat lookup that pairs a fork with its message.
     */
    function turnForMessage(chat, messageId) {
      if (!isRecord(chat) || !isRecord(chat.timeline) || typeof messageId !== "string") return null;
      var turns = chat.timeline.turns;
      if (turns === undefined || turns === null || typeof turns.values !== "function") return null;
      var found = null;
      turns.forEach(function (record) {
        if (found !== null || !isRecord(record)) return;
        var data = record.data;
        var tail = data !== undefined && data !== null && typeof data.get === "function" ? data.get("turn-tail") : null;
        var final = finalNodeOf(tail);
        if (final !== null && final.messageId === messageId) found = record;
      });
      return found;
    }

    function nodeKeysOf(chat, turn) {
      if (!isRecord(chat) || !isRecord(chat.locations) || typeof chat.locations.getTurn !== "function") return EMPTY_TARGETS;
      var keys = chat.locations.getTurn(turn);
      return Array.isArray(keys) ? keys : EMPTY_TARGETS;
    }

    function nodeOf(chat, key) {
      if (!isRecord(chat) || !isRecord(chat.nodes) || typeof chat.nodes.get !== "function") return undefined;
      return chat.nodes.get(key);
    }

    function isSkippedTailNode(kind) {
      return kind === "turn-tail" || kind === "turn-process" || kind === "turn-max-tokens";
    }

    /**
     * Whether the shipped turn-tail branch action is enabled for this turn.
     * This is the shipped rule read from the same two facts the host component
     * reads: the turn's own `branchUnavailable`, and whether content follows the
     * closing Assistant message inside that turn.
     */
    function hostBranchEnabled(chat, tail) {
      var data = tail;
      if (!isRecord(data)) return false;
      if (data.branchUnavailable === true) return false;
      var final = finalNodeOf(data);
      // No closing Assistant message: the host reports the turn unavailable and
      // renders its branch control disabled.
      if (final === null) return false;
      var boundary = final.seq;
      if (typeof boundary !== "number") return false;
      var latest = -1;
      var keys = nodeKeysOf(chat, typeof data.turn === "number" ? data.turn : undefined);
      for (var index = 0; index < keys.length; index++) {
        var node = nodeOf(chat, keys[index]);
        if (!isRecord(node) || isSkippedTailNode(node.kind)) continue;
        if (typeof node.anchorSeq === "number" && node.anchorSeq > latest) latest = node.anchorSeq;
      }
      return !(latest > boundary);
    }

    /**
     * The inclusive fork boundary of one chat node: a settled Assistant step
     * forks at its message event (its render anchor is the first visible chunk,
     * which would cut inside the message); every other node forks at its anchor.
     */
    function branchSeqOfNode(node) {
      if (!isRecord(node)) return undefined;
      if (node.kind === "assistant-step") {
        var data = node.data;
        var final = isRecord(data) ? data.finalNode : undefined;
        return isRecord(final) && typeof final.seq === "number" ? final.seq : undefined;
      }
      return typeof node.anchorSeq === "number" ? node.anchorSeq : undefined;
    }

    /** Whether the shipped action row already covers this node's branch point. */
    function hostCoversNode(tail, node, hostEnabled) {
      if (hostEnabled !== true || !isRecord(node) || node.kind !== "assistant-step") return false;
      var final = finalNodeOf(tail);
      var nodeFinal = isRecord(node.data) ? node.data.finalNode : undefined;
      if (final === null || !isRecord(nodeFinal)) return false;
      return final.messageId !== undefined && final.messageId === nodeFinal.messageId;
    }

    /** Every branchable node of one turn, in render order. */
    function targetsOfTurn(chat, turn) {
      if (typeof turn !== "number") return EMPTY_TARGETS;
      var tail = turnTailOf(chat, turn);
      var hostEnabled = hostBranchEnabled(chat, tail);
      var keys = nodeKeysOf(chat, turn);
      var targets = [];
      for (var index = 0; index < keys.length; index++) {
        var node = nodeOf(chat, keys[index]);
        if (!isRecord(node) || NODE_KINDS[node.kind] !== true) continue;
        if (node.visibility === "hidden") continue;
        var seq = branchSeqOfNode(node);
        if (typeof seq !== "number") continue;
        if (hostCoversNode(tail, node, hostEnabled)) continue;
        targets.push({ key: keys[index], kind: node.kind, seq: seq });
      }
      return targets.length === 0 ? EMPTY_TARGETS : targets;
    }

    /**
     * The shipped action row's branch button for `messageId`: visible only when
     * the host's own action is unavailable, so the row never holds two icons.
     */
    function rowStateOf(chat, messageId) {
      var record = turnForMessage(chat, messageId);
      if (record === null) return { visible: false, seq: undefined };
      var data = record.data;
      var tail = data !== undefined && data !== null && typeof data.get === "function" ? data.get("turn-tail") : null;
      if (hostBranchEnabled(chat, tail)) return { visible: false, seq: undefined };
      var final = finalNodeOf(tail);
      var seq = final !== null ? final.seq : isRecord(tail) ? tail.seq : undefined;
      if (typeof seq !== "number") return { visible: false, seq: undefined };
      return { visible: true, seq: seq };
    }

    // ------------------------------------------------------------------
    // fakes-free helpers
    // ------------------------------------------------------------------

    function messageOf(error) {
      if (error !== null && error !== undefined && typeof error.message === "string" && error.message !== "") return error.message;
      return String(error);
    }

    function fill(text, params) {
      var out = text;
      for (var name in params) {
        if (Object.prototype.hasOwnProperty.call(params, name)) out = out.split("{" + name + "}").join(String(params[name]));
      }
      return out;
    }

    function translate(t, key, params) {
      var text = t(key);
      return params === undefined ? text : fill(text, params);
    }

    function sameSeats(left, right) {
      if (left.size !== right.size) return false;
      var same = true;
      left.forEach(function (element, key) {
        if (right.get(key) !== element) same = false;
      });
      return same;
    }

    /**
     * The scrollport that owns the chat rows this occurrence belongs to. Scoping
     * the seat lookup keeps one Session rendered twice (main panel and a sidebar
     * chat tab) from attaching a control to the other occurrence's rows.
     */
    function scopeRootOf(from) {
      var element = from === null || from === undefined ? null : from.parentElement;
      var nearest = null;
      while (element !== null && element !== undefined) {
        if (element.querySelector(SEAT_SELECTOR) !== null) {
          if (nearest === null) nearest = element;
          var style = window.getComputedStyle(element);
          if (style.overflowY === "auto" || style.overflowY === "scroll") return element;
        }
        element = element.parentElement;
      }
      // A conversation whose rows live in the window scrollport still scopes to
      // the nearest ancestor that owns seats, never to the whole document.
      return nearest;
    }

    /**
     * Pick one live, visible render seat per wanted node key from the scope's
     * seat elements. Selection is one pass over the seats the scope already
     * rendered - never one selector per node, which would walk the conversation
     * once per branchable node on every chat snapshot.
     * @param elements - the scope's `[data-chat-node-key]` elements.
     * @param wanted - the node keys this occurrence can branch from.
     * @returns node key -> its rendered seat, in element order.
     */
    function selectSeats(elements, wanted) {
      var found = new Map();
      for (var index = 0; index < elements.length; index++) {
        var element = elements[index];
        if (element === null || element === undefined) continue;
        var key = element.getAttribute(SEAT_ATTR);
        if (typeof key !== "string" || !wanted.has(key) || found.has(key)) continue;
        if (element.hasAttribute("hidden")) continue;
        if (element.getClientRects().length === 0) continue;
        found.set(key, element);
      }
      return found;
    }

    // ------------------------------------------------------------------
    // shared action state
    // ------------------------------------------------------------------

    /** Run one fork and surface its pending/failed state on the control. */
    function useBranchAction(forkAt) {
      var store = useState({ kind: "idle", message: "" });
      var state = store[0];
      var setState = store[1];
      var aliveRef = useRef(true);
      var pendingRef = useRef(false);

      useEffect(function () {
        aliveRef.current = true;
        return function () {
          aliveRef.current = false;
        };
      }, []);

      var start = useCallback(function (seq) {
        if (pendingRef.current || typeof seq !== "number") return;
        pendingRef.current = true;
        setState({ kind: "busy", message: "" });
        forkAt(seq).then(function () {
          pendingRef.current = false;
          if (!aliveRef.current) return;
          setState({ kind: "idle", message: "" });
        }).catch(function (error) {
          pendingRef.current = false;
          var message = messageOf(error);
          try {
            console.error("[chat-branch] " + message);
          } catch {
            // Logging must never change the control state.
          }
          if (!aliveRef.current) return;
          setState({ kind: "error", message: message });
        });
      }, [forkAt]);

      return { state: state, start: start, busy: state.kind === "busy" };
    }

    function branchIcon(kind) {
      if (kind === "busy") {
        return createElement("svg", {
          viewBox: "0 0 16 16",
          width: 15,
          height: 15,
          className: "dsh-chat-branch-spin",
          "aria-hidden": true
        }, createElement("circle", {
          cx: 8,
          cy: 8,
          r: 6,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.6,
          strokeLinecap: "round",
          strokeDasharray: "26 12"
        }));
      }
      if (kind === "error") {
        return createElement("svg", { viewBox: "0 0 16 16", width: 15, height: 15, "aria-hidden": true },
          createElement("circle", { cx: 8, cy: 8, r: 6.2, fill: "none", stroke: "currentColor", strokeWidth: 1.4 }),
          createElement("path", { d: "M8 4.8v3.9", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" }),
          createElement("circle", { cx: 8, cy: 11.2, r: 0.9, fill: "currentColor" })
        );
      }
      return createElement(primitives.IconBranchOutlineRegular, null);
    }

    function buttonStateAttribute(kind) {
      return kind === "error" ? "error" : kind === "busy" ? "busy" : "idle";
    }

    // ------------------------------------------------------------------
    // contribution 1: the shipped action row of an uncovered turn
    // ------------------------------------------------------------------

    function BranchRowAction(props) {
      if (typeof props.useChat !== "function") return null;
      return createElement(BranchRowActionBody, props);
    }

    function BranchRowActionBody(props) {
      var chat = props.useChat(function (snapshot) {
        return snapshot;
      });
      var messageId = props.messageId;
      var state = useMemo(function () {
        return rowStateOf(chat, messageId);
      }, [chat, messageId]);
      var action = useBranchAction(props.forkAt);
      if (!state.visible) return null;
      var label = action.busy
        ? translate(props.t, "row.branching")
        : action.state.kind === "error"
          ? translate(props.t, "row.failed", { message: action.state.message })
          : translate(props.t, "row.branch");
      return createElement("button", {
        type: "button",
        className: ROW_CLASS,
        title: label,
        "aria-label": label,
        "data-state": buttonStateAttribute(action.state.kind),
        disabled: action.busy,
        onClick: function () {
          action.start(state.seq);
        }
      }, branchIcon(action.state.kind));
    }

    // ------------------------------------------------------------------
    // contribution 2: one hover control per branchable node of a turn
    // ------------------------------------------------------------------

    function NodeBranchButton(props) {
      var action = useBranchAction(props.forkAt);
      var label = action.busy
        ? translate(props.t, "node.branching")
        : action.state.kind === "error"
          ? translate(props.t, "node.failed", { message: action.state.message })
          : translate(props.t, "node." + props.kind);
      var button = createElement("button", {
        type: "button",
        className: SEAT_CLASS,
        title: label,
        "aria-label": label,
        "data-node-kind": props.kind,
        "data-state": buttonStateAttribute(action.state.kind),
        disabled: action.busy,
        onClick: function () {
          action.start(props.seq);
        }
      }, branchIcon(action.state.kind));
      return createElement(primitives.Tooltip, { label: label, side: "top", gap: 6 }, button);
    }

    function TurnNodeAnchors(props) {
      if (typeof props.useChat !== "function") return null;
      return createElement(TurnNodeAnchorsBody, props);
    }

    function TurnNodeAnchorsBody(props) {
      var chat = props.useChat(function (snapshot) {
        return snapshot;
      });
      var owner = props.turn;
      var turnNumber = owner !== null && owner !== undefined && typeof owner.turn === "number" ? owner.turn : undefined;
      // The signature keeps a streamed chunk from re-running the seat scan:
      // only a changed branchable node set (a new node, or a settled Assistant
      // step gaining its fork boundary) is worth another DOM pass.
      var plan = useMemo(function () {
        var list = turnNumber === undefined ? EMPTY_TARGETS : targetsOfTurn(chat, turnNumber);
        var wanted = new Set();
        var parts = [];
        for (var index = 0; index < list.length; index++) {
          wanted.add(list[index].key);
          parts.push(list[index].key + ":" + list[index].seq);
        }
        return { targets: list, wanted: wanted, signature: parts.join("|") };
      }, [chat, turnNumber]);
      var targets = plan.targets;

      var markerRef = useRef(null);
      var seatsRef = useRef(EMPTY_SEATS);
      var styledRef = useRef(new Set());
      var planRef = useRef(plan);
      planRef.current = plan;
      var seatsStore = useState(EMPTY_SEATS);
      var seats = seatsStore[0];
      var setSeats = seatsStore[1];

      var scan = useCallback(function () {
        var marker = markerRef.current;
        if (marker === null || marker === undefined) return;
        var scope = scopeRootOf(marker);
        if (scope === null) return;
        var next = selectSeats(scope.querySelectorAll(SEAT_SELECTOR), planRef.current.wanted);
        if (sameSeats(seatsRef.current, next)) return;
        seatsRef.current.forEach(function (element, key) {
          if (next.has(key)) return;
          if (styledRef.current.has(element)) {
            element.style.position = "";
            styledRef.current.delete(element);
          }
        });
        next.forEach(function (element) {
          if (styledRef.current.has(element)) return;
          if (window.getComputedStyle(element).position === "static") {
            element.style.position = "relative";
            styledRef.current.add(element);
          }
        });
        seatsRef.current = next;
        setSeats(next);
      }, [plan.signature]);

      useEffect(function () {
        scan();
      }, [scan]);

      useEffect(function () {
        var marker = markerRef.current;
        if (marker === null || marker === undefined) return undefined;
        var scope = scopeRootOf(marker);
        if (scope === null) return undefined;
        var frame = null;
        var observer = new MutationObserver(function () {
          if (frame !== null) return;
          frame = window.requestAnimationFrame(function () {
            frame = null;
            scan();
          });
        });
        observer.observe(scope, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
        return function () {
          if (frame !== null) window.cancelAnimationFrame(frame);
          observer.disconnect();
        };
      }, [scan]);

      useEffect(function () {
        return function () {
          seatsRef.current.forEach(function (element) {
            if (styledRef.current.has(element)) element.style.position = "";
          });
          styledRef.current.clear();
          seatsRef.current = EMPTY_SEATS;
        };
      }, []);

      var portals = [];
      seats.forEach(function (seat, key) {
        var target = null;
        for (var index = 0; index < targets.length; index++) {
          if (targets[index].key === key) target = targets[index];
        }
        if (target === null) return;
        portals.push(ReactDOM.createPortal(createElement(NodeBranchButton, {
          key: key,
          kind: target.kind,
          seq: target.seq,
          forkAt: props.forkAt,
          t: props.t
        }), seat, key));
      });

      return createElement(Fragment, null,
        createElement("span", { ref: markerRef, className: MARKER_CLASS, "aria-hidden": "true" }),
        portals
      );
    }

    // ------------------------------------------------------------------
    // plugin (client-side Cordis plugin)
    // ------------------------------------------------------------------

    var name = "chat-branch";
    var inject = ["slots", "locale", "sessions", "uiWorkspace"];

    function forkSession(ctx, sessionId, seq) {
      return ctx.sessions.fork({
        sessionId: sessionId,
        atSeq: seq,
        increaseTitle: true
      }).then(function (childId) {
        ctx.uiWorkspace.openSession(childId);
        return childId;
      });
    }

    function injectStyles() {
      if (typeof document === "undefined") return function () {};
      var existing = document.querySelector('style[data-plugin-css="' + MARKER_CSS_ID + '"]');
      if (existing !== null) return function () {};
      var style = document.createElement("style");
      style.dataset.plugin = "dsh-chat-branch";
      style.dataset.pluginCss = MARKER_CSS_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
      return function () {
        style.remove();
      };
    }

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "chat-branch: dictionaries");
      ctx.effect(injectStyles, "chat-branch: styles");

      ctx.slots.inject("conversation.chat.assistant-actions", function () {
        return ctx.slots.register({
          name: "conversation.chat.assistant-actions",
          id: "chat-branch-row",
          order: 30,
          locale: NS,
          inject: function (sessionId) {
            return {
              forkAt: function (seq) {
                return forkSession(ctx, sessionId, seq);
              }
            };
          }
        }, BranchRowAction);
      });

      ctx.slots.inject("conversation.chat.turnTail", function () {
        return ctx.slots.register({
          name: "conversation.chat.turnTail",
          id: "chat-branch-nodes",
          order: 40,
          locale: NS,
          inject: function (sessionId) {
            return {
              forkAt: function (seq) {
                return forkSession(ctx, sessionId, seq);
              }
            };
          }
        }, TurnNodeAnchors);
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    // Test seam for tools/chat-branch-client.test.mjs: the pure model reads and
    // the DOM helpers this bundle is built from. Nothing else reads it.
    exports.__internals = {
      NODE_KINDS: NODE_KINDS,
      turnTailOf: turnTailOf,
      turnForMessage: turnForMessage,
      hostBranchEnabled: hostBranchEnabled,
      branchSeqOfNode: branchSeqOfNode,
      targetsOfTurn: targetsOfTurn,
      rowStateOf: rowStateOf,
      sameSeats: sameSeats,
      selectSeats: selectSeats
    };
    return module.exports;
  }
});
