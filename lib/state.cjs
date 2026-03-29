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
  warned: { five_hour: null, seven_day: null },
};

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw);
    if (state && state.v === 1) {
      if (!state.warned) state.warned = { five_hour: null, seven_day: null };
      if (!state.snapshots) state.snapshots = {};
      // Migrate old single snapshot to snapshots map
      if (state.snapshot && !state.snapshots._legacy) {
        state.snapshots._legacy = state.snapshot;
        delete state.snapshot;
      }
      return state;
    }
  } catch {}
  return JSON.parse(JSON.stringify(EMPTY_STATE));
}

function writeState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_TMP, JSON.stringify(state), 'utf-8');
    fs.renameSync(STATE_TMP, STATE_FILE);
  } catch (e) {
    process.stderr.write(`[cc-budget] cannot save state: ${e.code || e.message}\n`);
  }
}

function safePct(val) {
  return typeof val === 'number' && !isNaN(val) ? val : null;
}

/** Prune snapshots older than 6 hours (dead sessions). */
function pruneSnapshots(snapshots) {
  const cutoff = Date.now() - 6 * 3600 * 1000;
  for (const id of Object.keys(snapshots)) {
    if (snapshots[id].ts < cutoff) delete snapshots[id];
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
  }

  state.session_cost_usd = input.cost?.total_cost_usd ?? null;

  if (windowReset) {
    state.warned = { five_hour: null, seven_day: null };
    state.snapshots = {};
    state.delta = null;
  }

  pruneSnapshots(state.snapshots);
  state.ts = Date.now();
  return state;
}

module.exports = { readState, writeState, updateFromStatusLine };
