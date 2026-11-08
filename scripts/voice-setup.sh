#!/usr/bin/env bash
# One-time setup of Jarvis's local voice services on a Mac with Apple
# silicon (#73). Everything goes into .voice/ (gitignored); nothing is
# installed system-wide except Homebrew packages (uv, espeak-ng).
#
#   npm run voice:setup      # install (safe to re-run)
#   npm run voice:up         # start the services (127.0.0.1 only)
#
# Pinned versions: Kokoro-FastAPI v0.9.2, piper-tts 1.8.0.
set -euo pipefail

cd "$(dirname "$0")/.."
VOICE_DIR="$PWD/.voice"
KOKORO_TAG="v0.9.2"
PIPER_VERSION="1.8.0"
PIPER_VOICES=(en_GB-alan-medium en_GB-jenny_dioco-medium en_GB-northern_english_male-medium en_US-lessac-medium)

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  warn "This script is written for a Mac with Apple silicon; continuing anyway."
fi
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is needed first: https://brew.sh" >&2
  exit 1
fi

say "1/3 Homebrew packages: uv (Python installer), espeak-ng (pronunciation fallback)"
for pkg in uv espeak-ng; do
  brew list --formula "$pkg" >/dev/null 2>&1 || brew install "$pkg"
done

mkdir -p "$VOICE_DIR/logs"

say "2/3 Kokoro-FastAPI $KOKORO_TAG (uses the M1 GPU through PyTorch MPS)"
if [[ ! -d "$VOICE_DIR/kokoro-fastapi" ]]; then
  git clone --quiet --depth 1 --branch "$KOKORO_TAG" https://github.com/remsky/Kokoro-FastAPI "$VOICE_DIR/kokoro-fastapi"
fi
(
  cd "$VOICE_DIR/kokoro-fastapi"
  [[ -d .venv ]] || uv venv --quiet --python 3.12
  uv pip install --quiet -e .
  # The model (~330 MB) and its config, checked against Kokoro-FastAPI's own SHA-256 list.
  uv run --no-sync python docker/scripts/download_model.py --output api/src/models/v1_0
)

say "3/3 Piper $PIPER_VERSION and English voices"
if [[ ! -d "$VOICE_DIR/piper/.venv" ]]; then
  mkdir -p "$VOICE_DIR/piper"
  uv venv --quiet --python 3.12 "$VOICE_DIR/piper/.venv"
fi
VIRTUAL_ENV="$VOICE_DIR/piper/.venv" uv pip install --quiet "piper-tts[http]==$PIPER_VERSION"
mkdir -p "$VOICE_DIR/piper/voices"
for voice in "${PIPER_VOICES[@]}"; do
  if [[ -f "$VOICE_DIR/piper/voices/$voice.onnx" ]]; then continue; fi
  "$VOICE_DIR/piper/.venv/bin/python" -m piper.download_voices --download-dir "$VOICE_DIR/piper/voices" "$voice" \
    || warn "Couldn't download Piper voice $voice; skipping it."
done

say "Disk used"
du -sh "$VOICE_DIR/kokoro-fastapi" "$VOICE_DIR/piper" 2>/dev/null || true
echo
echo "Done. Start the voice services with: npm run voice:up"
echo "Then open http://localhost:8080/voices (with npm run dev running) to pick a voice."
