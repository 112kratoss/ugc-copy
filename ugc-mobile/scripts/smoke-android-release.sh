#!/bin/zsh
# Emulator smoke for a release APK — the device gate of
# docs/android-app-optimization-plan-2026-09-05.md (§3), as run for every phase
# on 2026-09-05. Installs the APK over whatever is on the device (adb install -r
# keeps the app's data, so a signed-in session is exercised on the first launch),
# then drives Home, Showcase, the viewer through an app link, the Unlocks screen
# through the app scheme, Alerts, Profile, Create and a cold restart, and greps
# logcat for the record-converter and crash signatures build 62 produced.
#
# Coordinates are for the Pixel_9a AVD (1080x2424, tab bar at y=2216); on another
# device pass taps by hand. Screenshots, logcat and meminfo land in
# $SMOKE_OUT/<label> (default /tmp/magicbooklet-smoke). Zero signature matches is
# necessary, not sufficient: look at the screenshots.
#
#   usage: scripts/smoke-android-release.sh <label> <apk> [showcase-post-id]
#   env:   ANDROID_SERIAL (default emulator-5554), SMOKE_OUT
#
# Deliberately not wired to an npm script (package.json is an OTA fingerprint input).
set -u
export PATH="$HOME/Library/Android/sdk/platform-tools:$PATH"
LABEL="$1"; APK="$2"; POST="${3:-}"
DEV="${ANDROID_SERIAL:-emulator-5554}"; PKG="com.magicbooklet.mobile"
OUT="${SMOKE_OUT:-/tmp/magicbooklet-smoke}/$LABEL"
mkdir -p "$OUT"
A() { adb -s "$DEV" "$@"; }
shot() { A exec-out screencap -p > "$OUT/$1.png"; sips -Z 560 "$OUT/$1.png" --out "$OUT/$1-s.png" >/dev/null 2>&1; }
tap() { A shell input tap "$1" "$2"; }
focus() { A shell dumpsys window 2>/dev/null | grep -oE "mCurrentFocus=Window\{[^}]*\}" | head -1; }
# The emulator's system_server throws "Process system isn't responding" under host
# load; the dialog steals every tap. Dismiss it with Wait before each step.
anr() { for i in 1 2 3; do if focus | grep -q "Not Responding"; then echo "  (dismissed system ANR dialog)"; tap 318 1409; sleep 1.5; else break; fi; done; }

echo "== install"; A install -r "$APK" 2>&1 | tail -1
A shell am force-stop "$PKG"; A logcat -c
echo "== cold start"; A shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1; sleep 0.7; shot 00-splash
sleep 10; anr; shot 01-home; echo "focus: $(focus)"
echo "== showcase tab"; anr; tap 346 2216; sleep 6; anr; shot 02-showcase; echo "focus: $(focus)"
echo "== scroll showcase"; A shell input swipe 540 1700 540 700 400; sleep 3; anr; shot 03-showcase-scrolled
if [ -n "$POST" ]; then
  echo "== deep link viewer"; A shell am start -a android.intent.action.VIEW -d "https://magicbooklet.com/showcase/$POST" "$PKG" >/dev/null 2>&1
  sleep 8; anr; shot 04-viewer; echo "focus: $(focus)"
  A shell input keyevent BACK; sleep 2
fi
echo "== unlocks screen"; A shell am start -a android.intent.action.VIEW -d "magicbooklet://unlocks" "$PKG" >/dev/null 2>&1; sleep 6; anr; shot 10-unlocks; echo "focus: $(focus)"; A shell input keyevent BACK; sleep 2
echo "== alerts tab"; anr; tap 737 2216; sleep 5; anr; shot 05-alerts
echo "== profile tab"; anr; tap 931 2216; sleep 5; anr; shot 06-profile
echo "== create tab"; anr; tap 540 2216; sleep 6; anr; shot 07-create
echo "== home tab"; anr; tap 152 2216; sleep 3
echo "== cold restart (session restore)"; A shell am force-stop "$PKG"; sleep 1
A shell am start -W -n "$PKG/.MainActivity" 2>&1 | grep -E "TotalTime"; sleep 8; anr; shot 08-restart; echo "focus: $(focus)"
echo "== meminfo"; A shell dumpsys meminfo "$PKG" 2>/dev/null | grep -E "TOTAL PSS|Graphics|Native Heap|Dalvik Heap" | head -5 | tee "$OUT/meminfo.txt"
A logcat -d > "$OUT/logcat.txt"
echo "== signatures"; grep -cE "RecordCastException|Cannot create a record|cannot be cast to type|ArgumentCastException|FATAL EXCEPTION|Fatal signal" "$OUT/logcat.txt" | sed 's/^/matches: /'
grep -E "RecordCastException|Cannot create a record|cannot be cast to type|ArgumentCastException|FATAL EXCEPTION|Fatal signal" "$OUT/logcat.txt" | head -12
echo "== app-level errors (ReactNativeJS / expo)"; grep -E "^.{0,40}E (ReactNativeJS|ExpoModulesCore|expo-image|ExpoImage|unknown:ReactNative)" "$OUT/logcat.txt" | grep -v "Remote update request not successful" | head -12
echo "== app process alive: $(A shell pidof "$PKG" | wc -w | tr -d ' ')"
echo "done: $OUT"
