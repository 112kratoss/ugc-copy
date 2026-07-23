const {
  createRunOncePlugin,
  withAppBuildGradle,
  withGradleProperties,
} = require('expo/config-plugins');

const PLUGIN_NAME = 'withAndroidReleaseSafety';
const PLUGIN_VERSION = '1.0.0';
const RELEASE_PROPERTIES = {
  'android.enableMinifyInReleaseBuilds': 'false',
  'android.enableShrinkResourcesInReleaseBuilds': 'false',
};

function withAndroidReleaseSafety(config) {
  const configWithReleaseProperties = withGradleProperties(config, (nextConfig) => {
    nextConfig.modResults = setReleaseSafetyProperties(nextConfig.modResults);
    return nextConfig;
  });

  return withAppBuildGradle(configWithReleaseProperties, (nextConfig) => {
    nextConfig.modResults.contents = setReleaseProguardSafety(
      nextConfig.modResults.contents
    );
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

const plugin = createRunOncePlugin(
  withAndroidReleaseSafety,
  PLUGIN_NAME,
  PLUGIN_VERSION
);

module.exports = plugin;
module.exports.setReleaseProguardSafety = setReleaseProguardSafety;
module.exports.setReleaseSafetyProperties = setReleaseSafetyProperties;
module.exports.withAndroidReleaseSafety = withAndroidReleaseSafety;
