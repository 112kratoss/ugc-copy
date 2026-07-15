import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  setGradleCleartextPlaceholders,
  setManifestCleartextPlaceholder,
} from '../plugins/withAndroidLocalCleartextDebug';
import { setReleaseOptimizationProperties } from '../plugins/withAndroidReleaseOptimization';
import {
  DEVELOPMENT_ONLY_NATIVE_MODULES,
  setAndroidBuildProfileAutolinking,
  setIosBuildProfileAutolinking,
} from '../plugins/withBuildProfileAutolinking';

const projectRoot = join(__dirname, '..');

describe('Android native network config', () => {
  it('registers the Expo plugin that keeps regenerated Android projects local-API ready', () => {
    const appJson = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf8'));

    expect(appJson.expo.plugins).toContain('./plugins/withAndroidLocalCleartextDebug');
  });

  it('enables R8 code and resource shrinking for regenerated release builds', () => {
    const appJson = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf8'));
    const properties = setReleaseOptimizationProperties([
      { type: 'property', key: 'android.enableMinifyInReleaseBuilds', value: 'false' },
    ]);

    expect(appJson.expo.plugins).toContain('./plugins/withAndroidReleaseOptimization');
    expect(properties).toContainEqual({
      type: 'property',
      key: 'android.enableMinifyInReleaseBuilds',
      value: 'true',
    });
    expect(properties).toContainEqual({
      type: 'property',
      key: 'android.enableShrinkResourcesInReleaseBuilds',
      value: 'true',
    });
  });

  it('keeps the development launcher out of runtime dependencies', () => {
    const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
    const easJson = JSON.parse(readFileSync(join(projectRoot, 'eas.json'), 'utf8'));
    const appJson = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf8'));
    const autolinkingPatch = readFileSync(
      join(projectRoot, 'patches/expo-modules-autolinking+3.0.26.patch'),
      'utf8'
    );
    const settingsGradle = `plugins {
  id("expo-autolinking-settings")
}
expoAutolinking.useExpoModules()
`;
    const podfile = `target 'MagicBooklet' do
  use_expo_modules!
end
`;
    const productionSettings = setAndroidBuildProfileAutolinking(settingsGradle);
    const productionPodfile = setIosBuildProfileAutolinking(podfile);

    expect(packageJson.dependencies['expo-dev-client']).toBeUndefined();
    expect(packageJson.devDependencies['expo-dev-client']).toBe('6.0.21');
    expect(packageJson.scripts.postinstall).toBe('patch-package');
    expect(autolinkingPatch).toContain('value.forEach { optionsMap.add(key to it) }');
    expect(appJson.expo.plugins).toContain('./plugins/withBuildProfileAutolinking');
    expect(easJson.build.development.env.MAGICBOOKLET_INCLUDE_DEV_CLIENT).toBe('true');
    expect(easJson.build.preview.env.MAGICBOOKLET_INCLUDE_DEV_CLIENT).toBe('false');
    expect(easJson.build.production.env.MAGICBOOKLET_INCLUDE_DEV_CLIENT).toBe('false');
    expect(productionSettings.indexOf('expoAutolinking.exclude')).toBeLessThan(
      productionSettings.indexOf('expoAutolinking.useExpoModules()')
    );
    expect(productionPodfile).toContain("ENV['MAGICBOOKLET_INCLUDE_DEV_CLIENT'] == 'false'");
    expect(productionPodfile).toContain(':exclude => development_only_native_modules');
    for (const moduleName of DEVELOPMENT_ONLY_NATIVE_MODULES) {
      expect(productionSettings).toContain(`'${moduleName}'`);
      expect(productionPodfile).toContain(`'${moduleName}'`);
    }
    expect(setAndroidBuildProfileAutolinking(productionSettings)).toBe(productionSettings);
    expect(setIosBuildProfileAutolinking(productionPodfile)).toBe(productionPodfile);
  });

  it('enables native Sign in with Apple for iOS builds', () => {
    const appJson = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf8'));

    expect(appJson.expo.ios.usesAppleSignIn).toBe(true);
    expect(appJson.expo.plugins).toContain('expo-apple-authentication');
  });

  it('registers verified referral links on iOS and Android', () => {
    const appJson = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf8'));

    expect(appJson.expo.ios.associatedDomains).toContain('applinks:magicbooklet.com');
    expect(appJson.expo.android.intentFilters).toContainEqual({
      action: 'VIEW',
      autoVerify: true,
      data: [{ scheme: 'https', host: 'magicbooklet.com', pathPrefix: '/r/' }],
      category: ['BROWSABLE', 'DEFAULT'],
    });
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

  it('does not add manifest placeholders to signing config blocks', () => {
    const gradle = `android {
    defaultConfig {
        applicationId 'com.magicbooklet.mobile'
    }
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
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

    const nextGradle = setGradleCleartextPlaceholders(gradle);

    expect(nextGradle).toContain(`signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }`);
    expect(nextGradle).toContain(`buildTypes {
        debug {
            manifestPlaceholders = [usesCleartextTraffic: "true"]`);
  });
});
