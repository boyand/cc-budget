#!/usr/bin/env node
// Regenerates the README demo images from the real renderers, so they can't
// drift from the code: node demo/render.cjs
//   demo/cc-budget-modes.svg            animated, one line per plan
//   demo/cc-budget-preview-cropped.png  terminal preview (headless Chrome)
//   demo/vscode-extension-statusbar.png VS Code status bar (headless Chrome)
'use strict';

process.env.TZ = 'America/Los_Angeles';
process.env.XDG_CONFIG_HOME = '/nonexistent';  // built-in defaults, not your config
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Pinned clock: Tue 2026-11-03, PT. OFF = 14:00 (off-peak), PEAK = 08:51.
const OFF = Date.parse('2026-11-03T22:00:00Z');
const PEAK = Date.parse('2026-11-03T16:51:00Z');
let fixed = OFF;
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [fixed])); }
  static now() { return fixed; }
};

const ROOT = path.join(__dirname, '..');
const { formatStatusLine } = require('../lib/format.cjs');
const { loadConfig } = require('../lib/config.cjs');
const config = loadConfig();

// --- scenarios (state objects as lib/state.cjs builds them) ----------------
const at = (h) => Math.floor(fixed / 1000 + h * 3600);
const win = (pct, h) => ({ pct, resets_at: at(h) });
const ultra = (pct, h, extra = {}) => ({
  plan: 'sub', rate_limits: { five_hour: null, seven_day: win(pct, h) },
  day: { at: at(h), start_pct: pct - (extra.today ?? 4), allowance: (100 - pct + (extra.today ?? 4)) / Math.max(1, h / 24) },
  ...extra,
});
const maxPlan = (p5, h5, p7, h7, extra = {}) => ({
  plan: 'sub', rate_limits: { five_hour: win(p5, h5), seven_day: win(p7, h7) },
  day: { at: at(h7), start_pct: p7 - 3, allowance: (100 - p7 + 3) / Math.max(1, h7 / 24) },
  ...extra,
});
const fableCap = (pct) => [{ name: 'Fable', pct, resets_at: at(100) }];
const ledger = (pairs) => Object.fromEntries(pairs.map(([id, cost, day]) => [id, { cost, day: day || '2026-11-03', month: '2026-11' }]));

// Scenarios are thunks: the clock must be pinned before at() reads it.
function render(build, peak = false, cold = false) {
  fixed = peak ? PEAK : OFF;
  return formatStatusLine({ rate_limits: {}, ...build() }, config, peak, cold);
}

const S = {
  ultraCalm: () => render(() => ultra(38, 100, { delta: { seven_day: 0.4 } })),
  ultraBusy: () => render(() => ultra(52, 80, { delta: { seven_day: 1.3 }, today: 24 }), true),
  ultraHot: () => render(() => ultra(69, 82, { delta: { seven_day: 0.6 }, today: 6, cache: { cold: true, recache_tokens: 153000, expires_at: 0 } })),
  ultraFable: () => render(() => ultra(44, 90, { delta: { seven_day: 0.9 }, model: 'claude-fable-5-1', model_scoped: fableCap(61) })),
  maxCalm: () => render(() => maxPlan(16, 3.5, 30, 72, { delta: { five_hour: 0.8 } })),
  maxModerate: () => render(() => maxPlan(55, 2.5, 42, 72, { delta: { five_hour: 2.1 } })),
  maxWarn: () => render(() => maxPlan(78, 1.5, 45, 72, { delta: { five_hour: 3.5 } }), true),
  maxCrit: () => render(() => maxPlan(94, 0.5, 86, 72, { delta: { five_hour: 8.2 } }), true, true),
  gateway: () => render(() => ({ plan: 'gateway', session_cost_usd: 3.1, delta: { cost_usd: 0.4 }, rate_limits: { spend_limit: { pct: 54, resets_at: at(12 * 24 - 1), used_usd: 271.4, limit_usd: 500, period: 'monthly' } }, ledger: ledger([['a', 2.04]]) })),
  api: () => render(() => ({ plan: 'api', session_cost_usd: 14.5, delta: { cost_usd: 2.15 }, ledger: ledger([['a', 14.5], ['b', 8.3], ['c', 12.1, '2026-11-01']]) })),
};

// --- ANSI → styled runs -----------------------------------------------------
const COLORS = { 31: '#f85149', 32: '#3fb950', 33: '#d29922', 37: '#e6edf3', 91: '#ff7b72' };
const DIM = '#8b949e';
const FG = '#e6edf3';
function runs(ansi) {
  const out = [];
  let st = {};
  for (const part of ansi.split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[([0-9;]*)m$/);
    if (m) {
      for (const c of m[1].split(';')) {
        if (c === '0' || c === '') st = {};
        else if (c === '1') st = { ...st, bold: true };
        else if (c === '2') st = { ...st, dim: true };
        else if (COLORS[c]) st = { ...st, color: COLORS[c] };
      }
    } else if (part) out.push({ text: part, ...st });
  }
  return out.map(r => ({ ...r, fill: r.color || (r.dim ? DIM : FG), faded: !!(r.color && r.dim) }));
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const visible = (ansi) => ansi.replace(/\x1b\[[0-9;]*m/g, '');
const html = (ansi) => runs(ansi).map(r => `<span style="color:${r.fill}${r.bold ? ';font-weight:700' : ''}${r.faded ? ';opacity:.75' : ''}">${esc(r.text)}</span>`).join('');
const tspans = (ansi) => runs(ansi).map(r => `<tspan fill="${r.fill}"${r.bold ? ' font-weight="bold"' : ''}${r.faded ? ' fill-opacity=".75"' : ''}>${esc(r.text)}</tspan>`).join('');

// --- animated SVG -----------------------------------------------------------
function svg() {
  const modes = [['Ultra', S.ultraHot()], ['Max / Pro', S.maxModerate()], ['Gateway', S.gateway()], ['API / PAYG', S.api()]];
  const CH = 7.22, X = 124, T = 4;  // char width @12px mono, text x, seconds per mode
  const W = Math.ceil(X + Math.max(...modes.map(([, a]) => visible(a).length)) * CH + 20);
  const N = modes.length;
  const slot = 100 / N;
  const groups = modes.map(([label, a], i) => `    <g class="m" style="animation-delay:-${((N - i) % N) * T}s"${i ? ' opacity="0"' : ''}>
      <text x="${(110 - label.length * CH) / 2}" y="27" fill="${DIM}">${label}</text>
      <text x="${X}" y="27" xml:space="preserve">${tspans(a)}</text>
    </g>`).join('\n');
  return `<svg width="${W}" height="44" viewBox="0 0 ${W} 44" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="outer"><rect width="${W}" height="44" rx="6"/></clipPath>
    <style>
      @keyframes cyc{0%{opacity:0}2%,${(slot - 2).toFixed(1)}%{opacity:1}${slot}%,100%{opacity:0}}
      .m{animation:cyc ${N * T}s ease-in-out infinite}
      text{font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:12px}
    </style>
  </defs>
  <g clip-path="url(#outer)">
    <rect width="${W}" height="44" fill="#161b22"/>
    <rect width="110" height="44" fill="#21262d"/>
    <line x1="110" y1="8" x2="110" y2="36" stroke="#30363d" stroke-width="1"/>
${groups}
  </g>
</svg>
`;
}

// --- terminal preview -------------------------------------------------------
const ROW = 30, TITLE = 34, DIVIDER = 33, BAR = 40, PAD = 48;
function terminal() {
  const sections = [
    ['Ultra: the weekly limit is the bar', [
      ['Comfortable', S.ultraCalm()], ['Busy day', S.ultraBusy()], ['Running hot', S.ultraHot()], ['On Fable', S.ultraFable()]]],
    ['Pro / Max: 5-hour limit, weekly when it matters', [
      ['Comfortable', S.maxCalm()], ['Warning', S.maxWarn()], ['Critical', S.maxCrit()]]],
    ['Gateway spend limit, API', [['Gateway', S.gateway()], ['API / PAYG', S.api()]]],
  ];
  // Legend values come from the "Running hot" row so they always match it.
  const hot = visible(S.ultraHot());
  const [, used, share] = hot.match(/today (\d+)\/(\d+)%/);
  const [, outDay, outTime] = hot.match(/out (\S+) (\S+)/);
  const dayName = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' }[outDay] || 'today';
  const legend = [
    [`today ${used}/${share}%`, `${used}% of the week used today, out of an even ${share}% daily share`],
    [`out ${outDay} ${outTime}`, `At this week’s pace you hit the limit ${dayName} ${outTime}, before the reset`],
    ['cold 153k', 'Prompt cache expired: the next prompt re-caches 153k tokens'],
    ['(+0.6)', 'Last prompt cost 0.6% of the window shown'],
  ];
  let h = BAR + PAD;
  const body = sections.map(([title, rows], i) => {
    h += TITLE + rows.length * ROW + (i ? DIVIDER : 0);
    return `${i ? '<div class="divider"></div>' : ''}<div class="title">${title}</div>
${rows.map(([l, a]) => `<div class="row"><span class="label">${l}</span>${html(a)}</div>`).join('\n')}`;
  }).join('\n');
  h += DIVIDER + TITLE + legend.length * ROW;
  const leg = legend.map(([k, v]) => `<div class="row"><span class="key">${esc(k)}</span><span style="color:${FG}">${esc(v)}</span></div>`).join('\n');
  const width = 160 + 48 + Math.max(...sections.flatMap(([, r]) => r.map(([, a]) => visible(a).length))) * 8.43;
  return { width: Math.ceil(width), height: h, page: `<!doctype html><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#0d1117;width:${Math.ceil(width)}px;height:${h}px;overflow:hidden}
.bar{height:${BAR}px;background:#161b22;display:flex;align-items:center;gap:8px;padding:0 16px;font:500 13px -apple-system,sans-serif;color:#8b949e}
.dot{width:12px;height:12px;border-radius:50%}
.content{padding:${PAD / 2}px 24px;font:14px 'SF Mono',Menlo,monospace}
.title{height:${TITLE}px;line-height:${TITLE}px;color:#8b949e;font-size:11px;letter-spacing:1.5px;text-transform:uppercase}
.row{height:${ROW}px;line-height:${ROW}px;white-space:pre}
.label{display:inline-block;width:130px;color:#8b949e;font-size:12px}
.key{display:inline-block;width:170px;color:#8b949e}
.divider{height:${DIVIDER}px;border-bottom:1px solid #21262d;margin-bottom:0;transform:translateY(-16px)}
</style>
<div class="bar"><span class="dot" style="background:#ff5f56"></span><span class="dot" style="background:#ffbd2e"></span><span class="dot" style="background:#27c93f"></span><span style="margin-left:8px">Claude Code: cc-budget status line</span></div>
<div class="content">
${body}
<div class="divider"></div><div class="title">Reading the weekly line</div>
${leg}
</div>` };
}

// --- VS Code status bar (text from the real extension) -----------------------
function vscodeText() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-demo-'));
  fs.mkdirSync(path.join(home, '.claude', 'cc-budget'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'cc-budget', 'state.json'), JSON.stringify({
    v: 1, ts: Date.now(), rate_limits: { five_hour: null, seven_day: win(85, 60) }, delta: { seven_day: 0.4 },
  }));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  const Module = require('module');
  const item = { show() {} };
  const notes = [];
  const stub = {
    window: { createStatusBarItem: () => item, showWarningMessage: (m) => notes.push(m), showErrorMessage: (m) => notes.push(m), showInformationMessage() {} },
    StatusBarAlignment: { Right: 2 }, ThemeColor: function (id) { this.id = id; },
    commands: { registerCommand: () => ({}) },
  };
  const load = Module._load;
  Module._load = (req, ...rest) => (req === 'vscode' ? stub : load(req, ...rest));
  const ext = require('../vscode-extension/src/extension.js');
  try { ext.activate({ subscriptions: [] }); } finally { ext.deactivate(); Module._load = load; process.env.HOME = prevHome; }
  return { text: item.text, note: notes[0] };
}

function vscode() {
  const { text, note } = vscodeText();
  const gauge = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.3"/><path d="M8 8l3-3"/><circle cx="8" cy="8" r=".9" fill="currentColor"/></svg>';
  const warn = '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="#cca700" stroke-width="1.2"><path d="M8 1.8l6.6 12H1.4z"/><path d="M8 6v4M8 11.6v.6"/></svg>';
  const label = esc(text.replace('$(dashboard) ', '').replace('$(warning) ', ''));
  return `<!doctype html><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:796px;height:196px;background:#1f1f1f;overflow:hidden;font:13px -apple-system,'Segoe UI',sans-serif;color:#cccccc}
.input{position:absolute;left:56px;top:82px;width:678px;height:78px;border:1px solid #3c3c3c;border-radius:8px;background:#252526;padding:14px 16px;color:#8b8b8b}
.toast{position:absolute;right:12px;top:90px;width:450px;background:#252526;border:1px solid #454545;border-radius:4px;box-shadow:0 4px 16px rgba(0,0,0,.45)}
.toast .head{height:34px;line-height:34px;padding:0 10px;font-size:11px;letter-spacing:.4px;color:#cccccc}
.toast .msg{display:flex;align-items:center;gap:8px;height:40px;padding:0 10px;border:1px solid #2b79d0;border-radius:0 0 4px 4px;background:#2a2d2e;font-size:13px}
.status{position:absolute;left:0;right:0;bottom:0;height:22px;background:#181818;border-top:1px solid #2b2b2b;display:flex;justify-content:flex-end;align-items:center;font-size:12px}
.item{height:22px;display:flex;align-items:center;gap:5px;padding:0 8px;color:#cccccc}
.cc{background:#7a6a00;color:#ffffff}
</style>
<div class="input">⌘ Esc to focus or unfocus Claude</div>
<div class="toast"><div class="head">NOTIFICATIONS</div><div class="msg">${warn}<span>${esc(note || '')}</span></div></div>
<div class="status"><span class="item">Ln 42, Col 7</span><span class="item">UTF-8</span><span class="item cc">${gauge}<span>${label}</span></span><span class="item"><svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="#cccccc" stroke-width="1.2"><path d="M4 11V7a4 4 0 018 0v4l1.2 1.5H2.8z"/><path d="M6.5 14a1.5 1.5 0 003 0"/></svg></span></div>`;
}

// --- write + screenshot -----------------------------------------------------
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
function shoot(htmlText, w, h, out) {
  const tmp = path.join(os.tmpdir(), `ccb-demo-${process.pid}-${path.basename(out)}.html`);
  fs.writeFileSync(tmp, htmlText);
  execFileSync(CHROME, ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
    `--window-size=${w},${h}`, `--screenshot=${out}`, `file://${tmp}`], { stdio: 'ignore' });
  fs.unlinkSync(tmp);
}

fs.writeFileSync(path.join(__dirname, 'cc-budget-modes.svg'), svg());
const t = terminal();
fs.writeFileSync(path.join(__dirname, 'terminal-mockup.html'), t.page);  // gitignored, for tweaking
if (fs.existsSync(CHROME) && !process.argv.includes('--svg-only')) {
  shoot(t.page, t.width, t.height, path.join(__dirname, 'cc-budget-preview-cropped.png'));
  shoot(vscode(), 796, 196, path.join(__dirname, 'vscode-extension-statusbar.png'));
}
console.log('demo images written');
