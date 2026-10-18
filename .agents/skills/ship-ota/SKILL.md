---
name: ship-ota
description: Publish a JS-only over-the-air (OTA) update of the Magicbooklet mobile app with ugc-mobile/scripts/publish-ota.mjs and prove it reached phones. Use when the owner asks to ship, publish or roll out an OTA, to "update the apps" after a mobile fix merged, for a dry run, or to roll a live update back. Not for store binaries (that is mobile-store-release.yml), and not before the web release is live when the app half calls a new server route.
disable-model-invocation: true
---

# Ship an OTA

Every step here is one the publish script enforces or a check around it. The script is the only way an update leaves this Mac; never call `eas update` yourself (the Bash guard in `.claude/hooks/guard-bash.py` blocks it). Say "OTA" when reporting, never "release" or "deploy": merging to `main` never reaches phones.

## Before the dry run

1. The change is on `origin/main`: `git fetch origin main && git log --oneline -3 origin/main`. The script builds in a throwaway worktree at an origin/main commit (`--ref <sha>` picks one; the newest otherwise) with a real `npm ci`, so nothing uncommitted and nothing from this checkout's `.env.local` can reach a phone.
2. No store release is in flight: `gh run list --workflow mobile-store-release.yml --limit 3`. A push to `main` while one runs cancels it at the submit gate.
3. If the app half calls a new server route, the web release must be live first: wait until `https://magicbooklet.com/api/app-version` reports the merged build, or phones meet 404s.
4. `ugc-mobile/ota-targets.json` names the fingerprints of the binaries in users' hands; never edit it to make a publish pass. When the dry run says the fingerprint does not match, the change touched a native input (package.json, app.json or app.config.ts, plugins, patches, .gitignore) and needs a store build instead.
5. Pick a marker when the change adds a string literal that survives minification: `--expect "An ASCII marker"`. A change with no new literal (a value flip, a removed branch) has none; see Verify for what replaces it.

## Dry run, then publish

From `ugc-mobile/`. Keep every log; the record needs them.

```bash
mkdir -p "$TMPDIR/ota" && node ./scripts/publish-ota.mjs --platform all > "$TMPDIR/ota/dry-run-all.log" 2>&1; tail -40 "$TMPDIR/ota/dry-run-all.log"
```

```bash
node ./scripts/publish-ota.mjs --platform ios --publish > "$TMPDIR/ota/publish-ios.log" 2>&1; tail -30 "$TMPDIR/ota/publish-ios.log"
```

Add `--rollout <pct>` to stage. Read in the dry run: the runtime fingerprint it matched, the guard that found mobile changes over the live group (it refuses a republish with nothing mobile in it), the bundle name, size and embedded debug info (a few dozen bytes; tens of KB means the `--source-maps` export was lost), every production `EXPO_PUBLIC` value reported present, and the marker found. The publish must show the same bundle hash and size as the dry run.

It refuses to publish over a newer live update; `--allow-rollback` overrides that only for a deliberate rollback (below). Its other flags: `--allow-republish` (a release with no mobile changes), `--allow-unmerged` (a ref not on origin/main; never for a real publish), `--artifacts-dir`, `--keep-worktree`, `--message`, `--targets-file`. Prefer the defaults; each override exists for a reason the script explains when it refuses.

## Verify

1. Served check: `python3 scripts/verify_served_ipv4.py <ios|android> <runtime fingerprint> <update group id> [stored artifact dir]` (bundled beside this file, from the 2026-10-17 record; with the artifact dir it also compares the served launch asset with the stored `.hbc`) fetches the manifest as a phone would and checks every asset's sha256; expect every asset to match. It is IPv4-only because urllib tried a dead IPv6 route first and sat silent for minutes.
2. No marker? Confirm the published bundle's sha256 equals the dry runs', and grep the changed lines in `sourcesContent` of the `.map` the export wrote, with the previous record's artifacts as the negative control.
3. On a phone, when the owner connects the S24: follow the `android-device` skill's phone section. Success in expo-updates' log reads `appLoaderTask didLoadAsset … totalAssetCount=N` then `Updates state change: DownloadComplete … isUpdatePending=true`; after a second cold start the Settings footer reads `Version 0.1.x (build) · update <group>`. A cold start behind the lock screen under battery saver gets no network and reads as a failed download: screen on, unlocked, keep-awake running.

## Record

`UGC copy/releases/ota/<main sha>/README.md` (the parent folder of the repo) plus the logs: `dry-run-*.log`, `publish-*.log`, `verify-served-*.log`, `live-before-*.log`. Follow the newest record's shape: platform(s) and why; runtime fingerprint and which builds carry it; group and update ids with the creation time (UTC and IST) and rollout; the marker, or the sourcesContent check; bundle name, size and debug-info bytes; the served check result; what the update carries (files, PR numbers); where it was checked (emulator or phone, date); the group it replaces; the exact rollback command. Keep `.hbc` and `.map` artifacts only for the newest three records.

## Rollback

```bash
node ./scripts/publish-ota.mjs --platform <ios|android> --ref <previous main sha> --publish --allow-rollback
```

Record it as a new entry, naming the group it replaced and why.
