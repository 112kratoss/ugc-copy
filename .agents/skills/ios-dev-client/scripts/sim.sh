#!/bin/bash
# iPhone simulator helpers for the Magicbooklet dev client.
#   sim.sh which                     booted devices, and every MagicBooklet.app on the first one with its bundle id and kind
#   sim.sh boot [udid]               boot and wait (default: the first available iPhone)
#   sim.sh launch [udid] [port]      terminate, then launch the dev client once on Metro at 127.0.0.1:<port> (8081)
#   sim.sh shot <file.png> [udid]    screenshot
#   sim.sh appearance [light|dark] [udid]   print the current value, then set one if given
set -u
PKG="${PKG:-com.magicbooklet.mobile}"
booted() { xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}' | head -1; }
cmd="${1:?a command}"; shift
case "$cmd" in
  which)
    xcrun simctl list devices booted | grep -E 'iPhone|iPad' || echo "nothing booted"
    u="$(booted)"; [ -n "$u" ] || exit 0
    for app in ~/Library/Developer/CoreSimulator/Devices/"$u"/data/Containers/Bundle/Application/*/*.app; do
      [ -e "$app/Info.plist" ] || continue
      id=$(defaults read "$app/Info.plist" CFBundleIdentifier 2>/dev/null)
      case "$id" in *magicbooklet*|*MagicBook*) ;; *) continue;; esac
      kind="release build"; [ -e "$app/EXDevLauncher.bundle" ] && [ ! -e "$app/main.jsbundle" ] && kind="dev client"
      echo "$id  $kind  $(defaults read "$app/Info.plist" CFBundleShortVersionString 2>/dev/null) ($(defaults read "$app/Info.plist" CFBundleVersion 2>/dev/null))  $(stat -f '%Sm' "$app")"
    done;;
  boot)
    u="${1:-$(xcrun simctl list devices available | grep -E 'iPhone' | grep -oE '[0-9A-F-]{36}' | head -1)}"
    xcrun simctl boot "$u" 2>/dev/null || true
    xcrun simctl bootstatus "$u" -b && echo "booted $u";;
  launch)
    u="${1:-$(booted)}"; port="${2:-8081}"
    [ -n "$u" ] || { echo "no booted simulator"; exit 1; }
    xcrun simctl terminate "$u" "$PKG" 2>/dev/null || true
    xcrun simctl launch "$u" "$PKG" --initialUrl "http://127.0.0.1:$port"
    echo "one load only: wait for the app's UI or the 'Failed to connect' alert (15 s or more) before another; proof is an 'iOS Bundled' line in preview_logs";;
  shot)
    out="${1:?a .png path}"; u="${2:-$(booted)}"; xcrun simctl io "$u" screenshot "$out" > /dev/null && echo "$out";;
  appearance)
    want="${1:-}"; u="${2:-$(booted)}"
    echo "current: $(xcrun simctl ui "$u" appearance)"
    [ -n "$want" ] && xcrun simctl ui "$u" appearance "$want" && echo "set: $want (the app may override it in its own Settings)";;
  *) echo "unknown command: $cmd"; exit 2;;
esac
