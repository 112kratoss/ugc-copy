> **Graduated on 2026-09-19** into `patches/expo-video+55.0.21+002+android-light-player-view.patch`, applied by `postinstall` like every shipped patch; the copy that lived here is gone. This folder keeps the design notes and the inert helper plugin. Fingerprints and the store-build checklist: plan section 5, step 6.

# Scoped Android video hosts

The earlier app-wide layout override removed controls from creation previews
and the lightbox, which use `nativeControls`. Do not register that global
override. This patch adds distinct light surface and texture view types; the
Expo React wrapper selects them only for `nativeControls={false}` and only
when the binary advertises support. The normal hosts keep full controls and
subtitles. Changing the prop remounts the host while retaining the player.

Apply after the normal package patches:

```sh
npx patch-package --patch-dir experiments/android-light-player-view/patches
```

The patch includes uniquely named library resources and removes Expo Video's
prebuilt publication so Gradle compiles the changed Kotlin. No app config
plugin is needed. Promote it into the regular patch only in a store-build
commit. It changes runtime compatibility. Native compile, controlled-player
play/pause/seek/fullscreen, light-view playback/return and frame measurements
must pass before promotion. The iOS queue-loop experiment is independent.
