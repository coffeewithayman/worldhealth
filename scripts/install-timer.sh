#!/usr/bin/env bash
#
# Install a systemd *user* timer that runs the daily update.
#
# A user timer rather than crontab, for three reasons that matter when a job
# runs unattended for months: output goes to the journal instead of vanishing
# into mail, `systemctl --user status` shows whether the last run actually
# succeeded, and Persistent=true catches up a run missed while the machine was
# off — which matters here because a skipped day is a hole in the score history.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
NODE_BIN="$(command -v node)"

mkdir -p "$UNIT_DIR"

cat > "$UNIT_DIR/world-dashboard.service" <<EOF
[Unit]
Description=World Dashboard daily update (ingest, derive, score)
Documentation=file://$REPO/README.md

[Service]
Type=oneshot
WorkingDirectory=$REPO
ExecStart=$NODE_BIN $REPO/packages/ingest/dist/cli.js daily
# Sources are fetched with bounded concurrency and retries; if the whole run is
# still going after 30 minutes something is wrong.
TimeoutStartSec=1800
Nice=10
EOF

cat > "$UNIT_DIR/world-dashboard.timer" <<EOF
[Unit]
Description=Run the World Dashboard update daily

[Timer]
# 07:20 local. Late enough that the prior US session has settled and Treasury
# has published the previous day's curve; early enough to read over coffee.
OnCalendar=*-*-* 07:20:00
# Catch up a run missed while the machine was asleep — a skipped day leaves a
# permanent hole in the composite score history.
Persistent=true
# Jitter avoids hammering upstream APIs at the same second as everyone else.
RandomizedDelaySec=600

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now world-dashboard.timer

echo "Installed. Useful commands:"
echo "  systemctl --user list-timers world-dashboard.timer"
echo "  systemctl --user start world-dashboard.service   # run once now"
echo "  journalctl --user -u world-dashboard.service -n 50"
echo
echo "Note: without lingering enabled, user timers only run while you are logged in."
echo "  sudo loginctl enable-linger $USER"
