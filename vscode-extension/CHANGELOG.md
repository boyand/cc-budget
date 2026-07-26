# Changelog

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
