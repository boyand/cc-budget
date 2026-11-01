'use strict';

// ANSI escape codes
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BRIGHT_RED = '\x1b[91m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const WHITE_BOLD = '\x1b[1;37m';

// Unicode characters
const BAR_FULL = '\u2593';   // ▓ dark shade (filled)
const BAR_EMPTY = '\u2591';  // ░ light shade (empty)
const PACE_MARK = '\u2502';  // │ pacing target marker
const SEP = `${DIM} \u2502 ${RESET}`;  // │ section separator
const ARROW_UP = '\u21E1';   // ⇡ over-pace (burning too fast)
const ARROW_DN = '\u21E3';   // ⇣ under-pace (headroom)

function colorForPct(pct) {
  if (pct >= 90) return BRIGHT_RED;
  if (pct >= 70) return YELLOW;
  return GREEN;
}

function colorForCost(usd, thresholds) {
  if (usd >= (thresholds?.critical_cost_usd ?? 20)) return BRIGHT_RED;
  if (usd >= (thresholds?.warn_cost_usd ?? 5)) return YELLOW;
  return GREEN;
}

function progressBar(pct, width, pacePct) {
  const clamped = Math.max(0, Math.min(100, pct || 0));
  const color = colorForPct(clamped);
  const filledCount = Math.round((clamped / 100) * width);
  const pacePos = pacePct != null ? Math.round((Math.max(0, Math.min(100, pacePct)) / 100) * width) : -1;

  // Build the bar as width filled/empty chars, then insert the pace marker
  // as an extra character so it doesn't eat a position.
  let chars = [];
  for (let i = 0; i < width; i++) {
    chars.push(i < filledCount ? BAR_FULL : BAR_EMPTY);
  }

  let bar = '';
  for (let i = 0; i <= width; i++) {
    if (i === pacePos && pacePos >= 0) {
      bar += `${WHITE_BOLD}${PACE_MARK}${RESET}${color}`;
    }
    if (i < width) {
      bar += chars[i];
    }
  }
  return `${color}${bar}${RESET}`;
}

function formatResetTime(resetsAtEpochSec) {
  const diff = resetsAtEpochSec * 1000 - Date.now();
  if (diff <= 0) return 'soon';
  const totalMin = Math.floor(diff / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

/** "14:05" today, "Thu 14:05" otherwise (local time). */
function formatClock(epochSec) {
  const d = new Date(epochSec * 1000);
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return hm;
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${hm}`;
}

function formatTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/**
 * When the window runs out at its average burn rate so far, or null if it
 * makes it to reset. Needs 10% of the window elapsed to be worth trusting.
 * ponytail: window-average rate; a recent-rate (last 24h) blend is the upgrade
 * if projections feel laggy.
 */
function runoutAt(w, windowHours) {
  if (!w || !w.resets_at || !(w.pct > 0)) return null;
  const windowMs = windowHours * 3600000;
  const startMs = w.resets_at * 1000 - windowMs;
  const elapsed = Date.now() - startMs;
  if (elapsed < windowMs * 0.1 || elapsed >= windowMs) return null;
  if (w.pct >= 100) return Math.floor(Date.now() / 1000);
  const etaMs = startMs + elapsed * (100 / w.pct);
  return etaMs < w.resets_at * 1000 ? Math.floor(etaMs / 1000) : null;
}

/** Spend-limit period length in hours (monthly = the actual calendar month). */
function spendHours(sl) {
  if (sl.period === 'daily') return 24;
  if (sl.period === 'weekly') return 168;
  // Same day last month, clamped (a May 31 reset started Apr 30).
  const r = new Date(sl.resets_at * 1000);
  const s = new Date(r);
  s.setDate(1);
  s.setMonth(s.getMonth() - 1);
  s.setDate(Math.min(r.getDate(), new Date(s.getFullYear(), s.getMonth() + 1, 0).getDate()));
  return (r - s) / 3600000;
}

function paceTarget(resetsAtEpochSec, windowHours) {
  const resetMs = resetsAtEpochSec * 1000;
  const windowMs = windowHours * 3600 * 1000;
  const startMs = resetMs - windowMs;
  const elapsed = Date.now() - startMs;
  if (elapsed <= 0 || elapsed >= windowMs) return null;
  return (elapsed / windowMs) * 100;
}

function formatPaceDelta(currentPct, targetPct) {
  if (targetPct == null || currentPct == null) return '';
  const delta = Math.round(currentPct - targetPct);
  if (delta > 2) return `${RED}${ARROW_UP}${Math.abs(delta)}%${RESET}`;
  if (delta < -2) return `${GREEN}${ARROW_DN}${Math.abs(delta)}%${RESET}`;
  return `${DIM}on pace${RESET}`;
}

function peakTimeRemaining(isPeak, peakConfig) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: peakConfig.timezone,
      hour: 'numeric', hour12: false,
      minute: 'numeric',
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date()).map(p => [p.type, p.value])
    );
    const nowHour = parseInt(parts.hour, 10);
    const nowMin = parseInt(parts.minute, 10);
    const nowTotalMin = nowHour * 60 + nowMin;

    if (isPeak) {
      const endMin = peakConfig.end_hour * 60;
      const remaining = endMin - nowTotalMin;
      if (remaining <= 0) return { label: 'peak', remaining: 'ending' };
      const h = Math.floor(remaining / 60);
      const m = remaining % 60;
      return { label: 'peak', remaining: h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m` };
    } else {
      const startMin = peakConfig.start_hour * 60;
      let remaining;
      if (nowTotalMin < startMin) {
        remaining = startMin - nowTotalMin;
      } else {
        remaining = (24 * 60 - nowTotalMin) + startMin;
      }
      const h = Math.floor(remaining / 60);
      const m = remaining % 60;
      return { label: 'off-peak', remaining: h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m` };
    }
  } catch {
    return { label: isPeak ? 'peak' : 'off-peak', remaining: '' };
  }
}

function isFable(state) {
  return typeof state.model === 'string' && state.model.includes('fable');
}

const FABLE_TAG = `${YELLOW}fable${RESET}`;

/** Burn multipliers worth a glance: Fable, fast mode, xhigh/max effort. */
function costTags(state) {
  const tags = [];
  if (isFable(state)) tags.push(FABLE_TAG);
  if (state.fast_mode) tags.push(`${YELLOW}fast${RESET}`);
  if (state.effort === 'max' || state.effort === 'xhigh') tags.push(`${YELLOW}${state.effort}${RESET}`);
  return tags;
}

/** Per-model weekly-limit sections (e.g. Fable's separate cap). Same visual
 * grammar as the 7d bar. Shown while that model is active, or past 50%. */
function modelScopedSections(state) {
  if (!Array.isArray(state.model_scoped)) return [];
  const sections = [];
  for (const m of state.model_scoped) {
    const active = isFable(state) && m.name.toLowerCase().includes('fable');
    if (!active && m.pct <= 50) continue;
    const color = colorForPct(m.pct);
    const pace = m.resets_at ? paceTarget(m.resets_at, 168) : null;
    const bar = progressBar(m.pct, 5, pace);
    let s = `${color}${m.name}${RESET} ${bar} ${color}${Math.round(m.pct)}%${RESET}`;
    const paceDelta = formatPaceDelta(m.pct, pace);
    if (paceDelta) s += ` ${paceDelta}`;
    sections.push(s);
  }
  return sections;
}

/** Bar + pct + pace for one window. */
function windowCore(label, w, hours, width, bold) {
  const color = colorForPct(w.pct);
  const pace = w.resets_at ? paceTarget(w.resets_at, hours) : null;
  let s = `${color}${bold ? BOLD : ''}${label}${RESET} ${progressBar(w.pct, width, pace)} ${color}${Math.round(w.pct)}%${RESET}`;
  return { s, pace };
}

/** Cold-cache markers. Post-hoc `cold` (last prompt rebuilt the cache) goes
 * inside the delta parens; a cache that is cold *now* shows the re-cache cost. */
function withCache(s, state, coldStart, delta) {
  const cache = state.cache;
  const preCold = cache && cache.cold;
  if (delta != null) {
    s += ` ${DIM}(+${delta.toFixed(1)}${coldStart && !preCold ? ' cold' : ''})${RESET}`;
  } else if (coldStart && !preCold) {
    s += ` ${DIM}cold${RESET}`;
  }
  if (preCold) {
    s += ` ${YELLOW}cold${cache.recache_tokens ? ' ' + formatTokens(cache.recache_tokens) : ''}${RESET}`;
  } else if (cache && cache.expires_at * 1000 - Date.now() <= 10 * 60000) {
    s += ` ${DIM}${YELLOW}cache ${formatResetTime(cache.expires_at)}${RESET}`;
  }
  return s;
}

function shownDelta(config, d) {
  return config.show_delta && typeof d === 'number' && d >= 0.05 ? d : null;
}

/** "today 6/9%": weekly % used since local midnight vs. the even daily share. */
function todaySection(state, sd) {
  const day = state.day;
  if (!day || day.at !== sd.resets_at) return null;
  const used = Math.max(0, sd.pct - day.start_pct);
  const allow = day.allowance;
  const color = used > allow * 1.5 && used >= 2 ? BRIGHT_RED : used > allow ? YELLOW : DIM;
  return `${color}today ${Math.round(used)}/${Math.round(allow)}%${RESET}`;
}

function weeklyExtras(state, sd) {
  const out = [];
  const t = todaySection(state, sd);
  if (t) out.push(t);
  const eta = runoutAt(sd, 168);
  if (eta) out.push(`${BRIGHT_RED}out ${formatClock(eta)}${RESET}`);
  return out;
}

function peakSection(peak, config) {
  const pt = peakTimeRemaining(peak, config.peak);
  return peak
    ? `${BRIGHT_RED}${BOLD}▲${RESET} ${YELLOW}peak${RESET} ${DIM}${pt.remaining} left${RESET}`
    : `${GREEN}▽${RESET} ${DIM}off-peak${RESET} ${DIM}${pt.remaining}${RESET}`;
}

function planOf(state) {
  const { five_hour: fh, seven_day: sd, spend_limit: sl } = state.rate_limits;
  return state.plan || (fh || sd ? 'sub' : sl ? 'gateway' : state.session_cost_usd != null ? 'api' : null);
}

function spendSection(sl) {
  const hours = spendHours(sl);
  const { s, pace } = windowCore('spend', sl, hours, 5, false);
  let out = s;
  if (sl.used_usd != null && sl.limit_usd != null) {
    const per = { daily: 'day', weekly: 'wk', monthly: 'mo' }[sl.period] || 'mo';
    out += ` ${DIM}$${Math.round(sl.used_usd)}/$${Math.round(sl.limit_usd)} ${per}${RESET}`;
  }
  const pd = formatPaceDelta(sl.pct, pace);
  if (pd) out += ` ${pd}`;
  if (sl.resets_at) out += ` ${DIM}➞${formatResetTime(sl.resets_at)}${RESET}`;
  return out;
}

function dollarSections(state, config) {
  const mult = 1 - Math.max(0, Math.min(100, config.enterprise_discount || 0)) / 100;
  const adj = (usd) => usd * mult;
  const color = colorForCost(adj(state.session_cost_usd), config.thresholds);
  const sections = [];

  let session = `${color}$${adj(state.session_cost_usd).toFixed(2)}${RESET}`;
  if (state.delta?.cost_usd > 0) {
    session += ` ${DIM}(+$${adj(state.delta.cost_usd).toFixed(2)})${RESET}`;
  }
  session = [session, ...costTags(state)].join(' ');
  sections.push(session);

  // Gateway meter is already what you pay; no list-price discount.
  const sl = planOf(state) === 'gateway' ? state.rate_limits.spend_limit : null;
  if (sl) sections.push(spendSection(sl));

  if (state.ledger) {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const entries = Object.values(state.ledger);
    const todayEntries = entries.filter(e => e.day === today);
    const dayTotal = adj(todayEntries.reduce((s, e) => s + e.cost, 0));
    const ydayTotal = adj(entries.filter(e => e.day === yesterday).reduce((s, e) => s + e.cost, 0));
    const monTotal = adj(entries.filter(e => e.month === month).reduce((s, e) => s + e.cost, 0));
    const monthName = new Date().toLocaleString('en-US', { month: 'short' });
    if (todayEntries.length > 0) {
      sections.push(`${DIM}$${dayTotal.toFixed(2)} today${RESET}`);
    } else if (ydayTotal > 0) {
      sections.push(`${DIM}$${ydayTotal.toFixed(2)} yesterday${RESET}`);
    }
    if (monTotal > 0 && !sl) sections.push(`${DIM}$${monTotal.toFixed(2)} ${monthName}${RESET}`);
  }
  return sections;
}

function formatStatusLine(state, config, peak, coldStart) {
  const fh = state.rate_limits.five_hour;
  const sd = state.rate_limits.seven_day;
  const plan = planOf(state);

  if (plan !== 'sub') {
    if (state.session_cost_usd == null) return `${DIM}Budget: ...${RESET}`;
    return dollarSections(state, config).join(SEP);
  }

  // Subscriber. Primary window: 5h when the plan has one (Pro, Max, unverified
  // Ultra), else 7d (verified Ultra has no 5-hour limit since 2026-10-31).
  const sections = [];
  const primary = fh
    ? { label: '5h', w: fh, hours: 5, delta: state.delta?.five_hour }
    : { label: '7d', w: sd, hours: 168, delta: state.delta?.seven_day };

  let { s: s1, pace } = windowCore(primary.label, primary.w, primary.hours, 8, true);
  s1 = withCache(s1, state, coldStart, shownDelta(config, primary.delta));
  const pd = formatPaceDelta(primary.w.pct, pace);
  if (pd) s1 += ` ${pd}`;
  if (primary.w.resets_at) s1 += ` ${DIM}➞${formatResetTime(primary.w.resets_at)}${RESET}`;
  sections.push([s1, ...costTags(state)].join(' '));

  if (fh && sd) {
    const show7d = config.show_7d === 'always'
      || (config.show_7d === 'auto' && (sd.pct > 50 || fh.pct >= config.thresholds.warn_5h || runoutAt(sd, 168)));
    if (show7d) {
      const { s, pace: p7 } = windowCore('7d', sd, 168, 5, false);
      const pd7 = formatPaceDelta(sd.pct, p7);
      sections.push(pd7 ? `${s} ${pd7}` : s);
      sections.push(...weeklyExtras(state, sd));
    }
  } else if (sd) {
    sections.push(...weeklyExtras(state, sd));
  }

  sections.push(...modelScopedSections(state));
  sections.push(peakSection(peak, config));
  return sections.join(SEP);
}

/**
 * Compact widget format for embedding in ccstatusline or other statusline frameworks.
 * Shows only what ccstatusline doesn't: pacing, delta, run-out, tags, peak.
 */
function formatWidget(state, config, peak) {
  const fh = state.rate_limits.five_hour;
  const sd = state.rate_limits.seven_day;
  const plan = planOf(state);

  if (plan !== 'sub') {
    if (state.session_cost_usd == null) return '';
    const mult = 1 - Math.max(0, Math.min(100, config.enterprise_discount || 0)) / 100;
    const adj = (usd) => usd * mult;
    const parts = [];
    if (state.delta?.cost_usd > 0) {
      parts.push(`${DIM}+$${adj(state.delta.cost_usd).toFixed(2)}${RESET}`);
    }
    const sl = plan === 'gateway' ? state.rate_limits.spend_limit : null;
    if (sl) parts.push(`${colorForPct(sl.pct)}${Math.round(sl.pct)}% limit${RESET}`);
    if (state.ledger) {
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const entries = Object.values(state.ledger);
      const todayEntries = entries.filter(e => e.day === today);
      const dayTotal = adj(todayEntries.reduce((s, e) => s + e.cost, 0));
      const ydayTotal = adj(entries.filter(e => e.day === yesterday).reduce((s, e) => s + e.cost, 0));
      if (todayEntries.length > 0) parts.push(`${DIM}$${dayTotal.toFixed(2)} today${RESET}`);
      else if (ydayTotal > 0) parts.push(`${DIM}$${ydayTotal.toFixed(2)} yesterday${RESET}`);
    }
    parts.push(...costTags(state));
    return parts.join(' ');
  }

  const primary = fh ? { w: fh, hours: 5, delta: state.delta?.five_hour } : { w: sd, hours: 168, delta: state.delta?.seven_day };
  const parts = [];
  // ccstatusline shows the raw %; with no 5h window, label which one we pace.
  const pd = formatPaceDelta(primary.w.pct, primary.w.resets_at ? paceTarget(primary.w.resets_at, primary.hours) : null);
  if (pd) parts.push(fh ? pd : `${DIM}7d${RESET} ${pd}`);
  const d = shownDelta(config, primary.delta);
  if (d != null) parts.push(`${DIM}+${d.toFixed(1)}%${RESET}`);
  const eta = sd ? runoutAt(sd, 168) : null;
  if (eta) parts.push(`${BRIGHT_RED}out ${formatClock(eta)}${RESET}`);

  if (isFable(state)) {
    const fableWindow = (state.model_scoped || []).find(m => m.name.toLowerCase().includes('fable'));
    parts.push(fableWindow
      ? `${FABLE_TAG} ${colorForPct(fableWindow.pct)}${Math.round(fableWindow.pct)}%${RESET}`
      : FABLE_TAG);
  }
  parts.push(...costTags(state).filter(t => t !== FABLE_TAG));

  if (peak) {
    const pt = peakTimeRemaining(true, config.peak);
    parts.push(`${YELLOW}▲peak${RESET} ${DIM}${pt.remaining}${RESET}`);
  }
  return parts.join(' ');
}

module.exports = { formatStatusLine, formatWidget, formatResetTime, formatClock, formatTokens, runoutAt, spendHours, progressBar, paceTarget, formatPaceDelta, colorForPct, peakTimeRemaining, GREEN, YELLOW, RED, BRIGHT_RED, BOLD, DIM, RESET, WHITE_BOLD };
