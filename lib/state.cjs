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
  prev: null,
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

/** Update state with new rate_limits from statusline JSON. Does NOT write -- caller writes. */
function updateFromStatusLine(input) {
  const state = readState();
  const fiveHour = input.rate_limits && input.rate_limits.five_hour;
  const sevenDay = input.rate_limits && input.rate_limits.seven_day;

  const prevResetsAt = state.rate_limits.five_hour && state.rate_limits.five_hour.resets_at;
  const newResetsAt = fiveHour && fiveHour.resets_at;
  const windowReset = prevResetsAt && newResetsAt && prevResetsAt !== newResetsAt;

  if (state.rate_limits.five_hour && state.rate_limits.five_hour.pct != null && !windowReset) {
    state.prev = {
      five_hour_pct: state.rate_limits.five_hour.pct,
      seven_day_pct: state.rate_limits.seven_day && state.rate_limits.seven_day.pct,
      ts: state.ts,
    };
  } else {
    state.prev = null;
  }

  const pct5h = fiveHour ? safePct(fiveHour.used_percentage) : null;
  const pct7d = sevenDay ? safePct(sevenDay.used_percentage) : null;

  state.rate_limits.five_hour = pct5h != null
    ? { pct: pct5h, resets_at: fiveHour.resets_at }
    : null;
  state.rate_limits.seven_day = pct7d != null
    ? { pct: pct7d, resets_at: sevenDay.resets_at }
    : null;

  if (state.prev && state.rate_limits.five_hour) {
    state.delta = {
      five_hour: Math.max(0, state.rate_limits.five_hour.pct - state.prev.five_hour_pct),
      seven_day: state.prev.seven_day_pct != null && state.rate_limits.seven_day
        ? Math.max(0, state.rate_limits.seven_day.pct - state.prev.seven_day_pct)
        : null,
    };
  } else {
    state.delta = null;
  }

  state.session_cost_usd = input.cost?.total_cost_usd ?? null;

  if (windowReset) {
    state.warned = { five_hour: null, seven_day: null };
  }

  state.ts = Date.now();
  return state;
}

module.exports = { readState, writeState, updateFromStatusLine };
