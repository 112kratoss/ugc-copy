// Stands in for react-native-purchases/dist/browser/nativeModule in iOS and
// Android bundles (wired in metro.config.js).
//
// purchases.js requires the browser implementation unconditionally, and with it
// the purchases-js mappings (~330 KB of the Android bundle, measured 2026-09-12),
// but reads it only when shouldUseBrowserMode() is true: Expo Go without the
// native module, the Rork sandbox, or web. Every dev-client and store build of
// this app carries the RNPurchases native module, so that code never runs here.
//
// Should browser mode ever be selected on a native build anyway, RNPurchases
// resolves to null and the SDK throws its own "Native module (RNPurchases) not
// found" error on the first call, not at import.
exports.browserNativeModuleRNPurchases = null;
