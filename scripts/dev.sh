#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
command -v uv >/dev/null || { printf 'uv is required.\n'; exit 1; }
command -v pnpm >/dev/null || { printf 'pnpm is required.\n'; exit 1; }
if [ ! -f "$ROOT/backend/.env" ]; then
  python3 "$ROOT/scripts/init_env.py"
  printf 'Add model credentials to backend/.env before asking model-backed questions.\n'
fi
for port in 8010 5174; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'Port %s is already in use. Existing workbench: http://127.0.0.1:5174\n' "$port"
    exit 1
  fi
done
docker compose --env-file "$ROOT/deploy/.env" -f "$ROOT/deploy/compose.yml" up -d --wait
uv sync --project "$ROOT/backend" --locked
(cd "$ROOT/backend" && uv run alembic upgrade head)
(cd "$ROOT/frontend" && pnpm install --frozen-lockfile)
cleanup() {
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
}
(cd "$ROOT/backend" && exec uv run uvicorn app.main:app --host 127.0.0.1 --port 8010) &
BACKEND_PID=$!
(cd "$ROOT/frontend" && exec pnpm dev --host 127.0.0.1 --port 5174 --strictPort) &
FRONTEND_PID=$!
trap cleanup EXIT INT TERM
printf '\nTraceMind: http://127.0.0.1:5174\nAPI docs: http://127.0.0.1:8010/docs\nMCP: http://127.0.0.1:8010/mcp\nCtrl+C stops the app, not database containers or saved data.\n'
wait "$BACKEND_PID" "$FRONTEND_PID"
