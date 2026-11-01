#!/usr/bin/env node
'use strict';

const fs = require('fs');

// --legend: print a visual guide explaining the status line
if (process.argv.includes('--legend') || process.argv.includes('--help')) {
  const { formatStatusLine, GREEN, YELLOW, RED, BRIGHT_RED, BOLD, DIM, RESET, WHITE_BOLD } = require('./lib/format.cjs');
  const { loadConfig, XDG_CONFIG } = require('./lib/config.cjs');
  const config = loadConfig();

  const B = BOLD, D = DIM, R = RESET;
  const G = GREEN, Y = YELLOW, Rd = RED, Br = BRIGHT_RED;

  console.log(`
${B}cc-budget${R} — Claude Code Usage Monitor
${'─'.repeat(50)}

${B}STATUS LINE LAYOUT${R}

  ${B}5h${R} ${G}▓▓▓${R}${WHITE_BOLD}│${R}${G}░░░░░${R} ${G}24%${R} ${D}(+1.2)${R} ${G}⇣6%${R} ${D}➞3h15m${R} ${D}│${R} ${G}▽${R} ${D}off-peak 21h05m${R}
  ${D}──${R}  ${D}───────────${R}  ${D}───${R} ${D}──────${R} ${D}────${R} ${D}──────${R}     ${D}─────────────────${R}
  ${D}│${R}   ${D}│${R}            ${D}│${R}   ${D}│${R}       ${D}│${R}    ${D}│${R}         ${D}│${R}
  ${D}│${R}   ${D}│${R}            ${D}│${R}   ${D}│${R}       ${D}│${R}    ${D}│${R}         ${D}└─ peak/off-peak + time${R}
  ${D}│${R}   ${D}│${R}            ${D}│${R}   ${D}│${R}       ${D}│${R}    ${D}└─ ➞ time until the window resets${R}
  ${D}│${R}   ${D}│${R}            ${D}│${R}   ${D}│${R}       ${D}└─ ⇣ under pace (headroom)${R}
  ${D}│${R}   ${D}│${R}            ${D}│${R}   ${D}│${R}          ${Rd}⇡ over pace (burning too fast)${R}
  ${D}│${R}   ${D}│${R}            ${D}│${R}   ${D}└─ (+N.N) cost of last prompt (% of this window)${R}
  ${D}│${R}   ${D}│${R}            ${D}└─ usage percentage${R}
  ${D}│${R}   ${D}└─ progress bar with pacing marker${R}
  ${D}└─ window label (5h or 7d)${R}

${B}PROGRESS BAR${R}

  ${G}▓▓▓${R}${WHITE_BOLD}│${R}${G}░░░░░${R}  The white ${WHITE_BOLD}│${R} is the ${B}pacing marker${R} — where usage
           ${D}should${R} be for even distribution across the window.
           Filled past the marker = burning too fast.

${B}PACE INDICATOR${R}

  ${G}⇣14%${R}   Under pace — you have 14% headroom. Relax.
  ${D}on pace${R}  Right where you should be.
  ${Rd}⇡12%${R}   Over pace — burning 12% faster than sustainable.

${B}COLORS${R}

  ${G}green${R}    0-69%  — everything fine
  ${Y}yellow${R}   70-89% — be mindful
  ${Br}red${R}      90%+   — action likely needed

${B}PEAK / OFF-PEAK${R}

  ${Br}${B}▲${R} ${Y}peak${R} ${D}3h22m left${R}     Peak hours: 5-11 AM Pacific, weekdays
                          Budget depletes faster during peak.
  ${G}▽${R} ${D}off-peak 21h05m${R}    Off-peak: normal rate. Time until peak starts.

${B}7-DAY (WEEKLY) WINDOW${R}

  Pro / Max: shown next to 5h when weekly usage passes 50%, 5h is
  critical, or the week is projected to run out.
  Ultra (no 5-hour limit): 7d ${B}is${R} the main bar, delta in % of the week.

  ${D}today 6/9%${R}       Weekly % used today / even daily share left.
                   ${Y}yellow${R} over share, ${Br}red${R} over 1.5×.
  ${Br}out Thu 14:00${R}    At this week's average pace you hit 100% then,
                   before the reset. Hidden if you make it.

${B}FABLE / PER-MODEL LIMITS${R}

  ${Y}fable${R}            Tag shown while Fable is the active model.
  ${G}Fable${R} ${G}▓▓${R}${WHITE_BOLD}│${R}${G}░░░${R} ${G}41%${R}  Fable's weekly cap (the /usage "Fable" row; on
                   Max/Ultra up to half your weekly limit). Past it,
                   Fable bills usage credits. Pro: credits from the start.

${B}OTHER TAGS${R}

  ${Y}fast${R} ${Y}xhigh${R} ${Y}max${R}   Fast mode / high effort: each prompt costs more.

${B}PROMPT CACHE${R}

  ${D}(+8.2 cold)${R}      Last prompt rebuilt the prompt cache (pricier).
  ${Y}cold 153k${R}        Cache expired: next prompt re-caches 153k tokens.
  ${D}${Y}cache 8m${R}         Cache goes cold in 8 minutes.
                   Needs statusLine.refreshInterval to update while idle.

${B}EXAMPLES${R}
`);

  const mk = (p5, p7, resetH, d) => ({
    rate_limits: {
      five_hour: { pct: p5, resets_at: Math.floor(Date.now()/1000) + resetH*3600 },
      seven_day: { pct: p7, resets_at: Math.floor(Date.now()/1000) + 72*3600 }
    },
    delta: d ? { five_hour: d, seven_day: 0.1 } : null,
    session_cost_usd: 18.44
  });

  console.log(`  ${D}Comfortable:${R}  ${formatStatusLine(mk(16, 30, 3.5, 0.8), config, false)}`);
  console.log(`  ${D}Moderate:${R}     ${formatStatusLine(mk(55, 42, 2.5, 2.1), config, false)}`);
  console.log(`  ${D}Warning:${R}      ${formatStatusLine(mk(78, 45, 1.5, 3.5), config, true)}`);
  console.log(`  ${D}Critical:${R}     ${formatStatusLine(mk(94, 86, 0.5, 8.2), config, true)}`);
  console.log(`  ${D}Cold start:${R}   ${formatStatusLine(mk(55, 42, 2.5, 8.2), config, false, true)}`);
  console.log(`  ${D}On Fable:${R}     ${formatStatusLine({ ...mk(34, 20, 2, 1.2), model: 'claude-fable-5-1', model_scoped: [{ name: 'Fable', pct: 41, resets_at: Math.floor(Date.now()/1000) + 100*3600 }] }, config, false)}`);
  const ultra = (p7, resetH, d, extra) => ({
    plan: 'sub',
    rate_limits: { five_hour: null, seven_day: { pct: p7, resets_at: Math.floor(Date.now()/1000) + resetH*3600 } },
    delta: { seven_day: d },
    day: { date: 'x', at: Math.floor(Date.now()/1000) + resetH*3600, start_pct: p7 - 4, allowance: (100 - p7 + 4) / Math.max(1, resetH / 24) },
    ...extra,
  });
  console.log(`  ${D}Ultra:${R}        ${formatStatusLine(ultra(38, 100, 0.4), config, false)}`);
  console.log(`  ${D}Ultra, hot:${R}   ${formatStatusLine(ultra(81, 60, 1.3, { cache: { cold: true, recache_tokens: 153000, expires_at: 0 } }), config, false)}`);
  console.log(`  ${D}Gateway:${R}      ${formatStatusLine({ plan: 'gateway', rate_limits: { spend_limit: { pct: 54, resets_at: Math.floor(Date.now()/1000) + 12*86400, used_usd: 271.4, limit_usd: 500, period: 'monthly' } }, session_cost_usd: 3.1, delta: { cost_usd: 0.4 } }, config, false)}`);
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const mkLedger = (sessions) => Object.fromEntries(sessions.map(([id, cost, d]) => [id, { cost, day: d || today, month: (d || today).slice(0, 7) }]));
  console.log(`  ${D}API/Enterprise (low):${R}   ${formatStatusLine({ rate_limits: { five_hour: null, seven_day: null }, session_cost_usd: 0.84, delta: { cost_usd: 0.32 }, ledger: mkLedger([['s1', 0.84], ['s2', 1.20]]) }, config, false)}`);
  console.log(`  ${D}API/Enterprise (high):${R}  ${formatStatusLine({ rate_limits: { five_hour: null, seven_day: null }, session_cost_usd: 14.50, delta: { cost_usd: 2.15 }, ledger: mkLedger([['s3', 14.50], ['s4', 8.30], ['s5', 12.10, month + '-01']]) }, config, false)}`);
  console.log(`
${B}CONFIG${R}

  ${D}Edit:${R}  ${XDG_CONFIG}
  ${D}Docs:${R}  node ${__filename} --legend
`);
  process.exit(0);
}

const WIDGET_MODE = process.argv.includes('--widget');

function main() {
  try {
    const raw = fs.readFileSync(0, 'utf-8');
    if (!raw.trim()) return;

    const input = JSON.parse(raw);
    // Debug tap: keep the last raw payload for inspecting what Claude Code sends
    try {
      const path = require('path');
      fs.writeFileSync(path.join(process.env.HOME, '.claude', 'cc-budget', 'last-input.json'), raw);
    } catch {}
    const { loadConfig } = require('./lib/config.cjs');
    const { updateFromStatusLine, writeState } = require('./lib/state.cjs');
    const { isPeak } = require('./lib/peak.cjs');
    const { formatStatusLine, formatWidget } = require('./lib/format.cjs');

    const config = loadConfig();
    const { state, coldStart } = updateFromStatusLine(input);
    state.is_peak = isPeak(config.peak);
    writeState(state);

    const output = WIDGET_MODE
      ? formatWidget(state, config, state.is_peak)
      : formatStatusLine(state, config, state.is_peak, coldStart);
    process.stdout.write(output);
  } catch (e) {
    // Silent -- stderr triggers Claude Code's "hook error" display
  }
}

main();
