# Mobile light mode

Status: implemented on branch `feat/mobile-light-mode` (2026-09-23), not yet merged.
- It ships with the next store build, 0.1.6. The native half cannot go over the air (see Shipping).
- Verified on the iOS 26.4 simulator and the Android 16 emulator against production data, each with a dev client built from this branch. Test suite green: 264 files, 2,564 tests.
- Still open: the iPhone device pass and the store build (see "Still to do before release").

Scope: `ugc-mobile/` only. The web app keeps `color-scheme: dark`.

## Decisions

- **D1 — how the app chooses (the owner, 2026-09-23): follow the phone, with an in-app setting on both platforms.**
  - Settings → Display → Appearance offers System, Light or Dark, as a segmented control with radio semantics.
  - System is the default.
  - The HIG discourages an app-specific setting. Android's dark-theme guide suggests exactly these three options. The owner chose both platforms.
- **D2 — the reel stays dark in both schemes.** The HIG allows a permanently dark appearance for immersive media, and Instagram, TikTok and YouTube Shorts do the same.
  - Dark in both schemes: the zoom flight, the media lightbox and the first-run onboarding. Onboarding's art is a night scene made for black, and a flow that changed look halfway would read as broken.
  - Sheets the reel opens (actions, comments, unlock) are app UI and follow the app's scheme.
- **D3 — palette "warm paper".** It is the light twin of the ivory-on-black palette: warm off-white ground, warm ink type, and tinted panels that step down from the page.
  - Coral splits in two:
    - `primaryFill` is bright `#ff7a59` in both schemes, with ink on it.
    - `primary` is coral as text and marks: `#a83d1c` on light.
  - Tool and semantic accents split the same way.
  - The palette was sent to the owner as a checkpoint on 2026-09-23.

## What was checked before building (native first)

| Option | Verdict |
| --- | --- |
| `userInterfaceStyle: "automatic"` (Info.plist, and expo-system-ui's night mode) | **Adopted.** It is the only way the native layer can follow the phone: keyboard, alerts, glass, the share sheet. |
| React Native `Appearance.setColorScheme` | **Adopted** for the in-app override. It sets `overrideUserInterfaceStyle` on every window on iOS, and `setDefaultNightMode` on Android. On iOS 26 it overrides even an Info.plist pinned Dark (verified), so both schemes preview on existing dev clients. |
| `DynamicColorIOS` / `PlatformColor` with `values-night` | **Rejected for tokens.** Android resolves a `PlatformColor` once and never on a `uiMode` change. Every palette tweak would become a native build. The contrast maths and the tab-bar sampling cannot read opaque colours. |
| expo-splash-screen `dark` (per-platform `ios.splash` / `android.splash`) | **Adopted.** The top-level key drops the dark variant on iOS, and the per-platform legacy keys keep today's 200-wide full-screen image exactly. |
| expo-navigation-bar (SDK 55, `setButtonStyleAsync`) | **Adopted.** It is read through `requireOptionalNativeModule`, because the package's own wrapper requires the module at import and would crash a build that predates it. |
| React Navigation `DefaultTheme` / `DarkTheme` | **Adopted**, picked per scheme. |
| expo-glass-effect `colorScheme` | The tab bar follows the app. The reel's glass buttons are pinned to their dark scope (their default, `auto`, follows the window). |

## Architecture as built

- **`lib/theme.ts`**
  - Two palettes with identical keys: `darkColors` byte-identical to what shipped, and `lightColors`.
  - Per scheme: `semantic`, `state`, `shadow`, `dim` (scrim colour × strength), `tabBar` (the dock's glass, shade, rim and fills).
  - `mediaColors` is scheme-independent, for anything drawn over pictures.
  - `accentFill` / `onAccentFill`: bright fills with ink, in both schemes.
  - `appTheme` holds only static tokens. The dark-palette shim used during the migration is gone, so a static colour read fails typecheck.
- **`lib/theme-context.tsx`**
  - `useAppTheme()` returns one of two frozen themes, so React Compiler re-memoises once per switch.
  - `ThemeScope scheme="dark"` wraps the surfaces that stay dark.
  - `components/app-scheme-scope.tsx` hands the reel's sheets back to the app's scheme.
- **`lib/appearance.ts`**
  - A process store: the phone's scheme plus the stored override (`appearance-preference-v1`).
  - It ignores appearance events while the app is not active: iOS snapshots a backgrounding app in both appearances. It re-reads on return.
  - The root layout holds the splash on the stored choice beside the fonts, so the first frame is already in the right scheme.
  - It is gated on the embedded `userInterfaceStyle === 'automatic'` (or `__DEV__`). A binary still pinned dark can only run JS built from the same app.json, and it stays dark.
- **`lib/system-bars.ts`.** Android navigation-bar icons follow an ordered stack of surfaces. The root declares the app scheme; the reel, lightbox and onboarding declare dark while in front.
- **Tab bar** (`components/magic-tab-bar.tsx`, `lib/tab-bar-ambient.ts`):
  - Light glass with ink labels.
  - The adaptive fill gets a light band: the media's hue as a pastel at 0.90–0.955 lightness, above a contrast floor derived from the deep coral (`minBackgroundLuminance`). The thumbhash is decoded once and mapped per scheme, and both fills are stored.
- **Conversions.**
  - A TypeScript-compiler codemod moved about 1,300 palette reads in 65 files into `useAppTheme()`.
  - About 320 colour literals were classified by hand: accent washes → `hexWithAlpha(theme.colors.<accent>, α)`, media overlays → `mediaColors`, placeholders → `mediaPlaceholder`.
  - Coral fills moved to `primaryFill`. Thin marks stayed `primary`, which reaches 3:1 on paper where the bright coral does not.

## Guard rails

- `hig-type-and-contrast.test.ts` runs every foreground, including the tool accents, against `background`, `panel`, `panelSoft` and `surfaceInset`. It covers both schemes, ink on coral fill, and both tab-bar bands.
- `theme-palette-parity.test.ts` covers:
  - identical names in both palettes;
  - the same notation per token (hex stays hex);
  - shared static tokens;
  - `appTheme` carrying no colours.
- `theme-color-literals.test.ts` — no raw colour literal anywhere. The budget table is empty; `EXEMPT` names each file whose colours are the point: the reel, the lightbox, onboarding, the dock maths, letterbox shading and the web shell. It also pins each dark surface inside its dark scope.
- The same file fails a scheme colour drawn on a picture's dark overlay: a `mediaColors` background or a gradient with a dark foot, followed within a few lines by a `theme.colors` foreground. What sits on a picture takes `themes.dark.colors` or `mediaColors`.
- `appearance.test.ts`, `system-bars.test.tsx`, `appearance-native-config.test.ts`, and additions to `settings-screen`, `tab-bar-ambient` and `auth-screen-apple` (white Apple button on dark, black on light).

## Verified on the simulator (iOS 26.4, production data)

- **Every surface on paper in Light:** Home, Explore, Alerts, Profile, Settings, the tab bar (light glass) and sheets.
- **Dark identical to before** on every screen compared with the pre-change baseline.
- **The reel stays dark from a light Home**, with a light-content status bar and dark glass buttons.
- **Switching is instant** in both directions, with no remount and playback continuing.
- **The stored choice is restored at cold start** before the first frame.
- **iOS respects the override** even with an Info.plist pinned Dark.
- **Two bugs caught and fixed on the way:**
  - on-media pins and chips taking the light scheme's deep accents on dark glass;
  - text on coral fills using `textInverse` (ivory on paper).

### On a new native build

This is a dev client built from this branch: Info.plist `Automatic`, the new splash and expo-navigation-bar. It ran on the simulator `MagicBooklet Light Mode`, an APFS clone of the shared one, so that one was left alone.

- **Cold start in System.** The phone in Light gives a paper launch screen (`#fbf8f4`) and then a light Home with no colour step. The phone in Dark gives a black launch screen and dark Home.
- **A stored override holds before the first frame.** Light on a dark phone opens straight into Light.
- **System follows the phone live, both directions,** under iOS's own appearance crossfade. The Home video keeps playing through the switch.
- **A change made while backgrounded is taken on return,** with no dark frame first.

### On the Android emulator (2026-09-24)

This used a dev client built from this branch, on the Pixel 9a emulator (Android 16, API 36) switched to 3-button navigation. The emulator's settings and its dev client were restored afterwards. Contrast figures were measured from screenshots.

- **Settings → Appearance** switches the app in the same frame, in every direction:
  - A Light choice holds on a dark phone.
  - On System, the app follows the phone live, both ways. The copy reads "Matches your phone — light right now".
- **The 3-button navigation bar follows the surface every time.** Dark icons on light (4.6–5.7:1), light icons on dark (17.7:1). The reel opened from a light grid turns them light, and closing it hands them back.
- **Light surfaces:**
  - Home, Explore, Settings, the side menu, a creator page and the dock are on paper, with dark status-bar icons.
  - Home's top fade runs from paper into the feed.
- **The Google button on paper** is Google's dark artwork, which matches the black Apple button on light. Kept.
- **The splash colours are in the built APK:** `splashscreen_background` is `#fbf8f4`, and `#000000` at night. A dev client puts its own launcher windows in front of the splash, so the moment itself is for the store build.
- **The letterbox question is closed.**
  - Feed cards size each frame to its media, and Explore crops pictures to fill. Only a video whose real shape differs from its recorded one shows the dimmed, blurred edge, and none did in about 20 cards.
  - The black bars on one Explore tile are in that picture itself.
- **Bugs found and fixed:**
  - The creator page's Posts/Recipes/Tools track used the `overlayStrong` scrim, which is a dark grey on paper (1.26:1 labels). It now matches the other segmented controls, `surfaceInset` with a `border` (7.1:1 light, 7.9:1 dark). This makes the dark track a hair lighter.
  - Scheme colours drawn on pictures' dark overlays:
    - the creator tile's price and lock chip;
    - the edit-profile "Change cover" pill;
    - a feed video's loading spinner;
    - the image error plate over its thumbhash;
    - a template's title card.
    They take `themes.dark.colors` now, and the new guard above catches the pattern.
- **An Android build from a clean worktree needs about 10 GB free.**
  - It compiles React Native's Android code from source (the repo patches it), about 2.5 GB of intermediates.
  - expo-updates' CMake step has no `ndkVersion`, so the Android Gradle Plugin installs its default NDK 27.0.12077973 (about 3 GB). That is the "stale" NDK that keeps coming back after disk cleanups.

## Shipping

- **Fingerprint.** `app.json` (automatic, splash) and `package.json` (expo-navigation-bar) are fingerprint inputs on both platforms.
- **Merge timing.** Merge right before dispatching the 0.1.6 store build. After that, OTAs from main reach only 0.1.6, and nothing can be set aside, because app.json touches both platforms. Ship any pending 0.1.5 OTA fixes first.
- **`ota-targets.json`** is updated in the commit that ships the binary.
- **Rebased onto #197 and #201**, which moved the Home rail's and the reel's shades to React Native's own gradient. The rail shades are drawn in `mediaColors.mediaGround` through `linearGradient`, the same in both schemes.

## Still to do before release

1. **Android pass: done on the emulator** (see above). A look on the S24 is optional, for feel.
2. **iPhone pass.**
   - System following the phone, including the Auto schedule.
   - The light splash handing over to Home.
   - Control Center switches landing when it closes.
   - No flicker on background and return.
   - Reel open and close from a light grid, recorded frame by frame.
3. **App Review demo account** checked in light.
4. **Store build 0.1.6** on both platforms.
