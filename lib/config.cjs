'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  thresholds: { warn_5h: 90, critical_5h: 95, warn_7d: 80, critical_7d: 90, warn_cost_usd: 5, critical_cost_usd: 20 },
  peak: { start_hour: 5, end_hour: 11, timezone: 'America/Los_Angeles', weekdays_only: true },
  show_delta: true,
  show_7d: 'auto',
  enterprise_discount: 0,  // percentage off list price, e.g. 20 for 20% off
};

const XDG_CONFIG = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, '.config'), 'cc-budget', 'config.json');

function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(XDG_CONFIG, 'utf-8');
  } catch {
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
  } catch {
    return { ...DEFAULTS };
  }
}

module.exports = { loadConfig, XDG_CONFIG };
