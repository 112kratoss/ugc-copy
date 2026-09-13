const path = require('node:path');

// React Compiler, for the app's own code. It is switched on here rather than
// with app.json's `experiments.reactCompiler`: app.json feeds the expo-updates
// runtime fingerprint, so the flag would strand every installed build from
// over-the-air updates, and this file does not. The flag does two things, and
// both are covered. babel-preset-expo adds this same plugin when Metro's caller
// sets `supportsReactCompiler`; and Metro compiles imports itself
// (experimentalImportSupport), which Expo's default config already turns on for
// every bundle, so the import the compiler inserts is handled.
//
// The compiler skips any function that breaks the Rules of React, such as a ref
// read during render or a `try…finally`, instead of failing the build.
// validateNoImpureFunctionsInRender adds calls like Date.now() to that list: a
// memoized render would keep the first value such a call returned.
// __tests__/bundle-shaping.test.ts pins all of this.
const APP_SOURCE_DIRECTORIES = ['app', 'components', 'lib'].map((directory) => path.join(__dirname, directory) + path.sep);

function isAppSource(filename) {
  return typeof filename === 'string' && APP_SOURCE_DIRECTORIES.some((directory) => filename.startsWith(directory));
}

module.exports = function (api) {
  const isNodeModule = api.caller((caller) => Boolean(caller?.isNodeModule));
  const isServer = api.caller((caller) => Boolean(caller?.isServer || caller?.isReactServer));
  const isProduction = api.caller((caller) => caller?.isDev === false);

  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // First, so the compiler reads code no other plugin has rewritten yet.
      ...(isNodeModule || isServer ? [] : [[
        'babel-plugin-react-compiler',
        {
          target: '19',
          panicThreshold: 'none',
          sources: isAppSource,
          environment: {
            // Lets Fast Refresh start an edited component with a fresh memo
            // cache. Production bundles leave the check out.
            enableResetCacheOnSourceFileChanges: !isProduction,
            validateNoImpureFunctionsInRender: true,
          },
        },
      ]]),
      // One import per icon module instead of the whole lucide barrel — see the
      // plugin for the measurement. Metro caches transforms without tracking the
      // plugin file: run `expo start --clear` after editing it.
      './bundler/lucide-direct-imports',
    ],
  };
};
