#!/usr/bin/env bash
# Build the web UI locally, sync the repo to the VM, install runtime deps and restart the service.
# Usage: deploy/deploy.sh [ssh-host]   (default: tt)
set -euo pipefail
HOST="${1:-tt}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

npm run build

ssh "$HOST" "sudo mkdir -p /opt/ddz && sudo chown \$(whoami): /opt/ddz"

rsync -az --delete \
  --exclude node_modules --exclude data --exclude .git --exclude .worktrees \
  --exclude 'sdk/python/.venv' --exclude '__pycache__' \
  ./ "$HOST:/opt/ddz/"

ssh "$HOST" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/ddz
npm ci --omit=dev --no-audit --no-fund --ignore-scripts
if [ ! -f /etc/ddz.env ]; then
  code=$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12)
  printf 'PORT=80\nHOST=0.0.0.0\nDDZ_DB=/opt/ddz/data/ddz.db\nDDZ_INVITE_CODE=%s\n' "$code" | sudo tee /etc/ddz.env >/dev/null
  echo "created /etc/ddz.env with invite code: $code"
fi
sudo cp deploy/ddz.service /etc/systemd/system/ddz.service
sudo systemctl daemon-reload
sudo systemctl enable --now ddz
sudo systemctl restart ddz
sleep 2
curl -fsS "localhost:$(grep -oP '(?<=^PORT=)\d+' /etc/ddz.env)/healthz" && echo
REMOTE
