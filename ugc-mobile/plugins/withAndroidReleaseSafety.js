const fs = require('fs');
const path = require('path');
const {
  createRunOncePlugin,
  withAppBuildGradle,
  withGradleProperties,
  withSettingsGradle,
} = require('expo/config-plugins');

const PLUGIN_NAME = 'withAndroidReleaseSafety';
const PLUGIN_VERSION = '4.0.0';
const MATERIAL_COMPONENTS_VERSION = '1.14.0';

// R8 is on, with the safeguards the first attempt did not have.
//
// 0.1.2 (build 62) turned on minification, resource shrinking, the optimizing
// ProGuard base and - implicitly, as the AGP 8 default - R8 full mode in one
// change, and reached testers unusable. expo-modules-core builds every JS
// options object into a Kotlin record through kotlin-reflect; after R8,
// `expo-secure-store` rejected every read ("The 2nd argument cannot be cast to
// type SecureStoreOptions"), which trapped the app in a sign-out loop, and
// `expo-image` could not set `source`, so no image ever mounted. The revert
// (dc37fa2) switched everything off together, so which switch broke the record
// converter was never isolated.
//
// Google Play scores each uploaded bundle's obfuscation and warns under 25%
// (0.1.3 measured 1%), with a Feb 2027 deadline. Obfuscation only needs R8's
// shrink and rename passes, so this turns on the minimum:
//   - minification on; resource shrinking stays off (Play did not flag it,
//     and it is a separate failure surface);
//   - the plain `proguard-android.txt` base, which carries -dontoptimize, so
//     R8 renames and drops dead code but runs no inlining or class merging;
//   - `android.enableR8.fullMode=false`, so R8 keeps ProGuard-compatible
//     implicit behaviour (default constructors, member keeps) for every
//     reflecting library, not only those that ship consumer rules;
//   - `plugins/android-release.pro`, which keeps all of `expo.modules.**`
//     and the Kotlin metadata kotlin-reflect reads.
//
// None of that is proof. A release build has to be launched on a device and
// exercised (sign-in, Showcase images, video, paywall) before it reaches the
// store. A missing rule fails exactly as build 62 did: silently, at runtime,
// in whichever module is unlucky, behind a green build.
const RELEASE_PROPERTIES = {
  'android.enableMinifyInReleaseBuilds': 'true',
  'android.enableShrinkResourcesInReleaseBuilds': 'false',
  'android.enableR8.fullMode': 'false',
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
      setReleaseProguardRules(setReleaseProguardSafety(nextConfig.modResults.contents))
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
 * Pin the release build to the plain ProGuard default. `proguard-android-optimize.txt`
 * adds the optimization passes that were switched on with build 62; Play's
 * obfuscation score does not need them, so they stay off while R8 is on.
 */
function setReleaseProguardSafety(buildGradle) {
  const safeDefault = 'getDefaultProguardFile("proguard-android.txt")';
  if (/getDefaultProguardFile\((["'])proguard-android\.txt\1\)/.test(buildGradle)) {
    return buildGradle;
  }

  const optimizedDefault = /getDefaultProguardFile\((["'])proguard-android-optimize\.txt\1\)/g;
  if (!optimizedDefault.test(buildGradle)) {
    throw new Error('Could not locate the Android release ProGuard default configuration.');
  }

  return buildGradle.replace(optimizedDefault, safeDefault);
}

/**
 * Append the tracked keep rules to the release `proguardFiles`. Runs after
 * setReleaseProguardSafety, so it only ever sees the plain base; any other
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
    /(proguardFiles\s+getDefaultProguardFile\((["'])proguard-android\.txt\2\),\s*(["'])proguard-rules\.pro\3)/;
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
module.exports.setReleaseProguardSafety = setReleaseProguardSafety;
module.exports.setReleaseSafetyProperties = setReleaseSafetyProperties;
module.exports.withAndroidReleaseSafety = withAndroidReleaseSafety;
