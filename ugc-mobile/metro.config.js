const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Evaluate a module the first time one of its bindings is used, not the moment
// the file importing it loads. Expo ships this off; React Native's own template
// ships it on. Launch then runs only what the first screen touches, rather than
// every module reachable from an import statement. Side-effect imports
// (`import 'x'`) are never deferred.
//
// The root layout keeps eager requires: it renders on every launch, so nothing
// is saved there, and it is what loads lib/notifications, whose module scope
// installs the foreground notification handler. Deferring that to the first
// effect would open a window at startup where an arriving push uses the default
// handler.
const eagerRequireModules = { [path.join(__dirname, 'app', '_layout.tsx')]: true };
const expoGetTransformOptions = config.transformer.getTransformOptions;
config.transformer.getTransformOptions = async (...args) => {
  const options = await expoGetTransformOptions(...args);
  return {
    ...options,
    transform: { ...options.transform, inlineRequires: { blockList: eagerRequireModules } },
  };
};

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
