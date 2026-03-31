# Changelog

## 0.1.0

- Initial release
- Status bar item showing 5h usage %, pace indicator, per-prompt delta
- Background color changes at warning (70%) and critical (90%) thresholds
- Native VS Code notifications at threshold crossings
- Hover tooltip with reset time, 7d usage, peak/off-peak status
- Click for detailed modal breakdown
- Live updates via `state.json` file watcher + 30s polling fallback
