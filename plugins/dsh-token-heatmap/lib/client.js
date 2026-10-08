// dsh-token-heatmap client bundle — a floating GitHub-style contribution
// heatmap widget for token usage in the DSH web GUI (light theme).
//
// Registers a component into the global `shell.overlay` slot. A small toggle
// button in the bottom-right corner expands into a card that renders the
// daily token heatmap, fetched from this package's host half over
// /api/token-heatmap/data.

window.__ModuleLoader__.load({
  id: "dsh-token-heatmap",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var createElement = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;

    // ------------------------------------------------------------------
    // constants & helpers
    // ------------------------------------------------------------------

    var DATA_ROUTE = "/api/token-heatmap/data";
    var DAYS = 371; // ~53 weeks

    // Day-of-week labels shown on rows 1, 3, 5 (Mon / Wed / Fri), like GitHub.
    var DAY_LABELS = ["", "一", "", "三", "", "五", ""];
    var MONTH_NAMES = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

    // GitHub light-theme contribution palette (empty -> intense).
    var LEVELS = ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"];

    // Grid geometry (px).
    var CELL_SIZE = 11;
    var CELL_GAP_X = 3; // 1.5px each side
    var CELL_GAP_Y = 3; // bottom margin
    var CELL_PITCH_X = CELL_SIZE + CELL_GAP_X; // 14 = width of one week column
    var CELL_PITCH_Y = CELL_SIZE + CELL_GAP_Y; // 14 = height of one day row
    var DAY_COL_WIDTH = 28;
    var DAY_COL_GAP = 4;
    var GRID_LEFT = DAY_COL_WIDTH + DAY_COL_GAP; // 32 = weeks' left offset

    function pad(n) {
      return n < 10 ? "0" + n : "" + n;
    }

    function startOfDay(d) {
      return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    function addDays(d, n) {
      var x = new Date(d.getTime());
      x.setDate(x.getDate() + n);
      return x;
    }

    function keyOf(d) {
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    }

    function fmtNum(n) {
      n = Number(n) || 0;
      if (n >= 1000000000) return (n / 1000000000).toFixed(2).replace(/\.?0+$/, "") + "B";
      if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
      if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
      return String(Math.round(n));
    }

    var WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];
    function fmtDate(d) {
      return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日 周" + WEEKDAY_NAMES[d.getDay()];
    }

    function levelOf(tokens, max) {
      if (!tokens || tokens <= 0 || max <= 0) return 0;
      var ratio = tokens / max;
      if (ratio >= 0.75) return 4;
      if (ratio >= 0.5) return 3;
      if (ratio >= 0.25) return 2;
      return 1;
    }

    function coreTokens(b) {
      return b ? (Number(b.inputTokens) || 0) + (Number(b.outputTokens) || 0) : 0;
    }

    // ------------------------------------------------------------------
    // styles (light theme)
    // ------------------------------------------------------------------

    var S = {
      wrap: {
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 2147483000,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif"
      },
      toggle: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "8px 12px",
        borderRadius: "999px",
        background: "#ffffff",
        color: "#1f2328",
        border: "1px solid #d0d7de",
        boxShadow: "0 4px 12px rgba(140, 149, 159, 0.25)",
        cursor: "pointer",
        fontSize: "13px",
        fontWeight: 600,
        userSelect: "none",
        WebkitUserSelect: "none"
      },
      card: {
        width: "900px",
        maxWidth: "calc(100vw - 40px)",
        padding: "18px 20px",
        borderRadius: "12px",
        background: "#ffffff",
        color: "#1f2328",
        boxShadow: "0 12px 40px rgba(140, 149, 159, 0.3)",
        border: "1px solid #d0d7de"
      },
      header: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: "14px"
      },
      title: {
        fontSize: "15px",
        fontWeight: 700,
        color: "#1f2328"
      },
      close: {
        background: "transparent",
        border: "none",
        color: "#57606a",
        cursor: "pointer",
        fontSize: "16px",
        lineHeight: 1,
        padding: "4px",
        borderRadius: "6px"
      },
      stats: {
        display: "flex",
        flexWrap: "wrap",
        gap: "6px 24px",
        marginBottom: "16px",
        fontSize: "13px",
        color: "#57606a"
      },
      statValue: {
        color: "#1f2328",
        fontWeight: 700,
        marginLeft: "5px",
        fontVariantNumeric: "tabular-nums"
      },
      scroll: {
        overflowX: "auto",
        overflowY: "hidden",
        paddingBottom: "2px"
      },
      grid: {
        display: "inline-block",
        minWidth: "100%"
      },
      months: {
        position: "relative",
        height: "18px",
        marginLeft: GRID_LEFT + "px",
        marginBottom: "2px"
      },
      monthLabel: {
        position: "absolute",
        whiteSpace: "nowrap",
        fontSize: "10px",
        lineHeight: "14px",
        color: "#57606a"
      },
      body: {
        display: "flex",
        alignItems: "flex-start"
      },
      dayCol: {
        display: "flex",
        flexDirection: "column",
        width: DAY_COL_WIDTH + "px",
        flexShrink: 0,
        marginRight: DAY_COL_GAP + "px",
        fontSize: "10px",
        lineHeight: CELL_SIZE + "px",
        color: "#57606a"
      },
      dayCell: {
        height: CELL_PITCH_Y + "px",
        lineHeight: CELL_SIZE + "px",
        textAlign: "right",
        paddingRight: "4px"
      },
      weeks: {
        display: "flex",
        flexShrink: 0
      },
      week: {
        display: "flex",
        flexDirection: "column",
        width: CELL_PITCH_X + "px"
      },
      cell: {
        width: CELL_SIZE + "px",
        height: CELL_SIZE + "px",
        borderRadius: "2px",
        margin: "0 " + (CELL_GAP_X / 2) + "px " + CELL_GAP_Y + "px " + (CELL_GAP_X / 2) + "px"
      },
      legend: {
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: "4px",
        marginTop: "6px",
        fontSize: "11px",
        color: "#57606a"
      },
      legendCell: {
        width: CELL_SIZE + "px",
        height: CELL_SIZE + "px",
        borderRadius: "2px"
      },
      tooltip: {
        position: "fixed",
        zIndex: 2147483600,
        background: "rgba(31, 35, 40, 0.96)",
        color: "#ffffff",
        borderRadius: "6px",
        padding: "8px 11px",
        fontSize: "12px",
        lineHeight: 1.6,
        pointerEvents: "none",
        boxShadow: "0 6px 20px rgba(0, 0, 0, 0.28)",
        whiteSpace: "nowrap"
      },
      tipTitle: {
        fontWeight: 700,
        marginBottom: "3px",
        fontSize: "12px"
      },
      tipRow: {
        display: "flex",
        justifyContent: "space-between",
        gap: "16px"
      },
      tipLabel: {
        color: "#d0d7de"
      },
      tipValue: {
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums"
      },
      error: {
        fontSize: "13px",
        color: "#cf222e",
        padding: "10px 0"
      },
      loading: {
        fontSize: "13px",
        color: "#57606a",
        padding: "10px 0"
      }
    };

    // ------------------------------------------------------------------
    // heatmap body
    // ------------------------------------------------------------------

    function Heatmap(props) {
      var days = props.days || [];

      var map = {};
      var max = 0;
      for (var i = 0; i < days.length; i++) {
        var b = days[i];
        map[b.date] = b;
        var c = coreTokens(b);
        if (c > max) max = c;
      }

      var today = startOfDay(new Date());
      var windowStart = addDays(today, -(DAYS - 1));
      var gridStart = addDays(windowStart, -windowStart.getDay()); // Sunday on/before window start

      var dayCount = Math.round((today - gridStart) / 86400000) + 1;
      var weekCount = Math.ceil(dayCount / 7);

      // Build week columns and collect month-start positions.
      var weeks = [];
      var monthStarts = []; // { week, label }
      var lastMonth = -1;

      for (var w = 0; w < weekCount; w++) {
        var col = [];
        var firstInRange = null;
        for (var r = 0; r < 7; r++) {
          var date = addDays(gridStart, w * 7 + r);
          var key = keyOf(date);
          var inRange = date >= windowStart && date <= today;
          var bucket = map[key];
          col.push({ date: date, key: key, bucket: bucket, inRange: inRange, core: coreTokens(bucket) });
          if (inRange && firstInRange === null) firstInRange = date;
        }
        weeks.push(col);
        if (firstInRange !== null) {
          var m = firstInRange.getMonth();
          if (m !== lastMonth) {
            monthStarts.push({ week: w, label: MONTH_NAMES[m] });
            lastMonth = m;
          }
        }
      }

      // Month labels: absolutely positioned so text never pushes/overlaps cells.
      var monthLabelEls = [];
      for (var mi = 0; mi < monthStarts.length; mi++) {
        var item = monthStarts[mi];
        monthLabelEls.push(createElement("div", {
          key: "m" + mi,
          style: Object.assign({}, S.monthLabel, { left: (item.week * CELL_PITCH_X) + "px" })
        }, item.label));
      }

      // Hover tooltip state (date + token breakdown shown on mouse-over).
      var tipState = useState(null);
      var tip = tipState[0];
      var setTip = tipState[1];

      function showTip(e, cell) {
        if (!cell.inRange) return;
        var rect = e.currentTarget.getBoundingClientRect();
        var flip = rect.top < 96;
        setTip({
          left: rect.left + rect.width / 2,
          top: flip ? rect.bottom + 10 : rect.top - 10,
          place: flip ? "below" : "above",
          cell: cell
        });
      }
      function hideTip() {
        setTip(null);
      }

      // Week columns -> cells.
      var weekEls = [];
      for (var wc = 0; wc < weeks.length; wc++) {
        var cells = [];
        for (var rc = 0; rc < 7; rc++) {
          let cell = weeks[wc][rc];
          var bg = cell.inRange ? LEVELS[levelOf(cell.core, max)] : "transparent";
          cells.push(createElement("div", {
            key: rc,
            style: Object.assign({}, S.cell, { background: bg }),
            onMouseEnter: cell.inRange ? function (e) { showTip(e, cell); } : undefined,
            onMouseLeave: cell.inRange ? hideTip : undefined
          }));
        }
        weekEls.push(createElement("div", { key: "w" + wc, style: S.week }, cells));
      }

      // Day-of-week labels column.
      var dayEls = [];
      for (var d = 0; d < 7; d++) {
        dayEls.push(createElement("div", { key: "d" + d, style: S.dayCell }, DAY_LABELS[d] || ""));
      }

      // Tooltip element (fixed-positioned, so it escapes the scroll clip).
      var tooltipEl = null;
      if (tip) {
        var tipCell = tip.cell;
        var rows = [];
        var pushRow = function (label, value) {
          rows.push(createElement("div", { key: label, style: S.tipRow },
            createElement("span", { style: S.tipLabel }, label),
            createElement("span", { style: S.tipValue }, value)));
        };
        if (tipCell.core > 0) {
          pushRow("合计", fmtNum(tipCell.core));
          if (tipCell.bucket) {
            if (tipCell.bucket.inputTokens > 0) pushRow("输入", fmtNum(tipCell.bucket.inputTokens));
            if (tipCell.bucket.outputTokens > 0) pushRow("输出", fmtNum(tipCell.bucket.outputTokens));
            if (tipCell.bucket.cacheReadTokens > 0) pushRow("缓存读", fmtNum(tipCell.bucket.cacheReadTokens));
            if (tipCell.bucket.cacheWriteTokens > 0) pushRow("缓存写", fmtNum(tipCell.bucket.cacheWriteTokens));
            if (tipCell.bucket.reasoningTokens > 0) pushRow("推理", fmtNum(tipCell.bucket.reasoningTokens));
            if (tipCell.bucket.requests > 0) pushRow("请求", tipCell.bucket.requests + " 次");
          }
        } else {
          pushRow("用量", "无");
        }
        var transform = tip.place === "below" ? "translate(-50%, 0)" : "translate(-50%, -100%)";
        tooltipEl = createElement("div", {
          style: Object.assign({}, S.tooltip, { left: tip.left + "px", top: tip.top + "px", transform: transform })
        },
          createElement("div", { style: S.tipTitle }, fmtDate(tipCell.date)),
          rows
        );
      }

      return createElement(React.Fragment, null,
        createElement("div", { style: S.scroll },
          createElement("div", { style: S.grid },
            createElement("div", { style: S.months }, monthLabelEls),
            createElement("div", { style: S.body },
              createElement("div", { style: S.dayCol }, dayEls),
              createElement("div", { style: S.weeks }, weekEls)
            ),
            createElement("div", { style: S.legend },
              createElement("span", null, "少"),
              LEVELS.map(function (c) { return createElement("span", { key: c, style: Object.assign({}, S.legendCell, { background: c }) }); }),
              createElement("span", null, "多")
            )
          )
        ),
        tooltipEl
      );
    }

    // ------------------------------------------------------------------
    // widget (toggle button + panel)
    // ------------------------------------------------------------------

    function TokenHeatmapWidget() {
      var openState = useState(false);
      var open = openState[0];
      var setOpen = openState[1];

      var dataState = useState({ loading: true, error: null, days: [], total: null });
      var data = dataState[0];
      var setData = dataState[1];

      function load() {
        setData(function (d) {
          return { loading: true, error: null, days: d.days, total: d.total };
        });
        fetch(DATA_ROUTE + "?days=" + DAYS, { credentials: "same-origin" })
          .then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
          })
          .then(function (j) {
            setData({ loading: false, error: null, days: j.days || [], total: j.total || null });
          })
          .catch(function (e) {
            setData({ loading: false, error: String((e && e.message) || e), days: [], total: null });
          });
      }

      useEffect(function () {
        load();
        var t = setInterval(load, 30000);
        return function () { clearInterval(t); };
      }, []);

      var total = data.total;
      var todayKey = keyOf(startOfDay(new Date()));
      var todayBucket = null;
      for (var i = 0; i < data.days.length; i++) {
        if (data.days[i].date === todayKey) todayBucket = data.days[i];
      }
      var todayCore = coreTokens(todayBucket);

      if (!open) {
        return createElement("div", { style: S.wrap },
          createElement("button", {
            style: S.toggle,
            title: "Token 用量热力图",
            onClick: function () { setOpen(true); }
          },
            createElement("span", null, "🔥"),
            createElement("span", null, "今日 " + fmtNum(todayCore))
          )
        );
      }

      var body;
      if (data.loading && data.days.length === 0) {
        body = createElement("div", { style: S.loading }, "加载中…");
      } else if (data.error && data.days.length === 0) {
        body = createElement("div", { style: S.error }, "无法加载数据：" + data.error);
      } else {
        var last7 = data.days.slice(-7);
        var sum7 = 0;
        for (var j = 0; j < last7.length; j++) sum7 += coreTokens(last7[j]);
        var totalCore = total ? (Number(total.inputTokens) || 0) + (Number(total.outputTokens) || 0) : 0;

        body = createElement("div", null,
          createElement("div", { style: S.stats },
            createElement("span", null, "今日", createElement("span", { style: S.statValue }, fmtNum(todayCore))),
            createElement("span", null, "近 7 天", createElement("span", { style: S.statValue }, fmtNum(sum7))),
            createElement("span", null, "总计（输入+输出）", createElement("span", { style: S.statValue }, fmtNum(totalCore))),
            total ? createElement("span", null, "缓存读取", createElement("span", { style: S.statValue }, fmtNum(total.cacheReadTokens))) : null,
            total ? createElement("span", null, "请求数", createElement("span", { style: S.statValue }, fmtNum(total.requests))) : null
          ),
          createElement(Heatmap, { days: data.days })
        );
      }

      return createElement("div", { style: S.wrap },
        createElement("div", { style: S.card },
          createElement("div", { style: S.header },
            createElement("span", { style: S.title }, "🔥 Token 用量热力图"),
            createElement("button", { style: S.close, title: "收起", onClick: function () { setOpen(false); } }, "✕")
          ),
          body
        )
      );
    }

    // ------------------------------------------------------------------
    // plugin export (client-side Cordis plugin)
    // ------------------------------------------------------------------

    var name = "token-heatmap";
    var inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register({
          name: "shell.overlay",
          id: "dsh-token-heatmap-widget",
          order: 90,
          inject: function () { return {}; }
        }, TokenHeatmapWidget);
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
