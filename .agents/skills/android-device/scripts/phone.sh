#!/bin/bash
# One short command per step on the owner's S24. ANDROID_SERIAL must name the phone (adb devices).
# Nothing here taps anything by itself; `press` sends one press at a point the caller has just looked at.
#   phone.sh state            connected, awake, keyguard, what is in front, call state, audio mode, recent touches, app pid
#   phone.sh free             exit 0 only when the phone is free to use (see the skill), else 1 with the reason
#   phone.sh shot <name>      screenshot -> $SHOTS/<name>.png (scratchpad, never archive/)
#   phone.sh now              the phone's clock, in the form `logs` takes
#   phone.sh restart [link]   force-stop, then start (the launcher entry, or the deep link)
#   phone.sh open <link>      open a deep link in the running app
#   phone.sh logs <since>     expo-updates lines of the running app since <since>
#   phone.sh press <x> <y> [ms]   a press that carries move events, as a finger's does
#   phone.sh tapkey <keycode> one key (4 = BACK)
#   phone.sh home             a launcher-style start that clears the task (after a deep-link start)
set -u
S="${ANDROID_SERIAL:?set ANDROID_SERIAL to the serial of the phone, from adb devices}"
PKG="${PKG:-com.magicbooklet.mobile}"
SHOTS="${SHOTS:-${TMPDIR:-/tmp}/phone-shots}"
A() { adb -s "$S" "$@"; }
front() { A shell dumpsys window 2>/dev/null | grep -m1 'mCurrentFocus' | sed 's/.* u0 //; s/}.*//; s|/.*||' | tr -d '\r'; }
# Each check below says "unknown" when it cannot look, and `free` reads that as busy: no look is no all-clear.
# Touches in the last six seconds; unknown when the phone's clock or its log cannot be read.
touches() {
  local since log
  since=$(A shell "date -d @\$(( \$(date +%s) - 6 )) '+%m-%d %H:%M:%S.000'" | tr -d '\r')
  [ -n "$since" ] || { echo unknown; return; }
  log=$(A logcat -d -T "$since" 2>/dev/null) || { echo unknown; return; }
  printf '%s\n' "$log" | grep -c 'ViewPostIme pointer'
}
# Calls in progress: the entries of telecom's list of current calls (`mCalls:`, empty when idle), where cellular calls
# and app calls such as WhatsApp's both appear (telephony's own call state knows only cellular ones). The same dump
# keeps an event log of past calls, and the `state=DIALING` lines there kept the old check reporting a call long
# after it ended. The count holds only once the next section at the list's own depth closes it; a dump without the
# list, or cut short inside it (a dumpsys timeout), reads unknown. Bytes, not characters: LC_ALL=C.
calls() {
  A shell dumpsys telecom 2>/dev/null | LC_ALL=C awk '
    { sub(/\r$/, "") }
    /^ *mCalls:/ { match($0, /^ */); depth = RLENGTH; inside = 1; next }
    inside && NF {
      match($0, /^ */)
      if (RLENGTH > depth) { n++; next }
      inside = 0
      if (RLENGTH == depth && $0 ~ /^ *m[A-Za-z]+:/) closed = 1
    }
    END { if (closed) print n + 0; else print "unknown" }'
}
# The keyguard's own state, the first `showing=` of the window policy dump: unknown when it is not there.
keyguard() { A shell dumpsys window policy 2>/dev/null | LC_ALL=C grep -m1 -io 'showing=[a-z]*' | tr 'A-Z' 'a-z' | grep . || echo unknown; }
cmd="${1:?a step}"; shift
case "$cmd" in
  state)
    echo "device: $(A get-state 2>&1)"
    A shell dumpsys power 2>/dev/null | grep -m1 'mWakefulness=' | sed 's/^ */power: /'
    A shell dumpsys window policy 2>/dev/null | grep -m1 -i 'showing=' | sed 's/^ */keyguard: /'
    echo "front: $(front)"
    echo "calls in progress: $(calls)"
    A shell dumpsys audio 2>/dev/null | grep -m1 'Actual mode' | sed 's/^ */audio: /'
    echo "touches in the last 6 s: $(touches)"
    echo "app pid: $(A shell pidof "$PKG" 2>/dev/null | tr -d '\r')";;
  free)
    awake=$(A shell dumpsys power 2>/dev/null | grep -c 'mWakefulness=Awake')
    kg=$(keyguard)
    f=$(front); mode=$(A shell dumpsys audio 2>/dev/null | grep -m1 'Actual mode')
    call=$(calls)
    t=$(touches)
    case "$f" in com.sec.android.app.launcher|"$PKG") ok_front=1;; *) ok_front=0;; esac
    if [ "$awake" = 1 ] && [ "$kg" = showing=false ] && [ "$ok_front" = 1 ] && [ "$call" = 0 ] && printf '%s' "$mode" | grep -q MODE_NORMAL && [ "$t" = 0 ]; then echo "free"; exit 0; fi
    echo "not free: awake=$awake keyguard=$kg front=$f call=$call $mode touches=$t"; exit 1;;
  shot)
    name="${1:?a name}"; mkdir -p "$SHOTS"; A exec-out screencap -p > "$SHOTS/$name.png"; echo "$SHOTS/$name.png $(wc -c < "$SHOTS/$name.png" | tr -d ' ') bytes";;
  now) A shell "date '+%m-%d %H:%M:%S.000'" | tr -d '\r';;
  restart)
    link="${1:-}"; A shell am force-stop "$PKG"
    if [ -n "$link" ]; then A shell "am start -W -a android.intent.action.VIEW -d '$link' $PKG"; else A shell "am start -W -n $PKG/.MainActivity -a android.intent.action.MAIN -c android.intent.category.LAUNCHER"; fi 2>&1 | grep -E 'Status|LaunchState|TotalTime|Error' | tr '\n' ' '; echo;;
  open)
    link="${1:?a deep link}"; A shell "am start -W -a android.intent.action.VIEW -d '$link' $PKG" 2>&1 | grep -E 'Status|LaunchState|TotalTime|Error' | tr '\n' ' '; echo;;
  logs)
    since="${1:?the phone time, from: phone.sh now}"; pid="$(A shell pidof "$PKG" 2>/dev/null | tr -d '\r')"
    [ -n "$pid" ] || { echo "the app is not running"; exit 1; }
    A logcat -d -T "$since" --pid="$pid" 2>/dev/null | grep 'dev.expo.updates' | grep -v embeddedAssetFileMap | cut -c1-260;;
  press) x="${1:?x}"; y="${2:?y}"; ms="${3:-120}"; A shell input swipe "$x" "$y" "$x" "$y" "$ms";;
  tapkey) A shell input keyevent "${1:?a keycode}";;
  home) A shell "am start -W --activity-clear-task -n $PKG/.MainActivity -a android.intent.action.MAIN -c android.intent.category.LAUNCHER" 2>&1 | grep -E 'Status|Error' | tr '\n' ' '; echo;;
  *) echo "unknown step: $cmd"; exit 2;;
esac
