const {
  createRunOncePlugin,
  withAppBuildGradle,
  withGradleProperties,
} = require('expo/config-plugins');

const PLUGIN_NAME = 'withAndroidReleaseOptimization';
const PLUGIN_VERSION = '1.0.0';
const RELEASE_PROPERTIES = {
  'android.enableMinifyInReleaseBuilds': 'true',
  'android.enableShrinkResourcesInReleaseBuilds': 'true',
};

function withAndroidReleaseOptimization(config) {
  const configWithReleaseProperties = withGradleProperties(config, (nextConfig) => {
    nextConfig.modResults = setReleaseOptimizationProperties(nextConfig.modResults);
    return nextConfig;
  });

  return withAppBuildGradle(configWithReleaseProperties, (nextConfig) => {
    nextConfig.modResults.contents = setReleaseProguardOptimization(
      nextConfig.modResults.contents
    );
    return nextConfig;
  });
}

function setReleaseOptimizationProperties(properties) {
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

function setReleaseProguardOptimization(buildGradle) {
  const optimizedDefault = 'getDefaultProguardFile("proguard-android-optimize.txt")';
  if (/getDefaultProguardFile\((["'])proguard-android-optimize\.txt\1\)/.test(buildGradle)) {
    return buildGradle;
  }

  const unoptimizedDefault = /getDefaultProguardFile\((["'])proguard-android\.txt\1\)/g;
  if (!unoptimizedDefault.test(buildGradle)) {
    throw new Error('Could not locate the Android release ProGuard default configuration.');
  }

  return buildGradle.replace(unoptimizedDefault, optimizedDefault);
}

const plugin = createRunOncePlugin(
  withAndroidReleaseOptimization,
  PLUGIN_NAME,
  PLUGIN_VERSION
);

module.exports = plugin;
module.exports.setReleaseProguardOptimization = setReleaseProguardOptimization;
module.exports.setReleaseOptimizationProperties = setReleaseOptimizationProperties;
module.exports.withAndroidReleaseOptimization = withAndroidReleaseOptimization;
