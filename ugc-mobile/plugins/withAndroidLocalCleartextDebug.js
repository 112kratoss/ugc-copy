const {
  createRunOncePlugin,
  withAndroidManifest,
  withAppBuildGradle,
} = require('@expo/config-plugins');

const CLEAR_TEXT_PLACEHOLDER = 'usesCleartextTraffic';
const PLUGIN_NAME = 'withAndroidLocalCleartextDebug';
const PLUGIN_VERSION = '1.0.0';

function withAndroidLocalCleartextDebug(config) {
  config = withAndroidManifest(config, (nextConfig) => {
    nextConfig.modResults = setManifestCleartextPlaceholder(nextConfig.modResults);
    return nextConfig;
  });

  config = withAppBuildGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language === 'groovy') {
      nextConfig.modResults.contents = setGradleCleartextPlaceholders(nextConfig.modResults.contents);
    }
    return nextConfig;
  });

  return config;
}

function setManifestCleartextPlaceholder(androidManifest) {
  const application = androidManifest.manifest?.application?.[0];
  if (!application) {
    return androidManifest;
  }

  application.$ = application.$ ?? {};
  application.$['android:usesCleartextTraffic'] = `\${${CLEAR_TEXT_PLACEHOLDER}}`;
  return androidManifest;
}

function setGradleCleartextPlaceholders(contents) {
  let nextContents = setBlockCleartextPlaceholder(contents, 'defaultConfig', 'false', 8);
  nextContents = setBlockCleartextPlaceholder(nextContents, 'debug', 'true', 12);
  nextContents = setBlockCleartextPlaceholder(nextContents, 'release', 'false', 12);
  return nextContents;
}

function setBlockCleartextPlaceholder(contents, blockName, value, indentSize) {
  const blockPattern = new RegExp(`(${blockName}\\s*\\{)([\\s\\S]*?)(\\n\\s*\\})`);
  const indent = ' '.repeat(indentSize);
  const placeholderLine = `${indent}manifestPlaceholders = [${CLEAR_TEXT_PLACEHOLDER}: "${value}"]`;

  return contents.replace(blockPattern, (match, opening, body, closing) => {
    const withoutExistingCleartext = body.replace(
      new RegExp(`\\n\\s*manifestPlaceholders\\s*=\\s*\\[[^\\n\\]]*${CLEAR_TEXT_PLACEHOLDER}[^\\n\\]]*\\]`, 'g'),
      ''
    );

    return `${opening}\n${placeholderLine}${withoutExistingCleartext}${closing}`;
  });
}

const plugin = createRunOncePlugin(
  withAndroidLocalCleartextDebug,
  PLUGIN_NAME,
  PLUGIN_VERSION
);

module.exports = plugin;
module.exports.setGradleCleartextPlaceholders = setGradleCleartextPlaceholders;
module.exports.setManifestCleartextPlaceholder = setManifestCleartextPlaceholder;
module.exports.withAndroidLocalCleartextDebug = withAndroidLocalCleartextDebug;
