// Keeps the development-only native modules out of the runtime fingerprint.
// Production builds never link them (plugins/withBuildProfileAutolinking.js),
// so their versions should not decide which binaries an over-the-air update
// reaches. Parked: see experiments/fingerprint-dev-only/README.md. Graduated,
// this file sits beside app.json, where @expo/fingerprint reads it.
const { DEVELOPMENT_ONLY_NATIVE_MODULES } = require('./plugins/withBuildProfileAutolinking');

/** @type {import('@expo/fingerprint').Config} */
module.exports = {
  ignorePaths: DEVELOPMENT_ONLY_NATIVE_MODULES.map((name) => `node_modules/${name}/**`),
  fileHookTransform(source, chunk) {
    if (source.type !== 'contents' || !source.id.startsWith('expoAutolinkingConfig:')) {
      return chunk;
    }
    const config = JSON.parse(chunk);
    config.modules = config.modules.filter(
      (module) => !DEVELOPMENT_ONLY_NATIVE_MODULES.includes(module.packageName),
    );
    return JSON.stringify(config);
  },
};
