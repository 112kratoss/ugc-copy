# iOS video-loading experiment

Status: **not accepted as the Home scrolling fix**. This patch is deliberately
outside `patches/`, so the application's postinstall does not apply it.

This is a backport of [Expo PR #47975](https://github.com/expo/expo/pull/47975)
to the installed `expo-video` 55.0.21. It adds the dedicated loading executor,
preloads asset properties and media-selection groups, and avoids assigning the
same player to AVPlayerViewController twice. UIKit/player-item replacement
continues to use the existing main-thread path.

The patch compiled in the separate iPhone Release test build alongside the
existing cache and experimental lightweight-video-view patches. Exact native
events confirmed that asset initialization moved off the main thread. That is
an implementation result, **not evidence that the reported stutter is fixed**.

## Physical-phone evidence

Device: iPhone 16e, iOS 26.6.2. Separate bundle:
`com.athuls.magicbooklet.zoom`; production was not replaced. Fixed 12-card feed,
same slow held drags over new video cards, original React Native traversal.
The baseline already includes earlier experimental feed/host changes.

| Capture | Loader | Main-thread asset initializations during measured drags | Moving display-link callback gaps >25 ms | Largest callback gap | Instruments hitch duration in test interval |
| --- | --- | --- | --- | --- | --- |
| R7-N1 | baseline | 3/3 | 2 | 48.7 ms | 16.7 ms |
| R8-N1 | candidate | 0/3 | 3 | 62.8 ms | 33.3 ms |
| R8-N2 | candidate | 0/3 | 4 | 52.0 ms | 16.7 ms |

Callback gaps measure delayed main-thread observation during native scrolling;
they are not presentation timestamps or directly measured frozen-frame time.
These few runs do not establish statistical equivalence or a regression, but
they do not support shipping the candidate as the scrolling fix either.
The same players remain prepared for the warm reversal control, so that test
does not exercise this candidate's main change.

Raw traces, source hashes, test logs and analysis scripts are preserved outside
git in `archive/home-scroll-audit-2026-09-22/device-ab/` at the workspace level.
See `R8-manifest.json`, `read_fixed.py`, `compare_fixed.py` and `gap_stacks.py`.
The temporary build checkout and its derived data were subsequently removed;
the baseline app and recorded evidence remain in the archive. The R8 diagnostic
app remains installed on the test phone.

## Applying for another experiment

From an isolated mobile checkout with the repository's normal patches applied:

```sh
patch --dry-run -p1 < experiments/ios-video-loading/patches/expo-video+55.0.21.patch
patch -p1 < experiments/ios-video-loading/patches/expo-video+55.0.21.patch
```

Run CocoaPods and make a new native build. This is iOS native code and cannot
reach existing store binaries through a JavaScript OTA. Android stays on its
existing implementation. The test build compiled with the package's Swift 5.9
settings and deployment target; only the stated iPhone OS has been exercised.

Before promotion, require repeatable scrolling benefit plus source replacement,
cancellation, HLS, failure/retry, backgrounding, cache and feed/reel handoff
coverage. The mobile suite (256 files, 2,494 tests) and typecheck passed during
the experiment, but those checks do not validate native timing or concurrency.
