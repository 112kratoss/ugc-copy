# Native loop probe

This small UIKit app compiles the **actual patched** `VideoPlayerLoopController.swift` from the installed expo-video package (present only while the experiment patch below is applied). It runs seek-based looping for 64 seconds, then queue looping for 64 seconds on the same generated 3-second, 30 fps H.264 fixture. It checks disabling preserves the item/position and resetting cancels preparation and empties the queue.

`AVPlayerItemVideoOutput` reports decoded sample availability. The JSON **does not measure compositor presentation** and must not be called a displayed-frame or app smoothness benchmark. It adds sample-output overhead. Record the integrated app with Instruments Display + Points of Interest for the presentation gate. The full Expo subclass, source events, caching and navigation need integrated app tests too.

From `ugc-mobile`, create a scratch directory outside paths containing spaces. Copy `Probe.swift` there, then generate the fixture:

```sh
ffmpeg -f lavfi -i testsrc2=size=320x480:rate=30 -t 3 -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart /tmp/magicbooklet-loop-probe/loop.mp4
ruby scripts/native-loop-probe/make-project.rb /tmp/magicbooklet-loop-probe "$PWD/node_modules/expo-video/ios/VideoPlayerLoopController.swift"
xcodebuild -project /tmp/magicbooklet-loop-probe/LoopProbe.xcodeproj -scheme LoopProbe -configuration Release -destination 'platform=iOS Simulator,id=<simulator-id>' -derivedDataPath /tmp/magicbooklet-loop-probe/loop-sim CODE_SIGNING_ALLOWED=NO ONLY_ACTIVE_ARCH=YES
```

Use the local CocoaPods Ruby environment if `xcodeproj` is not available. The generator uses the existing Personal Team for local device testing and the separate `com.athuls.magicbooklet.loopprobe` identifier. Install/launch with simctl or devicectl. Read `Documents/results.json` from that app's data container after the label says Complete. Keep simulator and physical results separate; record exact build, device, thermal state and source hash. The fixture has no audio; this probe cannot verify audio continuity.

The integrated Magicbooklet experiment has two halves. The native half is `experiments/seamless-loop/patches/expo-video+55.0.21.patch`, kept outside `patches/` on purpose: `@expo/fingerprint` hashes `patches/` and the patched `node_modules/expo-video/ios` for every platform, so inside `patches/` it moves the iOS runtime fingerprint and strands JS-only updates to the shipped build (verified 2026-09-19). `postinstall` never applies it. Apply it by hand after `npm ci`, and reverse it before any fingerprint or OTA check:

```sh
npx patch-package --patch-dir experiments/seamless-loop/patches
npx patch-package --reverse --patch-dir experiments/seamless-loop/patches
```

The JS half is `EXPO_PUBLIC_SEAMLESS_VIDEO_LOOP=1` at bundle build time. Default is disabled, and a binary without the native half ignores the option. Build under a separate test bundle ID and a private Metro TMPDIR. Do not alter production OTA targets. When a store build is to carry the experiment, move the file into `patches/` in the commit that build is made from, and update `ota-targets.json` when the binary ships.
