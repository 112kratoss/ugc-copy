#!/bin/bash
# Pixel_9a emulator helpers. ANDROID_SERIAL defaults to emulator-5554.
#   emulator.sh lock [minutes]   read UGC copy/.claude/emulator-5554.lock; refuse if another session holds it, else write our line
#   emulator.sh unlock           remove our lock
#   emulator.sh boot             start the AVD detached with IPv4 DNS and wait for boot
#   emulator.sh launch [port]    force-stop the dev client and open it on Metro at 10.0.2.2:<port> (default 8081)
#   emulator.sh shot <file.png>  screenshot; host-side capture when adb returns a white frame
#   emulator.sh restarts         app starts and kills in the events log, newest last
set -u
S="${ANDROID_SERIAL:-emulator-5554}"
# With the phone's serial exported, launch and shot would act on the owner's phone with no check that it is free.
case "$S" in emulator-*) ;; *) echo "emulator.sh drives emulators only, and $S is not one: the phone has phone.sh" >&2; exit 2;; esac
PKG="${PKG:-com.magicbooklet.mobile}"
ADB="${ADB:-$(command -v adb || echo "$HOME/Library/Android/sdk/platform-tools/adb")}"
EMU="${EMU:-$HOME/Library/Android/sdk/emulator/emulator}"
MAIN_WT="$(git worktree list --porcelain 2>/dev/null | head -1 | sed 's/^worktree //')"
LOCK="${LOCK:-${MAIN_WT:-$PWD}/../.claude/emulator-5554.lock}"
OWNER="${LOCK_OWNER:-$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")}"
cmd="${1:?a command}"; shift
case "$cmd" in
  lock)
    mins="${1:-20}"
    if [ -s "$LOCK" ] && ! grep -q "^$OWNER " "$LOCK"; then
      echo "held by another session: $(cat "$LOCK")"; echo "message that session; do not touch the device"; exit 1
    fi
    "$ADB" devices | grep -q "^$S" && echo "device: $S online" || echo "device: $S not online"
    pgrep -l qemu-system > /dev/null && echo "an emulator process is running"
    printf '%s since %s until ~%s\n' "$OWNER" "$(date '+%H:%M')" "$(date -v+"${mins}"M '+%H:%M')" > "$LOCK"
    echo "lock written: $(cat "$LOCK")";;
  unlock)
    if [ -s "$LOCK" ] && grep -q "^$OWNER " "$LOCK"; then rm -f "$LOCK"; echo "lock removed"; else echo "no lock of ours"; fi;;
  boot)
    if "$ADB" devices | grep -q "^$S.*device$"; then echo "$S already booted"; exit 0; fi
    log="${TMPDIR:-/tmp}/emulator-$(date +%H%M%S).log"
    nohup "$EMU" -avd Pixel_9a -dns-server 8.8.8.8,1.1.1.1 > "$log" 2>&1 &
    disown
    echo "booting Pixel_9a; log $log"
    perl -e 'alarm shift; exec @ARGV' 240 "$ADB" -s "$S" wait-for-device shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 1; done; echo booted';;
  launch)
    port="${1:-8081}"
    "$ADB" -s "$S" shell am force-stop "$PKG"
    "$ADB" -s "$S" shell am start -W -a android.intent.action.VIEW -d "exp+magicbooklet-mobile://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A$port" "$PKG" | grep -E 'Status|LaunchState|TotalTime|Error' | tr '\n' ' '; echo
    echo "proof: preview_logs search \"Bundled\" must show an Android Bundled line";;
  shot)
    out="${1:?a .png path}"
    "$ADB" -s "$S" exec-out screencap -p > "$out"
    size=$(wc -c < "$out" | tr -d ' ')
    if [ "$size" -lt 20000 ]; then
      dir="${TMPDIR:-/tmp}/emu-shot-$$"; mkdir -p "$dir"
      "$ADB" -s "$S" emu screenrecord screenshot "$dir" > /dev/null 2>&1
      f=$(ls -t "$dir"/*.png 2>/dev/null | head -1); [ -n "$f" ] && mv "$f" "$out"
      echo "adb frame was $size bytes (white); used a host-side capture"
    fi
    echo "$out $(wc -c < "$out" | tr -d ' ') bytes";;
  restarts)
    "$ADB" -s "$S" logcat -d -v time -b events | grep -E 'am_proc_start|am_kill' | grep magicbooklet | tail -8;;
  *) echo "unknown command: $cmd"; exit 2;;
esac
