import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { themes } from '../lib/theme';

const mobileRoot = path.resolve(__dirname, '..');
const appJson = JSON.parse(readFileSync(path.join(mobileRoot, 'app.json'), 'utf8')).expo;
const packageJson = JSON.parse(readFileSync(path.join(mobileRoot, 'package.json'), 'utf8'));

/**
 * The native half of light mode. None of it can ship over the air: app.json is
 * a runtime-fingerprint input, so these lines only reach phones in a store
 * build — which is also why `isAppearanceChoiceAvailable` can read the
 * embedded config as its gate.
 */
describe('light mode native configuration', () => {
  it('lets the native layer follow the phone', () => {
    // Info.plist UIUserInterfaceStyle and expo-system-ui's night mode. "dark"
    // here pinned every native element — keyboard, alerts, glass — to dark.
    expect(appJson.userInterfaceStyle).toBe('automatic');
  });

  it('opens each scheme on a splash that matches its first frame', () => {
    for (const platform of ['ios', 'android'] as const) {
      const splash = appJson[platform].splash;
      expect(splash.image).toBe('./assets/images/splash-icon.png');
      // Handing over to the first screen with no colour step: paper under
      // light, true black under dark.
      expect(splash.backgroundColor).toBe(themes.light.colors.background);
      expect(splash.dark.backgroundColor).toBe(themes.dark.colors.app);
      expect(splash.dark.image).toBe(splash.image);
    }
    // One source of truth: the top-level key cannot carry a dark variant on iOS.
    expect(appJson.splash).toBeUndefined();
  });

  it('carries the module that lets Android navigation bar icons follow a switch', () => {
    expect(packageJson.dependencies['expo-navigation-bar']).toMatch(/^~55\./);
  });
});
