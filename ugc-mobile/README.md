# Magicbooklet Mobile

Standalone Expo app for the Magicbooklet mobile experience.

## Run

```sh
npm install
npm start
```

For the local Android development build:

```sh
npm run android
```

Store purchases require a native development or store build once RevenueCat and the App Store / Play products are configured.

## Checks

```sh
npm run test
npm run typecheck
```

## Store release profiles

The first iOS release is intentionally iPhone-only (`ios.supportsTablet: false`).
Do not attach iPad screenshots to this version. Enabling iPad later requires a
fresh build plus layout, purchase, authentication, generation, and account-flow
QA on supported iPad sizes.

Keep the version in `app.json`, `package.json`, and `package-lock.json` aligned
before creating a store build. EAS owns the monotonically increasing native
build/version codes through `appVersionSource: remote` and `autoIncrement`.

Use the manual `Mobile signed store build` GitHub workflow. It accepts only the
current `main` SHA with a successful exact-SHA `Quality` run, creates signed EAS
production artifacts, and re-reads EAS build metadata before submission. The
build must be `FINISHED`, match the authorized commit and `app.json` version,
use the production store-distribution profile, and expose an HTTPS artifact.
Immediately before the EAS build and again before tester submission, the
workflow also requires the live production `/api/app-version` response to serve
that exact commit.
The workflow optionally submits only to the configured internal TestFlight
group or Google Play closed alpha; it cannot promote a public store release.
Its run summary records the platform, app version, native build number, build
ID, submission ID, and commit SHA for tester-delivery readback.

The GitHub `mobile-production` environment needs the `EXPO_TOKEN` secret and a
`TESTFLIGHT_INTERNAL_GROUP` environment variable. Set that variable to the exact
App Store Connect internal group name (`Team (Expo)`); an iOS tester submission
fails closed when it is absent. The EAS `production` environment must contain
the public site/API/Supabase/RevenueCat variables below. Store signing and
submission credentials stay in EAS. The build hook fails before dependency
installation if the production profile has a missing, placeholder, insecure,
wrong-platform, or non-production value.

Public App Store / Play promotion remains a deliberate operator action after
TestFlight/closed-alpha purchases, auth, generation, account deletion, privacy
disclosures, crash reporting, and staged-rollout checks pass.
The public legal URLs are `https://magicbooklet.com/terms`,
`https://magicbooklet.com/privacy`, `https://magicbooklet.com/cancellation`, and
`https://magicbooklet.com/delete-account`.

## Physical Android performance profile

Connect and authorize one physical Android device, then provide a signed,
non-debuggable release APK:

```sh
npm run profile:android:physical -- \
  --apk /absolute/path/to/app-release.apk \
  --cold-runs 10 \
  --hot-runs 10
```

Pass `--serial DEVICE_SERIAL` when more than one physical phone is connected.
The command rejects emulators, debug/unsigned APKs, and packages other than
`com.magicbooklet.mobile`. It prints one JSON report containing per-run startup
timings, summary percentiles, device/build metadata, and `gfxinfo` frame stats.
Graphics counters are reset and read around every startup run, so each cold/hot
sample has its own frame metrics. The report also sums additive counters and
calculates weighted jank across runs; frame-time percentiles stay per-run because
averaging percentiles would be misleading.

The profile is data-preserving: it replaces/launches the app, force-stops it for
cold starts, sends the device Home for hot resumes, and resets performance
counters. It does not clear app data or caches, grant permissions, change runtime
compilation, or reboot the phone.

## Environment

Copy `.env.example` to `.env.local` and fill in:

- `EXPO_PUBLIC_SITE_URL`
- `EXPO_PUBLIC_API_BASE_URL`
- `EXPO_PUBLIC_WEB_API_BASE_URL`
- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `EXPO_PUBLIC_REVENUECAT_IOS_API_KEY`
- `EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY`

For the lean launch, review native iOS crash reports in App Store Connect and
Android vitals/crash reports in Google Play Console before each public
promotion. This has no extra vendor account or app integration, but it provides
less JavaScript context and no JavaScript source-map symbolication. Handled
JavaScript errors that do not become native crashes depend on user reports,
reproduction, and the app's existing backend health signals.

For local API development, run the web app on port `3000` from the repo root.
Use `http://10.0.2.2:3000` for `EXPO_PUBLIC_API_BASE_URL` in an Android emulator.
Use your machine's LAN address, for example `http://192.168.x.x:3000`, for a physical phone on the same Wi-Fi network.
After native Android network config changes, rebuild and reinstall the dev app with `npm run android`; a JS reload will not update the manifest.

Keep `.env.local`, upload credentials, `.expo`, native build folders, and `.aab`/`.apk` outputs out of Git.
