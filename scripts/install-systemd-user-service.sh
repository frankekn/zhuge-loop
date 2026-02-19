#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${1:-$(pwd)}"
CONFIG_PATH="${2:-$REPO_DIR/zhuge.config.json}"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_PATH="$SERVICE_DIR/zhuge-loop.service"

mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_PATH" <<SERVICE
[Unit]
Description=Zhuge Loop (user)
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
ExecStart=/usr/bin/node $REPO_DIR/src/cli.js run --config $CONFIG_PATH
Restart=on-failure
RestartSec=20
RestartPreventExitStatus=50
StartLimitIntervalSec=600
StartLimitBurst=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
SERVICE

systemctl --user daemon-reload
systemctl --user enable zhuge-loop.service

echo "Installed: $SERVICE_PATH"
echo "Start with: systemctl --user start zhuge-loop.service"
