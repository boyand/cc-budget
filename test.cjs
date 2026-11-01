// Run: node --test test.cjs
// End-to-end: runs statusline.cjs / hook.cjs as Claude Code would, against a
// throwaway HOME, plus unit checks for the projection/format math.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const now = () => Math.floor(Date.now() / 1000);
// Fixed base for window resets_at: recomputing per call drifts a second and
// looks like a new window.
const T0 = now();
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-'));
  fs.mkdirSync(path.join(h, '.claude', 'cc-budget'), { recursive: true });
  return h;
}
function run(h, script, input, args = []) {
  const r = spawnSync('node', [path.join(ROOT, script), ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { ...process.env, HOME: h, XDG_CONFIG_HOME: path.join(h, '.config') },
    encoding: 'utf-8',
  });
  assert.equal(r.stderr, '', `${script} wrote to stderr`);
  return r.stdout;
}
const line = (h, input, args) => strip(run(h, 'statusline.cjs', input, args));
const hook = (h, sid = 's1') => {
  const out = run(h, 'hook.cjs', { hook_event_name: 'UserPromptSubmit', session_id: sid });
  return out ? JSON.parse(out).hookSpecificOutput.additionalContext : '';
};
const stateOf = (h) => JSON.parse(fs.readFileSync(path.join(h, '.claude', 'cc-budget', 'state.json'), 'utf-8'));
const patchState = (h, fn) => {
  const s = stateOf(h); fn(s);
  fs.writeFileSync(path.join(h, '.claude', 'cc-budget', 'state.json'), JSON.stringify(s));
};

// Shape of a real 2.1.316 payload on a verified Ultra account (2026-11-01).
function ultra(over = {}) {
  return {
    session_id: 's1',
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    version: '2.1.316',
    effort: { level: 'high' },
    cost: { total_cost_usd: 209.64 },
    fast_mode: false,
    prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: now() + 3000, requests: 529, misses: 3, last_miss_at: now() - 4000, recache_tokens_if_cold: 152679 },
    rate_limits: { seven_day: { used_percentage: 69, resets_at: T0 + 3.4 * 86400 } },
    ...over,
  };
}
const max = (p5, p7, over = {}) => ultra({
  rate_limits: { five_hour: { used_percentage: p5, resets_at: T0 + 2 * 3600 }, seven_day: { used_percentage: p7, resets_at: T0 + 3 * 86400 } },
  ...over,
});

// --- plan detection -------------------------------------------------------

test('Ultra (no five_hour): weekly bar, never dollars, no ledger', () => {
  const h = home();
  const out = line(h, ultra());
  assert.match(out, /^7d .* 69% /);
  assert.doesNotMatch(out, /\$/);
  assert.match(out, /today 0\/\d+%/);
  const s = stateOf(h);
  assert.equal(s.plan, 'sub');
  assert.deepEqual(s.ledger, {});
});

test('Pro/Max: 5h stays primary; 7d hidden under 50%', () => {
  const h = home();
  const out = line(h, max(40, 30));
  assert.match(out, /^5h .* 40% /);
  assert.doesNotMatch(out, /7d/);
});

test('Max with weekly over 50%: 7d section plus today', () => {
  const out = line(home(), max(40, 60));
  assert.match(out, /│ 7d .* 60%/);
  assert.match(out, /today 0\/\d+%/);
});

test('before first response (no rate_limits): reuses last known windows', () => {
  const h = home();
  line(h, ultra());
  const out = line(h, ultra({ session_id: 's2', rate_limits: undefined, prompt_cache: undefined, cost: { total_cost_usd: 0 } }));
  assert.match(out, /^7d .* 69%/);
  assert.deepEqual(stateOf(h).ledger, {});
});

test('expired windows are dropped when CC sends none', () => {
  const h = home();
  line(h, ultra());
  patchState(h, s => { s.rate_limits.seven_day.resets_at = now() - 10; });
  const out = line(h, ultra({ rate_limits: undefined }));
  assert.match(out, /^\$209\.64/);
});

test('API key (no rate_limits ever): dollar mode with ledger', () => {
  const h = home();
  const out = line(h, ultra({ rate_limits: undefined, cost: { total_cost_usd: 1.5 } }));
  assert.match(out, /^\$1\.50 │ \$1\.50 today/);
  assert.equal(stateOf(h).plan, 'api');
});

test('gateway spend_limit: spend bar with dollars and period', () => {
  const h = home();
  const out = line(h, ultra({ cost: { total_cost_usd: 3.1 }, rate_limits: { spend_limit: { used_percentage: 54, resets_at: now() + 12 * 86400, used_usd: 271.4, limit_usd: 500, period: 'monthly' } } }));
  assert.match(out, /spend .* 54% \$271\/\$500 mo/);
  assert.equal(stateOf(h).plan, 'gateway');
  assert.doesNotMatch(out, /Nov|Dec|Jan/, 'month total hidden when gateway limit shown');
});

// --- per-prompt delta -----------------------------------------------------

test('weekly delta: calibrated $ → % gives decimals', () => {
  const h = home();
  const at = now() + 3 * 86400;
  const p = (cost, pct) => ultra({ cost: { total_cost_usd: cost }, rate_limits: { seven_day: { used_percentage: pct, resets_at: at } } });
  line(h, p(100, 10));                 // first anchor: not on a tick, untrusted
  line(h, p(103, 11));                 // tick: aligned anchor at $103
  line(h, p(123, 13));                 // 2 steps over $20 → $10 per 1%
  assert.equal(Math.round(stateOf(h).calib.usd_per_pct), 10);
  hook(h);                             // prompt submitted at $123
  const out = line(h, p(127, 13));     // $4 → 0.4%
  assert.match(out, /\(\+0\.4\)/);
});

test('weekly delta: raw integer fallback before calibration', () => {
  const h = home();
  const at = now() + 3 * 86400;
  line(h, ultra({ rate_limits: { seven_day: { used_percentage: 20, resets_at: at } } }));
  hook(h);
  const out = line(h, ultra({ rate_limits: { seven_day: { used_percentage: 21, resets_at: at } } }));
  assert.match(out, /21% \(\+1\.0/);
});

test('5h delta; not carried across a 5h window reset', () => {
  const h = home();
  line(h, max(40, 30));
  hook(h);
  assert.match(line(h, max(43, 30)), /43% \(\+3\.0/);
  const reset = max(2, 30);
  reset.rate_limits.five_hour.resets_at = T0 + 5 * 3600;
  assert.equal(stateOf(h).sessions.s1.delta.five_hour, 3);
  line(h, reset);
  assert.equal(stateOf(h).sessions.s1.delta.five_hour, undefined);
});

// --- hook warnings --------------------------------------------------------

test('hook: Ultra weekly warning fires once, re-arms next window', () => {
  const h = home();
  const at = now() + 1.5 * 86400;
  line(h, ultra({ rate_limits: { seven_day: { used_percentage: 85, resets_at: at } } }));
  assert.match(hook(h), /Weekly usage at 85%/);
  assert.doesNotMatch(hook(h), /Weekly usage/);
  line(h, ultra({ rate_limits: { seven_day: { used_percentage: 82, resets_at: at + 7 * 86400 } } }));
  assert.match(hook(h), /Weekly usage at 82%/);
});

test('hook: snapshot is taken on Ultra (no 5h)', () => {
  const h = home();
  line(h, ultra());
  hook(h);
  const snap = JSON.parse(fs.readFileSync(path.join(h, '.claude', 'cc-budget', 'snap', 's1.json'), 'utf-8'));
  assert.equal(snap.seven_day_pct, 69);
  assert.equal(snap.cost, 209.64);
});

test('hook: expensive weekly prompt, once per day', () => {
  const h = home();
  line(h, ultra({ rate_limits: { seven_day: { used_percentage: 20, resets_at: now() + 5 * 86400 } } }));
  patchState(h, s => { s.sessions.s1.delta = { seven_day: 1.6, seven_day_est: true }; });
  assert.match(hook(h), /Last prompt used 1\.6% of the weekly limit/);
  patchState(h, s => { s.sessions.s1.delta = { seven_day: 2, seven_day_est: true }; });
  assert.doesNotMatch(hook(h), /Last prompt/);
});

test('hook: Max 5h threshold + expensive 5h prompt still work', () => {
  const h = home();
  line(h, max(91, 30));
  patchState(h, s => { s.sessions.s1.delta = { five_hour: 6 }; });
  const w = hook(h);
  assert.match(w, /5h usage at 91%/);
  assert.match(w, /Last prompt used 6\.0% of the 5h limit/);
});

test('hook: projected run-out before reset, once per window', () => {
  const h = home();
  // 96h into the week at 80% → 100% at 120h, 48h before reset
  line(h, ultra({ rate_limits: { seven_day: { used_percentage: 70, resets_at: now() + 72 * 3600 } } }));
  assert.match(hook(h), /runs out .*, 1d\d\dh before it resets/);
  assert.equal(hook(h), '');
});

test('hook: Fable cap warning names usage credits', () => {
  const h = home();
  line(h, ultra({
    model: { id: 'claude-fable-5-1' },
    rate_limits: { seven_day: { used_percentage: 20, resets_at: now() + 5 * 86400 }, model_scoped: [{ display_name: 'Fable', utilization: 83, resets_at: new Date(Date.now() + 5 * 86400e3).toISOString() }] },
  }));
  assert.match(hook(h), /Fable weekly cap at 83%.*usage credits/);
});

test('hook: old warned.json format is ignored, not fatal', () => {
  const h = home();
  fs.writeFileSync(path.join(h, '.claude', 'cc-budget', 'warned.json'), JSON.stringify({ five_hour: 95, seven_day: 90, expensive_delta: true }));
  line(h, ultra({ rate_limits: { seven_day: { used_percentage: 92, resets_at: now() + 86400 } } }));
  assert.match(hook(h), /Weekly usage at 92%/);
});

// --- cache, tags, model_scoped -------------------------------------------

test('cache cold now: shows re-cache size', () => {
  const out = line(home(), ultra({ prompt_cache: { caching_observed: true, warm: false, expires_at: now() - 60, requests: 10, recache_tokens_if_cold: 152679 } }));
  assert.match(out, /69% cold 153k/);
});

test('cache about to expire: countdown', () => {
  const out = line(home(), ultra({ prompt_cache: { caching_observed: true, warm: true, expires_at: now() + 8 * 60 + 30, requests: 10 } }));
  assert.match(out, /cache 8m/);
});

test('cache miss during this prompt: (+x cold)', () => {
  const h = home();
  const at = now() + 3 * 86400;
  line(h, ultra({ rate_limits: { seven_day: { used_percentage: 20, resets_at: at } } }));
  hook(h);
  const out = line(h, ultra({ rate_limits: { seven_day: { used_percentage: 22, resets_at: at } }, prompt_cache: { caching_observed: true, expires_at: now() + 3600, requests: 12, last_miss_at: now() + 1 } }));
  assert.match(out, /\(\+2\.0 cold\)/);
});

test('warm 1h cache after 20 min idle is NOT cold (old 5-min heuristic was)', () => {
  const h = home();
  line(h, max(40, 30));
  patchState(h, s => { s.session_last_seen.s1 = Date.now() - 20 * 60e3; });
  assert.doesNotMatch(line(h, max(40, 30)), /cold/);
});

test('no prompt_cache (older CC): 5-min heuristic fallback still works', () => {
  const h = home();
  line(h, ultra({ prompt_cache: undefined }));
  patchState(h, s => { s.session_last_seen.s1 = Date.now() - 6 * 60e3; });
  assert.match(line(h, ultra({ prompt_cache: undefined })), /69% cold/);
});

test('tags: Fable 5.1, fast mode, max effort', () => {
  const out = line(home(), ultra({ model: { id: 'claude-fable-5-1' }, fast_mode: true, effort: { level: 'max' } }));
  assert.match(out, /fable fast max/);
  assert.doesNotMatch(line(home(), ultra()), /fable|fast|high/);
});

test('model_scoped: kept when absent, cleared by []', () => {
  const h = home();
  const ms = [{ display_name: 'Fable', utilization: 60, resets_at: new Date(Date.now() + 86400e3).toISOString() }];
  line(h, ultra({ rate_limits: { seven_day: { used_percentage: 10, resets_at: now() + 86400 }, model_scoped: ms } }));
  assert.match(line(h, ultra()), /Fable .* 60%/);
  line(h, ultra({ rate_limits: { seven_day: { used_percentage: 10, resets_at: now() + 86400 }, model_scoped: [] } }));
  assert.doesNotMatch(line(h, ultra()), /Fable/);
});

test('today allowance re-bases on a new day', () => {
  const h = home();
  line(h, ultra());
  patchState(h, s => { s.day.date = '2000-01-01'; s.day.start_pct = 50; });
  line(h, ultra());
  assert.equal(stateOf(h).day.start_pct, 69);
});

test('widget mode: Ultra paces the weekly window', () => {
  const out = line(home(), ultra(), ['--widget']);
  assert.match(out, /^7d (⇡|⇣|on pace)/);
});

test('--legend renders', () => {
  const out = line(home(), '', ['--legend']);
  assert.match(out, /Ultra:/);
  assert.match(out, /Gateway:/);
});

// --- units ---------------------------------------------------------------

// --- cross-session (review findings) ---------------------------------------

test('snapshot cost is this session\'s, even when another session rendered last', () => {
  const h = home();
  line(h, ultra({ session_id: 'A', cost: { total_cost_usd: 120 } }));
  line(h, ultra({ session_id: 'B', cost: { total_cost_usd: 2 } }));
  hook(h, 'A');
  line(h, ultra({ session_id: 'A', cost: { total_cost_usd: 120.5 } }));
  assert.equal(stateOf(h).sessions.A.delta.cost_usd, 0.5);
});

test('API-key session never borrows a subscriber\'s weekly window', () => {
  const h = home();
  line(h, ultra());
  const api = line(h, ultra({ session_id: 'K', rate_limits: undefined, cost: { total_cost_usd: 3.25 } }));
  assert.match(api, /^\$3\.25/);
  assert.equal(stateOf(h).ledger.K.cost, 3.25);
  assert.match(line(h, ultra()), /^7d .* 69%/, 'subscriber session unaffected');
  line(h, ultra({ session_id: 'K', rate_limits: undefined, cost: { total_cost_usd: 9 } }));
  assert.equal(stateOf(h).cost_total, 0, 'API spend stays out of calibration');
});

test('a session that misclassified pre-response leaves the ledger once rate_limits arrive', () => {
  const h = home();
  line(h, ultra({ session_id: 'R', rate_limits: undefined, cost: { total_cost_usd: 50 } }));
  assert.ok(stateOf(h).ledger.R);
  line(h, ultra({ session_id: 'R', cost: { total_cost_usd: 51 } }));
  assert.equal(stateOf(h).ledger.R, undefined);
});

test('expensive-prompt alert uses this session\'s delta after others render', () => {
  const h = home();
  line(h, ultra({ session_id: 'A', rate_limits: { seven_day: { used_percentage: 20, resets_at: T0 + 5 * 86400 } } }));
  patchState(h, s => { s.sessions.A.delta = { seven_day: 1.5, seven_day_est: true }; });
  line(h, ultra({ session_id: 'B', rate_limits: { seven_day: { used_percentage: 20, resets_at: T0 + 5 * 86400 } } }));
  assert.match(hook(h, 'A'), /Last prompt used 1\.5%/);
});

test('uncalibrated whole-percent tick does not fire the weekly expensive alert', () => {
  const h = home();
  line(h, ultra({ rate_limits: { seven_day: { used_percentage: 20, resets_at: T0 + 5 * 86400 } } }));
  patchState(h, s => { s.sessions.s1.delta = { seven_day: 1 }; });
  assert.equal(hook(h), '');
});

test('Fable advice/cap warnings follow this session\'s model', () => {
  const h = home();
  const rl = { seven_day: { used_percentage: 20, resets_at: T0 + 5 * 86400 }, model_scoped: [{ display_name: 'Fable', utilization: 85, resets_at: new Date((T0 + 5 * 86400) * 1000).toISOString() }] };
  line(h, ultra({ session_id: 'O', rate_limits: rl }));
  line(h, ultra({ session_id: 'F', model: { id: 'claude-fable-5-1' }, rate_limits: rl }));
  assert.doesNotMatch(hook(h, 'O'), /Fable/);
});

test('cache miss stamped in the same second as the prompt still reads cold', () => {
  const h = home();
  const rl = { seven_day: { used_percentage: 20, resets_at: T0 + 3 * 86400 } };
  line(h, ultra({ rate_limits: rl }));
  hook(h);
  const snapTs = JSON.parse(fs.readFileSync(path.join(h, '.claude', 'cc-budget', 'snap', 's1.json'), 'utf-8')).ts;
  const out = line(h, ultra({ rate_limits: rl, cost: { total_cost_usd: 210 }, prompt_cache: { caching_observed: true, expires_at: now() + 3600, requests: 12, last_miss_at: Math.floor(snapTs / 1000) } }));
  assert.match(out, /20% cold /);
});

test('daily baseline survives a render without a weekly window', () => {
  const h = home();
  line(h, ultra());
  const day = stateOf(h).day;
  line(h, ultra({ session_id: 'G', cost: { total_cost_usd: 1 }, rate_limits: { spend_limit: { used_percentage: 5, resets_at: T0 + 86400 } } }));
  assert.deepEqual(stateOf(h).day, day);
});

test('expired window still sent by CC is dropped (status line and hook agree)', () => {
  const h = home();
  const out = line(h, max(94, 30, { rate_limits: { five_hour: { used_percentage: 94, resets_at: now() - 5 }, seven_day: { used_percentage: 30, resets_at: T0 + 3 * 86400 } } }));
  assert.match(out, /^7d/);
});

test('fallback cold check: 30s refresh renders do not reset the idle clock', () => {
  const h = home();
  const old = (over) => ultra({ prompt_cache: undefined, version: '2.1.200', ...over });
  line(h, old());
  const idleSince = Date.now() - 4 * 60e3;
  patchState(h, s => { s.session_last_seen.s1 = idleSince; });
  assert.doesNotMatch(line(h, old()), /cold/);              // refresh, same cost
  assert.equal(stateOf(h).session_last_seen.s1, idleSince);
  patchState(h, s => { s.session_last_seen.s1 = Date.now() - 6 * 60e3; });
  assert.match(line(h, old({ cost: { total_cost_usd: 215 } })), /cold/);  // first prompt after idle
});

test('1.2 state.json migrates (legacy snapshot fields dropped)', () => {
  const h = home();
  fs.writeFileSync(path.join(h, '.claude', 'cc-budget', 'state.json'), JSON.stringify({ v: 1, ts: 1, rate_limits: { five_hour: null, seven_day: { pct: 68, resets_at: T0 + 86400 } }, snapshots: { s1: { five_hour_pct: null, seven_day_pct: 60, session_cost_usd: 2, ts: 1 } }, delta_session_id: 's1', ledger: { s1: { cost: 200, day: '2026-11-01', month: '2026-11' } } }));
  assert.match(line(h, ultra()), /^7d .* 69% (?!\()/);
  const s = stateOf(h);
  assert.equal(s.snapshots, undefined);
  assert.equal(s.ledger.s1, undefined, 'subscriber session purged from $ ledger');
});

test('runoutAt / formatResetTime', () => {
  process.env.HOME = home();
  const { runoutAt, formatResetTime, spendHours } = require('./lib/format.cjs');
  const half = now() + 84 * 3600;
  assert.equal(runoutAt({ pct: 40, resets_at: half }, 168), null);          // under pace
  assert.ok(runoutAt({ pct: 60, resets_at: half }, 168) < half);            // over pace
  assert.equal(runoutAt({ pct: 30, resets_at: now() + 160 * 3600 }, 168), null);  // too early to tell
  assert.equal(formatResetTime(now() + 3 * 86400 + 5 * 3600 + 30), '3d05h');
  assert.equal(formatResetTime(now() + 2 * 3600 + 5 * 60 + 30), '2h05m');
  assert.equal(spendHours({ period: 'daily' }), 24);
  assert.equal(spendHours({ period: 'monthly', resets_at: new Date(2026, 4, 31).getTime() / 1000 }), 31 * 24);
});

test('VS Code extension: Ultra and gateway states render (vscode stubbed)', () => {
  const h = home();
  process.env.HOME = h;
  const Module = require('module');
  const item = { show() {}, text: '', tooltip: '' };
  const cmds = {};
  const stub = {
    window: { createStatusBarItem: () => item, showWarningMessage() {}, showErrorMessage() {}, showInformationMessage() {} },
    StatusBarAlignment: { Right: 2 }, ThemeColor: function (id) { this.id = id; },
    commands: { registerCommand: (id, fn) => { cmds[id] = fn; return {}; } },
  };
  const load = Module._load;
  Module._load = (req, ...rest) => (req === 'vscode' ? stub : load(req, ...rest));
  const ext = require('./vscode-extension/src/extension.js');
  try {
    const stateFile = path.join(h, '.claude', 'cc-budget', 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ v: 1, ts: Date.now(), rate_limits: { five_hour: null, seven_day: { pct: 69, resets_at: now() + 3 * 86400 } }, delta: { seven_day: 0.4 } }));
    ext.activate({ subscriptions: [] });
    assert.match(item.text, /^\$\(dashboard\) 7d: 69% .*\(\+0\.4\)$/);
    assert.match(item.tooltip, /Resets in: (2d23h|3d00h)/);

    fs.writeFileSync(stateFile, JSON.stringify({ v: 1, ts: Date.now(), session_cost_usd: 3.1, rate_limits: { spend_limit: { pct: 92, resets_at: now() + 86400, used_usd: 460, limit_usd: 500, period: 'monthly' } } }));
    cmds['cc-budget.refresh']();
    assert.equal(item.text, '$(credit-card) $3.10 | limit 92%');
    assert.equal(item.backgroundColor.id, 'statusBarItem.errorBackground');

    fs.writeFileSync(stateFile, JSON.stringify({ v: 1, ts: Date.now(), session_cost_usd: 3.1, rate_limits: { spend_limit: { pct: 50, resets_at: now() + 86400, used_usd: null, limit_usd: 500 } } }));
    cmds['cc-budget.refresh']();
    assert.equal(item.text, '$(credit-card) $3.10 | limit 50%');
  } finally {
    ext.deactivate();  // clears the 30s poll + file watcher so the runner can exit
    Module._load = load;
  }
});
