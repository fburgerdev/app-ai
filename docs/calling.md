# Calling the inbox

You call a phone number; the app reads you the thread that has waited longest; you answer out loud; it moves to the next one. Claude starts working on your answer while the call goes on.

This part is built and tested against a simulated call, but it has never taken a real one: a Twilio account is needed for that, and only you can open one. Expect to adjust a detail or two on the first try.

## What a call is like

- The app says how many threads are waiting, then the first one's name and a spoken summary of Claude's reply (prepared when the thread became ready, so there is no waiting).
- Speak your reply. You can pause; everything you say is collected until you say **send**. Ending a sentence with "…and send it" works too.
- When nothing is waiting, the app stays on the line and tells you when Claude finishes a thread.

| Say | or press | |
|---|---|---|
| send | 1 | Send what you dictated, go to the next thread |
| repeat | 2 | Hear the thread again |
| later / skip | 3 | Put the thread at the back |
| done | 4 | Close the thread |
| new thread | 5 | Dictate a new thread, then "send" |
| cancel | 0 | Drop what you dictated |
| goodbye | 9 | End the call |

A reply sent by phone is marked as dictated, so Claude reads past transcription errors.

## What you need

1. **The app running** on a machine that is on during your walk: the laptop left open, or the Pi (docs/pi.md).
2. **A Twilio account with a phone number.** https://www.twilio.com. For a German number Twilio asks for proof of address, and approval can take a few days. A number from another country works at once, but calling it may cost you more.
3. **ConversationRelay switched on** for the account: Twilio Console → Voice → ConversationRelay (Twilio calls this onboarding; it includes agreeing to its AI terms).
4. **A public https address** that leads to this app, because Twilio has to reach it from the internet.

Twilio charges per minute for the call and for ConversationRelay, plus a monthly fee for the number. Check its price list for your country before you start.

## Steps

### 1. Give the app a public address

Only the path `/voice` has to be public. Two ways:

- **To try it quickly:** [ngrok](https://ngrok.com): `ngrok http 4317`. It prints an address like `https://abc123.ngrok.app`. It changes each time unless you pay.
- **To keep:** Tailscale Funnel, on a port of its own, limited to the voice path. Roughly:
  ```
  tailscale funnel --bg --https=8443 --set-path /voice http://127.0.0.1:4317/voice
  ```
  The address is then `https://<machine>.<tailnet>.ts.net:8443`. The exact flags differ between Tailscale versions; `tailscale funnel --help` shows yours.

Do not publish the whole app. As a second lock, the app itself serves nothing but the call entry point under the public address, and it refuses to switch calling on if `publicUrl` is also one of your private `allowedHosts`.

### 2. Fill in config.json

In the app's data folder:

```json
"voice": {
  "enabled": true,
  "publicUrl": "https://abc123.ngrok.app",
  "authToken": "your Twilio Auth Token",
  "allowedCallers": ["+4917012345678"],
  "language": "en-US"
}
```

- `authToken`: Twilio Console → Account → API keys & tokens → Auth Token. The app uses it to check that a request really comes from Twilio.
- `allowedCallers`: the numbers you call from, with country code. Every other caller is turned away.
- `language`: the language you speak on calls and that is read to you (`de-DE` for German). One language per call.
- Optional: `speechTimeoutMs` (default 2500) is how long a pause may be before Twilio hands over what you said; `digestModel` (default `haiku`) writes the spoken summaries.

Restart the app. **Connections** should show "Calling the inbox: ready".

### 3. Point the number at the app

Twilio Console → Phone Numbers → your number → Voice configuration → "A call comes in": **Webhook**, `https://<your public address>/voice/twiml`, method **POST**. Save.

### 4. Call

Call the number from an allowed phone. If you hear Twilio's "application error" message, look at `log.txt` in the app's data folder and at Twilio Console → Monitor → Errors. The usual causes:

| What happens | Cause |
|---|---|
| Twilio reports 403 | `publicUrl` is not exactly the address in the webhook (without `/voice/twiml`), or the Auth Token is wrong |
| Twilio reports 404 | Calling is not "ready" in Connections |
| The call is rejected at once | Your number is not in `allowedCallers` |
| Silence after connecting | ConversationRelay is not switched on for the account, or the tunnel does not pass WebSockets |

## How it is protected

- The request that starts a call must carry Twilio's signature, made with your Auth Token.
- The caller's number must be one of yours.
- The audio connection is only accepted with a one-time code handed out in that request, valid for a minute.
- A call can do what the keys above do and nothing else. It cannot update the brain or read files.
