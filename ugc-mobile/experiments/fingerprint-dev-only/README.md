# Development-only modules out of the fingerprint

Status: **written and measured against the fingerprint; waiting for the next store build.** The config is deliberately outside the app root, where `@expo/fingerprint` does not read it: in place it moves both runtime fingerprints once, so no JavaScript-only update would reach the binaries already out. It moves beside `app.json` in the commit the next store build is cut from ("Graduating" below), and `__tests__/fingerprint-dev-only.test.ts` fails the release bump that leaves it behind.

## What it fixes

The published fingerprint hashes expo-dev-client and the three modules it brings (`DEVELOPMENT_ONLY_NATIVE_MODULES` in `plugins/withBuildProfileAutolinking.js`): their native folders, and their entries in the `expoAutolinkingConfig:android` and `expoAutolinkingConfig:ios` sources. Production builds never link them (that plugin leaves them out when `MAGICBOOKLET_INCLUDE_DEV_CLIENT` is `false`), so a dev-client patch changes nothing in a store binary, yet it moves both fingerprints and strands every over-the-air update. That is why expo-dev-client is one of the packages `__tests__/expo-install-exclude.test.ts` holds back, and why every later dev-client patch would need the same hold.

## What it changes

`fingerprint.config.js` gives `@expo/fingerprint` 0.16.8:

- `ignorePaths` for `node_modules/<module>/**` of each of the four modules, so their folders hash to nothing;
- a `fileHookTransform` that drops the four from the `expoAutolinkingConfig:*` sources, which list every autolinked module with its version.

The list is read from the plugin, so the two cannot drift. Development builds get the same fingerprint as store builds of the same tree; they load their JavaScript from Metro, not from updates, so nothing reaches them differently.

## What has been checked

On 0.1.8's tree (2026-10-22, `archive/expo-check-policy-2026-10-22/` at the workspace level):

| Tree | Android | iOS |
|---|---|---|
| As shipped | `02b8fe85` | `4babc8b4` |
| A faked expo-dev-client 55.0.41 (version and a native file) | `cba75f7a` | `d7c244c3` |
| With this config | `ec14a864` | `8d3fb803` |
| With this config and the faked 55.0.41 | `ec14a864` | `8d3fb803` |

Without the config a dev-client change moves both runtimes; with it, it moves neither. The ignored folders stay in the source list with a null hash, so they add nothing.

**Parked, it moves nothing.** `scripts/verify-ota-target.mjs` reports both fingerprints equal to the shipped 0.1.8 builds with this folder present.

## Graduating

In the release bump that the next store build is cut from (both platforms, since the config moves both fingerprints):

1. `git mv experiments/fingerprint-dev-only/fingerprint.config.js fingerprint.config.js` and put a "Graduated on" line at the top of this file.
2. Compute both fingerprints (`./node_modules/.bin/expo-updates fingerprint:generate --platform <ios|android>`), and record them in `ota-targets.json` when the binaries ship.

A release that ships a binary for one platform only cannot graduate it without stranding the other platform's updates: repin the version in the guard test instead.
