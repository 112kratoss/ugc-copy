const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// bundler/lucide-direct-imports.js imports each icon from dist/esm, a path the
// package's "exports" map does not list. Metro would still find it through its
// file-based fallback, but would log a warning for every icon on every bundle.
const LUCIDE_ESM_PREFIX = 'lucide-react-native/dist/esm/';
const lucideEsmRoot = path.resolve(path.dirname(require.resolve('lucide-react-native')), '..', 'esm');

// react-native-purchases requires its browser implementation unconditionally,
// though only Expo Go, web, and the Rork sandbox ever select it. Native bundles
// get a stand-in instead; see bundler/revenuecat-browser-stub.js.
const PURCHASES_ENTRY = path.join('react-native-purchases', 'dist', 'purchases.js');
const purchasesBrowserStub = path.join(__dirname, 'bundler', 'revenuecat-browser-stub.js');

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith(LUCIDE_ESM_PREFIX)) {
    return {
      type: 'sourceFile',
      filePath: path.join(lucideEsmRoot, moduleName.slice(LUCIDE_ESM_PREFIX.length)),
    };
  }
  if (
    platform !== 'web'
    && moduleName === './browser/nativeModule'
    && context.originModulePath.endsWith(PURCHASES_ENTRY)
  ) {
    return { type: 'sourceFile', filePath: purchasesBrowserStub };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
