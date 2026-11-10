import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { addHermesSourceMap, EXPORT_LINE } from '../plugins/withIosHermesSourceMap';

const projectRoot = join(__dirname, '..');
const stockXcodeEnv = 'export NODE_BINARY=$(command -v node)\n';

/**
 * iOS store builds compiled the bundle with Hermes debug info in it, because
 * React Native's bundle step passes `-output-source-map` only when
 * `SOURCEMAP_FILE` is set. Measured on 2026-11-11 by running the app's own
 * "Bundle React Native code and images" phase outside Xcode: 9.44 MB in the
 * app without the setting, 5.81 MB with it, the map left in derived files and
 * none in the app. OTA bundles have always been compiled this way.
 */
describe('withIosHermesSourceMap', () => {
  it('sets SOURCEMAP_FILE in .xcode.env, which the bundle phase sources', () => {
    const next = addHermesSourceMap(stockXcodeEnv);
    expect(next.startsWith(stockXcodeEnv)).toBe(true);
    expect(next).toContain(EXPORT_LINE);
    expect(EXPORT_LINE).toBe('export SOURCEMAP_FILE="${DERIVED_FILE_DIR:-$CONFIGURATION_BUILD_DIR}/main.jsbundle.map"');
  });

  it('writes the line once however often prebuild runs', () => {
    const once = addHermesSourceMap(stockXcodeEnv);
    expect(addHermesSourceMap(once)).toBe(once);
    expect(addHermesSourceMap('export NODE_BINARY=node')).toContain('export NODE_BINARY=node\n\n# withIosHermesSourceMap');
  });

  it('is registered in app.json', () => {
    const appJson = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf8'));
    expect(appJson.expo.plugins).toContain('./plugins/withIosHermesSourceMap');
  });

  it('matches what React Native 0.83’s bundle step reads', () => {
    const script = readFileSync(join(projectRoot, 'node_modules/react-native/scripts/react-native-xcode.sh'), 'utf8');
    expect(script).toContain('if [[ ! -z "$SOURCEMAP_FILE" ]]; then');
    expect(script).toContain('EXTRA_COMPILER_ARGS="$EXTRA_COMPILER_ARGS -output-source-map"');
  });
});
