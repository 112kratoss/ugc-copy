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

## Environment

Copy `.env.example` to `.env.local` and fill in:

- `EXPO_PUBLIC_SITE_URL`
- `EXPO_PUBLIC_API_BASE_URL`
- `EXPO_PUBLIC_WEB_API_BASE_URL`
- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `EXPO_PUBLIC_REVENUECAT_IOS_API_KEY`
- `EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY`

For local API development, run the web app on port `3000` from the repo root.
Use `http://10.0.2.2:3000` for `EXPO_PUBLIC_API_BASE_URL` in an Android emulator.
Use your machine's LAN address, for example `http://192.168.x.x:3000`, for a physical phone on the same Wi-Fi network.
After native Android network config changes, rebuild and reinstall the dev app with `npm run android`; a JS reload will not update the manifest.

Keep `.env.local`, upload credentials, `.expo`, native build folders, and `.aab`/`.apk` outputs out of Git.
