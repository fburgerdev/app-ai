# The laptop and the Pi

The app runs on the laptop and the laptop does the work: it is the faster side, and it is
there whether or not the Pi is. The Pi is the side that is always on: for the phone, and for
when the laptop sleeps. A switch in the top bar hands everything over to the Pi and takes it
back.

## Setting it up on the laptop

1. **Start the app with Windows.** Double-click `deploy\windows\install-autostart.cmd` once.
   From then on the app starts by itself, without a window, when you log in. It keeps itself
   up to date: every ten minutes it looks for a newer version on GitHub, takes it as soon as
   Claude is not working on anything, and restarts; the open window reloads by itself. If a
   new version does not start, it goes back to the one before. Settings → Connections shows
   the version that runs. What happens at start is in `%LOCALAPPDATA%\app-ai\startup.txt`. To undo: Win+R, `shell:startup`, delete
   "Brain app.vbs".
2. **Install the app from the laptop, not from the Pi.** Open `http://localhost:4317` in
   Chrome or Edge and install it from there (the install icon in the address bar). Remove the
   one you installed from the Pi's Tailscale address: that one only opens while the Pi is on.
3. **Tell the laptop where the Pi is.** In the laptop's `config.json`
   (`%LOCALAPPDATA%\app-ai\config.json`) add the address you use for the Pi:
   `"remote": "https://<your-pi>.<tailnet>.ts.net"`. Restart the app. Without this line the
   laptop simply works alone and shows no switch. The Pi's own `config.json` needs nothing.
4. **Each computer has its own sign-ins.** They are never synced: Claude (the laptop needs
   Claude Code signed in, like the Pi), Google (Settings → Connections, once per computer),
   and the keys in `config.json` (Groq and the like).

## The status line

Under the top bar, on the laptop, one line says where things stand:

- **Which side does the work**: Laptop or Pi.
- **Whether the laptop can sleep.** "Everything is saved. Safe to suspend the Laptop." when
  nothing is running and everything is on GitHub. While Claude is working, a brain update or
  a card run is going, or changes are not on GitHub yet, it says so: keep the laptop awake.
- **Whether the Pi could take over**: "Pi is ready", "Pi: waits for one thing" (hover to see
  what), or "Pi is off". Repo work that is only on the laptop (branches not pushed) is named
  too; it does not travel, so push it first in the thread's repo panel.

**Hand over to the Pi** starts the takeover. If Claude is still working here, the line says
it hands over as soon as that is finished (Cancel stops it). Then the laptop saves to GitHub,
the Pi takes everything in, and the line turns green: "Handed over … Safe to suspend the
Laptop." From then on the laptop's window only passes everything on to the Pi.

**Take back to the Laptop** brings everything back; it also happens by itself when the laptop
wakes up or starts, and when the Pi stops answering. The Pi saves first if it can.

Background work (new cards, opening events, sorting threads into projects) runs on one side
only: on the laptop while it does the work, on the Pi while the laptop is handed over or off.

## How the threads stay together

Both computers keep their state in the same data repo on GitHub (`app-ai-data`). Every two
minutes each one takes in what the other saved and saves its own; the laptop also tells the Pi
the moment it has saved. A handover does the same at once, in both directions. So:

- What you do on the phone (which talks to the Pi) shows up on the laptop within a couple of
  minutes, and the other way round.
- Threads are separate folders, so work on different threads never collides. If the same
  thread got messages on both sides, the conversation keeps both. For any other file changed
  on both sides (a thread's status, the mood line), the version saved to GitHub first wins.
- With the Pi off, the laptop just works; nothing can sync to the Pi until it is back, and
  when it is, it catches up by itself.
- If the Pi goes off without warning while it has everything, the laptop carries on with
  what the Pi last saved (at most two minutes old). The rest comes in when the Pi is back.
- No internet at all: the laptop works on what it has and saves when it is online again.

What does not travel: a turn Claude is in the middle of (it finishes where it started), and
work in a repo that is not pushed. Push a thread's branch (repo panel → Only push) before you
continue it on the other side.

## The phone

The phone keeps using the Pi's Tailscale address, so it needs the Pi to be on. With the Pi off
for days, the laptop can stand in while it is awake: `tailscale serve --bg 4317` on the laptop
and its Tailscale name in the laptop's `allowedHosts`, as in [pi.md](pi.md).
