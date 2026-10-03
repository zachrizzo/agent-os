#!/usr/bin/env bash
# Install Agent OS from this checkout: build + install the OpenClaw plugin, then (macOS) point the
# launchd data server (com.zach.agent-os-api, 127.0.0.1:5198) at this checkout's prototype/ and restart it.
# Usage: scripts/install.sh            (run from anywhere inside the repo)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.zach.agent-os-api"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"

echo "==> deps (real installs; the plugin installer rejects node_modules symlinks)"
for d in prototype plugin; do
  [ -L "$ROOT/$d/node_modules" ] && unlink "$ROOT/$d/node_modules"
  (cd "$ROOT/$d" && npm ci --no-audit --no-fund)
done

echo "==> build UI bundle + plugin"
(cd "$ROOT/prototype" && npx vite build --base ./ --outDir ../plugin/app --emptyOutDir)
(cd "$ROOT/plugin" && npm run build && npm run validate)

echo "==> install plugin into OpenClaw"
(cd "$ROOT/plugin" && openclaw plugins install . --force)

if [ "$(uname)" = "Darwin" ]; then
  echo "==> data server (launchd $LABEL)"
  [ -f "$PLIST" ] && cp "$PLIST" "$PLIST.bak-$(date +%Y%m%d%H%M%S)"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.openclaw/logs"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string>
    <string>--import</string><string>file://$ROOT/prototype/node_modules/tsx/dist/loader.mjs</string>
    <string>server/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT/prototype</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.openclaw/logs/agent-os-api.log</string>
  <key>StandardErrorPath</key><string>$HOME/.openclaw/logs/agent-os-api.log</string>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  for _ in $(seq 1 15); do
    curl -fs -o /dev/null http://127.0.0.1:5198/api/config && { echo "data server up on :5198"; break; }
    sleep 1
  done
else
  echo "==> not macOS: start the data server yourself: (cd prototype && node --import tsx server/index.ts)"
fi

echo "Done. Reload the Agent OS tab in the Control UI."
