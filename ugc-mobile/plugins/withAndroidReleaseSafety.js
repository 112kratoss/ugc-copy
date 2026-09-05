const fs = require('fs');
const path = require('path');
const {
  createRunOncePlugin,
  withAppBuildGradle,
  withGradleProperties,
  withSettingsGradle,
} = require('expo/config-plugins');

const PLUGIN_NAME = 'withAndroidReleaseSafety';
const PLUGIN_VERSION = '5.0.0';
const MATERIAL_COMPONENTS_VERSION = '1.14.0';

// R8 release shape. Pinned by __tests__/android-config.test.ts; widened one
// switch per build by docs/android-app-optimization-plan-2026-09-05.md.
//
// 0.1.2 (build 62) turned on minification, resource shrinking, the optimizing
// ProGuard base and - implicitly, as the AGP 8 default - R8 full mode in one
// change, and reached testers unusable. expo-modules-core builds every JS
// options object into a Kotlin record through kotlin-reflect; after R8,
// `expo-secure-store` rejected every read ("The 2nd argument cannot be cast to
// type SecureStoreOptions"), which trapped the app in a sign-out loop, and
// `expo-image` could not set `source`, so no image ever mounted. The revert
// (dc37fa2) switched everything off together, so which switch broke the record
// converter was never isolated. 0.1.4 (build 70) brought R8 back in the
// narrowest shape (minify only, plain base, compat mode) and shipped clean.
//
// From there the plan widens the shape one switch per build, each one launched
// on a device before the next is touched, because a missing rule fails exactly
// as build 62 did: silently, at runtime, in whichever module is unlucky, behind
// a green build. This revision pins:
//   - minification on;
//   - the optimizing base `proguard-android-optimize.txt` (phase 1). The plain
//     `proguard-android.txt` carried -dontoptimize, and AGP 9.0 no longer ships
//     it at all, so the swap that used to select it is gone;
//   - `android.enableR8.fullMode=true` (phase 2): R8 keeps nothing implicitly any
//     more - no default constructors, no members - so every reflecting library
//     must name what it needs. expo-modules-core's consumer rules do (records,
//     enumerables, Module `<init>()`, ExpoView constructors) and the blanket
//     rule below still covers the rest of `expo.modules.**`;
//   - resource shrinking on (phase 3a), with the classic AAPT2 pipeline
//     (`android.r8.optimizedResourceShrinking=false`); phase 3b moves it onto
//     R8's optimized pipeline, which AGP 9 makes the default;
//   - `plugins/android-release.pro`, which keeps all of `expo.modules.**` and
//     the Kotlin metadata kotlin-reflect reads (phase 4 narrows it).
const RELEASE_PROPERTIES = {
  'android.enableMinifyInReleaseBuilds': 'true',
  'android.enableShrinkResourcesInReleaseBuilds': 'true',
  'android.r8.optimizedResourceShrinking': 'false',
  'android.enableR8.fullMode': 'true',
  'org.gradle.jvmargs': '-Xmx3072m -XX:MaxMetaspaceSize=1536m',
};

// Relative to android/app, which is where Gradle resolves `proguardFiles`.
const RELEASE_KEEP_RULES = '../../plugins/android-release.pro';
const RELEASE_KEEP_RULES_FILE = path.join(__dirname, 'android-release.pro');

function withAndroidReleaseSafety(config) {
  const configWithReleaseProperties = withGradleProperties(config, (nextConfig) => {
    nextConfig.modResults = setReleaseSafetyProperties(nextConfig.modResults);
    return nextConfig;
  });

  const configWithAppBuildGradle = withAppBuildGradle(configWithReleaseProperties, (nextConfig) => {
    nextConfig.modResults.contents = setMaterialComponentsVersion(
      setReleaseProguardRules(setReleaseProguardBase(nextConfig.modResults.contents))
    );
    return nextConfig;
  });

  return withSettingsGradle(configWithAppBuildGradle, (nextConfig) => {
    nextConfig.modResults.contents = setReactNativeBuildFromSource(nextConfig.modResults.contents);
    return nextConfig;
  });
}

function setReleaseSafetyProperties(properties) {
  const nextProperties = [...properties];

  for (const [key, value] of Object.entries(RELEASE_PROPERTIES)) {
    const existing = nextProperties.find((entry) => entry.type === 'property' && entry.key === key);
    if (existing && existing.type === 'property') {
      existing.value = value;
      continue;
    }
    nextProperties.push({ type: 'property', key, value });
  }

  return nextProperties;
}

/**
 * Pin the release build to the optimizing ProGuard base. The plain
 * `proguard-android.txt` carried -dontoptimize, which the build-62 revert leaned
 * on and which AGP 9.0 no longer ships; a template that regressed to it is moved
 * back so the base can never move by accident in either direction.
 */
function setReleaseProguardBase(buildGradle) {
  const optimizedDefault = 'getDefaultProguardFile("proguard-android-optimize.txt")';
  if (/getDefaultProguardFile\((["'])proguard-android-optimize\.txt\1\)/.test(buildGradle)) {
    return buildGradle;
  }

  const plainDefault = /getDefaultProguardFile\((["'])proguard-android\.txt\1\)/g;
  if (!plainDefault.test(buildGradle)) {
    throw new Error('Could not locate the Android release ProGuard default configuration.');
  }

  return buildGradle.replace(plainDefault, optimizedDefault);
}

/**
 * Append the tracked keep rules to the release `proguardFiles`. Runs after
 * setReleaseProguardBase, so it only ever sees the optimizing base; any other
 * shape means the template changed and the rules would be silently dropped,
 * which is a build-62 failure waiting to happen - so it throws instead.
 */
function setReleaseProguardRules(buildGradle) {
  if (!fs.existsSync(RELEASE_KEEP_RULES_FILE)) {
    throw new Error(`Missing Android release keep rules at ${RELEASE_KEEP_RULES_FILE}.`);
  }

  const entry = `"${RELEASE_KEEP_RULES}"`;
  if (buildGradle.includes(entry)) {
    return buildGradle;
  }

  const proguardFiles =
    /(proguardFiles\s+getDefaultProguardFile\((["'])proguard-android-optimize\.txt\2\),\s*(["'])proguard-rules\.pro\3)/;
  if (!proguardFiles.test(buildGradle)) {
    throw new Error('Could not locate the Android release proguardFiles declaration.');
  }

  return buildGradle.replace(proguardFiles, `$1, ${entry}`);
}

function setMaterialComponentsVersion(buildGradle) {
  const dependency = `implementation("com.google.android.material:material:${MATERIAL_COMPONENTS_VERSION}")`;
  if (buildGradle.includes(dependency)) {
    return buildGradle;
  }

  const dependenciesBlock = /dependencies\s*\{/;
  if (!dependenciesBlock.test(buildGradle)) {
    throw new Error('Could not locate the Android dependencies block.');
  }

  return buildGradle.replace(dependenciesBlock, (match) => `${match}\n    ${dependency}`);
}

function setReactNativeBuildFromSource(settingsGradle) {
  const marker = '// @generated by withAndroidReleaseSafety - React Native source build';
  if (settingsGradle.includes(marker)) {
    return settingsGradle;
  }

  return `${settingsGradle.trimEnd()}

${marker}
includeBuild('../node_modules/react-native') {
  dependencySubstitution {
    substitute(module('com.facebook.react:react-android')).using(project(':packages:react-native:ReactAndroid'))
    substitute(module('com.facebook.react:react-native')).using(project(':packages:react-native:ReactAndroid'))
  }
}
`;
}

const plugin = createRunOncePlugin(
  withAndroidReleaseSafety,
  PLUGIN_NAME,
  PLUGIN_VERSION
);

module.exports = plugin;
module.exports.RELEASE_KEEP_RULES = RELEASE_KEEP_RULES;
module.exports.setMaterialComponentsVersion = setMaterialComponentsVersion;
module.exports.setReactNativeBuildFromSource = setReactNativeBuildFromSource;
module.exports.setReleaseProguardRules = setReleaseProguardRules;
module.exports.setReleaseProguardBase = setReleaseProguardBase;
module.exports.setReleaseSafetyProperties = setReleaseSafetyProperties;
module.exports.withAndroidReleaseSafety = withAndroidReleaseSafety;
