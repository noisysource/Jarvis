#!/usr/bin/env bash
# Starts Jarvis's local voice services (#73), bound to 127.0.0.1 only, and
# waits until they answer. Ctrl-C stops them all.
#
#   Kokoro-FastAPI  http://127.0.0.1:8880   (KOKORO_PORT)
#   Piper           http://127.0.0.1:5001   (PIPER_PORT; not 5000, which macOS uses for AirPlay)
#   Whisper         http://127.0.0.1:8178   (WHISPER_PORT; WHISPER_MODEL=small.en or base.en)
#
# Their logs go to .voice/logs/ at warning level, so the text being spoken
# isn't logged. whisper-server is started without --print-realtime (it
# doesn't print what it heard) and without --convert (it decodes audio in
# memory and writes no files).
set -euo pipefail

cd "$(dirname "$0")/.."
VOICE_DIR="$PWD/.voice"
KOKORO_PORT="${KOKORO_PORT:-8880}"
PIPER_PORT="${PIPER_PORT:-5001}"
WHISPER_PORT="${WHISPER_PORT:-8178}"
WHISPER_MODEL="${WHISPER_MODEL:-small.en}"
LOGS="$VOICE_DIR/logs"
# While this script waits for a service, .voice/run/<service>.starting holds
# this script's PID, so /voices can say "Kokoro is starting" instead of "not
# running" (the first start takes a minute or two). Cleared once the service
# answers, gives up, or this script stops.
RUN="$VOICE_DIR/run"

if [[ ! -d "$VOICE_DIR/kokoro-fastapi/.venv" || ! -d "$VOICE_DIR/piper/.venv" ]]; then
  echo "Run npm run voice:setup first." >&2
  exit 1
fi
mkdir -p "$LOGS" "$RUN"
starting() { echo "$$" >"$RUN/$1.starting"; }
started() { rm -f "$RUN/$1.starting"; }

pids=()
stop() {
  started kokoro
  started piper
  started whisper
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
# Ctrl-C or a TERM exits (a plain trap would run stop and carry on waiting); exiting runs stop once.
trap stop EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

starting kokoro
(
  cd "$VOICE_DIR/kokoro-fastapi"
  export USE_GPU=true DEVICE_TYPE=mps PYTORCH_ENABLE_MPS_FALLBACK=1
  export PYTHONPATH="$PWD:$PWD/api" MODEL_DIR=src/models VOICES_DIR=src/voices/v1_0 WEB_PLAYER_PATH="$PWD/web"
  export API_LOG_LEVEL=WARNING HOST=127.0.0.1 PORT="$KOKORO_PORT"
  exec uv run --no-sync uvicorn api.src.main:app --host 127.0.0.1 --port "$KOKORO_PORT" --log-level warning --no-access-log
) >"$LOGS/kokoro.log" 2>&1 &
pids+=($!)

# A glob, not ls: under pipefail, ls failing on no voices would stop the script.
first_voice=""
for f in "$VOICE_DIR/piper/voices"/*.onnx; do
  if [[ -e "$f" ]]; then first_voice="$(basename "$f" .onnx)"; break; fi
done
if [[ -n "$first_voice" ]]; then
  starting piper
  "$VOICE_DIR/piper/.venv/bin/python" -m piper.http_server --host 127.0.0.1 --port "$PIPER_PORT" \
    --data-dir "$VOICE_DIR/piper/voices" -m "$first_voice" >"$LOGS/piper.log" 2>&1 &
  pids+=($!)
else
  echo "No Piper voices downloaded; skipping Piper." >&2
fi

whisper_model="$VOICE_DIR/whisper/ggml-$WHISPER_MODEL.bin"
if [[ -f "$whisper_model" ]] && command -v whisper-server >/dev/null 2>&1; then
  starting whisper
  whisper-server --host 127.0.0.1 --port "$WHISPER_PORT" -m "$whisper_model" -l en >"$LOGS/whisper.log" 2>&1 &
  pids+=($!)
else
  echo "Whisper isn't set up ($whisper_model); skipping it. Run npm run voice:setup." >&2
  whisper_model=""
fi

wait_for() { # name url seconds service
  for _ in $(seq 1 "$3"); do
    if curl -fsS -o /dev/null "$2" 2>/dev/null; then started "$4"; echo "✓ $1 is up at $2"; return 0; fi
    sleep 1
  done
  started "$4"
  echo "✗ $1 didn't answer at $2 within $3 s; see $LOGS" >&2
  return 1
}
wait_for "Kokoro" "http://127.0.0.1:$KOKORO_PORT/health" 180 kokoro || true
[[ -n "$first_voice" ]] && { wait_for "Piper" "http://127.0.0.1:$PIPER_PORT/voices" 60 piper || true; }
[[ -n "$whisper_model" ]] && { wait_for "Whisper ($WHISPER_MODEL)" "http://127.0.0.1:$WHISPER_PORT/health" 120 whisper || true; }

echo "Voice services running (Ctrl-C to stop). Logs: $LOGS"
wait
