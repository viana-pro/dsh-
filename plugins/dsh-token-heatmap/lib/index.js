// Host half of dsh-token-heatmap.
//
// This plugin aggregates provider-reported token usage into a per-day map
// (the data behind a GitHub-style contribution heatmap) and persists it to a
// JSON file under $DSH_HOME/storages. It exposes the map to the browser half
// (./client.js) over a small authenticated `/api` fetch route.
//
// It deliberately imports only Node built-ins (no @deepseek-ai/* packages) so
// the package can be dropped into the profile's node_modules without pnpm
// resolving private packages — the same contract the dsh-pomodoro example uses.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const name = "token-heatmap";
// Hard service dependencies (Cordis service keys, not npm packages).
const inject = ["connection", "sessions"];

const ROUTE_PATH = "/api/token-heatmap/data";
const DATA_VERSION = 1;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function dataPath() {
  const home = process.env.DSH_HOME || homedir();
  return join(home, "storages", "token-heatmap.json");
}

/** Local-date key (YYYY-MM-DD) for a timestamp, matching what the browser shows. */
function dayKey(timeMs) {
  const d = new Date(timeMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function emptyBucket(date) {
  return {
    date,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    requests: 0
  };
}

function normalizeBucket(raw) {
  const b = emptyBucket(String(raw?.date ?? ""));
  if (!raw || typeof raw !== "object") return b;
  b.inputTokens = Number(raw.inputTokens) || 0;
  b.outputTokens = Number(raw.outputTokens) || 0;
  b.cacheReadTokens = Number(raw.cacheReadTokens) || 0;
  b.cacheWriteTokens = Number(raw.cacheWriteTokens) || 0;
  b.reasoningTokens = Number(raw.reasoningTokens) || 0;
  b.requests = Number(raw.requests) || 0;
  return b;
}

/**
 * Extract the durable TokenUsage record from one session event.
 * - `assistant/message` carries the authoritative `data.usage` when reported.
 * - `assistant/attempt` embeds a `usage` stream chunk for a partial attempt.
 */
function usageOf(event) {
  if (!event || typeof event !== "object") return undefined;
  if (event.type === "assistant/message" && event.data && event.data.usage) {
    return event.data.usage;
  }
  if (event.type === "assistant/attempt" && event.data && Array.isArray(event.data.stream)) {
    for (let i = event.data.stream.length - 1; i >= 0; i--) {
      const rec = event.data.stream[i];
      if (rec && rec.type === "chunk" && rec.chunk && rec.chunk.type === "usage" && rec.chunk.usage) {
        return rec.chunk.usage;
      }
    }
  }
  return undefined;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

function apply(ctx) {
  const state = {
    days: new Map(), // date string -> bucket
    seen: new Map(), // session id string -> last folded seq number
    saveTimer: null
  };

  // Load previously persisted buckets.
  try {
    const p = dataPath();
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      if (raw && Array.isArray(raw.days)) {
        for (const item of raw.days) {
          const b = normalizeBucket(item);
          if (b.date) state.days.set(b.date, b);
        }
      }
    }
  } catch (error) {
    // First run, or a corrupt file: start empty. Logging is best-effort.
    try { ctx.logger?.warn?.(`token-heatmap: failed to load state: ${String(error)}`); } catch {}
  }

  function persist() {
    try {
      const p = dataPath();
      mkdirSync(dirname(p), { recursive: true });
      const days = [...state.days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
      writeFileSync(p, JSON.stringify({ version: DATA_VERSION, updatedAt: Date.now(), days }), "utf8");
    } catch (error) {
      try { ctx.logger?.warn?.(`token-heatmap: failed to persist state: ${String(error)}`); } catch {}
    }
  }

  function schedulePersist() {
    if (state.saveTimer) return;
    state.saveTimer = setTimeout(() => {
      state.saveTimer = null;
      persist();
    }, 500);
  }

  function addUsage(date, usage) {
    let b = state.days.get(date);
    if (!b) {
      b = emptyBucket(date);
      state.days.set(date, b);
    }
    b.inputTokens += num(usage.inputTokens);
    b.outputTokens += num(usage.outputTokens);
    b.cacheReadTokens += num(usage.cacheReadTokens);
    b.cacheWriteTokens += num(usage.cacheWriteTokens);
    b.reasoningTokens += num(usage.reasoningTokens);
    b.requests += 1;
    schedulePersist();
  }

  function foldEvent(sessionId, event) {
    const usage = usageOf(event);
    if (!usage) return;
    const seq = Number(event.seq);
    const last = state.seen.get(sessionId);
    if (last !== undefined && seq <= last) return; // already folded (replay + live dedup)
    addUsage(dayKey(Number(event.time)), usage);
    if (last === undefined || seq > last) state.seen.set(sessionId, seq);
  }

  function replaySession(session) {
    if (!session || typeof session.ownEvents !== "function") return;
    const id = String(session.id);
    const last = state.seen.get(id);
    let events;
    try {
      events = session.ownEvents();
    } catch {
      return;
    }
    let maxSeq = last;
    for (const event of events) {
      const seq = Number(event.seq);
      if (last !== undefined && seq <= last) continue;
      const usage = usageOf(event);
      if (usage) addUsage(dayKey(Number(event.time)), usage);
      if (maxSeq === undefined || seq > maxSeq) maxSeq = seq;
    }
    state.seen.set(id, maxSeq === undefined ? last : maxSeq);
  }

  // Seed from sessions that are already live when this plugin loads.
  if (ctx.sessions && typeof ctx.sessions.list === "function") {
    for (const session of ctx.sessions.list()) replaySession(session);
  }

  // Live append feed for every session.
  ctx.on("session/event", (session, event) => {
    foldEvent(String(session?.id), event);
  });

  // New / resumed sessions: replay their history once.
  ctx.on("session/created", (session) => {
    replaySession(session);
  });

  // Drop bookkeeping when a session leaves the registry.
  ctx.on("session/disposed", (session) => {
    state.seen.delete(String(session?.id));
  });

  // Expose the daily map to the browser half over the authenticated /api fence.
  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE_PATH,
    methods: ["GET", "HEAD"],
    requestBody: "buffered",
    fetch: (request) => {
      const url = new URL(request.url);
      const daysParam = Number(url.searchParams.get("days"));
      const limit = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 2000) : 371;
      const list = [...state.days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
      const days = list.slice(-limit); // most recent `limit` days
      const total = list.reduce(
        (acc, b) => ({
          inputTokens: acc.inputTokens + b.inputTokens,
          outputTokens: acc.outputTokens + b.outputTokens,
          cacheReadTokens: acc.cacheReadTokens + b.cacheReadTokens,
          cacheWriteTokens: acc.cacheWriteTokens + b.cacheWriteTokens,
          reasoningTokens: acc.reasoningTokens + b.reasoningTokens,
          requests: acc.requests + b.requests
        }),
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, requests: 0 }
      );
      return Response.json({ version: DATA_VERSION, days, total });
    }
  }), "token-heatmap: data route");

  // Safety-net persistence on a timer and on unload.
  const flushTimer = setInterval(persist, 30000);
  ctx.effect(() => () => {
    clearInterval(flushTimer);
    if (state.saveTimer) clearTimeout(state.saveTimer);
    persist();
  });
}

export { name, inject, apply };
