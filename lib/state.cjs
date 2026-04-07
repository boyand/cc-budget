'use strict';

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(process.env.HOME, '.claude', 'cc-budget');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const STATE_TMP = path.join(STATE_DIR, 'state.json.tmp');

const EMPTY_STATE = {
  v: 1,
  ts: 0,
  rate_limits: { five_hour: null, seven_day: null },
  snapshots: {},  // keyed by session_id
  delta: null,
  session_cost_usd: null,
  is_peak: false,
  ledger: {},  // keyed by session_id: { cost, day, month }
  session_last_seen: {},  // per-session: last statusline timestamp (ms)
  delta_session_id: null,
};

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw);
    if (state && state.v === 1) {
      if (!state.snapshots) state.snapshots = {};
      if (!state.ledger) state.ledger = {};
      if (!state.session_last_seen) state.session_last_seen = {};
      // Migrate old single snapshot to snapshots map
      if (state.snapshot && !state.snapshots._legacy) {
        state.snapshots._legacy = state.snapshot;
        delete state.snapshot;
      }
      // Remove legacy warned field (now in separate file)
      delete state.warned;
      return state;
    }
  } catch {}
  return JSON.parse(JSON.stringify(EMPTY_STATE));
}

function writeState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // Use pid-based tmp file to avoid ENOENT when concurrent processes
    // rename the same shared tmp file
    const tmp = path.join(STATE_DIR, `state.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf-8');
    fs.renameSync(tmp, STATE_FILE);
  } catch {
    // Silent -- don't write to stderr as Claude Code treats it as hook error
  }
}

function safePct(val) {
  return typeof val === 'number' && !isNaN(val) ? val : null;
}

/** Prune snapshots older than 48 hours (likely abandoned sessions). */
function pruneSnapshots(snapshots) {
  const cutoff = Date.now() - 48 * 3600 * 1000;
  for (const id of Object.keys(snapshots)) {
    if (snapshots[id].ts < cutoff) delete snapshots[id];
  }
}

/** Prune session_last_seen entries older than 48 hours. */
function pruneSessionLastSeen(sls) {
  const cutoff = Date.now() - 3600 * 1000;  // 1 hour — well past the 5 min cache TTL
  for (const id of Object.keys(sls)) {
    if (sls[id] < cutoff) delete sls[id];
  }
}

/** Prune ledger entries older than 31 days. */
function pruneLedger(ledger) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 31);
  const cutoffDay = cutoff.toISOString().slice(0, 10);
  for (const id of Object.keys(ledger)) {
    if (ledger[id].day < cutoffDay) delete ledger[id];
  }
}

/** Update state with new rate_limits from statusline JSON. Does NOT write -- caller writes. */
function updateFromStatusLine(input) {
  const state = readState();
  const fiveHour = input.rate_limits && input.rate_limits.five_hour;
  const sevenDay = input.rate_limits && input.rate_limits.seven_day;

  const prevResetsAt = state.rate_limits.five_hour && state.rate_limits.five_hour.resets_at;
  const newResetsAt = fiveHour && fiveHour.resets_at;
  const windowReset = prevResetsAt && newResetsAt && prevResetsAt !== newResetsAt;

  const pct5h = fiveHour ? safePct(fiveHour.used_percentage) : null;
  const pct7d = sevenDay ? safePct(sevenDay.used_percentage) : null;

  state.rate_limits.five_hour = pct5h != null
    ? { pct: pct5h, resets_at: fiveHour.resets_at }
    : null;
  state.rate_limits.seven_day = pct7d != null
    ? { pct: pct7d, resets_at: sevenDay.resets_at }
    : null;

  // Delta: compare current usage against this session's pre-prompt snapshot
  const sessionId = input.session_id;
  const snap = sessionId && state.snapshots[sessionId];
  if (snap && state.rate_limits.five_hour && !windowReset) {
    const d5h = state.rate_limits.five_hour.pct - snap.five_hour_pct;
    const d7d = snap.seven_day_pct != null && state.rate_limits.seven_day
      ? state.rate_limits.seven_day.pct - snap.seven_day_pct
      : null;
    state.delta = {
      five_hour: Math.max(0, d5h),
      seven_day: d7d != null ? Math.max(0, d7d) : null,
    };
    state.delta_session_id = sessionId || null;
  } else {
    state.delta = null;
    state.delta_session_id = null;
  }

  // Cache freshness: Anthropic prompt cache TTL is ~5 min.
  // New session_id = no cache (cold). Same session_id idle >5 min = cache expired (cold).
  if (!state.session_last_seen) state.session_last_seen = {};
  const prevSeen = sessionId ? state.session_last_seen[sessionId] : null;
  let coldStart = false;
  if (sessionId && prevSeen) {
    coldStart = (Date.now() - prevSeen > 5 * 60 * 1000);
  } else if (sessionId && !prevSeen && state.ts > 0) {
    // New session_id but we've seen activity before — this is a fresh session, always cold
    coldStart = true;
  }
  if (sessionId) state.session_last_seen[sessionId] = Date.now();

  state.session_cost_usd = input.cost?.total_cost_usd ?? null;

  // Cost delta for enterprise/API users (no rate_limits)
  if (!state.rate_limits.five_hour && state.session_cost_usd != null && snap?.session_cost_usd != null) {
    const costDelta = state.session_cost_usd - snap.session_cost_usd;
    state.delta = { cost_usd: Math.max(0, costDelta) };
    state.delta_session_id = sessionId || null;
  }

  // Ledger: track per-session cost for daily/monthly totals
  if (!state.rate_limits.five_hour && state.session_cost_usd != null && sessionId) {
    if (!state.ledger) state.ledger = {};
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const entry = state.ledger[sessionId];
    if (!entry) {
      state.ledger[sessionId] = { cost: state.session_cost_usd, day: today, month };
    } else if (state.session_cost_usd > entry.cost) {
      state.ledger[sessionId].cost = state.session_cost_usd;
    }
    pruneLedger(state.ledger);
  }

  if (windowReset) {
    state.snapshots = {};
    state.delta = null;
    state.delta_session_id = null;
    state.session_last_seen = {};
    // Reset warned state (separate file) on window reset
    try {
      const warnedFile = path.join(STATE_DIR, 'warned.json');
      fs.writeFileSync(warnedFile, JSON.stringify({ five_hour: null, seven_day: null, expensive_delta: null }));
    } catch {}
  }

  pruneSnapshots(state.snapshots);
  pruneSessionLastSeen(state.session_last_seen);
  state.ts = Date.now();
  return { state, coldStart };
}

module.exports = { readState, writeState, updateFromStatusLine };
