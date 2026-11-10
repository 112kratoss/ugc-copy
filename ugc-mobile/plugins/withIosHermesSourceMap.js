const fs = require('node:fs');
const path = require('node:path');

const { createRunOncePlugin, withDangerousMod } = require('expo/config-plugins');

const PLUGIN_NAME = 'withIosHermesSourceMap';
const PLUGIN_VERSION = '1.0.0';

/**
 * React Native's iOS bundle step (`react-native/scripts/react-native-xcode.sh`)
 * passes Hermes `-output-source-map` only when `SOURCEMAP_FILE` is set. Without
 * it hermesc keeps the debug info in the bytecode: on 2026-11-11 the release
 * bundle of this app compiled to 9.44 MB that way and to 5.81 MB with the map
 * written beside it (4.12 MB against 2.87 MB gzipped). Android's Gradle plugin
 * always writes the map, and OTA exports use `--source-maps`, so only the iOS
 * store binary carried the extra 3.6 MB.
 *
 * The build phase sources `ios/.xcode.env`, so the variable goes there. The map
 * lands in the build's derived files, never inside the app.
 */
const MARKER = '# withIosHermesSourceMap';
const EXPORT_LINE = 'export SOURCEMAP_FILE="${DERIVED_FILE_DIR:-$CONFIGURATION_BUILD_DIR}/main.jsbundle.map"';

function addHermesSourceMap(contents) {
  if (contents.includes(MARKER)) {
    return contents;
  }
  const base = contents.endsWith('\n') ? contents : `${contents}\n`;
  return `${base}\n${MARKER}: write the Hermes source map outside the app so the bytecode ships without debug info.\n${EXPORT_LINE}\n`;
}

function withIosHermesSourceMap(config) {
  return withDangerousMod(config, [
    'ios',
    async (nextConfig) => {
      const file = path.join(nextConfig.modRequest.platformProjectRoot, '.xcode.env');
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      fs.writeFileSync(file, addHermesSourceMap(current));
      return nextConfig;
    },
  ]);
}

const plugin = createRunOncePlugin(withIosHermesSourceMap, PLUGIN_NAME, PLUGIN_VERSION);

module.exports = plugin;
module.exports.addHermesSourceMap = addHermesSourceMap;
module.exports.withIosHermesSourceMap = withIosHermesSourceMap;
module.exports.EXPORT_LINE = EXPORT_LINE;
