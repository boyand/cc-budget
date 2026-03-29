# cc-budget

Claude Code usage monitor with progressive status line display, pacing indicators, peak/off-peak awareness, and threshold warnings.

## What it does

- **Progress bar with pacing marker** — shows your 5h/7d usage with a white `│` marker at where you *should* be for even distribution
- **Pace indicator** — `⇣14%` (under pace, headroom) / `⇡12%` (over pace, burning too fast)
- **Per-prompt delta** — `(+2.3)` shows how much your last prompt cost as % of the 5h window
- **Peak/off-peak** — `▲ peak 3h left` / `▽ off-peak 21h` with countdown timers
- **Threshold warnings** — fires once at 90% and 95% via UserPromptSubmit hook (under 20 tokens)
- **Reset countdown** — `➞2h15m` shows when the 5h window resets

```
5h ▓▓▓│░░░░░ 24% (+1.2) ⇣6% ➞3h15m │ ▽ off-peak 21h05m
```

## Install

```bash
# Clone
git clone <repo-url> /tmp/cc-budget && cd /tmp/cc-budget

# Run installer
./install.sh
```

Or manually:

```bash
# Copy code
mkdir -p ~/.claude/hooks/cc-budget/lib
cp statusline.cjs hook.cjs ~/.claude/hooks/cc-budget/
cp lib/*.cjs ~/.claude/hooks/cc-budget/lib/

# Create config (optional — sensible defaults built in)
mkdir -p ~/.config/cc-budget
cp config.example.json ~/.config/cc-budget/config.json

# Add to ~/.claude/settings.json:
# "statusLine": {
#   "type": "command",
#   "command": "node $HOME/.claude/hooks/cc-budget/statusline.cjs"
# }
#
# Under "hooks" -> "UserPromptSubmit", add:
# {
#   "matcher": "",
#   "hooks": [{
#     "type": "command",
#     "command": "node $HOME/.claude/hooks/cc-budget/hook.cjs",
#     "timeout": 5000
#   }]
# }
```

## Requirements

- Node.js (ships with Claude Code)
- Claude Code v2.1.80+ (provides `rate_limits` in status line JSON)
- Claude Max or Pro plan (API/PAYG users see session cost instead)

## Configuration

Edit `~/.config/cc-budget/config.json`:

```json
{
  "thresholds": {
    "warn_5h": 90,       // warn at this 5h usage %
    "critical_5h": 95,   // critical warning at this %
    "warn_7d": 80,
    "critical_7d": 90
  },
  "peak": {
    "start_hour": 5,           // peak start (PT)
    "end_hour": 11,            // peak end (PT)
    "timezone": "America/Los_Angeles",
    "weekdays_only": true
  },
  "show_delta": true,    // show (+N.N) last prompt cost
  "show_7d": "auto"      // "auto" | "always" | "never"
}
```

## Visual legend

```bash
node ~/.claude/hooks/cc-budget/statusline.cjs --legend
```

## ccstatusline integration

If you use [ccstatusline](https://github.com/sirmalloc/ccstatusline), add cc-budget as a Custom Command widget instead of replacing your statusline:

```yaml
widgets:
  - type: customCommand
    command: "node ~/.claude/hooks/cc-budget/statusline.cjs --widget"
    timeout: 1000
```

Widget mode outputs only what ccstatusline doesn't have: pacing (`⇡`/`⇣`), per-prompt delta, and peak indicator. The hook warnings work regardless of which statusline you use.

## How it works

1. **Status line** reads the `rate_limits` JSON that Claude Code pipes to stdin on every assistant message
2. Writes state to `~/.claude/cc-budget/state.json` (atomic writes, SIGTERM-safe)
3. Computes delta from previous reading, pacing target, peak/off-peak status
4. Outputs a progressive display: more detail appears as usage increases
5. **Hook** reads the state file on each prompt submission, warns once per threshold crossing

Zero external dependencies. Zero API calls. All data comes from Claude Code's built-in status line JSON.

## Uninstall

```bash
rm -rf ~/.claude/hooks/cc-budget ~/.claude/cc-budget ~/.config/cc-budget
# Then remove the statusLine and UserPromptSubmit entries from ~/.claude/settings.json
```

## License

MIT
