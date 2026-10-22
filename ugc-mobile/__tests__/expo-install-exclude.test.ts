import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = join(__dirname, '..');
const read = (relativePath: string) => readFileSync(join(projectRoot, relativePath), 'utf8');

/**
 * CI's `expo install --check` (quality.yml, and the store release's validate
 * job) compares what is installed with the versions Expo's servers recommend
 * on the day it runs, so an Expo patch release turns every tree red with
 * nothing changed here: expo-updates 55.0.31 on 2026-09-19 (#180), then expo
 * 55.0.32, expo-auth-session 55.0.19 and expo-dev-client 55.0.41 on 2026-10-21
 * (#517). A native bump moves the runtime fingerprint, after which no
 * over-the-air update reaches the store builds in ota-targets.json, so main
 * holds the versions every 0.1.8 binary was cut with, and `expo.install.exclude`
 * tells the check to skip them. A temporary hold is written `name@55.0.x`: it
 * is skipped while Expo recommends another 55.0.x patch and reported again at
 * an SDK upgrade. A bare name would hide the package at any version, leave it
 * out of the upgrade's `--fix`, and break `expo install expo` outright.
 *
 * The entries only silence the check. The lockfile is what holds the versions,
 * so it is pinned here: `npm update expo` alone would otherwise take the bump
 * with CI green.
 *
 * #180 said to take its bump with the next store binaries, and all nine store
 * builds since kept the hold, so these fail the release bump instead. app.json's
 * version is itself a fingerprint input, so a new version moves both runtimes
 * anyway, and that commit is where the bumps cost no over-the-air reach. In it,
 * remove the four `@55.0.x` entries from package.json (react-native and
 * @shopify/flash-list stay), run `./node_modules/.bin/expo install --fix` (it
 * skips any entry still listed), repin android-config.test.ts's expo-dev-client
 * range, and empty HELD. A rebuild at 0.1.8 does not trip this; one that carries
 * a native change anyway should take the bumps too.
 *
 * What the held versions defer, to check on a device when they are taken:
 * expo 55.0.32 brings expo-modules-core 55.0.27, whose Android update log no
 * longer blocks the threads writing to it at a cold start, and @expo/cli
 * 55.0.37, which fixes the dev server's loopback check. expo-updates 55.0.32 and
 * 55.0.33 stop updates re-downloading assets the binary already embeds (iOS,
 * then both platforms). expo-auth-session 55.0.19 and expo-dev-client 55.0.41
 * change no code.
 */
const DURABLE = ['react-native', '@shopify/flash-list'];
const HELD: Record<string, string> = {
  'expo-updates': '55.0.30',
  expo: '55.0.31',
  'expo-auth-session': '55.0.18',
  'expo-dev-client': '55.0.40',
};

describe('expo.install.exclude', () => {
  const exclude: string[] = JSON.parse(read('package.json')).expo.install.exclude;
  const lock = JSON.parse(read('package-lock.json'));
  const held = Object.keys(HELD);

  it('names the lasting holds outright and the temporary ones by SDK 55 patch', () => {
    expect(exclude).toEqual([...DURABLE, ...held.map((name) => `${name}@55.0.x`)]);
  });

  it('holds each temporary package at the version every 0.1.8 binary was cut with', () => {
    for (const [name, version] of Object.entries(HELD)) {
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version);
    }
  });

  it('is still held only because 0.1.8 is the newest store build', () => {
    if (held.length > 0) {
      expect(JSON.parse(read('app.json')).expo.version).toBe('0.1.8');
    }
  });
});
