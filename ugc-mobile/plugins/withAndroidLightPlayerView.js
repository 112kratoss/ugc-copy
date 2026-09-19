const fs = require('fs');
const path = require('path');
const { createRunOncePlugin, withDangerousMod } = require('expo/config-plugins');

const PLUGIN_NAME = 'withAndroidLightPlayerView';
const PLUGIN_VERSION = '1.0.0';

// Resource-copy helper for the scoped lightweight native hosts. The host
// implementation and library resources are in experiments/android-light-player-view.
// Native controls remain supported by Expo's original, untouched layout names.
// The source patch already bundles these resources, so it does not require
// registering this helper as an app plugin. Registering this helper alone
// deliberately changes no existing video view.
const LAYOUT_DIR = path.join(__dirname, 'android-light-player-view');
const LAYOUT_FILES = [
  'texture_player_view.xml',
  'surface_player_view.xml',
  'magicbooklet_player_view.xml',
  'magicbooklet_player_controls.xml',
];

function writeLightPlayerViewLayouts(projectRoot) {
  const target = path.join(projectRoot, 'android', 'app', 'src', 'main', 'res', 'layout');
  fs.mkdirSync(target, { recursive: true });
  for (const file of LAYOUT_FILES) {
    // Never override Expo's standard layouts: creation previews and the
    // lightbox need their full native controls. Only the scoped native hosts
    // in experiments/android-light-player-view select these unique names.
    const output = file === 'texture_player_view.xml' || file === 'surface_player_view.xml'
      ? `magicbooklet_${file}` : file;
    fs.copyFileSync(path.join(LAYOUT_DIR, file), path.join(target, output));
  }
  return LAYOUT_FILES.map((file) => path.join(target,
    file === 'texture_player_view.xml' || file === 'surface_player_view.xml' ? `magicbooklet_${file}` : file));
}

function withAndroidLightPlayerView(config) {
  return withDangerousMod(config, [
    'android',
    (modConfig) => {
      writeLightPlayerViewLayouts(modConfig.modRequest.projectRoot);
      return modConfig;
    },
  ]);
}

const plugin = createRunOncePlugin(withAndroidLightPlayerView, PLUGIN_NAME, PLUGIN_VERSION);

module.exports = plugin;
module.exports.LAYOUT_DIR = LAYOUT_DIR;
module.exports.LAYOUT_FILES = LAYOUT_FILES;
module.exports.writeLightPlayerViewLayouts = writeLightPlayerViewLayouts;
module.exports.withAndroidLightPlayerView = withAndroidLightPlayerView;
