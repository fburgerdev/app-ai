#!/bin/sh
# Keeps the app on the Pi up to date with GitHub.
#
# Run by app-ai-update.timer every few minutes, and by the app itself (systemctl --user
# start app-ai-update) when Florian locked it for the update and nothing runs any more.
# When GitHub has something new it waits until Claude is not working on anything, pulls,
# installs, restarts the app, and checks that it came back. If it did not, it goes back to
# the version that ran before and leaves the new one alone until GitHub changes again.
#
# It never cuts off Claude's work by itself (Florian, 23-11-2026): until 23-11-2026 it
# restarted anyway after an hour. Now the page shows a line that a new version is there;
# "Update now" there leaves the file "force" here, and only that skips the waiting.
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
if [ "$OLD" = "$NEW" ]; then rm -f "$STATE/waiting-since" "$STATE/waiting-said" "$STATE/force"; exit 0; fi
if [ -f "$STATE/bad" ] && [ "$(cat "$STATE/bad")" = "$NEW" ]; then exit 0; fi

# "Update now" on the page: at once, whatever runs.
FORCE=0
if [ -f "$STATE/force" ]; then FORCE=1; rm -f "$STATE/force"; fi

# Never restart while the night prune is in the middle of a part: that part would be lost.
# (Between parts, and while it waits for the usage limit, it picks up again after a restart.)
if [ "$FORCE" = 0 ] && health | grep -q '"pruning":true'; then say "new version ${NEW%"${NEW#???????}"} is waiting: the night prune is running"; exit 0; fi

# Do not restart in the middle of Claude's work. The page offers to lock for the update.
if [ "$FORCE" = 0 ] && health | grep -q '"busy":true'; then
  [ -f "$STATE/waiting-said" ] && [ "$(cat "$STATE/waiting-said")" = "$NEW" ] || { say "new version ${NEW%"${NEW#???????}"} is waiting: Claude is working"; echo "$NEW" > "$STATE/waiting-said"; }
  exit 0
fi
rm -f "$STATE/waiting-since" "$STATE/waiting-said"

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
