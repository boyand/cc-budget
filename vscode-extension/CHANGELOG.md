# Changelog

## 0.3.0

- Ultra accounts (no 5-hour limit): the weekly window becomes the main status bar segment, with its pace and per-prompt delta, instead of falling back to "API session cost"
- Claude gateway spend limit shown next to session cost, with severity colors
- Reset times past 24h read as days (`3d05h`)

## 0.2.0

- Per-model weekly limits (e.g. the separate Fable 5 cap from /usage): status bar segment, tooltip and details lines, background severity, and native notifications at the 7d thresholds

## 0.1.0

- Initial release
- Status bar item showing 5h usage %, pace indicator, per-prompt delta
- Background color changes at warning (70%) and critical (90%) thresholds
- Native VS Code notifications at threshold crossings
- Hover tooltip with reset time, 7d usage, peak/off-peak status
- Click for detailed modal breakdown
- Live updates via `state.json` file watcher + 30s polling fallback
