# Android app optimization: R8 full pipeline and image memory — plan

Date: 2026-09-05. Baseline: `main` at `5b643d0`; shipped Android build 0.1.4 (70), the first with R8 on.

Scope: the two "Memory usage" recommendations Google Play attaches to 0.1.4 on the Production release dashboard — *Improve your app's memory and performance with R8 optimization* and *Improve your app's performance with bitmap image optimization* — taken to completion rather than dismissed. Android only. iOS is untouched by every phase here.

Non-goals: removing Fresco (it is part of React Native core), chasing the bitmap card to zero (Play's static check flags Glide's and Fresco's own internals and will keep doing so), or enabling anything on the strength of a green build.

## 1. Where we stand

### The R8 card, bullet by bullet

| Play says | Setting today | Where it is pinned |
| --- | --- | --- |
| "uses R8 in compatibility mode rather than full mode" | `android.enableR8.fullMode=false` | `ugc-mobile/plugins/withAndroidReleaseSafety.js` `RELEASE_PROPERTIES`; asserted in `ugc-mobile/__tests__/android-config.test.ts` |
| "Optimization isn't enabled" | plain `proguard-android.txt` base, which carries `-dontoptimize` | `setReleaseProguardSafety()` swaps the template's `proguard-android-optimize.txt` for it; asserted in the same test |
| "Resource shrinking isn't enabled" | `android.enableShrinkResourcesInReleaseBuilds=false` | same plugin and test; the test also asserts `android.r8.optimizedResourceShrinking` is *absent* |
| "Upgrade your Android Gradle plugin to version 9.0 or higher" | AGP 8.12.0 | not ours: `node_modules/@react-native/gradle-plugin/gradle/libs.versions.toml` (`agp = "8.12.0"`, React Native 0.83.10). React Native `main` already pins `agp = "9.2.1"`, so the next Expo SDK brings AGP 9 |

Play's per-bundle numbers for 70 (App bundle explorer → Details): obfuscation 80 %, optimization "–", shrinking "–", install size 23.7 MB. Local proxy: 70 % of `mapping.txt` class lines renamed.

### Why the shape is narrow

0.1.2 build 62 turned on minify, resource shrinking, the optimize base and (implicitly) full mode in one change and reached testers unusable: `expo-secure-store` rejected every read ("cannot be cast to type SecureStoreOptions"), `expo-image` could not build `ContentPosition`, Google sign-in never finished. The revert switched everything off together, so **which switch broke expo-modules-core's record converter was never isolated**. This plan is, first of all, that bisection — one switch per build, a device launch per build.

Two facts gathered for this plan change the risk picture:

- The consumer keep rules *are* in the graph. `expo-modules-core/android/build.gradle` declares `consumerProguardFiles 'proguard-rules.pro'`, and that file keeps every `Record` implementor with members, every `Enumerable` enum, `SharedObject` subclasses, `Module` subclasses' `<init>()` and `definition()`, `ExpoView` constructors, view-event members, `ComposeProps` and `Service`s. `expo-image` ships Glide's recommended rules the same way. So build 62 did not fail because record classes were *deleted*; the suspects are the optimizer (inlining / class merging / access widening against kotlin-reflect) and full mode's stricter reflection assumptions.
- Our own `plugins/android-release.pro` keeps **all of `expo.modules.**` with members**, which shields every Expo module from all three R8 passes. That makes phases 1–3 below safer than build 62 was, and it is also why Play's "optimization percentage" will stay mediocre until phase 4 narrows it.

### The bitmap card

Play lists network-download + `BitmapFactory`-decode paths. The named packages are Glide's fetcher (`com.bumptech.glide.load.data.*`, used by `expo-image`, 15 files in the app) and Fresco's `NetworkFetchProducer` (`com.facebook.imagepipeline.producers.*`, React Native core). The renamed classes (`f4.b.c`, `f4.b.e`, `j4.g.d`, `w0.q.a`) need build 70's `mapping.txt`, which is not on this machine (Play → bundle explorer → Downloads has the ReTrace file).

App code reaches Fresco's network path in exactly one place: the RN core `Image` thumbnail in `ugc-mobile/app/unlocks.tsx:176`. `ugc-mobile/app/auth.tsx:454` uses RN core `Image` for a bundled PNG. Every other image goes through `expo-image`, always inside a sized container (`position: absolute, inset: 0` under a fixed-size `View`), so Glide already downsamples to view size (`allowDownscaling` defaults to true). Server-side, every poster and preview is one rendition at `PREVIEW_MAX_SIZE` (720 px, `src/lib/generation-media-preview.ts`, `src/lib/post-media-preview.ts`, `src/lib/video-poster.ts`), which a 56 px unlock thumbnail and a grid cell both download in full.

## 2. Rules for every phase

1. **One switch per build.** Never combine two R8 changes in one binary, even if both look safe.
2. **The device is the gate.** A green build proves nothing here; a missing rule fails silently at runtime in whichever module is unlucky. Both devices (Pixel_9a AVD API 36 and the Galaxy S24 Ultra) run the full smoke in §3 before anything is uploaded.
3. **Read the outputs before installing.** AGP writes `mapping.txt`, `seeds.txt`, `usage.txt` and `configuration.txt` to `android/app/build/outputs/mapping/release/`. §3 says what to check in them.
4. **Pin every step in the test.** Each phase flips specific assertions in `__tests__/android-config.test.ts`; the test must fail before the change and pass after. Drift is deliberate or it does not happen.
5. **Android-only store builds.** `mobile-store-release.yml` takes `platform: android`; do not churn iOS review for R8 work. Each binary moves the Android fingerprint: `ota-targets.json` changes in the same commit that ships it (`scripts/verify-ota-target.mjs` enforces this).
6. **Alpha for numbers, production at milestones.** Every phase build goes to the closed alpha so Play scores the bundle (bundle explorer → Details); production promotions happen after phase 3 and after phase 4, each as a **staged rollout** (20 % → 100 % after 48 h with vitals clean). R8 breakage is native: an OTA cannot fix it, so the staged rollout is the only safety net once a build is public.
7. **One phase per branch and conversation**, with results recorded in §9 of this document in the same PR.

## 3. Phase 0 — the verification kit (built once, reused by every phase)

**Local release build** (worktree; the recipe from 2026-09-05):

```bash
MAGICBOOKLET_INCLUDE_DEV_CLIENT=false ./node_modules/.bin/expo prebuild --platform android --no-install
printf 'sdk.dir=%s/Library/Android/sdk\n' "$HOME" > android/local.properties
cd android && JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a --console=plain
```

Known trap: `.env.local` carries `EXPO_PUBLIC_REVENUECAT_*` as empty strings and outranks `.env.production`; delete those two lines from the *worktree's copy* or the JS bundle step refuses to build.

**New script `ugc-mobile/scripts/inspect-r8-output.mjs`** (deliverable of this phase), reading the four output files:

- obfuscation proxy: share of `mapping.txt` class lines whose renamed side differs (baseline 70 %);
- survivors: for a fixed list — `expo.modules.securestore.SecureStoreOptions`, `expo.modules.image.ContentPosition`, every class `seeds.txt` lists as an `expo.modules.kotlin.records.Record` implementor, `kotlin.Metadata` — print kept-by-name / renamed / removed;
- `configuration.txt`: confirm the merged config contains the expo-modules-core consumer rules, our `android-release.pro` lines, and (until phase 1) `-dontoptimize`;
- diff mode: given two output directories, list every `expo.modules.*` class whose status changed. This is how phase 4 is reviewed.

**Device smoke** (both devices; the S24 Ultra needs the Play-signed alpha or an uninstall first — a debug-signed APK cannot install over the Play-signed app):

| Area | What to do | Module under test |
| --- | --- | --- |
| Cold start | launch, then force-stop and relaunch | splash (`expo-splash-screen`), `expo-updates` startup |
| Registered session | existing account restored, still restored after a cold restart | `expo-secure-store` records |
| Guest path | fresh install as guest, onboarding, guest session survives restart | secure store + auth |
| Google sign-in | complete a sign-in, not just open it | `expo-auth-session` / browser hand-off (never finished in build 62) |
| Home + Showcase | grids fill, hero transition, pull to refresh | `expo-image` records (`ContentPosition`, source) |
| Viewer | open a Motion post, audio, scrub | `expo-video` / media3 (Qualcomm decoder on the phone, software on the AVD) |
| Create | pick a reference image and a document | `expo-image-picker`, `expo-document-picker` option records |
| Alerts | grant push permission, token registers | `expo-notifications`, FCM |
| Paywall | offerings load, Play Billing "Ready", INR prices (phone only; the AVD reports BILLING_UNAVAILABLE) | RevenueCat + Play Billing |
| Deep link | open a `https://magicbooklet.com/showcase/…` link | intent filters, `expo-router` |
| Phase 3 extras | notification icon in a real push, launcher icon, fonts, splash colours | resource shrinking |

Logcat gate: zero matches for `RecordCastException|Cannot create a record|cannot be cast to type|FATAL EXCEPTION|Fatal signal` across the run. Expected noise on a plain Gradle build: `expo-updates` "Remote update request not successful" (no EAS channel header) and RevenueCat BILLING_UNAVAILABLE on the AVD.

**Memory measurement** (for phase 5, taken now as baseline): `adb shell dumpsys meminfo com.magicbooklet.mobile` after (a) Showcase grid scrolled through 60 cards, (b) 20 feed cards, (c) the viewer on a Motion post. Record `Graphics` and `TOTAL PSS`.

**Play read** per uploaded bundle: obfuscation %, optimization %, shrinking %, the "R8 configuration" checklist, install size, and the review page's device-support warning count (must stay at the ABI six).

Deliverables: the script, a `docs/` note of baseline numbers in §9, and the test file unchanged.

## 4. Phase 1 — optimization on (optimize base), still compatibility mode, no shrinking

Change (one line of behaviour): `setReleaseProguardSafety()` stops swapping the template's `proguard-android-optimize.txt` for the plain file. Keep `-dontoptimize` available as an explicit line in `android-release.pro` **only as the rollback**, not in the shipped config.

Test flips: the "plain base" assertions invert (`safeBuildGradle` must now contain `proguard-android-optimize.txt`); `setReleaseProguardRules()` must locate the optimize base instead; the survivors list from phase 0 is asserted against a committed fixture of `seeds.txt` names, so a future edit that drops `SecureStoreOptions` from the seeds fails a unit test, not a tester.

What it enables: inlining, class merging, `-allowaccessmodification`. Everything under `expo.modules.**` is still hard-kept, so the optimizer cannot touch a record, a module or a view; the likely failure surface is a *non*-Expo reflecting library. Check `configuration.txt` for libraries with no consumer rules (`react-native-purchases`' wrapper has none; RevenueCat's own AAR ships its rules inside `META-INF/proguard`) before installing.

Exit: smoke green on both devices; alpha bundle shows an optimization percentage; install size below 23.7 MB; `-dontoptimize` gone from `configuration.txt`.

Why first: AGP 9.0 drops `getDefaultProguardFile("proguard-android.txt")` altogether. If this phase cannot be made to pass, the fallback is an explicit `-dontoptimize` in `android-release.pro` — and that fallback must be in place *before* the Expo SDK that brings AGP 9, or the plugin's swap breaks the build.

## 5. Phase 2 — R8 full mode

Change: `android.enableR8.fullMode` → `true` (explicit, so the intent is pinned, not the AGP default).

Test flips: the fullMode assertion.

What changes in full mode: `-keep class X` no longer implicitly keeps `X`'s default constructor or members; R8 assumes no reflection on anything not covered by a rule. expo-modules-core's consumer rules were written for this (they keep `Module` `<init>()` and `ExpoView(Context, AppContext)` explicitly). Our blanket rule still covers the rest of `expo.modules.**`. Libraries to inspect in `configuration.txt`: `expo-video`/media3 (ships rules), Firebase messaging (ships rules), Google Sign-In, `kotlinx.coroutines`, and anything using `Class.forName` with a string (dev-only in Expo).

Exit: smoke green; Play's checklist drops "Full Mode"; obfuscation and optimization percentages do not regress.

## 6. Phase 3 — resource shrinking, then optimized resource shrinking

3a. `android.enableShrinkResourcesInReleaseBuilds=true` with `android.r8.optimizedResourceShrinking=false`.
3b. `android.r8.optimizedResourceShrinking=true` (AGP 9 makes this the default; Play scores it as a separate checklist item).

Test flips: the shrink assertion, and the "optimizedResourceShrinking must be absent" assertion becomes "must be `true`" after 3b.

Failure surface: resources looked up by name at runtime (`Resources.getIdentifier`) — notification icon and colour (`expo-notifications` reads them via manifest meta-data, which the shrinker respects), splash drawables and colours referenced from styles, fonts (React Native loads them from assets, not resources), adaptive launcher icon, Google Sign-In button assets. `android/app/build/outputs/mapping/release/resources.txt` lists what was removed; anything wrongly removed gets a `res/raw/keep.xml` entry with `tools:keep`, written by the plugin so a prebuild does not lose it.

Exit: phase-3 rows of the smoke green (a *real* push shows the icon), Play shows a shrinking percentage, install size down again. **Milestone: promote to production, staged 20 %.**

## 7. Phase 4 — narrow the keep rules (where the real optimization lives)

Today `-keep class expo.modules.** { *; }` holds every Expo class by name, with all members, unoptimized. The consumer rules already describe what actually needs keeping, so the blanket rule is mostly insurance carried from build 62. Narrow it in steps, one build each, reviewing the phase-0 script's diff between builds:

4a. `-keep,allowoptimization class expo.modules.** { *; }` — names and members stay, the optimizer may inline and merge inside. Lowest risk, and it is the change that moves Play's optimization percentage the most.
4b. `-keep,allowoptimization,allowshrinking class expo.modules.** { *; }` — unused Expo code may now be dropped; records, modules and views are still pinned by the consumer rules.
4c. Drop the blanket rule; keep `-keep class kotlin.Metadata { *; }`, the `-keepattributes` line (`InnerClasses,Signature,RuntimeVisible*Annotations,EnclosingMethod,AnnotationDefault` are what kotlin-reflect reads), and the two named modules (`expo.modules.securestore.**`, `expo.modules.image.**`) as `-keep,allowoptimization`. Anything the smoke breaks gets a targeted rule with a comment naming the failure, never a return to the blanket.

Do **not** add `-repackageclasses` here; AGP 9.1 will make repackaging the default and that is its own verification (phase 6).

Test flips: the four literal keep-rule assertions become assertions on the narrowed forms plus a rule that the blanket `-keep class expo.modules.** { *; }` is absent.

Exit: smoke green on both devices after each sub-step; Play obfuscation above 80 % and optimization percentage up versus phase 3. **Milestone: promote to production, staged 20 %.**

## 8. Phase 5 — the image decoding surface

5a. **Retire RN core `Image` from app code.** `app/unlocks.tsx` `UnlockThumbnail` → `expo-image` (`contentFit="cover"`, `cachePolicy="memory-disk"`, `recyclingKey={uri}`, keep the icon base layer and the `onError` fallback). `app/auth.tsx` Google button PNG → `expo-image`. Add a ratchet guard (the mobile UI ratchet already scans every file): no `Image`/`ImageBackground` import from `react-native` under `app/` and `components/`.

5b. **Drop the Fresco add-ons.** With RN core `Image` unused, `expo.gif.enabled` and `expo.webp.enabled` only add Fresco's `animated-gif` and `webpsupport` (`android/app/build.gradle:163–177`). Set both to `false` through the plugin's `withGradleProperties` so a prebuild keeps them. `expo-image` decodes GIF and WebP through Glide (its keep rules already name the Glide WebP integration). Verify a GIF and a WebP still render in the feed.

5c. **Bound and dedupe decodes.** Audit the 15 `expo-image` sites: every one must sit in a fixed-size container (they do today); blurred backdrops in `components/feed-media-frame.tsx` decode the same 720 px poster a second time at low priority — acceptable, but measure it in the phase-0 memory numbers and drop the backdrop on low-RAM devices if `Graphics` PSS says so.

5d. **A small rendition for small tiles** (separate deliverable, shared with the scaling track). Add a 256 px rendition beside the 720 px one in the three producers and the `media-preview-repair` cron, expose it as `thumbnailUrl` on the generation, post and showcase DTOs, and let the mobile tiles (`showcase.tsx`, `home-feed-card.tsx`, `profile-feed-card.tsx`, `showcase-media-preview.tsx`, `unlocks.tsx`) request it below a 200 px container. This is the change that lowers both decode memory and Supabase egress; it needs a backfill for existing media, so it ships through the normal web release, not the store.

Exit for 5a–5c: smoke green; `dumpsys meminfo` `Graphics` PSS at or below baseline on the three scenarios; install size down. The Play card is expected to **persist** (it flags Glide and Fresco internals); after 5a–5b it is fair to mark it "not useful" in the console.

## 9. Phase 6 — AGP 9 (arrives with the next Expo SDK)

Not schedulable by us; prepare for it: phase 1 done (or the explicit `-dontoptimize` fallback), `android.r8.optimizedResourceShrinking` becomes default-on (phase 3b already matches), AGP 9.0 filters global options out of library consumer rules (nothing we depend on uses one), AGP 9.1 repackages classes by default — re-run the whole phase-0 kit as the first step of the SDK upgrade and treat any string-based class lookup failure as a `-keepnames` candidate.

## 10. Sequencing and effort

| Phase | Change surface | Builds | Gate | Estimate |
| --- | --- | --- | --- | --- |
| 0 | `scripts/inspect-r8-output.mjs`, baseline numbers | 1 local | script output matches Play's 80 % within a few points | ½ day |
| 1 | plugin swap removed, test | 1 local + alpha | smoke ×2 devices, optimization % on Play | 1 day |
| 2 | one property, test | 1 local + alpha | smoke ×2 | 1 day |
| 3a/3b | two properties, `keep.xml` if needed, test | 2 local + alpha | smoke incl. resource rows; **production, staged** | 1 day |
| 4a/4b/4c | `android-release.pro`, test | 3 local + alpha | smoke after each; **production, staged** | 2–3 days |
| 5a–5c | two screens, ratchet guard, two properties | 1 local + rides the next release | smoke + `meminfo` | 1 day |
| 5d | web producers, cron, DTOs, mobile tiles, backfill | web release + mobile OTA-able | egress and `meminfo` | 3–5 days |

Each store build after phase 0 is a new Android version code with the same `0.1.x` name unless a milestone ships; the milestone releases bump the version in the usual five places.

## 11. Rollback

Every phase is one property or one line in the plugin: revert the line, rebuild, re-upload. A bad build already in production is halted from the staged rollout and the previous bundle re-promoted; nothing here can be fixed by an OTA update, which is why no phase build goes to 100 % without 48 h of clean vitals.

## 12. Decisions for the owner

- Production cadence: two milestones (after phase 3 and after phase 4) as written, or a single release at the end. Two is recommended: a smaller diff to bisect if Play vitals move.
- Staged rollout percentage for the first optimized production build. 20 % recommended.
- Whether 5d belongs to this track or to the scaling audit. Recommended: the scaling track owns the producers and backfill; this plan only fixes the mobile consumer contract (`thumbnailUrl`).

## 13. Results log

### Status — 2026-09-05, end of the first working day

Done on `feat/android-r8-full-pipeline` (12 commits), every step verified on the Pixel_9a emulator (API 36, existing signed-in demo account) and none yet on a phone: the phase 0 kit, phases 1, 2, 3a, 3b, 4a, 4b (second attempt), 4c, 5a, 5b, and the 5c audit. The shape now pinned by `plugins/withAndroidReleaseSafety.js`, `plugins/android-release.pro` and `__tests__/android-config.test.ts`: optimize base, full mode, optimized resource shrinking, the `expo.modules.kotlin.**` runtime kept optimizable-not-shrinkable, no blanket rule over the modules, React Native's core `Image` retired, Fresco's GIF/WebP add-ons off. Local arm64 release APK 43.6 → 38.9 MB; classes 23028 → 13313; TOTAL PSS on the smoke path 201 → 186 MB. The renamed share reads 64.2 % of a much smaller program; Play's own three percentages are read from the alpha bundle, not locally.

The one finding that matters most: **build 62's culprit is isolated**. Shrinking expo-modules-core's runtime (`expo.modules.kotlin.**`) reproduces it exactly, with every record class intact; full mode and the optimizer do not. The inspector reports that failing build as clean, so the device smoke stays the gate for every future keep-rule edit.

Not done, in order: the phone smoke (no device was connected; §3 lists the rows only a phone can cover — Play Billing, Google sign-in completion, the Qualcomm decoder); the Android-only store build to the closed alpha (`mobile-store-release.yml` with `platform: android` and `submit_to_test_track: true`, from `main` after the PR merges) and the Play bundle-explorer read of obfuscation / optimization / shrinking percentages; the staged production promotion (§12 decision 1 — with all of 3 and 4 in one branch, the two milestones collapse into one release unless the owner wants them split); `ota-targets.json` in the commit that ships the binary; 5d renditions; phase 6 when the Expo SDK that carries AGP 9 lands (the base file is already the one AGP 9 keeps).

Append one entry per phase in the PR that ships it: date, branch, build/version code, script output (obfuscation proxy, survivors), device smoke result per device, Play numbers (obfuscation / optimization / shrinking / install size), and any rule added with the failure that justified it.

- **Phase 0 — 2026-09-05, `feat/android-r8-full-pipeline`, local release build off `main` 5b643d0 (shape of shipped build 70).** Inspector: 16158 of 23028 classes renamed (70.2 %); merged configuration carries the expo-modules-core record and enumerable keeps, `kotlin.Metadata`, the blanket `expo.modules.**` keep and `-dontoptimize`; `expo.modules.*` 4082 classes (3697 kept by name, 385 renamed, 0 removed); reflected types 110 of 110 kept by name. Emulator smoke (Pixel_9a, API 36, existing signed-in demo account): cold start 4.3 s, session restored, Showcase grid, viewer via app link on a Motion post, Alerts, Profile, Create sheet, cold restart 0.6 s; 0 logcat signature matches; TOTAL PSS 201 MB (emulator reports no Graphics PSS). Phone: not connected, not run. APK 43.6 MB debug-signed arm64.
- **Phase 1 — 2026-09-05, optimize base (`proguard-android-optimize.txt`, no plain-file swap).** Build 1 m 25 s on the warm worktree. Inspector: 12236 of 19103 classes renamed (64.1 %; the optimizer merged or inlined ~3900 classes, so the ratio's denominator shrank while the kept-by-name Expo set did not); `-dontoptimize` gone, `-allowaccessmodification` on; `expo.modules.*` 3848 classes (3697 kept by name, 127 renamed, 24 removed — all D8/R8 synthetic lambdas and API outlines); reflected types 110 of 110 kept by name, 0 status changes against phase 0. Emulator smoke: cold start 3.1 s, session restored, Showcase grid, viewer video, Alerts, Profile, Create sheet, cold restart 0.45 s; 0 logcat signature matches; TOTAL PSS 193 MB. APK 41.9 MB (−1.7 MB). Phone: not run.
- **Phase 2 — 2026-09-05, R8 full mode (`android.enableR8.fullMode=true`).** Build 1 m 13 s. Inspector: 8388 of 15234 classes renamed (55.1 %; another ~3900 classes gone, the kept-by-name Expo set is now a quarter of the program, which is what phase 4 addresses); `expo.modules.*` 3807 classes (3697 kept by name, 85 renamed, 25 removed synthetics); reflected types 110 of 110 kept by name, 0 status changes against phase 1. Emulator smoke: cold start 3.1 s, session restored, Showcase grid, viewer video, Alerts, Profile, Create sheet, cold restart 0.48 s; 0 signature matches; error-level logcat lines from the app process identical to phase 1 (expo-updates 400 without a channel header, WebView seed, ashmem). TOTAL PSS 191 MB. APK 41.5 MB. Phone: not run.
- **Phase 3a — 2026-09-05, resource shrinking on the classic AAPT2 pipeline (`android.r8.optimizedResourceShrinking=false`).** Build 1 m 53 s. APK `res/` entries 1454 → 1282, `resources.arsc` 2.1 → 1.8 MB, APK 41.1 MB; code outputs identical to phase 2 (0 class or reflected-type status changes). AGP 8.12's `resources.txt` lists only reachability markings, so removals are read from the APK. Emulator smoke: session restored, Showcase grid, viewer video, Alerts, Profile, Create sheet, cold restart 0.52 s; 0 signature matches; a missing launch-theme or splash resource would have surfaced as a Resources$NotFoundException at start and did not. The 0.7 s splash capture was covered by the emulator's own system ANR dialog and proves nothing. TOTAL PSS 192 MB. Phone: not run.
- **Phase 3b — 2026-09-05, R8 optimized resource shrinking (`android.r8.optimizedResourceShrinking=true`).** Build 1 m 28 s. APK `res/` entries 1282 → 983, `resources.arsc` 1.8 → 1.3 MB, dex 14.6 → 14.3 MB, APK 40.3 MB (−3.3 MB against build 70's local baseline); 15038 classes, 54.7 % renamed; the only class-status changes are 19 R8 synthetic lambdas; reflected types 110 of 110 kept by name. `aapt2 dump resources` on the APK still lists `mipmap/ic_launcher*`, `drawable/splashscreen_logo`, `color/splashscreen_background`, `drawable/notification_icon`, `color/notification_icon_color` and `color/iconBackground`. Emulator smoke: session restored, Showcase grid, viewer video, Alerts, Profile, Create sheet, cold restart 0.52 s; 0 signature matches; no resource-not-found line from the app process; the 146 `ViewManagerPropertyUpdater` "could not find generated setter" warnings are present in identical number in every phase including the baseline (React Native falls back to reflection for view managers without generated setters). TOTAL PSS 190 MB. Phone: not run. **Milestone reached for production per §2 rule 6, pending the phone smoke.**
- **Phase 4a — 2026-09-05, `-keep,allowoptimization class expo.modules.** { *; }`.** Build 1 m 18 s. With every member still kept the optimizer has little to remove: 15005 classes (−33), dex 14.3 MB unchanged, APK 40.3 MB; 12 synthetic-lambda status changes, reflected types 110 of 110 kept by name. Emulator smoke identical to 3b, 0 signature matches, cold restart 0.49 s, TOTAL PSS 191 MB. Launcher icon confirmed in the app drawer on the 3b/4a install. Phone: not run.
- **Phase 4b, first attempt — 2026-09-05, `-keep,allowoptimization,allowshrinking class expo.modules.** { *; }` — FAILED on the emulator, reproducing build 62.** Build fine (13381 classes, dex 12.5 MB, APK 39.7 MB); inspector clean: all 110 records and enumerables kept by name, `Field`, `Required`, `Record`, `Enumerable` present. On device: Showcase shows "Something went wrong — Call to function 'VideoPlayer.constructor' has been rejected → The 1st argument cannot be cast to type expo.modules.video.records.VideoSource? (received ReadableNativeMap) → NullPointerException", and logcat carries `Cannot set prop 'source' on ExpoImageViewWrapper … Cannot create a record of the type: 'expo.modules.image.records.ContentPosition?'`. So the build-62 culprit is isolated: **shrinking expo-modules-core's own runtime (`expo.modules.kotlin.**`)** — 844 whole classes and members of `RecordTypeConverter`, `TypeConverterProviderImpl`, `Either*`, `SharedRef` and the allocators went — breaks the reflection-driven record converter even though every record class survives intact. Full mode (phase 2) and the optimizer (phases 1, 4a) were not the cause. The inspector cannot see this class of failure, which is exactly why the device smoke is the gate.
- **Phase 4b, second attempt — 2026-09-05, `-keep,allowoptimization class expo.modules.kotlin.** { *; }` (the runtime, never shrinkable) + `-keep,allowoptimization,allowshrinking class expo.modules.** { *; }` (the modules).** Build 1 m 18 s. 14184 classes, 55.8 % renamed; `expo.modules.*` 3614 classes (3146 kept by name, 65 renamed, 403 removed); dex 13.2 MB (from 14.3), APK 39.9 MB; reflected types 110 of 110 kept by name. Emulator smoke: session restored, Showcase grid, viewer video, Alerts, Profile, Create sheet, cold restart 0.51 s; 0 signature matches; TOTAL PSS 191 MB. Phone: not run.
- **Phase 4c — 2026-09-05, no blanket rule over the modules.** Kept: the runtime `expo.modules.kotlin.**` (optimizable, never shrinkable), `expo.modules.ExpoModulesPackageList` by name (three `Class.forName` sites in expo-modules-core and expo), `expo.modules.updates.UpdatesPackage` by name (`ModulePriorities` keys packages by qualified name), `kotlin.Metadata` and the attributes, the two build-62 modules as optimizable-not-shrinkable, and a `-keepclassmembers` for the cropper field and method expo-image-picker reaches by reflection. Build 1 m 16 s. 13356 classes, **64.3 % renamed** (back above the phase-0 level's neighbourhood with 42 % fewer classes); `expo.modules.*` 2845 classes (1644 kept by name, 785 renamed, 416 removed); dex 12.8 MB, APK 39.8 MB (−3.8 MB against the local baseline); reflected types 110 of 110 kept by name. Emulator smoke: session restored, Showcase grid, viewer video, Alerts, Profile, Create sheet, cold restart 0.50 s; 0 signature matches; no new error- or warning-level line from the app process against phase 3b; TOTAL PSS 187 MB. Phone: not run. **Second production milestone reached per §2 rule 6, pending the phone smoke.**
- **Phase 5a + 5b — 2026-09-05, React Native core `Image` retired, Fresco add-ons dropped.** Three uses, not two: the unlock thumbnail (`app/unlocks.tsx`), the Google sign-in button (`app/auth.tsx`) and the shared avatar in `components/ui.tsx` (found by the new ratchet `__tests__/react-native-image-retired.test.ts`, which now fails on any `Image`/`ImageBackground` import from react-native under `app/`, `components/`, `lib/`). All three render through expo-image (`contentFit`, `cachePolicy="memory-disk"`, `recyclingKey`; `accessibilityIgnoresInvertColors` kept — expo-image's props extend `ViewProps`). `expo.gif.enabled` and `expo.webp.enabled` are written `false` by the plugin. Result: Fresco 304 → 268 classes, its animated/WebP add-ons 37 → 1 class, native `lib/` 20.2 → 19.4 MB, APK **38.9 MB** (−4.7 MB against the local build-70 baseline of 43.6 MB). Code shape otherwise as 4c (13313 classes, 64.2 % renamed, 110 of 110 reflected types kept by name). Emulator smoke: session restored, Showcase grid, viewer video, Unlocks screen with thumbnails, Alerts, Profile with avatar, Create sheet, cold restart 0.47 s; 0 signature matches; TOTAL PSS 186 MB (baseline 201 MB). Phone: not run. 5c (bounded decodes) audited: all expo-image sites sit in fixed-size containers; nothing to change. 5d (256 px renditions) not started — separate deliverable with the web producers.
