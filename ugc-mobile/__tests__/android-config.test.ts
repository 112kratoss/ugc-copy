import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  setGradleCleartextPlaceholders,
  setManifestCleartextPlaceholder,
} from '../plugins/withAndroidLocalCleartextDebug';
import {
  setReleaseSafetyProperties,
  setReleaseProguardSafety,
} from '../plugins/withAndroidReleaseSafety';
import {
  DEVELOPMENT_ONLY_NATIVE_MODULES,
  setAndroidBuildProfileAutolinking,
  setIosBuildProfileAutolinking,
  setPathSafeIosBundleScript,
} from '../plugins/withBuildProfileAutolinking';

const projectRoot = join(__dirname, '..');

describe('Android native network config', () => {
  it('registers the Expo plugin that keeps regenerated Android projects local-API ready', () => {
    const appJson = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf8'));

    expect(appJson.expo.plugins).toContain('./plugins/withAndroidLocalCleartextDebug');
  });

  it('disables unsafe R8 optimization for regenerated release builds', () => {
    const appJson = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf8'));
    const properties = setReleaseSafetyProperties([
      { type: 'property', key: 'android.enableMinifyInReleaseBuilds', value: 'true' },
    ]);

    expect(appJson.expo.plugins).toContain('./plugins/withAndroidReleaseSafety');
    expect(appJson.expo.plugins).not.toContain('./plugins/withAndroidReleaseOptimization');
    expect(properties).toContainEqual({
      type: 'property',
      key: 'android.enableMinifyInReleaseBuilds',
      value: 'false',
    });
    expect(properties).toContainEqual({
      type: 'property',
      key: 'android.enableShrinkResourcesInReleaseBuilds',
      value: 'false',
    });
    expect(properties).toContainEqual({
      type: 'property',
      key: 'org.gradle.jvmargs',
      value: '-Xmx3072m -XX:MaxMetaspaceSize=1536m',
    });

    const optimizedBuildGradle = `release {
      proguardFiles getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro"
    }`;
    const safeBuildGradle = setReleaseProguardSafety(optimizedBuildGradle);
    expect(safeBuildGradle).toContain('getDefaultProguardFile("proguard-android.txt")');
    expect(safeBuildGradle).not.toContain('getDefaultProguardFile("proguard-android-optimize.txt")');
    expect(setReleaseProguardSafety(safeBuildGradle)).toBe(safeBuildGradle);
  });

  it('excludes RevenueCat Amazon billing code from the Google Play-only binary', () => {
    const appJson = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf8'));
    const inAppPurchaseSource = readFileSync(join(projectRoot, 'lib/iap.ts'), 'utf8');
    const purchasesPatch = readFileSync(
      join(projectRoot, 'patches/react-native-purchases+10.1.0.patch'),
      'utf8'
    );

    expect(appJson.expo.android.permissions).toContain('com.android.vending.BILLING');
    expect(inAppPurchaseSource).not.toMatch(/useAmazon\s*:\s*true/);
    expect(purchasesPatch).toContain("module: 'purchases-store-amazon'");
  });

  it('keeps the development launcher out of runtime dependencies', () => {
    const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
    const easJson = JSON.parse(readFileSync(join(projectRoot, 'eas.json'), 'utf8'));
    const appJson = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf8'));
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
    expect(packageJson.devDependencies['expo-dev-client']).toBe('~55.0.37');
    expect(packageJson.scripts.postinstall).toBe('patch-package');
    expect(packageJson.dependencies.expo).toMatch(/^\^55\./);
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

  it('keeps Expo Constants builds safe when the workspace path contains spaces', () => {
    const constantsPatch = readFileSync(
      join(projectRoot, 'patches/expo-constants+55.0.17.patch'),
      'utf8'
    );

    expect(constantsPatch).toContain('basename \"$PROJECT_DIR\"');
    expect(constantsPatch).toContain('bash -l \\\"$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh\\\"');
  });

  it('quotes the resolved React Native iOS bundle script path', () => {
    const unsafeInvocation =
      '`\"$NODE_BINARY\" --print \"require(\'path\').dirname(require.resolve(\'react-native/package.json\')) + \'/scripts/react-native-xcode.sh\'\"`';
    const project = {
      hash: {
        project: {
          objects: {
            PBXShellScriptBuildPhase: {
              phase: {
                name: JSON.stringify('Bundle React Native code and images'),
                shellScript: JSON.stringify(`before\n${unsafeInvocation}\nafter\n`),
              },
            },
          },
        },
      },
    };

    setPathSafeIosBundleScript(project);
    const script = JSON.parse(
      project.hash.project.objects.PBXShellScriptBuildPhase.phase.shellScript
    );

    expect(script).toContain('REACT_NATIVE_XCODE_SCRIPT=');
    expect(script).toContain('\"$REACT_NATIVE_XCODE_SCRIPT\"');
    expect(script).not.toContain(unsafeInvocation);
    expect(() => setPathSafeIosBundleScript(project)).not.toThrow();
  });

  it('registers verified app links on iOS and Android', () => {
    const appJson = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf8'));

    expect(appJson.expo.ios.associatedDomains).toContain('applinks:magicbooklet.com');

    // Referral, post, and creator links. Without the last two, every shared post
    // or profile link opens the browser instead of the app.
    for (const pathPrefix of ['/r/', '/showcase/', '/creators/']) {
      expect(appJson.expo.android.intentFilters).toContainEqual({
        action: 'VIEW',
        autoVerify: true,
        data: [{ scheme: 'https', host: 'magicbooklet.com', pathPrefix }],
        category: ['BROWSABLE', 'DEFAULT'],
      });
    }
    // Pinned so a later edit cannot silently drop a path family: toContainEqual
    // alone would still pass if one were removed and another duplicated.
    expect(appJson.expo.android.intentFilters).toHaveLength(3);
  });

  it('keeps the Android path prefixes in step with the shared app-link contract', () => {
    // The AASA `paths` list and these prefixes are the same fact stated in two
    // workspaces that never import each other.
    const appJson = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf8'));
    const contract = JSON.parse(
      readFileSync(join(projectRoot, '..', 'contracts', 'universal-links-v1.json'), 'utf8')
    ) as { host: string; paths: string[] };

    const declaredPrefixes = appJson.expo.android.intentFilters
      .map((filter: { data: { pathPrefix: string }[] }) => filter.data[0].pathPrefix)
      .sort();
    const contractPrefixes = contract.paths
      .map((path) => (path.endsWith('*') ? path.slice(0, -1) : path))
      .sort();

    expect(declaredPrefixes).toEqual(contractPrefixes);
    expect(appJson.expo.ios.associatedDomains).toContain(`applinks:${contract.host}`);
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
