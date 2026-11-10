#!/bin/sh
# Installs Piper, the voice the app speaks with, and one German and one English voice.
# Run once on the machine the app runs on (the Pi, or a Linux or macOS laptop):
#   sh deploy/voice-setup.sh          medium voices (a laptop, a Pi 5)
#   sh deploy/voice-setup.sh low      smaller, faster voices (a Pi 4)
set -eu
QUALITY="${1:-medium}"
DATA="${APP_AI_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/app-ai}"
[ "$(uname)" = "Darwin" ] && [ -z "${APP_AI_DATA:-}" ] && DATA="$HOME/Library/Application Support/app-ai"
DIR="$DATA/piper"
mkdir -p "$DIR"

echo "Installing Piper into $DIR/venv ..."
python3 -m venv "$DIR/venv"
"$DIR/venv/bin/pip" install --quiet --upgrade pip
"$DIR/venv/bin/pip" install --quiet piper-tts

get() { # language folder, locale, voice name
  name="$2-$3-$QUALITY"
  base="https://huggingface.co/rhasspy/piper-voices/resolve/main/$1/$2/$3/$QUALITY/$name.onnx"
  [ -s "$DIR/$name.onnx" ] || curl -fL --progress-bar -o "$DIR/$name.onnx" "$base"
  [ -s "$DIR/$name.onnx.json" ] || curl -fsSL -o "$DIR/$name.onnx.json" "$base.json"
  echo "  voice: $name"
}
echo "Downloading voices ($QUALITY) ..."
get de de_DE thorsten
get en en_US lessac

echo "Trying it ..."
echo "Das ist ein Test." | "$DIR/venv/bin/piper" -m "$DIR/de_DE-thorsten-$QUALITY.onnx" -f "$DIR/test.wav"
rm -f "$DIR/test.wav"

cat <<DONE

Piper works. Put this into the "voice" part of $DATA/config.json and restart the app:

  "speak": "piper",
  "piper": {
    "command": "$DIR/venv/bin/piper",
    "voices": { "de": "de_DE-thorsten-$QUALITY", "en": "en_US-lessac-$QUALITY" }
  }
DONE
