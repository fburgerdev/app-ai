#!/bin/sh
# Keeps the app on the Pi up to date with GitHub.
#
# Run by app-ai-update.timer every few minutes. When GitHub has something new it waits
# until Claude is not working on anything (at most an hour), pulls, installs, restarts
# the app, and checks that it came back. If it did not, it goes back to the version that
# ran before and leaves the new one alone until GitHub changes again.
set -u
cd "$(dirname "$0")/.." || exit 1

PORT="${APP_AI_PORT:-4317}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/app-ai-update"
mkdir -p "$STATE"
say() { echo "$(date '+%Y-%m-%d %H:%M:%S')  $*" | tee -a "$STATE/update.log"; }
health() { curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null; }

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch -q origin "$BRANCH" || { say "could not reach GitHub"; exit 0; }
OLD="$(git rev-parse HEAD)"
NEW="$(git rev-parse "origin/$BRANCH")"
if [ "$OLD" = "$NEW" ]; then rm -f "$STATE/waiting-since"; exit 0; fi
if [ -f "$STATE/bad" ] && [ "$(cat "$STATE/bad")" = "$NEW" ]; then exit 0; fi

# Do not restart in the middle of Claude's work, unless it has gone on for an hour.
if health | grep -q '"busy":true'; then
  [ -f "$STATE/waiting-since" ] || date +%s > "$STATE/waiting-since"
  waited=$(( $(date +%s) - $(cat "$STATE/waiting-since") ))
  if [ "$waited" -lt 3600 ]; then say "new version ${NEW%"${NEW#???????}"} is waiting: Claude is working"; exit 0; fi
fi
rm -f "$STATE/waiting-since"

install() { npm install --omit=dev --no-audit --no-fund >> "$STATE/update.log" 2>&1; }
restart() { systemctl --user restart app-ai; }
came_back() {
  i=0
  while [ "$i" -lt 12 ]; do
    sleep 5
    health | grep -q '"ok":true' && return 0
    i=$((i + 1))
  done
  return 1
}

say "updating ${OLD%"${OLD#???????}"} -> ${NEW%"${NEW#???????}"}"
if ! git merge -q --ff-only "origin/$BRANCH"; then
  say "could not fast-forward (local changes on the Pi?). Nothing changed."
  echo "$NEW" > "$STATE/bad"
  exit 1
fi
install
restart
if came_back; then
  say "running ${NEW%"${NEW#???????}"}"
  rm -f "$STATE/bad"
  exit 0
fi

say "the new version did not start; going back to ${OLD%"${OLD#???????}"}"
echo "$NEW" > "$STATE/bad"
git reset -q --hard "$OLD"
install
restart
came_back && say "back on ${OLD%"${OLD#???????}"}" || say "the old version did not start either; see journalctl --user -u app-ai"
exit 1
