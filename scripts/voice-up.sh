#!/usr/bin/env bash
# Starts Jarvis's local voice services (#73), bound to 127.0.0.1 only, and
# waits until they answer. Ctrl-C stops them all.
#
#   Kokoro-FastAPI  http://127.0.0.1:8880   (KOKORO_PORT)
#   Piper           http://127.0.0.1:5001   (PIPER_PORT; not 5000, which macOS uses for AirPlay)
#
# Their logs go to .voice/logs/ at warning level, so the text being spoken
# isn't logged.
set -euo pipefail

cd "$(dirname "$0")/.."
VOICE_DIR="$PWD/.voice"
KOKORO_PORT="${KOKORO_PORT:-8880}"
PIPER_PORT="${PIPER_PORT:-5001}"
LOGS="$VOICE_DIR/logs"

if [[ ! -d "$VOICE_DIR/kokoro-fastapi/.venv" || ! -d "$VOICE_DIR/piper/.venv" ]]; then
  echo "Run npm run voice:setup first." >&2
  exit 1
fi
mkdir -p "$LOGS"

pids=()
stop() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap stop EXIT INT TERM

(
  cd "$VOICE_DIR/kokoro-fastapi"
  export USE_GPU=true DEVICE_TYPE=mps PYTORCH_ENABLE_MPS_FALLBACK=1
  export PYTHONPATH="$PWD:$PWD/api" MODEL_DIR=src/models VOICES_DIR=src/voices/v1_0 WEB_PLAYER_PATH="$PWD/web"
  export API_LOG_LEVEL=WARNING HOST=127.0.0.1 PORT="$KOKORO_PORT"
  exec uv run --no-sync uvicorn api.src.main:app --host 127.0.0.1 --port "$KOKORO_PORT" --log-level warning --no-access-log
) >"$LOGS/kokoro.log" 2>&1 &
pids+=($!)

first_voice="$(ls "$VOICE_DIR/piper/voices"/*.onnx 2>/dev/null | head -n 1 | xargs -n1 basename 2>/dev/null | sed 's/\.onnx$//')"
if [[ -n "$first_voice" ]]; then
  "$VOICE_DIR/piper/.venv/bin/python" -m piper.http_server --host 127.0.0.1 --port "$PIPER_PORT" \
    --data-dir "$VOICE_DIR/piper/voices" -m "$first_voice" >"$LOGS/piper.log" 2>&1 &
  pids+=($!)
else
  echo "No Piper voices downloaded; skipping Piper." >&2
fi

wait_for() { # name url seconds
  for _ in $(seq 1 "$3"); do
    if curl -fsS -o /dev/null "$2" 2>/dev/null; then echo "✓ $1 is up at $2"; return 0; fi
    sleep 1
  done
  echo "✗ $1 didn't answer at $2 within $3 s; see $LOGS" >&2
  return 1
}
wait_for "Kokoro" "http://127.0.0.1:$KOKORO_PORT/health" 180 || true
[[ -n "$first_voice" ]] && { wait_for "Piper" "http://127.0.0.1:$PIPER_PORT/voices" 60 || true; }

echo "Voice services running (Ctrl-C to stop). Logs: $LOGS"
wait
