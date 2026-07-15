const {
  createRunOncePlugin,
  withGradleProperties,
} = require('@expo/config-plugins');

const PLUGIN_NAME = 'withAndroidReleaseOptimization';
const PLUGIN_VERSION = '1.0.0';
const RELEASE_PROPERTIES = {
  'android.enableMinifyInReleaseBuilds': 'true',
  'android.enableShrinkResourcesInReleaseBuilds': 'true',
};

function withAndroidReleaseOptimization(config) {
  return withGradleProperties(config, (nextConfig) => {
    nextConfig.modResults = setReleaseOptimizationProperties(nextConfig.modResults);
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

const plugin = createRunOncePlugin(
  withAndroidReleaseOptimization,
  PLUGIN_NAME,
  PLUGIN_VERSION
);

module.exports = plugin;
module.exports.setReleaseOptimizationProperties = setReleaseOptimizationProperties;
module.exports.withAndroidReleaseOptimization = withAndroidReleaseOptimization;
