# cc-budget for VS Code

Budget intelligence for Claude Code — right in your VS Code status bar.

![Status Bar Preview](https://raw.githubusercontent.com/boyand/cc-budget/main/demo/cc-budget-preview-cropped.png)

## What it does

Surfaces your Claude Code usage data in the VS Code status bar so you can see it without switching to the terminal:

- **5h usage %** with progress toward your rate limit
- **Pace indicator** — are you burning too fast or have headroom?
- **Per-prompt delta** — what each prompt actually cost
- **Peak/off-peak** awareness (Anthropic charges more 5-11 AM PT weekdays)
- **Threshold warnings** — native VS Code notifications at 90% and 95%

## Prerequisites

This extension reads data written by the [cc-budget CLI hooks](https://github.com/boyand/cc-budget). Install those first:

```bash
git clone https://github.com/boyand/cc-budget /tmp/cc-budget
cd /tmp/cc-budget && ./install.sh
```

## How it works

1. The cc-budget CLI hooks run inside Claude Code and write usage data to `~/.claude/cc-budget/state.json`
2. This extension watches that file and renders the data in the VS Code status bar
3. Click the status bar item for a detailed breakdown
4. At threshold crossings, a VS Code notification appears

No API calls. No authentication. Just reads a local JSON file.

## Status bar format

```
$(dashboard) 5h: 42% ⇣8% (+1.2)
```

| Part | Meaning |
|------|---------|
| `5h: 42%` | 5-hour window usage |
| `⇣8%` | 8% under pace (headroom) |
| `⇡12%` | 12% over pace (burning too fast) |
| `(+1.2)` | Last prompt cost 1.2% of window |
| `▲pk` | Peak hours active |

## Colors

| Color | Usage | Meaning |
|-------|-------|---------|
| Default | 0-69% | Everything fine |
| Yellow background | 70-89% | Be mindful |
| Red background | 90%+ | Action likely needed |

## Commands

- **cc-budget: Show Budget Details** — modal with full breakdown
- **cc-budget: Refresh** — force a status bar update

## Configuration

No extension settings needed. The extension reads the same config as the CLI:

```
~/.config/cc-budget/config.json
```

See the [main project README](https://github.com/boyand/cc-budget#configuration) for config options.

## License

MIT
