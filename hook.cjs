#!/usr/bin/env node
'use strict';

const fs = require('fs');

function main() {
  try {
    const raw = fs.readFileSync(0, 'utf-8');
    if (!raw.trim()) return;

    const input = JSON.parse(raw);
    if (input.hook_event_name !== 'UserPromptSubmit') return;

    const { loadConfig } = require('./lib/config.cjs');
    const { readState, writeState } = require('./lib/state.cjs');
    const { isPeak } = require('./lib/peak.cjs');
    const { formatResetTime } = require('./lib/format.cjs');

    const config = loadConfig();
    const state = readState();
    if (!state.warned) state.warned = { five_hour: null, seven_day: null };

    const fh = state.rate_limits.five_hour;
    const sd = state.rate_limits.seven_day;

    // Snapshot current usage keyed by session — statusline computes delta from this
    const sessionId = input.session_id;
    const costUsd = state.session_cost_usd;
    if (sessionId && (fh || costUsd != null)) {
      if (!state.snapshots) state.snapshots = {};
      state.snapshots[sessionId] = {
        five_hour_pct: fh ? fh.pct : null,
        seven_day_pct: sd ? sd.pct : null,
        session_cost_usd: costUsd,
        ts: Date.now(),
      };
      writeState(state);
    }

    if (!fh || (fh.resets_at && fh.resets_at * 1000 < Date.now())) return;

    const { thresholds } = config;
    const peak = isPeak(config.peak);
    const warnings = [];

    const pct5h = fh.pct;
    const lastWarned5h = state.warned.five_hour;

    if (pct5h >= thresholds.critical_5h && lastWarned5h !== thresholds.critical_5h) {
      warnings.push(`[cc-budget] 5h usage at ${Math.round(pct5h)}%. Resets in ${formatResetTime(fh.resets_at)}. Consider waiting.`);
      state.warned.five_hour = thresholds.critical_5h;
    } else if (pct5h >= thresholds.warn_5h && (lastWarned5h == null || lastWarned5h < thresholds.warn_5h)) {
      warnings.push(`[cc-budget] 5h usage at ${Math.round(pct5h)}%. Resets in ${formatResetTime(fh.resets_at)}.`);
      state.warned.five_hour = thresholds.warn_5h;
    }

    if (sd) {
      const pct7d = sd.pct;
      const lastWarned7d = state.warned.seven_day;

      if (pct7d >= thresholds.critical_7d && lastWarned7d !== thresholds.critical_7d) {
        warnings.push(`[cc-budget] 7d usage at ${Math.round(pct7d)}%.`);
        state.warned.seven_day = thresholds.critical_7d;
      } else if (pct7d >= thresholds.warn_7d && (lastWarned7d == null || lastWarned7d < thresholds.warn_7d)) {
        warnings.push(`[cc-budget] 7d usage at ${Math.round(pct7d)}%.`);
        state.warned.seven_day = thresholds.warn_7d;
      }
    }

    if (warnings.length > 0 && peak) {
      warnings.push(`Peak hours end at ${config.peak.end_hour} AM PT.`);
    }

    if (warnings.length > 0) {
      writeState(state);
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: warnings.join(' '),
        },
      }));
    }
  } catch (e) {
    // Silent -- stderr triggers Claude Code's "hook error" display
  }
}

main();
