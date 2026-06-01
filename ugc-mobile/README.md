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

Keep `.env.local`, upload credentials, `.expo`, native build folders, and `.aab`/`.apk` outputs out of Git.
