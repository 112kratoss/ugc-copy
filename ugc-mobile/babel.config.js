module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // One import per icon module instead of the whole lucide barrel — see the
    // plugin for the measurement. Metro caches transforms without tracking the
    // plugin file: run `expo start --clear` after editing it.
    plugins: ['./bundler/lucide-direct-imports'],
  };
};
