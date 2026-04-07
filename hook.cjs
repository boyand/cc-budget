#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const WARNED_FILE = path.join(process.env.HOME, '.claude', 'cc-budget', 'warned.json');

function readWarned() {
  try {
    return JSON.parse(fs.readFileSync(WARNED_FILE, 'utf-8'));
  } catch {
    return { five_hour: null, seven_day: null, expensive_delta: null };
  }
}

function writeWarned(warned) {
  try {
    const dir = path.dirname(WARNED_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `warned.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(warned), 'utf-8');
    fs.renameSync(tmp, WARNED_FILE);
  } catch {}
}

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

    // Warned state lives in its own file to avoid race with statusline
    const warned = readWarned();
    const { thresholds } = config;
    const peak = isPeak(config.peak);
    const warnings = [];

    const pct5h = fh.pct;

    // Expensive prompt alert — fires once per 5h window
    const delta5h = state.delta && state.delta.five_hour;
    const deltaSessionId = state.delta_session_id;
    const expThresh = thresholds.expensive_delta ?? 5;
    if (typeof delta5h === 'number' && delta5h >= expThresh && deltaSessionId && deltaSessionId === input.session_id && !warned.expensive_delta) {
      warnings.push(`[cc-budget] Last prompt used ${delta5h.toFixed(1)}% of 5h window. Consider lowering effort or switching to Sonnet.`);
      warned.expensive_delta = true;
    }

    if (pct5h >= thresholds.critical_5h && warned.five_hour !== thresholds.critical_5h) {
      warnings.push(`[cc-budget] 5h usage at ${Math.round(pct5h)}%. Resets in ${formatResetTime(fh.resets_at)}. Consider waiting.`);
      warned.five_hour = thresholds.critical_5h;
    } else if (pct5h >= thresholds.warn_5h && (warned.five_hour == null || warned.five_hour < thresholds.warn_5h)) {
      warnings.push(`[cc-budget] 5h usage at ${Math.round(pct5h)}%. Resets in ${formatResetTime(fh.resets_at)}.`);
      warned.five_hour = thresholds.warn_5h;
    }

    if (sd) {
      const pct7d = sd.pct;

      if (pct7d >= thresholds.critical_7d && warned.seven_day !== thresholds.critical_7d) {
        warnings.push(`[cc-budget] 7d usage at ${Math.round(pct7d)}%.`);
        warned.seven_day = thresholds.critical_7d;
      } else if (pct7d >= thresholds.warn_7d && (warned.seven_day == null || warned.seven_day < thresholds.warn_7d)) {
        warnings.push(`[cc-budget] 7d usage at ${Math.round(pct7d)}%.`);
        warned.seven_day = thresholds.warn_7d;
      }
    }

    if (warnings.length > 0 && peak) {
      warnings.push(`Peak hours end at ${config.peak.end_hour} AM PT.`);
    }

    if (warnings.length > 0) {
      writeWarned(warned);
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
