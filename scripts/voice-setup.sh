#!/usr/bin/env bash
# One-time setup of Jarvis's local voice services on a Mac with Apple
# silicon (#73, #74). Everything goes into .voice/ (gitignored); nothing is
# installed system-wide except Homebrew packages (uv, espeak-ng, whisper-cpp).
#
#   npm run voice:setup                         # install (safe to re-run)
#   WHISPER_MODEL=base.en npm run voice:setup   # a smaller, faster Whisper model
#   npm run voice:up                            # start the services (127.0.0.1 only)
#
# Pinned versions: Kokoro-FastAPI v0.9.2, piper-tts 1.8.0. Whisper models
# are checked against whisper.cpp's published SHA-1s.
set -euo pipefail

cd "$(dirname "$0")/.."
VOICE_DIR="$PWD/.voice"
KOKORO_TAG="v0.9.2"
PIPER_VERSION="1.8.0"
PIPER_VOICES=(en_GB-alan-medium en_GB-jenny_dioco-medium en_GB-northern_english_male-medium en_US-lessac-medium)
WHISPER_MODEL="${WHISPER_MODEL:-small.en}"
# From whisper.cpp's models/README.md.
case "$WHISPER_MODEL" in
  small.en) WHISPER_SHA1="db8a495a91d927739e50b3fc1cc4c6b8f6c2d022" ;;
  base.en) WHISPER_SHA1="137c40403d78fd54d454da0f9bd998f78703390c" ;;
  *) echo "WHISPER_MODEL must be small.en (the default) or base.en." >&2; exit 1 ;;
esac

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  warn "This script is written for a Mac with Apple silicon; continuing anyway."
else
  # Native arm64 only: under Rosetta (an x86_64 terminal or Intel Homebrew),
  # uv and its Python would be x86_64 and PyTorch couldn't use the GPU.
  if [[ "$(uname -m)" != "arm64" || "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" == "1" ]]; then
    echo "This shell is running under Rosetta (x86_64). Open a native arm64 terminal and run this again." >&2
    exit 1
  fi
fi
if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew is needed first: https://brew.sh" >&2
  exit 1
fi
if [[ "$(uname -s)" == "Darwin" && "$(brew --prefix)" != "/opt/homebrew" ]]; then
  cat >&2 <<EOF
The brew on your PATH is at $(brew --prefix): that's the Intel Homebrew, which
runs under Rosetta. Jarvis's voices need the native Apple-silicon Homebrew in
/opt/homebrew. To install it:

  1. In this (native arm64) terminal, run Homebrew's installer:
       /bin/bash -c "\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
     It installs into /opt/homebrew because the terminal is arm64.
  2. Put it first in PATH for new terminals:
       echo 'eval "\$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
  3. Open a new terminal and check:
       brew --prefix        # should print /opt/homebrew
  4. Run npm run voice:setup again.

The Intel Homebrew in /usr/local can stay; it just has to come after
/opt/homebrew in PATH.
EOF
  exit 1
fi

say "1/4 Homebrew packages: uv (Python installer), espeak-ng (pronunciation fallback), whisper-cpp (listening, with Metal)"
for pkg in uv espeak-ng whisper-cpp; do
  brew list --formula "$pkg" >/dev/null 2>&1 || brew install "$pkg"
done

mkdir -p "$VOICE_DIR/logs"

# Python comes only from uv's own managed builds, never python.org's or
# Homebrew's: python.org's Python has no certificates until its "Install
# Certificates" step is run, which made downloads fail with
# CERTIFICATE_VERIFY_FAILED.
export UV_PYTHON_PREFERENCE=only-managed
PYTHON_VERSION="3.12"
uv python install --quiet "$PYTHON_VERSION"
UV_PYTHON_DIR="$(uv python dir)"

# Removes a venv that wasn't built from a uv-managed arm64 Python (or no
# longer runs), so it's rebuilt below. Only ever removes paths inside .voice/.
check_venv() {
  local venv="$1"
  [[ -d "$venv" ]] || return 0
  local why=""
  if [[ ! -x "$venv/bin/python" ]]; then
    why="it has no working Python"
  else
    local info
    if ! info="$("$venv/bin/python" -I -c 'import os, platform, sys; print(platform.machine()); print(os.path.realpath(sys.base_prefix).startswith(os.path.realpath(sys.argv[1]) + os.sep))' "$UV_PYTHON_DIR" 2>/dev/null)"; then
      why="its Python doesn't run"
    elif [[ "$(sed -n 1p <<<"$info")" != "arm64" && "$(uname -s)" == "Darwin" ]]; then
      why="its Python is $(sed -n 1p <<<"$info"), not arm64"
    elif [[ "$(sed -n 2p <<<"$info")" != "True" ]]; then
      why="its Python isn't one uv manages"
    fi
  fi
  [[ -n "$why" ]] || return 0
  case "$venv" in
    "$VOICE_DIR"/*) ;;
    *) echo "Refusing to remove $venv: it's outside $VOICE_DIR" >&2; exit 1 ;;
  esac
  warn "Rebuilding $venv: $why."
  rm -rf "$venv"
}

say "2/4 Kokoro-FastAPI $KOKORO_TAG (uses the M1 GPU through PyTorch MPS)"
if [[ ! -d "$VOICE_DIR/kokoro-fastapi" ]]; then
  git clone --quiet --depth 1 --branch "$KOKORO_TAG" https://github.com/remsky/Kokoro-FastAPI "$VOICE_DIR/kokoro-fastapi"
fi
(
  cd "$VOICE_DIR/kokoro-fastapi"
  check_venv "$VOICE_DIR/kokoro-fastapi/.venv"
  [[ -d .venv ]] || uv venv --quiet --python "$PYTHON_VERSION"
  uv pip install --quiet -e .
  # The model (~330 MB) and its config, checked against Kokoro-FastAPI's own SHA-256 list.
  uv run --no-sync python docker/scripts/download_model.py --output api/src/models/v1_0
)

say "3/4 Piper $PIPER_VERSION and English voices"
check_venv "$VOICE_DIR/piper/.venv"
if [[ ! -d "$VOICE_DIR/piper/.venv" ]]; then
  mkdir -p "$VOICE_DIR/piper"
  uv venv --quiet --python "$PYTHON_VERSION" "$VOICE_DIR/piper/.venv"
fi
VIRTUAL_ENV="$VOICE_DIR/piper/.venv" uv pip install --quiet "piper-tts[http]==$PIPER_VERSION"
mkdir -p "$VOICE_DIR/piper/voices"
for voice in "${PIPER_VOICES[@]}"; do
  if [[ -f "$VOICE_DIR/piper/voices/$voice.onnx" ]]; then continue; fi
  "$VOICE_DIR/piper/.venv/bin/python" -m piper.download_voices --download-dir "$VOICE_DIR/piper/voices" "$voice" \
    || warn "Couldn't download Piper voice $voice; skipping it."
done

say "4/4 Whisper model $WHISPER_MODEL (whisper.cpp)"
if ! command -v whisper-server >/dev/null 2>&1; then
  echo "Homebrew's whisper-cpp didn't put whisper-server on PATH. Try: brew reinstall whisper-cpp" >&2
  exit 1
fi
mkdir -p "$VOICE_DIR/whisper"
model_file="$VOICE_DIR/whisper/ggml-$WHISPER_MODEL.bin"
sha1() { shasum -a 1 "$1" | cut -d' ' -f1; }
if [[ -f "$model_file" && "$(sha1 "$model_file")" != "$WHISPER_SHA1" ]]; then
  warn "$model_file doesn't match its checksum; downloading it again."
  rm -f "$model_file"
fi
if [[ ! -f "$model_file" ]]; then
  curl -fL --retry 3 --progress-bar -o "$model_file.part" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$WHISPER_MODEL.bin"
  if [[ "$(sha1 "$model_file.part")" != "$WHISPER_SHA1" ]]; then
    rm -f "$model_file.part"
    echo "The downloaded Whisper model doesn't match its checksum; not using it." >&2
    exit 1
  fi
  mv "$model_file.part" "$model_file"
fi

say "Disk used"
du -sh "$VOICE_DIR/kokoro-fastapi" "$VOICE_DIR/piper" "$VOICE_DIR/whisper" 2>/dev/null || true
echo
echo "Done. Start the voice services with: npm run voice:up"
echo "Then open http://localhost:8080/voices (with npm run dev running) to pick a voice."
