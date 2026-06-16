import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  setGradleCleartextPlaceholders,
  setManifestCleartextPlaceholder,
} from '../plugins/withAndroidLocalCleartextDebug';

const projectRoot = join(__dirname, '..');

describe('Android native network config', () => {
  it('registers the Expo plugin that keeps regenerated Android projects local-API ready', () => {
    const appJson = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf8'));

    expect(appJson.expo.plugins).toContain('./plugins/withAndroidLocalCleartextDebug');
  });

  it('sets a manifest placeholder and debug-only Gradle values for local HTTP', () => {
    const manifest: {
      manifest: {
        application: Array<{
          $: Record<string, string>;
        }>;
      };
    } = {
      manifest: {
        application: [
          {
            $: {
              'android:name': '.MainApplication',
            },
          },
        ],
      },
    };
    const gradle = `android {
    defaultConfig {
        applicationId 'com.magicbooklet.mobile'
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
        }
    }
}`;

    setManifestCleartextPlaceholder(manifest);
    const nextGradle = setGradleCleartextPlaceholders(gradle);

    expect(manifest.manifest.application[0].$['android:usesCleartextTraffic']).toBe('${usesCleartextTraffic}');
    expect(nextGradle).toContain('defaultConfig {\n        manifestPlaceholders = [usesCleartextTraffic: "false"]');
    expect(nextGradle).toContain('debug {\n            manifestPlaceholders = [usesCleartextTraffic: "true"]');
    expect(nextGradle).toContain('release {\n            manifestPlaceholders = [usesCleartextTraffic: "false"]');
  });
});
