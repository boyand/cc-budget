const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_FILE = path.join(os.homedir(), '.claude', 'cc-budget', 'state.json');
const CONFIG_FILE = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'cc-budget',
  'config.json'
);

const DEFAULTS = {
  thresholds: { warn_5h: 90, critical_5h: 95, warn_7d: 80, critical_7d: 90 },
  peak: { start_hour: 5, end_hour: 11, timezone: 'America/Los_Angeles', weekdays_only: true },
  show_delta: true,
  show_7d: 'auto',
};

let statusBarItem;
let watcher;
let pollInterval;
let lastWarned = { five_hour: null, seven_day: null };

function activate(context) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBarItem.command = 'cc-budget.showDetails';
  statusBarItem.name = 'cc-budget';
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('cc-budget.showDetails', showDetails)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('cc-budget.refresh', () => update())
  );

  // Watch state file for changes
  try {
    const stateDir = path.dirname(STATE_FILE);
    if (fs.existsSync(stateDir)) {
      watcher = fs.watch(stateDir, (event, filename) => {
        if (filename === 'state.json') update();
      });
      context.subscriptions.push({ dispose: () => watcher.close() });
    }
  } catch {}

  // Poll every 30s as fallback (fs.watch can miss events)
  pollInterval = setInterval(() => update(), 30000);
  context.subscriptions.push({ dispose: () => clearInterval(pollInterval) });

  update();
}

function deactivate() {
  if (watcher) watcher.close();
  if (pollInterval) clearInterval(pollInterval);
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
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

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw);
    if (state && state.v === 1) return state;
  } catch {}
  return null;
}

function isPeak(peakConfig) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: peakConfig.timezone,
      hour: 'numeric', hour12: false,
      weekday: 'short',
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date()).map(p => [p.type, p.value])
    );
    const hour = parseInt(parts.hour, 10);
    const isWeekday = !['Sat', 'Sun'].includes(parts.weekday);
    if (peakConfig.weekdays_only && !isWeekday) return false;
    return hour >= peakConfig.start_hour && hour < peakConfig.end_hour;
  } catch {
    return false;
  }
}

function paceTarget(resetsAtEpochSec, windowHours) {
  const resetMs = resetsAtEpochSec * 1000;
  const windowMs = windowHours * 3600 * 1000;
  const startMs = resetMs - windowMs;
  const elapsed = Date.now() - startMs;
  if (elapsed <= 0 || elapsed >= windowMs) return null;
  return (elapsed / windowMs) * 100;
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

function update() {
  const state = readState();
  if (!state) {
    statusBarItem.text = '$(pulse) cc-budget: waiting...';
    statusBarItem.tooltip = 'Waiting for Claude Code to report usage data';
    statusBarItem.backgroundColor = undefined;
    statusBarItem.show();
    return;
  }

  const config = loadConfig();
  const fh = state.rate_limits.five_hour;
  const sd = state.rate_limits.seven_day;
  const peak = isPeak(config.peak);

  if (!fh) {
    if (state.session_cost_usd != null) {
      statusBarItem.text = `$(credit-card) $${state.session_cost_usd.toFixed(2)}`;
      statusBarItem.tooltip = 'API/PAYG session cost';
      statusBarItem.backgroundColor = undefined;
    } else {
      statusBarItem.text = '$(pulse) cc-budget: ...';
      statusBarItem.tooltip = 'No rate limit data yet';
      statusBarItem.backgroundColor = undefined;
    }
    statusBarItem.show();
    return;
  }

  const pct = Math.round(fh.pct);
  const pace = fh.resets_at ? paceTarget(fh.resets_at, 5) : null;
  const paceDelta = pace != null ? Math.round(fh.pct - pace) : null;

  // Icon based on severity
  let icon;
  if (pct >= 90) icon = '$(warning)';
  else if (pct >= 70) icon = '$(dashboard)';
  else icon = '$(dashboard)';

  // Status bar text
  let text = `${icon} 5h: ${pct}%`;

  // Pace indicator
  if (paceDelta != null) {
    if (paceDelta > 2) text += ` \u21E1${Math.abs(paceDelta)}%`;
    else if (paceDelta < -2) text += ` \u21E3${Math.abs(paceDelta)}%`;
  }

  // Delta from last prompt
  if (config.show_delta && state.delta && state.delta.five_hour > 0) {
    text += ` (+${state.delta.five_hour.toFixed(1)})`;
  }

  // Peak indicator
  if (peak) text += ' \u25B2pk';

  statusBarItem.text = text;

  // Background color for severity
  if (pct >= 90) {
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (pct >= 70) {
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    statusBarItem.backgroundColor = undefined;
  }

  // Tooltip with full details
  const lines = [`5h usage: ${pct}%`];
  if (fh.resets_at) lines.push(`Resets in: ${formatResetTime(fh.resets_at)}`);
  if (paceDelta != null) {
    if (paceDelta > 2) lines.push(`Pace: ${Math.abs(paceDelta)}% over (burning too fast)`);
    else if (paceDelta < -2) lines.push(`Pace: ${Math.abs(paceDelta)}% under (headroom)`);
    else lines.push('Pace: on target');
  }
  if (state.delta && state.delta.five_hour > 0) {
    lines.push(`Last prompt: +${state.delta.five_hour.toFixed(1)}%`);
  }
  if (sd) lines.push(`7d usage: ${Math.round(sd.pct)}%`);
  lines.push(peak ? 'Peak hours (higher cost)' : 'Off-peak');
  if (state.ts) {
    const ago = Math.round((Date.now() - state.ts) / 1000);
    lines.push(`Updated: ${ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`}`);
  }
  statusBarItem.tooltip = lines.join('\n');
  statusBarItem.show();

  // Threshold notifications (once per crossing, matches CLI behavior)
  checkThresholds(fh, sd, config, peak);
}

function checkThresholds(fh, sd, config, peak) {
  const { thresholds } = config;
  const pct5h = fh.pct;

  if (pct5h >= thresholds.critical_5h && lastWarned.five_hour !== thresholds.critical_5h) {
    const msg = `cc-budget: 5h usage at ${Math.round(pct5h)}%. Resets in ${formatResetTime(fh.resets_at)}.${peak ? ' Peak hours — consider waiting.' : ''}`;
    vscode.window.showErrorMessage(msg);
    lastWarned.five_hour = thresholds.critical_5h;
  } else if (pct5h >= thresholds.warn_5h && (lastWarned.five_hour == null || lastWarned.five_hour < thresholds.warn_5h)) {
    const msg = `cc-budget: 5h usage at ${Math.round(pct5h)}%. Resets in ${formatResetTime(fh.resets_at)}.`;
    vscode.window.showWarningMessage(msg);
    lastWarned.five_hour = thresholds.warn_5h;
  }

  if (sd) {
    const pct7d = sd.pct;
    if (pct7d >= thresholds.critical_7d && lastWarned.seven_day !== thresholds.critical_7d) {
      vscode.window.showErrorMessage(`cc-budget: 7d usage at ${Math.round(pct7d)}%.`);
      lastWarned.seven_day = thresholds.critical_7d;
    } else if (pct7d >= thresholds.warn_7d && (lastWarned.seven_day == null || lastWarned.seven_day < thresholds.warn_7d)) {
      vscode.window.showWarningMessage(`cc-budget: 7d usage at ${Math.round(pct7d)}%.`);
      lastWarned.seven_day = thresholds.warn_7d;
    }
  }

  // Reset warnings when window resets (usage drops below warn threshold)
  if (pct5h < thresholds.warn_5h) lastWarned.five_hour = null;
  if (sd && sd.pct < thresholds.warn_7d) lastWarned.seven_day = null;
}

function showDetails() {
  const state = readState();
  if (!state) {
    vscode.window.showInformationMessage('cc-budget: No usage data available. Start a Claude Code session first.');
    return;
  }

  const config = loadConfig();
  const fh = state.rate_limits.five_hour;
  const sd = state.rate_limits.seven_day;
  const peak = isPeak(config.peak);

  const lines = ['cc-budget — Claude Code Usage', ''];

  if (!fh) {
    if (state.session_cost_usd != null) {
      lines.push(`Session cost: $${state.session_cost_usd.toFixed(2)}`);
    } else {
      lines.push('No rate limit data yet.');
    }
  } else {
    const pct = Math.round(fh.pct);
    const pace = fh.resets_at ? paceTarget(fh.resets_at, 5) : null;

    lines.push(`5h window: ${pct}%`);
    if (fh.resets_at) lines.push(`  Resets in: ${formatResetTime(fh.resets_at)}`);
    if (pace != null) {
      const delta = Math.round(fh.pct - pace);
      if (delta > 2) lines.push(`  Pace: ${Math.abs(delta)}% over target`);
      else if (delta < -2) lines.push(`  Pace: ${Math.abs(delta)}% under target (headroom)`);
      else lines.push('  Pace: on target');
    }
    if (state.delta && state.delta.five_hour > 0) {
      lines.push(`  Last prompt cost: +${state.delta.five_hour.toFixed(1)}%`);
    }

    if (sd) {
      lines.push('');
      lines.push(`7d window: ${Math.round(sd.pct)}%`);
      if (sd.resets_at) lines.push(`  Resets in: ${formatResetTime(sd.resets_at)}`);
    }

    lines.push('');
    lines.push(peak ? 'Peak hours active (5-11 AM PT weekdays)' : 'Off-peak');
  }

  vscode.window.showInformationMessage(lines.join('\n'), { modal: true });
}

module.exports = { activate, deactivate };
