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
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m`;
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

function formatStatusLine(state, config, peak) {
  const fh = state.rate_limits.five_hour;
  const sd = state.rate_limits.seven_day;

  if (!fh) {
    if (state.session_cost_usd != null) {
      const mult = 1 - Math.max(0, Math.min(100, config.enterprise_discount || 0)) / 100;
      const adj = (usd) => usd * mult;

      const color = colorForCost(adj(state.session_cost_usd), config.thresholds);
      const sections = [];

      let session = `${color}$${adj(state.session_cost_usd).toFixed(2)}${RESET}`;
      if (state.delta?.cost_usd > 0) {
        session += ` ${DIM}(+$${adj(state.delta.cost_usd).toFixed(2)})${RESET}`;
      }
      sections.push(session);

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
        if (monTotal > 0) sections.push(`${DIM}$${monTotal.toFixed(2)} ${monthName}${RESET}`);
      }

      return sections.join(SEP);
    }
    return `${DIM}Budget: ...${RESET}`;
  }

  const pct5h = typeof fh.pct === 'number' ? fh.pct : 0;
  const color5h = colorForPct(pct5h);
  const showDelta = config.show_delta && state.delta && state.delta.five_hour > 0;

  const sections = [];

  // 5h with bar, pacing marker, and pace delta
  const pace5h = fh.resets_at ? paceTarget(fh.resets_at, 5) : null;
  const bar5h = progressBar(pct5h, 8, pace5h);
  const paceDelta5h = formatPaceDelta(pct5h, pace5h);

  let s1 = `${color5h}${BOLD}5h${RESET} ${bar5h} ${color5h}${Math.round(pct5h)}%${RESET}`;
  if (showDelta) {
    s1 += ` ${DIM}(+${state.delta.five_hour.toFixed(1)})${RESET}`;
  }
  if (paceDelta5h) {
    s1 += ` ${paceDelta5h}`;
  }
  if (fh.resets_at) {
    s1 += ` ${DIM}\u279E${formatResetTime(fh.resets_at)}${RESET}`;
  }
  sections.push(s1);

  // 7d (when relevant)
  const show7d = config.show_7d === 'always'
    || (config.show_7d === 'auto' && sd && (sd.pct > 50 || pct5h >= config.thresholds.warn_5h));
  if (show7d && sd) {
    const color7d = colorForPct(sd.pct);
    const pace7d = sd.resets_at ? paceTarget(sd.resets_at, 168) : null;
    const bar7d = progressBar(sd.pct, 5, pace7d);
    const paceDelta7d = formatPaceDelta(sd.pct, pace7d);
    let s2 = `${color7d}7d${RESET} ${bar7d} ${color7d}${Math.round(sd.pct)}%${RESET}`;
    if (paceDelta7d) s2 += ` ${paceDelta7d}`;
    sections.push(s2);
  }

  // Peak/off-peak with countdown
  const pt = peakTimeRemaining(peak, config.peak);
  if (peak) {
    sections.push(`${BRIGHT_RED}${BOLD}\u25B2${RESET} ${YELLOW}peak${RESET} ${DIM}${pt.remaining} left${RESET}`);
  } else {
    sections.push(`${GREEN}\u25BD${RESET} ${DIM}off-peak${RESET} ${DIM}${pt.remaining}${RESET}`);
  }

  return sections.join(SEP);
}

/**
 * Compact widget format for embedding in ccstatusline or other statusline frameworks.
 * Shows only what ccstatusline doesn't: pacing + peak + delta.
 */
function formatWidget(state, config, peak) {
  const fh = state.rate_limits.five_hour;

  // Enterprise/API: show per-prompt delta and daily total
  if (!fh) {
    if (state.session_cost_usd == null) return '';
    const mult = 1 - Math.max(0, Math.min(100, config.enterprise_discount || 0)) / 100;
    const adj = (usd) => usd * mult;
    const parts = [];
    if (state.delta?.cost_usd > 0) {
      parts.push(`${DIM}+$${adj(state.delta.cost_usd).toFixed(2)}${RESET}`);
    }
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
    return parts.join(' ');
  }

  const pct5h = typeof fh.pct === 'number' ? fh.pct : 0;
  const pace5h = fh.resets_at ? paceTarget(fh.resets_at, 5) : null;
  const paceDelta5h = formatPaceDelta(pct5h, pace5h);

  const parts = [];

  // Pace (the unique value)
  if (paceDelta5h) parts.push(paceDelta5h);

  // Delta
  if (config.show_delta && state.delta && state.delta.five_hour > 0) {
    parts.push(`${DIM}+${state.delta.five_hour.toFixed(1)}%${RESET}`);
  }

  // Peak
  if (peak) {
    const pt = peakTimeRemaining(true, config.peak);
    parts.push(`${YELLOW}\u25B2peak${RESET} ${DIM}${pt.remaining}${RESET}`);
  }

  return parts.join(' ');
}

module.exports = { formatStatusLine, formatWidget, formatResetTime, progressBar, paceTarget, formatPaceDelta, colorForPct, peakTimeRemaining, GREEN, YELLOW, RED, BRIGHT_RED, BOLD, DIM, RESET, WHITE_BOLD };
