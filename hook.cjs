#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const WARNED_FILE = path.join(process.env.HOME, '.claude', 'cc-budget', 'warned.json');

// Each warning remembers which window it fired in ({at: resets_at, level}),
// so it re-arms by itself when that window resets. Old flat files read as empty.
function readWarned() {
  try {
    const w = JSON.parse(fs.readFileSync(WARNED_FILE, 'utf-8'));
    if (w && w.v === 2) return w;
  } catch {}
  return { v: 2 };
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

/** Threshold crossing for one window; returns the level to warn at, or null. */
function crossing(warned, key, w, warnAt, critAt) {
  const prev = warned[key] && warned[key].at === w.resets_at ? warned[key].level : null;
  const level = w.pct >= critAt ? critAt : w.pct >= warnAt ? warnAt : null;
  if (level == null || (prev != null && prev >= level)) return null;
  warned[key] = { at: w.resets_at, level };
  return level;
}

function live(w) {
  return w && (!w.resets_at || w.resets_at * 1000 > Date.now()) ? w : null;
}

function main() {
  try {
    const raw = fs.readFileSync(0, 'utf-8');
    if (!raw.trim()) return;

    const input = JSON.parse(raw);
    if (input.hook_event_name !== 'UserPromptSubmit') return;

    const { loadConfig } = require('./lib/config.cjs');
    const { readState, localDay, writeSnap, pruneSnaps } = require('./lib/state.cjs');
    const { isPeak } = require('./lib/peak.cjs');
    const { formatResetTime, formatClock, runoutAt } = require('./lib/format.cjs');

    const config = loadConfig();
    const state = readState();
    const sessionId = input.session_id;
    // Everything per-session comes from this session's own entry; top-level
    // state fields belong to whichever session rendered last.
    const sess = (sessionId && state.sessions && state.sessions[sessionId]) || {};
    const sub = (sess.plan || state.plan) === 'sub';

    const fh = sub ? live(state.rate_limits.five_hour) : null;
    const sd = sub ? live(state.rate_limits.seven_day) : null;

    if (sessionId) {
      writeSnap(sessionId, {
        cost: sess.cost ?? null,
        five_hour_pct: fh ? fh.pct : null,
        five_hour_at: fh ? fh.resets_at : null,
        seven_day_pct: sd ? sd.pct : null,
        seven_day_at: sd ? sd.resets_at : null,
        ts: Date.now(),
      });
      pruneSnaps();
    }

    if (!fh && !sd) return;

    const warned = readWarned();
    const { thresholds } = config;
    const warnings = [];
    const onFable = typeof sess.model === 'string' && sess.model.includes('fable');
    const advice = onFable ? 'Consider switching from Fable to Opus or Sonnet.' : 'Consider lowering effort or switching to Sonnet.';

    // Expensive last prompt, measured on the primary window. Once per 5h
    // window, or once per day when weekly is the only window. The weekly one
    // needs calibration: a raw whole-percent tick says nothing about one prompt.
    const d = sess.delta;
    const expKey = fh ? `5h:${fh.resets_at}` : `day:${localDay()}`;
    if (d && warned.expensive !== expKey) {
      if (fh && typeof d.five_hour === 'number' && d.five_hour >= (thresholds.expensive_delta ?? 5)) {
        warnings.push(`[cc-budget] Last prompt used ${d.five_hour.toFixed(1)}% of the 5h limit${onFable ? ' on Fable' : ''}. ${advice}`);
        warned.expensive = expKey;
      } else if (!fh && d.seven_day_est && d.seven_day >= (thresholds.expensive_delta_7d ?? 1)) {
        warnings.push(`[cc-budget] Last prompt used ${d.seven_day.toFixed(1)}% of the weekly limit${onFable ? ' on Fable' : ''}. ${advice}`);
        warned.expensive = expKey;
      }
    }

    if (fh) {
      const lvl = crossing(warned, 'five_hour', fh, thresholds.warn_5h, thresholds.critical_5h);
      if (lvl != null) {
        warnings.push(`[cc-budget] 5h usage at ${Math.round(fh.pct)}%. Resets in ${formatResetTime(fh.resets_at)}.${lvl === thresholds.critical_5h ? ' Consider waiting.' : ''}`);
      }
    }

    if (sd) {
      const lvl = crossing(warned, 'seven_day', sd, thresholds.warn_7d, thresholds.critical_7d);
      if (lvl != null) {
        warnings.push(`[cc-budget] Weekly usage at ${Math.round(sd.pct)}%. Resets in ${formatResetTime(sd.resets_at)}.`);
      }
      // Projected to run out before reset: once per weekly window, from 50% up.
      const eta = sd.pct >= 50 ? runoutAt(sd, 168) : null;
      if (eta && warned.runout !== sd.resets_at) {
        const gap = formatResetTime(Date.now() / 1000 + (sd.resets_at - eta));
        warnings.push(`[cc-budget] At this pace the weekly limit runs out ${formatClock(eta)}, ${gap} before it resets.`);
        warned.runout = sd.resets_at;
      }
    }

    // Model weekly caps (Fable). Past it, Fable bills usage credits.
    if (onFable) {
      for (const m of (state.model_scoped || []).filter(m => live(m) && m.name.toLowerCase().includes('fable'))) {
        const lvl = crossing(warned, `model:${m.name}`, m, thresholds.warn_7d, thresholds.critical_7d);
        if (lvl != null) {
          warnings.push(`[cc-budget] ${m.name} weekly cap at ${Math.round(m.pct)}%. Past it, Fable bills usage credits or stops. Consider Opus.`);
        }
      }
    }

    if (warnings.length > 0 && isPeak(config.peak)) {
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
  }
}

main();
