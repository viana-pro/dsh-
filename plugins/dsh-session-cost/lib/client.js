// dsh-session-cost client bundle.
//
// Adds "how much money has this task spent" to the DSH web GUI's bottom info
// bar — the row of stats pills the Conversation renders under the composer
// (`conversation.composer.dock`, shipped occupant `stats`).
//
// The money is ESTIMATED from the session's durable token accounting:
//   * `tokenUsage`     — provider-reported buckets for the whole session log
//                        (uncached input / cache read / cache write / output).
//   * `modelSelection` — the route (provider + model) the session last used.
// Both are whole-log session projections computed by the Host, so the figure
// covers the entire task, not just the part of the transcript the window holds.
//
// The pill is portalled INTO the shipped stats row, so it sits on the same line
// as the built-in "turns · tok/s" and "tokens · cache-hit" pills instead of
// becoming a second row. When that row does not exist (a fresh session with no
// token usage yet), the pill falls back to its own centred row.

window.__ModuleLoader__.load({
  id: "dsh-session-cost",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var ReactDOM = require("react-dom");
    var createElement = React.createElement;
    var Fragment = React.Fragment;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    // ------------------------------------------------------------------
    // pricing (CNY per 1,000,000 tokens)
    // ------------------------------------------------------------------
    //
    // Source: DeepSeek's published price list. Each entry is [offPeak, peak]:
    // DeepSeek bills off-peak at exactly half the peak rate, and peak hours are
    // Beijing time (UTC+8) Mon-Fri 09:00-12:00 and 14:00-18:00.
    //
    // reasoning tokens are already part of `outputTokens`, and DeepSeek bills
    // cache WRITES at the cache-miss rate (it reports no separate write price),
    // so `cacheWriteTokens` is folded into the miss bucket below.
    var PRICES = {
      "deepseek-flash": { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
      "deepseek-v4-pro": { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] }
    };

    // Retired ids still served by the same backing model at the same price.
    var ALIASES = {
      "deepseek-v4-flash": "deepseek-flash",
      "deepseek-v4-flash-vision-exp": "deepseek-flash",
      "deepseek-v4.1-flash": "deepseek-flash"
    };

    /** Price row for one model id, tolerating dated/aliased ids; null when unpriced. */
    function priceRow(model) {
      if (typeof model !== "string" || model === "") return null;
      var id = model.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(ALIASES, id)) id = ALIASES[id];
      if (Object.prototype.hasOwnProperty.call(PRICES, id)) return PRICES[id];
      // Prefix match: "deepseek-v4-pro-0813" rides the "deepseek-v4-pro" row.
      var best = null;
      for (var key in PRICES) {
        if (!Object.prototype.hasOwnProperty.call(PRICES, key)) continue;
        if (id.indexOf(key) === 0 && (best === null || key.length > best.length)) best = key;
      }
      return best === null ? null : PRICES[best];
    }

    /** Whether the current instant falls in a Beijing-time peak billing window. */
    function isPeakNow() {
      var beijing = new Date(Date.now() + 480 * 60000);
      var day = beijing.getUTCDay();
      if (day === 0 || day === 6) return false; // weekend is off-peak all day
      var minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
      return (minutes >= 540 && minutes < 720) || (minutes >= 840 && minutes < 1080);
    }

    function count(value) {
      var n = Number(value);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }

    /**
     * Price one session's token buckets against one model.
     * @returns a breakdown object, or null when nothing can be priced.
     */
    function estimate(usage, model) {
      var row = priceRow(model);
      if (row === null || !usage) return null;
      var peak = isPeakNow() ? 1 : 0;
      var hit = count(usage.cacheReadTokens);
      var miss = count(usage.uncachedInputTokens) + count(usage.cacheWriteTokens);
      var out = count(usage.outputTokens);
      if (hit + miss + out <= 0) return null;
      return {
        cost: (hit * row.hit[peak] + miss * row.miss[peak] + out * row.out[peak]) / 1e6,
        peak: peak === 1,
        row: row,
        hit: hit,
        miss: miss,
        out: out,
        model: model
      };
    }

    // ------------------------------------------------------------------
    // formatting
    // ------------------------------------------------------------------

    function formatCost(cost) {
      if (cost >= 1000) return cost.toFixed(0);
      if (cost >= 1) return cost.toFixed(2);
      if (cost >= 0.01) return cost.toFixed(3);
      if (cost > 0) return cost.toFixed(4);
      return "0";
    }

    function formatTokens(value) {
      if (value >= 1e9) return (value / 1e9).toFixed(2) + "B";
      if (value >= 1e6) return (value / 1e6).toFixed(2) + "M";
      if (value >= 1e3) return (value / 1e3).toFixed(1) + "k";
      return String(Math.round(value));
    }

    function tooltipOf(est, t) {
      var rate = est.peak ? 1 : 0;
      var per = " / " + t("cost.perMillion");
      var lines = [t("cost.tipTitle", { amount: "¥" + formatCost(est.cost) })];
      lines.push(t("cost.model") + ": " + est.model + " (" + (est.peak ? t("cost.peak") : t("cost.offPeak")) + ")");
      if (est.miss > 0) lines.push(t("cost.inputMiss") + ": " + formatTokens(est.miss) + " × ¥" + est.row.miss[rate] + per);
      if (est.hit > 0) lines.push(t("cost.inputHit") + ": " + formatTokens(est.hit) + " × ¥" + est.row.hit[rate] + per);
      if (est.out > 0) lines.push(t("cost.output") + ": " + formatTokens(est.out) + " × ¥" + est.row.out[rate] + per);
      lines.push(t("cost.note"));
      return lines.join("\n");
    }

    // ------------------------------------------------------------------
    // styles (theme tokens, so light/dark both work)
    // ------------------------------------------------------------------

    var S = {
      anchor: { display: "none" },
      // Mirrors the shipped stats pill geometry (StatsPills.module.css .pill).
      pill: {
        boxSizing: "border-box",
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        flex: "0 1 auto",
        minWidth: "0",
        maxWidth: "100%",
        padding: "1px 8px",
        borderRadius: "24px",
        color: "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor))",
        fontSize: "var(--dsh-content-font-size-secondary, 13px)",
        lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
        cursor: "default"
      },
      amount: {
        overflow: "hidden",
        textOverflow: "ellipsis"
      },
      glyph: {
        color: "var(--dsw-alias-state-business-primary, currentColor)",
        fontWeight: 600,
        fontSize: "12px",
        lineHeight: 1
      },
      // Fallback row mirrors the shipped stats row (StatsPills.module.css .root).
      row: {
        boxSizing: "border-box",
        display: "flex",
        justifyContent: "center",
        gap: "12px",
        width: "100%",
        maxWidth: "var(--dsh-chat-content-width)",
        margin: "0 auto",
        padding: "4px calc(var(--dsh-composer-side-clearance) + 16px) 0"
      }
    };

    // ------------------------------------------------------------------
    // portal target discovery
    // ------------------------------------------------------------------

    /**
     * Closest ancestor of `node` that holds exactly one shipped stats row — the
     * row this pill rides in. Walking up from our own anchor keeps each composer
     * (main conversation, sidebar chat) pricing only its own session.
     */
    function findStatsRow(node) {
      var el = node;
      while (el && el !== document.body && el !== document.documentElement) {
        var rows = el.querySelectorAll("[data-composer-stats]");
        if (rows.length === 1) return rows[0];
        if (rows.length > 1) return null;
        el = el.parentElement;
      }
      return null;
    }

    // ------------------------------------------------------------------
    // component
    // ------------------------------------------------------------------

    function CostPill(props) {
      // Guard before any hook: without the projection hook there is nothing to read.
      if (typeof props.useProjection !== "function") return null;
      return createElement(CostPillBody, props);
    }

    function CostPillBody(props) {
      var useProjection = props.useProjection;
      var t = typeof props.t === "function" ? props.t : function (key) { return String(key); };

      var usage = useProjection("tokenUsage");
      var selection = useProjection("modelSelection");
      var model = selection && selection.lastUsed ? selection.lastUsed.model
        : selection && selection.next ? selection.next.model
          : null;

      var anchorRef = useRef(null);
      var pillRef = useRef(null);

      var targetState = useState(null);
      var target = targetState[0];
      var setTarget = targetState[1];

      // The shipped stats row mounts and unmounts with the session's token
      // accounting; re-target it whenever the composer changes. A target whose
      // portal is no longer connected (the row was replaced) falls back to our
      // own row until the next sync finds the live one.
      useEffect(function () {
        function sync() {
          var node = anchorRef.current;
          var next = node ? findStatsRow(node) : null;
          var pillNode = pillRef.current;
          if (next !== null && pillNode !== null && !pillNode.isConnected) next = null;
          setTarget(function (prev) { return prev === next ? prev : next; });
        }
        sync();
        var timer = setInterval(sync, 400);
        return function () { clearInterval(timer); };
      }, []);

      // The row is React-owned and appends its own pills as they appear; keep
      // ours last so the money always reads as the row's final item.
      useEffect(function () {
        var node = pillRef.current;
        if (!node || !target) return;
        if (node.parentNode === target && target.lastElementChild !== node) target.appendChild(node);
      });

      var anchor = createElement("span", { ref: anchorRef, style: S.anchor });

      var est = estimate(usage, model);
      if (est === null) return anchor;

      var title = tooltipOf(est, t);
      var pill = createElement("span", {
        ref: pillRef,
        style: S.pill,
        title: title,
        "aria-label": title.replace(/\n/g, "，"),
        "data-session-cost": true
      },
        createElement("span", { style: S.glyph, "aria-hidden": true }, "¥"),
        createElement("span", { style: S.amount }, formatCost(est.cost))
      );

      if (target) return createElement(Fragment, null, anchor, ReactDOM.createPortal(pill, target));
      return createElement(Fragment, null, anchor, createElement("div", { style: S.row }, pill));
    }

    // ------------------------------------------------------------------
    // plugin (client-side Cordis plugin)
    // ------------------------------------------------------------------

    var NS = "session-cost";

    var zh = {
      "cost.tipTitle": "本次任务花费约 {amount}",
      "cost.model": "模型",
      "cost.peak": "高峰时段",
      "cost.offPeak": "空闲时段",
      "cost.inputMiss": "输入·缓存未命中",
      "cost.inputHit": "输入·缓存命中",
      "cost.output": "输出",
      "cost.perMillion": "百万 tokens",
      "cost.note": "按 DeepSeek 官方价目表与当前时段单价估算"
    };

    var en = {
      "cost.tipTitle": "This task has cost about {amount}",
      "cost.model": "Model",
      "cost.peak": "peak hours",
      "cost.offPeak": "off-peak hours",
      "cost.inputMiss": "Input (cache miss)",
      "cost.inputHit": "Input (cache hit)",
      "cost.output": "Output",
      "cost.perMillion": "1M tokens",
      "cost.note": "Estimated from DeepSeek's published price list at the current rate window"
    };

    var name = "session-cost";
    var inject = ["slots", "locale"];

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "session-cost: dictionaries");

      ctx.slots.inject("conversation.composer.dock", function () {
        return ctx.slots.register({
          name: "conversation.composer.dock",
          id: "session-cost",
          order: 10,
          locale: NS,
          inject: function () { return {}; }
        }, CostPill);
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
