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
  ${D}│${R}   ${D}│${R}            ${D}│${R}   ${D}│${R}       ${D}│${R}    ${D}└─ ➞ time until 5h window resets${R}
  ${D}│${R}   ${D}│${R}            ${D}│${R}   ${D}│${R}       ${D}└─ ⇣ under pace (headroom)${R}
  ${D}│${R}   ${D}│${R}            ${D}│${R}   ${D}│${R}          ${Rd}⇡ over pace (burning too fast)${R}
  ${D}│${R}   ${D}│${R}            ${D}│${R}   ${D}└─ (+N.N) cost of last prompt (% of 5h window)${R}
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

${B}7-DAY WINDOW${R}

  Shown automatically when 7d usage exceeds 50% or 5h is critical.
  Same bar + pace format as the 5h window.

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
  console.log(`  ${D}API user:${R}     ${formatStatusLine({ rate_limits: { five_hour: null, seven_day: null }, session_cost_usd: 14.50 }, config, false)}`);
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
    const { loadConfig } = require('./lib/config.cjs');
    const { updateFromStatusLine, writeState } = require('./lib/state.cjs');
    const { isPeak } = require('./lib/peak.cjs');
    const { formatStatusLine, formatWidget } = require('./lib/format.cjs');

    const config = loadConfig();
    const state = updateFromStatusLine(input);
    state.is_peak = isPeak(config.peak);
    writeState(state);

    const output = WIDGET_MODE
      ? formatWidget(state, config, state.is_peak)
      : formatStatusLine(state, config, state.is_peak);
    process.stdout.write(output);
  } catch (e) {
    process.stderr.write(`[cc-budget] statusline error: ${e.stack || e.message}\n`);
  }
}

main();
