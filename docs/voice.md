# A better ear and a better voice for the Talk page

Out of the box the Talk page listens and speaks with the phone's own engines. This replaces both, with the laptop off: the phone records, the machine the app runs on (the Pi) does the rest.

| | What does it | Cost |
|---|---|---|
| Listening | Groq's Whisper (large-v3-turbo) | about $0.04 per hour of speech; a free allowance covers light use |
| Speaking | Piper, on the app's own machine | free, unlimited |
| Speaking, optional | OpenAI's voice | about 1.5 cents per minute spoken |

Everything goes into the `voice` part of `config.json` in the app's data folder. That file is never committed. Restart the app after changing it.

## 1. Listening: a Groq key (5 minutes)

1. Go to **console.groq.com**, sign up, and open **API Keys → Create API Key**.
2. Put it into `config.json`:
   ```json
   "voice": { "groqKey": "gsk_…" }
   ```
3. Restart the app. In the Talk page's settings it now says "Listening goes through Groq's Whisper".

How it works: the microphone stays open while Talk is on. When you have spoken and then paused (the pause you set, at least 1.2 seconds), that recording goes to Groq and comes back as text. The names from "Names and words I use" and your project names are sent along, so Whisper spells them your way. Nothing is recorded while the app itself speaks, unless "I am wearing headphones" is on.

## 2. Speaking: Piper (10 minutes, on the Pi)

```
cd ~/app-ai
sh deploy/voice-setup.sh low
```

Use `low` on a Pi 4: the smaller voices answer faster. On a Pi 5 or a laptop leave the word out for the medium voices. The script installs Piper into the app's data folder, downloads a German voice (Thorsten) and an English one (Lessac), tries them, and prints the lines to put into `config.json`.

On Windows, for trying it on the laptop: `pip install piper-tts`, download the two voices by hand from huggingface.co/rhasspy/piper-voices into `%LOCALAPPDATA%\app-ai\piper`, and set `"command"` to where `piper.exe` landed.

## 3. Optional: OpenAI's voice

It sounds close to a person. Add `"openaiKey": "sk-…"` to `voice`. In the Talk page's settings, **Voice** then offers it next to Piper; `"speak": "openai"` makes it the default. `"openaiVoice"` picks the voice (default `sage`).

## Choosing on the phone

Talk page → settings → **Voice**: Piper, OpenAI, or the phone's own. The choice is kept per phone. If the server's voice fails, that sentence is read in the phone's voice instead, and "What happened" says why.

## If something is off

- **"Could not turn that into text: Groq refused the key"**: the key in `config.json` is wrong.
- **It answers late**: on a Pi 4 with medium voices, Piper is slower than speech. Run the setup again with `low`.
- **It hears itself**: without headphones the app does not listen while it speaks. With the headphone switch on and no headphones in, it will.
- **It cuts you off**: raise the pause in the settings.
- "What happened" in the settings shows each step: "speech started", "heard: …", and where the host put it.
