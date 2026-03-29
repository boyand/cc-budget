#!/usr/bin/env bash
set -euo pipefail

HOOK_DIR="$HOME/.claude/hooks/cc-budget"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/cc-budget"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing cc-budget..."

# Copy code
mkdir -p "$HOOK_DIR/lib"
cp "$SCRIPT_DIR/statusline.cjs" "$SCRIPT_DIR/hook.cjs" "$HOOK_DIR/"
cp "$SCRIPT_DIR/lib/"*.cjs "$HOOK_DIR/lib/"

# Create config if not exists
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/config.json" ]; then
  cp "$SCRIPT_DIR/config.example.json" "$CONFIG_DIR/config.json"
  echo "  Created config at $CONFIG_DIR/config.json"
else
  echo "  Config already exists at $CONFIG_DIR/config.json (kept)"
fi

echo "  Code installed to $HOOK_DIR/"
echo ""
echo "Add to ~/.claude/settings.json:"
echo ""
echo '  "statusLine": {'
echo '    "type": "command",'
echo "    \"command\": \"node $HOOK_DIR/statusline.cjs\""
echo '  }'
echo ""
echo '  Under "hooks" -> "UserPromptSubmit", add:'
echo '  {'
echo '    "matcher": "",'
echo '    "hooks": [{'
echo '      "type": "command",'
echo "      \"command\": \"node $HOOK_DIR/hook.cjs\","
echo '      "timeout": 5000'
echo '    }]'
echo '  }'
echo ""
echo "Done. Run: node $HOOK_DIR/statusline.cjs --legend"
