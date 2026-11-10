# Running the app on a Raspberry Pi

On the laptop, threads only make progress while the laptop is awake. On a Pi the app is always on: threads keep working with the laptop closed, and you reach the inbox from the laptop and the phone.

Nothing changes until you do this. The app on the laptop keeps working as it is.

These steps were written without a Pi to test on. The app's side (reaching it under another address, signing in without a screen, files that download instead of opening) is tested; the commands for the Pi itself are standard but unverified here.

## What you need

- A Raspberry Pi 4 or 5 with a **64-bit** Raspberry Pi OS. Check with `uname -m`: it must say `aarch64`.
- With 2 GB of memory: set `maxParallel` to `2` (below). Each thread being worked on is its own Claude Code process.
- Better an SSD than an SD card, which wears out from many small writes. It works without.
- [Tailscale](https://tailscale.com) (free for personal use) on the Pi, the laptop and the phone. It gives your devices a private network, so the app is never open to your Wi-Fi or the internet.

## Steps

### 1. Node, Git and the app

```
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
git clone https://github.com/fburgerdev/app-ai ~/app-ai
cd ~/app-ai && npm install
```

Both repositories are private, so Git on the Pi needs access to them. The simplest way is the GitHub CLI: `sudo apt-get install -y gh`, then `gh auth login` and `gh auth setup-git`. (Do this before the `git clone` above.) It needs to be able to push to the brain repo.

Tell Git who commits brain updates:

```
git config --global user.name "Claude"
git config --global user.email "noreply@anthropic.com"
```

### 2. Sign in to Claude

```
npm run login
```

Without a screen it prints a link. Open it on the laptop, sign in, and paste the code it shows back into the Pi's terminal. `npm run login -- status` confirms it.

### 3. Tailscale

Install it on the Pi (`curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up`), and on the laptop and phone. Then let Tailscale put the app on the private network with https:

```
sudo tailscale serve --bg 4317
```

It prints the Pi's address, like `https://pi.tail1234.ts.net`. Only your own devices can open it.

### 4. Settings

Start the app once (`npm run serve`, stop with Ctrl+C) so it creates its data folder, then edit `~/.local/share/app-ai/config.json`:

```json
"allowedHosts": ["pi.tail1234.ts.net"],
"maxParallel": 2
```

`allowedHosts` is the address from step 3, without `https://`. The app refuses every address not listed there.

### 5. Keep it running

```
mkdir -p ~/.config/systemd/user
cp ~/app-ai/deploy/app-ai.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now app-ai
sudo loginctl enable-linger $USER
```

The last line lets it run without you being logged in, and start after a reboot. `systemctl --user status app-ai` shows whether it runs; `journalctl --user -u app-ai -f` shows its log.

### 6. Open it

On the laptop or phone: the address from step 3. Install it as an app from the browser menu (on the phone: "Add to Home Screen").

## Without a Pi: reaching the laptop from the phone

Walk mode needs the app reachable from your phone over https. The Tailscale part alone does that for a laptop: install Tailscale on the laptop and the phone, run `tailscale serve --bg 4317` on the laptop, put the address it prints into `allowedHosts`, restart the app, and open that address on the phone. It works while the laptop is awake.

## What is different on the Pi

- **Files open by download.** "Open in app" would start a program on the Pi, so it is not offered; use Download.
- **Gmail and Calendar** need the Pi's address as a second redirect URI and one more "Connect Google", done from the Pi's address (docs/google.md, step 5).
- **Your threads so far stay on the laptop.** To take them along, copy the `threads` and `extractions` folders from the laptop's data folder (`%LOCALAPPDATA%\app-ai`) to `~/.local/share/app-ai/` before the first start. Claude's own session files do not move with them; each thread then carries on from the app's transcript the first time you reply.
- **Run it in one place.** Stop using the laptop's copy once the Pi runs, or the two will hold different threads. The brain itself is safe either way, since both only push through GitHub.
- **Updating the app:** `cd ~/app-ai && git pull && npm install && systemctl --user restart app-ai`.
