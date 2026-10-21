#!/bin/bash
# Keeps the phone's screen on without changing a setting: one harmless key (KEYCODE_UNKNOWN) every 12 s,
# while the screen is on and the launcher or our app is in front. Stops by itself otherwise.
#   keep-awake.sh [minutes, default 15]     ANDROID_SERIAL names the phone; touch $STOP to stop early
set -u
S="${ANDROID_SERIAL:?set ANDROID_SERIAL to the serial of the phone}"
PKG="${PKG:-com.magicbooklet.mobile}"
STOP="${STOP:-${TMPDIR:-/tmp}/keep-awake-stop}"
end=$(( $(date +%s) + ${1:-15} * 60 ))
while [ "$(date +%s)" -lt "$end" ]; do
  # A stop ends one run and is used up: left in place, it ended every later run at once and the phone slept.
  [ -e "$STOP" ] && { rm -f "$STOP"; echo "stopped by $STOP"; exit 0; }
  adb -s "$S" shell dumpsys power 2>/dev/null | grep -q 'mWakefulness=Awake' || { echo "screen off; stopping"; exit 0; }
  f=$(adb -s "$S" shell dumpsys window 2>/dev/null | grep -m1 'mCurrentFocus' | sed 's/.* u0 //; s/}.*//; s|/.*||' | tr -d '\r')
  # The store build and the dev build alike: PKG is often given to phone.sh alone.
  case "$f" in com.sec.android.app.launcher|com.magicbooklet.mobile|com.magicbooklet.mobile.dev|"$PKG") ;; *) echo "another app is in front ($f); stopping"; exit 0;; esac
  adb -s "$S" shell input keyevent 0
  sleep 12
done
echo "time is up"
