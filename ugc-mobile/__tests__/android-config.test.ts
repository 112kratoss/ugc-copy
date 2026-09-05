import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  setGradleCleartextPlaceholders,
  setManifestCleartextPlaceholder,
} from '../plugins/withAndroidLocalCleartextDebug';
import {
  RELEASE_KEEP_RULES,
  setMaterialComponentsVersion,
  setReactNativeBuildFromSource,
  setReleaseSafetyProperties,
  setReleaseProguardBase,
  setReleaseProguardRules,
} from '../plugins/withAndroidReleaseSafety';
import {
  DEVELOPMENT_ONLY_NATIVE_MODULES,
  setAndroidBuildProfileAutolinking,
  setIosBuildProfileAutolinking,
  setPathSafeIosBundleScript,
} from '../plugins/withBuildProfileAutolinking';

const projectRoot = join(__dirname, '..');

describe('Android native network config', () => {
  it('disables Android application backups for regenerated native projects', () => {
    const appJson = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf8'));

    expect(appJson.expo.android.allowBackup).toBe(false);
  });

  it('registers the Expo plugin that keeps regenerated Android projects local-API ready', () => {
    const appJson = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf8'));

    expect(appJson.expo.plugins).toContain('./plugins/withAndroidLocalCleartextDebug');
  });

  it('pins the R8 release shape the optimization plan has reached', () => {
    // 0.1.2 (build 62) shipped with minification on and reached testers unusable.
    // expo-modules-core builds Kotlin records from JS options by reflection, and
    // that build turned on shrinking, the optimizing ProGuard base and R8 full
    // mode in one change; something in that set stripped what the record
    // converter needs, so the failure landed at runtime in whichever module was
    // unlucky rather than at build time: expo-secure-store rejected every read
    // ("The 2nd argument cannot be cast to type SecureStoreOptions"), which
    // trapped the app in a sign-out loop, and expo-image could not set `source`,
    // so no image mounted. The revert switched everything off together, so the
    // culprit was never isolated.
    //
    // 0.1.4 (build 70) brought R8 back in the narrowest shape and shipped clean.
    // docs/android-app-optimization-plan-2026-09-05.md widens it from there one
    // switch per build, each launched on a device before the next; this pins the
    // exact shape the plan has reached, so any drift is deliberate, never
    // incidental. A green build still proves nothing here.
    const appJson = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf8'));
    const properties = setReleaseSafetyProperties([
      { type: 'property', key: 'android.enableMinifyInReleaseBuilds', value: 'false' },
    ]);

    expect(appJson.expo.plugins).toContain('./plugins/withAndroidReleaseSafety');
    expect(properties).toContainEqual({
      type: 'property',
      key: 'android.enableMinifyInReleaseBuilds',
      value: 'true',
    });
    // Phase 3a: resource shrinking on the classic AAPT2 pipeline. The optimized
    // pipeline (phase 3b, and the AGP 9 default) is pinned off explicitly so the
    // two are never switched in one build.
    expect(properties).toContainEqual({
      type: 'property',
      key: 'android.enableShrinkResourcesInReleaseBuilds',
      value: 'true',
    });
    expect(properties).toContainEqual({
      type: 'property',
      key: 'android.r8.optimizedResourceShrinking',
      value: 'false',
    });
    // Phase 2: full mode. R8 drops ProGuard's implicit keeps (default
    // constructors, members of kept classes), so every reflecting library has to
    // name what it needs; expo-modules-core's consumer rules do, and the blanket
    // rule below covers the rest until phase 4. Pinned explicitly rather than left
    // to the AGP default so the intent survives an AGP that changes its default.
    expect(properties).toContainEqual({
      type: 'property',
      key: 'android.enableR8.fullMode',
      value: 'true',
    });
    expect(properties).toContainEqual({
      type: 'property',
      key: 'org.gradle.jvmargs',
      value: '-Xmx3072m -XX:MaxMetaspaceSize=1536m',
    });

    // Phase 1: the optimizing base. The plain `proguard-android.txt` carried
    // -dontoptimize and AGP 9.0 no longer ships it; a template that regresses to
    // it is moved back, and the optimize file is left alone.
    const plainBuildGradle = `release {
      proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"
    }`;
    const optimizedBuildGradle = setReleaseProguardBase(plainBuildGradle);
    expect(optimizedBuildGradle).toContain('getDefaultProguardFile("proguard-android-optimize.txt")');
    expect(optimizedBuildGradle).not.toContain('getDefaultProguardFile("proguard-android.txt")');
    expect(setReleaseProguardBase(optimizedBuildGradle)).toBe(optimizedBuildGradle);

    // The tracked keep rules ride on the release proguardFiles after the base
    // and the generated file, and the plugin refuses a template it cannot place
    // them in rather than silently building without them.
    const withRules = setReleaseProguardRules(optimizedBuildGradle);
    expect(withRules).toContain(
      `proguardFiles getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro", "${RELEASE_KEEP_RULES}"`
    );
    expect(setReleaseProguardRules(withRules)).toBe(withRules);
    expect(() => setReleaseProguardRules(plainBuildGradle)).toThrow(/proguardFiles/);

    // The entry is relative to android/app and must resolve to the tracked file.
    const keepRulesPath = join(projectRoot, 'android', 'app', RELEASE_KEEP_RULES);
    expect(keepRulesPath).toBe(join(projectRoot, 'plugins', 'android-release.pro'));
    const keepRules = readFileSync(keepRulesPath, 'utf8').split('\n');
    // Phase 4 narrows these; until then every Expo class is held by name.
    for (const rule of [
      '-keep class expo.modules.** { *; }',
      '-keep class kotlin.Metadata { *; }',
      '-keep class expo.modules.securestore.** { *; }',
      '-keep class expo.modules.image.** { *; }',
    ]) {
      expect(keepRules).toContain(rule);
    }
    expect(keepRules.some((line) => /^-keepattributes .*RuntimeVisible\*Annotations/.test(line)))
      .toBe(true);
    // Play scores obfuscation and optimization; a stray global switch in our own
    // file would quietly undo a phase.
    expect(keepRules.some((line) => /^\s*-dontobfuscate/.test(line))).toBe(false);
    expect(keepRules.some((line) => /^\s*-dontoptimize/.test(line))).toBe(false);
  });

  it('leaves predictive back off so the system back key still reaches JavaScript', () => {
    // `predictiveBackGestureEnabled: true` writes
    // `android:enableOnBackInvokedCallback="true"`, and from Android 13 that
    // opt-in stops the system calling `Activity.onBackPressed()` at all: back is
    // dispatched to OnBackPressedDispatcher callbacks instead. Nothing in this
    // app registers one on those OS versions. React Native's own callback --
    // its only bridge from the system back key to `BackHandler`, and so to
    // React Navigation -- is gated on `AndroidVersion.isAtLeastTargetSdk36`,
    // which requires the *device* to be running Android 16; react-native-screens
    // registers one only for its search bar. With no enabled callback the
    // dispatcher falls through to the platform default, which finishes the
    // activity: on Android 13/14/15 the first press of back or the back gesture
    // closed the app from any screen, while the in-app back arrow kept working
    // because that is `router.back()` in JS. An Android 16 device hides the bug
    // completely, which is why this is pinned rather than left to a manual pass.
    //
    // Turning it off costs nothing: Android 16 enforces predictive back for
    // targetSdk 36 whatever this attribute says, and React Native's SDK-36
    // workaround handles that case.
    const appJson = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf8'));

    expect(appJson.expo.android.predictiveBackGestureEnabled).not.toBe(true);

    // The reason the flag has to stay off, read from the runtime it depends on.
    // When React Native registers its callback for every OS version this stops
    // being true, and the flag can be reconsidered.
    const androidVersion = readFileSync(
      join(
        projectRoot,
        'node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/util/AndroidVersion.kt'
      ),
      'utf8'
    );
    const reactActivity = readFileSync(
      join(
        projectRoot,
        'node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/ReactActivity.java'
      ),
      'utf8'
    );

    expect(androidVersion).toContain('Build.VERSION.SDK_INT >= VERSION_CODE_BAKLAVA');
    expect(reactActivity).toContain(
      'AndroidVersion.isAtLeastTargetSdk36(this)'
    );
  });

  it('pins the Android Material release that handles API 35 system bars', () => {
    const buildGradle = `android {}

dependencies {
    implementation("com.facebook.react:react-android")
}`;
    const updatedBuildGradle = setMaterialComponentsVersion(buildGradle);

    expect(updatedBuildGradle).toContain(
      'implementation("com.google.android.material:material:1.14.0")'
    );
    expect(setMaterialComponentsVersion(updatedBuildGradle)).toBe(updatedBuildGradle);
  });

  it('builds the patched React Native Android runtime from source', () => {
    const settingsGradle = `rootProject.name = 'Magic Booklet'
include ':app'`;
    const updatedSettings = setReactNativeBuildFromSource(settingsGradle);

    expect(updatedSettings).toContain("includeBuild('../node_modules/react-native')");
    expect(updatedSettings).toContain(
      "substitute(module('com.facebook.react:react-android')).using(project(':packages:react-native:ReactAndroid'))"
    );
    expect(updatedSettings).not.toContain("substitute(module('com.facebook.react:hermes-android'))");
    expect(updatedSettings).not.toContain("substitute(module('com.facebook.react:hermes-engine'))");
    expect(setReactNativeBuildFromSource(updatedSettings)).toBe(updatedSettings);
  });

  it('does not lock the Android app to portrait on large screens', () => {
    const appJson = JSON.parse(readFileSync(join(projectRoot, 'app.json'), 'utf8'));

    expect(appJson.expo.orientation).toBeUndefined();
    expect(appJson.expo.ios.infoPlist.UISupportedInterfaceOrientations).toEqual([
      'UIInterfaceOrientationPortrait',
    ]);
  });

  it('removes Android 15 deprecated system-bar calls from the React Native runtime', () => {
    const statusBarModule = readFileSync(
      join(
        projectRoot,
        'node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/statusbar/StatusBarModule.kt'
      ),
      'utf8'
    );
    const windowUtil = readFileSync(
      join(
        projectRoot,
        'node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/views/view/WindowUtil.kt'
      ),
      'utf8'
    );
    const appLayout = readFileSync(join(projectRoot, 'app/_layout.tsx'), 'utf8');

    expect(statusBarModule).not.toMatch(/window\??\.statusBarColor/);
    expect(windowUtil).not.toContain('statusBarColor =');
    expect(windowUtil).not.toContain('navigationBarColor =');
    expect(windowUtil).not.toContain('LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES');
    expect(windowUtil).not.toContain('LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT');
    expect(appLayout).not.toMatch(/<StatusBar[^>]+backgroundColor=/);
    expect(appLayout).not.toMatch(/<StatusBar[^>]+translucent=/);
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
    expect(packageJson.devDependencies['expo-dev-client']).toBe('~55.0.40');
    expect(packageJson.scripts.postinstall).toBe('patch-package');
    expect(packageJson.dependencies.expo).toMatch(/^[~^]55\./);
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

  it('never strips a native module that expo-updates depends on', () => {
    // OTA updates run in production builds, so anything expo-updates needs must
    // survive autolinking there. expo-manifests was on the exclusion list from
    // when only the dev client used it; leaving it there breaks the CocoaPods
    // graph ("Unable to find a specification for EXManifests depended upon by
    // EXUpdates") in exactly the profiles that ship, while development builds
    // stay green — so nothing local would have caught it.
    const updatesManifest = JSON.parse(
      readFileSync(join(projectRoot, 'node_modules/expo-updates/package.json'), 'utf8')
    ) as { dependencies?: Record<string, string> };

    const updatesDependencies = Object.keys(updatesManifest.dependencies ?? {});
    const stripped = DEVELOPMENT_ONLY_NATIVE_MODULES.filter((moduleName) =>
      updatesDependencies.includes(moduleName)
    );

    expect(stripped).toEqual([]);
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
