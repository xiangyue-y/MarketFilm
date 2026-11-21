#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo '本地语音需要 Apple Silicon Mac。' >&2
  exit 1
fi
launcher=${TTS_BOOTSTRAP_PYTHON:-python3.12}
"$launcher" -m venv .models/tts-venv
.models/tts-venv/bin/python -m pip install --disable-pip-version-check 'mlx-audio[tts]==0.6.7'
.models/tts-venv/bin/python scripts/fetch-tts.py
