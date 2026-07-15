const DEVELOPMENT_ONLY_NATIVE_MODULES = [
  'expo-dev-client',
  'expo-dev-launcher',
  'expo-dev-menu',
  'expo-dev-menu-interface',
  'expo-manifests',
  'expo-updates-interface',
];

function withBuildProfileAutolinking(config, includeDevClient) {
  if (includeDevClient !== false) return config;

  const existingExcludes = config.autolinking?.exclude ?? [];
  return {
    ...config,
    autolinking: {
      ...config.autolinking,
      exclude: [...new Set([...existingExcludes, ...DEVELOPMENT_ONLY_NATIVE_MODULES])],
    },
  };
}

function appConfig({ config }) {
  return withBuildProfileAutolinking(
    config,
    process.env.MAGICBOOKLET_INCLUDE_DEV_CLIENT !== 'false'
  );
}

module.exports = appConfig;
module.exports.withBuildProfileAutolinking = withBuildProfileAutolinking;
