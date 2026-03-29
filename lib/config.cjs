'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  thresholds: { warn_5h: 90, critical_5h: 95, warn_7d: 80, critical_7d: 90 },
  peak: { start_hour: 5, end_hour: 11, timezone: 'America/Los_Angeles', weekdays_only: true },
  show_delta: true,
  show_7d: 'auto',
};

// Config lookup order (XDG Base Directory convention):
// 1. XDG config: ~/.config/cc-budget/config.json (user-editable)
// 2. Hardcoded defaults
const XDG_CONFIG = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, '.config'), 'cc-budget', 'config.json');

function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(XDG_CONFIG, 'utf-8');
  } catch (e) {
    if (e.code !== 'ENOENT') {
      process.stderr.write(`[cc-budget] cannot read config ${XDG_CONFIG}: ${e.code}\n`);
    }
    return { ...DEFAULTS };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULTS,
      ...parsed,
      thresholds: { ...DEFAULTS.thresholds, ...(parsed.thresholds || {}) },
      peak: { ...DEFAULTS.peak, ...(parsed.peak || {}) },
    };
  } catch (e) {
    process.stderr.write(`[cc-budget] invalid JSON in ${XDG_CONFIG}: ${e.message}\n`);
    return { ...DEFAULTS };
  }
}

module.exports = { loadConfig, XDG_CONFIG };
