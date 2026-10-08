// dsh-prompt-polish client bundle - a one-click "polish this instruction"
// button in the composer's tool row (slot `conversation.input.right`, the
// compact controls before the submit action).
//
// The button reads the live draft through the standard `useInput` selector
// hook, asks this package's host half over POST /api/prompt-polish/optimize,
// and writes the reply back with `inputActions.setDraft` - but only while the
// draft revision captured at click time is still current.

window.__ModuleLoader__.load({
  id: "dsh-prompt-polish",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var createElement = React.createElement;
    var Fragment = React.Fragment;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    var ROUTE = "/api/prompt-polish/optimize";
    var NS = "prompt-polish";

    var zh = {
      "polish.title": "一键优化指令",
      "polish.running": "优化中…",
      "polish.done": "已优化",
      "polish.stale": "草稿已改动,未替换",
      "polish.emptyResult": "模型没有返回内容",
      "polish.failed": "优化失败:{message}"
    };

    var en = {
      "polish.title": "Polish this instruction",
      "polish.running": "Polishing…",
      "polish.done": "Polished",
      "polish.stale": "Draft changed; not replaced",
      "polish.emptyResult": "The model returned no text",
      "polish.failed": "Polish failed: {message}"
    };

    // ------------------------------------------------------------------
    // text
    // ------------------------------------------------------------------

    /** Dictionary lookup used only when the locale service is unavailable. */
    function fallbackTranslate() {
      var dict = en;
      try {
        var tag = String(navigator.language || "");
        if (tag.toLowerCase().indexOf("zh") === 0) dict = zh;
      } catch {
        dict = en;
      }
      return function (key, params) {
        var text = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
        if (params) {
          for (var name in params) {
            if (Object.prototype.hasOwnProperty.call(params, name)) {
              text = text.split("{" + name + "}").join(String(params[name]));
            }
          }
        }
        return text;
      };
    }

    function textOf(props) {
      return typeof props.t === "function" ? props.t : fallbackTranslate();
    }

    // ------------------------------------------------------------------
    // styles (theme tokens only, so light and dark both work)
    // ------------------------------------------------------------------

    var CSS = [
      ".dsh-prompt-polish-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-prompt-polish-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
      "@keyframes dsh-prompt-polish-spin{to{transform:rotate(360deg)}}",
      ".dsh-prompt-polish-spin{animation:dsh-prompt-polish-spin .9s linear infinite}"
    ].join("");

    // Mirrors the shipped tool-row control geometry
    // (InputBar .add / .standardControls in dsh-client-ui-conversation).
    var S = {
      root: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        minWidth: 0,
        flex: "0 1 auto"
      },
      status: {
        fontSize: "12px",
        lineHeight: "18px",
        color: "var(--dsw-alias-label-secondary)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: "220px"
      },
      statusError: {
        color: "var(--dsw-alias-state-error-primary)"
      },
      button: {
        boxSizing: "border-box",
        width: "28px",
        height: "28px",
        padding: 0,
        display: "grid",
        placeItems: "center",
        border: "none",
        borderRadius: "999px",
        background: "transparent",
        color: "var(--dsw-alias-label-secondary)",
        cursor: "pointer",
        flex: "none",
        transition: "background-color .1s, color .1s"
      },
      buttonBusy: { color: "var(--dsw-alias-brand-primary)", cursor: "default" },
      buttonDone: { color: "var(--dsw-alias-state-success-primary)" },
      buttonError: { color: "var(--dsw-alias-state-error-primary)" },
      buttonDisabled: { color: "var(--dsw-alias-state-idle-primary)", cursor: "default" }
    };

    function merged(base, extra) {
      var style = {};
      for (var key in base) if (Object.prototype.hasOwnProperty.call(base, key)) style[key] = base[key];
      for (var other in extra) if (Object.prototype.hasOwnProperty.call(extra, other)) style[other] = extra[other];
      return style;
    }

    // ------------------------------------------------------------------
    // icon
    // ------------------------------------------------------------------

    function icon(kind) {
      if (kind === "running") {
        return createElement("svg", {
          viewBox: "0 0 16 16",
          width: 16,
          height: 16,
          className: "dsh-prompt-polish-spin",
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
      if (kind === "done") {
        return createElement("svg", {
          viewBox: "0 0 16 16",
          width: 16,
          height: 16,
          "aria-hidden": true
        }, createElement("path", {
          d: "M3.5 8.5l3 3 6-7",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.8,
          strokeLinecap: "round",
          strokeLinejoin: "round"
        }));
      }
      if (kind === "error" || kind === "stale") {
        return createElement("svg", {
          viewBox: "0 0 16 16",
          width: 16,
          height: 16,
          "aria-hidden": true
        },
          createElement("circle", { cx: 8, cy: 8, r: 6.2, fill: "none", stroke: "currentColor", strokeWidth: 1.4 }),
          createElement("path", { d: "M8 4.8v3.9", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" }),
          createElement("circle", { cx: 8, cy: 11.2, r: 0.9, fill: "currentColor" })
        );
      }
      // Sparkle: polish.
      return createElement("svg", {
        viewBox: "0 0 16 16",
        width: 16,
        height: 16,
        "aria-hidden": true
      },
        createElement("path", {
          d: "M6.2 1.6l1.15 3.2 3.2 1.15-3.2 1.15L6.2 10.3 5.05 7.1 1.85 5.95 5.05 4.8z",
          fill: "currentColor"
        }),
        createElement("path", {
          d: "M11.6 8.6l.75 2.05 2.05.75-2.05.75-.75 2.05-.75-2.05-2.05-.75 2.05-.75z",
          fill: "currentColor",
          opacity: 0.75
        })
      );
    }

    // ------------------------------------------------------------------
    // component
    // ------------------------------------------------------------------

    /** Guard before any hook: without the composer's standard props there is nothing to read. */
    function PromptPolish(props) {
      if (typeof props.useInput !== "function" || props.inputActions === null || props.inputActions === undefined) return null;
      return createElement(PromptPolishBody, props);
    }

    function PromptPolishBody(props) {
      var useInput = props.useInput;
      var inputActions = props.inputActions;
      var t = textOf(props);

      // The selector may see an undefined snapshot before the Session binding
      // publishes its first value, so it never dereferences blindly.
      var field = function (name) {
        return function (state) {
          return state === undefined || state === null ? undefined : state[name];
        };
      };
      var draft = useInput(field("draft")) || "";
      var rev = useInput(field("draftRev"));
      var phase = useInput(field("phase"));

      var statusState = useState({ kind: "idle", message: "" });
      var status = statusState[0];
      var setStatus = statusState[1];

      // The revision at the moment of the click must still be current when the
      // reply lands, otherwise the user typed something we would overwrite.
      var revRef = useRef(rev);
      revRef.current = rev;
      var timerRef = useRef(null);

      useEffect(function () {
        return function () {
          if (timerRef.current !== null) clearTimeout(timerRef.current);
        };
      }, []);

      function flash(next, ms) {
        setStatus(next);
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(function () {
          timerRef.current = null;
          setStatus({ kind: "idle", message: "" });
        }, ms);
      }

      var running = status.kind === "running";
      var frozen = phase === "adjudicating" || phase === "submitting" || phase === "inert";
      var empty = draft.trim() === "";
      var disabled = running || frozen || empty;

      function keepFocus(event) {
        event.preventDefault();
      }

      function run() {
        var sent = draft;
        if (sent.trim() === "" || running || frozen) return;
        var startRev = revRef.current;
        setStatus({ kind: "running", message: t("polish.running") });

        fetch(ROUTE, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ text: sent })
        }).then(function (response) {
          return response.json().catch(function () { return null; }).then(function (data) {
            if (!response.ok || data === null || data.ok !== true) {
              var detail = data !== null && data !== undefined && data.error !== null && data.error !== undefined && typeof data.error.message === "string"
                ? data.error.message
                : "HTTP " + response.status;
              throw new Error(detail);
            }
            return typeof data.text === "string" ? data.text.trim() : "";
          });
        }).then(function (polished) {
          if (polished === "") throw new Error(t("polish.emptyResult"));
          if (revRef.current !== startRev) {
            flash({ kind: "stale", message: t("polish.stale") }, 4000);
            return;
          }
          inputActions.setDraft(polished);
          flash({ kind: "done", message: t("polish.done") }, 2000);
        }).catch(function (error) {
          var message = error !== null && error !== undefined && error.message ? error.message : String(error);
          try {
            console.error("[prompt-polish] " + message);
          } catch {
            // Logging must never change the button state.
          }
          flash({ kind: "error", message: t("polish.failed", { message: message }) }, 6000);
        });
      }

      var kind = status.kind === "error" || status.kind === "stale" ? "error" : status.kind;
      var buttonStyle = S.button;
      if (running) buttonStyle = merged(S.button, S.buttonBusy);
      else if (status.kind === "done") buttonStyle = merged(S.button, S.buttonDone);
      else if (kind === "error") buttonStyle = merged(S.button, S.buttonError);
      else if (disabled) buttonStyle = merged(S.button, S.buttonDisabled);

      var label = "";
      if (status.kind !== "idle") label = status.message;
      else if (frozen) label = "";
      var showStatus = label !== "";
      var statusStyle = kind === "error" ? merged(S.status, S.statusError) : S.status;

      var buttonTitle = t("polish.title");

      return createElement(Fragment, null,
        createElement("style", null, CSS),
        createElement("div", { style: S.root },
          showStatus ? createElement("span", { style: statusStyle, title: label }, label) : null,
          createElement("button", {
            type: "button",
            className: "dsh-prompt-polish-button",
            style: buttonStyle,
            title: buttonTitle,
            "aria-label": buttonTitle,
            disabled: disabled,
            onMouseDown: keepFocus,
            onClick: run
          }, icon(kind))
        )
      );
    }

    // ------------------------------------------------------------------
    // plugin (client-side Cordis plugin)
    // ------------------------------------------------------------------

    var name = "prompt-polish";
    var inject = ["slots", "locale"];

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "prompt-polish: dictionaries");

      ctx.slots.inject("conversation.input.right", function () {
        return ctx.slots.register({
          name: "conversation.input.right",
          id: "prompt-polish",
          order: 50,
          locale: NS
        }, PromptPolish);
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
