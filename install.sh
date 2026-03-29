#!/usr/bin/env bash
set -euo pipefail

HOOK_DIR="$HOME/.claude/hooks/cc-budget"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/cc-budget"
SETTINGS="$HOME/.claude/settings.json"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing cc-budget..."

# Copy code
mkdir -p "$HOOK_DIR/lib"
cp "$SCRIPT_DIR/statusline.cjs" "$SCRIPT_DIR/hook.cjs" "$HOOK_DIR/"
cp "$SCRIPT_DIR/lib/"*.cjs "$HOOK_DIR/lib/"
echo "  Code installed to $HOOK_DIR/"

# Create config if not exists
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/config.json" ]; then
  cp "$SCRIPT_DIR/config.example.json" "$CONFIG_DIR/config.json"
  echo "  Config created at $CONFIG_DIR/config.json"
else
  echo "  Config already exists at $CONFIG_DIR/config.json (kept)"
fi

# Patch settings.json
if [ ! -f "$SETTINGS" ]; then
  echo "  Warning: $SETTINGS not found. Create it or add settings manually."
  echo ""
  echo "  Required settings.json entries:"
  echo "    statusLine.command: node $HOOK_DIR/statusline.cjs"
  echo "    hooks.UserPromptSubmit: node $HOOK_DIR/hook.cjs"
  exit 0
fi

if ! command -v node &>/dev/null; then
  echo "  Warning: node not found. settings.json not patched."
  echo "  Add statusLine and UserPromptSubmit hook manually."
  exit 0
fi

# Use node to safely merge into settings.json (no jq dependency)
node -e "
const fs = require('fs');
const settings = JSON.parse(fs.readFileSync('$SETTINGS', 'utf-8'));

// Add statusLine
settings.statusLine = {
  type: 'command',
  command: 'node $HOOK_DIR/statusline.cjs'
};

// Add UserPromptSubmit hook (don't clobber existing hooks)
if (!settings.hooks) settings.hooks = {};
if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];

const hookCmd = 'node $HOOK_DIR/hook.cjs';
const alreadyInstalled = settings.hooks.UserPromptSubmit.some(
  h => h.hooks && h.hooks.some(hh => hh.command && hh.command.includes('cc-budget'))
);

if (!alreadyInstalled) {
  settings.hooks.UserPromptSubmit.push({
    matcher: '',
    hooks: [{
      type: 'command',
      command: hookCmd,
      timeout: 5000
    }]
  });
}

fs.writeFileSync('$SETTINGS', JSON.stringify(settings, null, 2) + '\n');
console.log('  settings.json patched');
"

echo ""
echo "Done! Restart Claude Code to activate."
echo "Run: node $HOOK_DIR/statusline.cjs --legend"
