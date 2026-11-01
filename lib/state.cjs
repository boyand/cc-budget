'use strict';

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(process.env.HOME, '.claude', 'cc-budget');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

const EMPTY_STATE = {
  v: 1,
  ts: 0,
  rate_limits: { five_hour: null, seven_day: null, spend_limit: null },
  // ponytail: state.json is last-writer-wins across sessions; losing an entry
  // needs two renders within ~10ms (stress-tested fine at 6 sessions, 14 ops/s).
  // Move sessions to per-session files like snap/ if that ever shows up.
  sessions: {},  // keyed by session_id: { cost, plan, model, delta, rl, ts }
  delta: null,
  session_cost_usd: null,
  is_peak: false,
  ledger: {},  // keyed by session_id: { cost, day, month }
  session_last_seen: {},  // per-session: last activity timestamp (ms), cold-cache fallback
};

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw);
    if (state && state.v === 1) {
      if (!state.ledger) state.ledger = {};
      if (!state.session_last_seen) state.session_last_seen = {};
      if (!state.rate_limits) state.rate_limits = { five_hour: null, seven_day: null, spend_limit: null };
      // 1.2 fields: per-prompt snapshots moved to snap/<sid>.json, per-session
      // delta into sessions.
      delete state.snapshot;
      delete state.snapshots;
      delete state.delta_session_id;
      delete state.cost_seen;
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

function win(w, pctKey = 'used_percentage') {
  const pct = w ? safePct(w[pctKey]) : null;
  return pct != null ? live({ pct, resets_at: w.resets_at }) : null;
}

function live(w) {
  return w && (!w.resets_at || w.resets_at * 1000 > Date.now()) ? w : null;
}

function localDay(d = new Date()) {
  return d.toLocaleDateString('en-CA');  // YYYY-MM-DD in local time
}

// Per-prompt snapshots live in one file per session: the hook writes them,
// the status line reads them, and neither can clobber the other's state.json
// write (several sessions render every 30s with refreshInterval).
const SNAP_DIR = path.join(STATE_DIR, 'snap');
const snapFile = (sid) => path.join(SNAP_DIR, `${String(sid).replace(/[^\w-]/g, '_')}.json`);

function readSnap(sid) {
  try { return JSON.parse(fs.readFileSync(snapFile(sid), 'utf-8')); } catch { return null; }
}

function writeSnap(sid, snap) {
  try {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    const tmp = path.join(SNAP_DIR, `.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(snap), 'utf-8');
    fs.renameSync(tmp, snapFile(sid));
  } catch {}
}

function pruneSnaps() {
  try {
    const cutoff = Date.now() - 48 * 3600 * 1000;
    for (const f of fs.readdirSync(SNAP_DIR)) {
      const p = path.join(SNAP_DIR, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch {}
}

/** prompt_cache arrived in 2.1.251; before that, "no response yet" = $0 spent. */
function hasPromptCacheField(version) {
  const [a, b, c] = String(version || '0').split('.').map(Number);
  return a > 2 || (a === 2 && (b > 1 || (b === 1 && c >= 251)));
}

/**
 * Learn how many notional dollars (cost.total_cost_usd, API list price) move
 * the weekly window by 1%. used_percentage is an integer, so a single prompt
 * almost always reads +0; dividing its $ delta by this ratio gives +0.4.
 * Anchors are only trusted once taken on the render where pct ticks over, so
 * both ends of a sample sit near integer boundaries.
 * ponytail: only counts subscriber spend from sessions on this machine. Usage
 * on other devices / claude.ai makes the ratio low and per-prompt % high; a
 * server-side fractional utilization would replace this.
 */
function updateCalibration(state, sd) {
  const c = state.calib || (state.calib = { usd_per_pct: null, anchor: null });
  const a = c.anchor;
  const fresh = (aligned) => ({ pct: sd.pct, cost: state.cost_total, at: sd.resets_at, aligned });
  if (!a || a.at !== sd.resets_at || sd.pct < a.pct) { c.anchor = fresh(false); return; }
  if (sd.pct === a.pct) return;
  if (!a.aligned) { c.anchor = fresh(true); return; }
  if (sd.pct - a.pct < 2) return;
  const sample = (state.cost_total - a.cost) / (sd.pct - a.pct);
  if (sample > 0) c.usd_per_pct = c.usd_per_pct ? c.usd_per_pct * 0.7 + sample * 0.3 : sample;
  c.anchor = fresh(true);
}

/** Update state from status line JSON. Does NOT write -- caller writes. */
function updateFromStatusLine(input) {
  const state = readState();
  const now = Date.now();
  const sid = input.session_id || null;
  const cost = input.cost?.total_cost_usd ?? null;
  const rl = input.rate_limits;
  if (!state.sessions) state.sessions = {};
  const sess = sid ? (state.sessions[sid] || (state.sessions[sid] = {})) : {};

  // Account windows. rate_limits present: take it wholesale (absent windows,
  // like 5h on Ultra, are gone). Absent: keep what's known until it expires.
  if (rl) {
    sess.rl = true;
    const sl = rl.spend_limit;
    state.rate_limits = {
      five_hour: win(rl.five_hour),
      seven_day: win(rl.seven_day),
      spend_limit: sl && safePct(sl.used_percentage) != null ? live({
        pct: sl.used_percentage,
        resets_at: sl.resets_at,
        used_usd: sl.used_usd ?? null,
        limit_usd: sl.limit_usd ?? null,
        period: sl.period ?? null,
      }) : null,
    };
    // model_scoped is absent when CC only had cached/header data; keep the
    // last known answer then. [] means the server listed none.
    if (Array.isArray(rl.model_scoped)) {
      state.model_scoped = rl.model_scoped
        .filter(m => m && typeof m.utilization === 'number')
        .map(m => ({
          name: m.display_name || 'model',
          pct: m.utilization,
          resets_at: m.resets_at ? Math.floor(Date.parse(m.resets_at) / 1000) || null : null,
        }));
    }
  } else {
    state.rate_limits = {
      five_hour: live(state.rate_limits.five_hour),
      seven_day: live(state.rate_limits.seven_day),
      spend_limit: live(state.rate_limits.spend_limit),
    };
  }
  if (Array.isArray(state.model_scoped)) state.model_scoped = state.model_scoped.filter(m => live(m));

  // This session's plan. Without rate_limits, borrow the account windows only
  // for a session that has had them before or hasn't had a response yet; a
  // session past its first response with none is on an API key.
  const { five_hour: kf, seven_day: ks, spend_limit: kl } = state.rate_limits;
  const preResponse = hasPromptCacheField(input.version) ? !input.prompt_cache : !(cost > 0);
  const borrow = !!rl || !!sess.rl || preResponse;
  const plan = borrow && (kf || ks) ? 'sub' : borrow && kl ? 'gateway' : cost != null ? 'api' : null;
  state.plan = plan;
  sess.plan = plan;
  const fh = plan === 'sub' ? kf : null;
  const sd = plan === 'sub' ? ks : null;

  // Spend counter for calibration: only subscriber spend moves the weekly %.
  if (typeof state.cost_total !== 'number') state.cost_total = 0;
  const active = cost != null && cost !== sess.cost;
  if (cost != null) {
    if (plan === 'sub' && sess.cost != null && cost > sess.cost) state.cost_total += cost - sess.cost;
    sess.cost = cost;
  }
  sess.ts = now;
  if (sd) updateCalibration(state, sd);

  // Daily allowance for the weekly window: fixed at the first render of the day.
  if (sd) {
    const today = localDay();
    const d = state.day;
    if (!d || d.date !== today || d.at !== sd.resets_at || sd.pct < d.start_pct) {
      const daysLeft = Math.max(1, (sd.resets_at * 1000 - now) / 86400000);
      state.day = { date: today, at: sd.resets_at, start_pct: sd.pct, allowance: Math.max(0, 100 - sd.pct) / daysLeft };
    }
  }

  // Per-prompt delta against the snapshot the hook took at prompt submit.
  // Window deltas only count within the same window.
  const snap = sid ? readSnap(sid) : null;
  const delta = {};
  if (snap) {
    if (cost != null && snap.cost != null) delta.cost_usd = Math.max(0, cost - snap.cost);
    if (fh && snap.five_hour_pct != null && snap.five_hour_at === fh.resets_at) {
      delta.five_hour = Math.max(0, fh.pct - snap.five_hour_pct);
    }
    if (sd && snap.seven_day_pct != null && snap.seven_day_at === sd.resets_at) {
      const usdPerPct = state.calib?.usd_per_pct;
      if (usdPerPct && delta.cost_usd != null) {
        delta.seven_day = delta.cost_usd / usdPerPct;
        delta.seven_day_est = true;
      } else {
        delta.seven_day = Math.max(0, sd.pct - snap.seven_day_pct);
      }
    }
  }
  state.delta = Object.keys(delta).length ? delta : null;
  sess.delta = state.delta;

  // Cold cache. Prefer CC's own prompt_cache (2.1.251+). Fallback: idle time
  // since this session's cost last changed (refresh renders don't count),
  // against the old 5-minute cache TTL.
  if (!state.session_last_seen) state.session_last_seen = {};
  const pc = input.prompt_cache;
  let coldStart = false;
  state.cache = null;
  if (pc && typeof pc === 'object') {
    const missThisPrompt = pc.last_miss_at && snap && pc.last_miss_at >= Math.floor(snap.ts / 1000);
    coldStart = !!(pc.caching_observed && (pc.requests === 1 || missThisPrompt));
    if (pc.caching_observed && pc.expires_at) {
      state.cache = {
        expires_at: pc.expires_at,
        cold: pc.expires_at * 1000 <= now,
        recache_tokens: pc.recache_tokens_if_cold ?? null,
      };
    }
  } else if (sid) {
    const prevSeen = state.session_last_seen[sid];
    if (prevSeen) coldStart = now - prevSeen > 5 * 60 * 1000;
    else if (state.ts > 0) coldStart = true;
    if (active || !prevSeen) state.session_last_seen[sid] = now;
  }

  state.session_cost_usd = cost;
  state.model = sess.model = input.model?.id ?? null;
  state.effort = input.effort?.level ?? null;
  state.fast_mode = input.fast_mode === true;

  // $ ledger only for plans billed in dollars; subscriber spend is notional.
  if (!state.ledger) state.ledger = {};
  if (plan === 'sub') {
    if (sid) delete state.ledger[sid];
  } else if (cost != null && sid) {
    const today = new Date().toISOString().slice(0, 10);
    const entry = state.ledger[sid];
    if (!entry) {
      state.ledger[sid] = { cost, day: today, month: today.slice(0, 7) };
    } else if (cost > entry.cost) {
      entry.cost = cost;
    }
  }
  pruneLedger(state.ledger);

  pruneSessionLastSeen(state.session_last_seen);
  for (const id of Object.keys(state.sessions)) {
    if (!(state.sessions[id].ts > now - 7 * 86400000)) delete state.sessions[id];
  }
  state.ts = now;
  return { state, coldStart };
}

module.exports = { readState, writeState, updateFromStatusLine, localDay, readSnap, writeSnap, pruneSnaps };
