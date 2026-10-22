import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = join(__dirname, '..');
const read = (relativePath: string) => readFileSync(join(projectRoot, relativePath), 'utf8');

/**
 * CI runs `expo install --check` and Expo Doctor offline (EXPO_OFFLINE=1 in
 * quality.yml and in the store release's validate job), against the versions
 * the installed expo package lists in its bundledNativeModules.json. Online
 * they used Expo's live list, so every Expo patch release turned every tree
 * red with nothing changed here: on 2026-08-26, then expo-updates 55.0.31 on
 * 2026-09-19 (#180), then expo 55.0.32, expo-auth-session 55.0.19 and
 * expo-dev-client 55.0.41 on 2026-10-21 (#517). Offline, only
 * @shopify/flash-list differs from that list today (2.3.2 against 2.0.2); it
 * and react-native, both pinned on purpose, are the whole of
 * `expo.install.exclude`.
 *
 * Expo's newer patches still wait for a store build. A native one moves the
 * runtime fingerprint, after which no over-the-air update reaches the store
 * builds in ota-targets.json, so main keeps the versions every 0.1.8 binary
 * was cut with. The lockfile holds them, and HELD pins it here: `npm update
 * expo` or an online `expo install --fix` alone would otherwise take a bump
 * with CI green. The Mobile app job also warns when the fingerprint moves, and
 * the store release's validate job lists what Expo's live list would add
 * (both steps are run in ci-advisory-steps.test.ts).
 *
 * #180 said to take its bump with the next store binaries, and all nine store
 * builds since kept the hold, so HELD fails the release bump instead. app.json's
 * version is itself a fingerprint input, so a new version moves both runtimes
 * anyway, and that commit is where the bumps cost no over-the-air reach. In it,
 * run `./node_modules/.bin/expo install --fix` (online, so it takes Expo's live
 * list), repin android-config.test.ts's expo-dev-client range, and empty HELD.
 * A rebuild at 0.1.8 does not trip this; one that carries a native change
 * anyway should take the bumps too.
 *
 * The same commit can keep the development-only native modules
 * (DEVELOPMENT_ONLY_NATIVE_MODULES in plugins/withBuildProfileAutolinking.js)
 * out of the fingerprint. Production builds never link them, yet every
 * expo-dev-client patch moves both runtimes today. A fingerprint.config.js
 * beside app.json that ignores `node_modules/<module>/**` and filters those
 * modules out of the `expoAutolinkingConfig:*` sources in a fileHookTransform
 * does it: measured on 2026-10-22, a dev-client bump then moved neither
 * fingerprint. The file moves both fingerprints itself, so it ships only with
 * new binaries.
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

/** One step of a workflow, from its `- name:` line to the next step's. */
function workflowStep(workflow: string, name: string) {
  const text = read(`../.github/workflows/${workflow}`);
  const start = text.indexOf(`- name: ${name}\n`);
  expect(start, `${workflow}: ${name}`).toBeGreaterThan(-1);
  const next = text.indexOf('\n      - name: ', start);
  return text.slice(start, next === -1 ? undefined : next);
}

describe('expo.install.exclude', () => {
  const exclude: string[] = JSON.parse(read('package.json')).expo.install.exclude;
  const lock = JSON.parse(read('package-lock.json'));

  it('names only the lasting holds', () => {
    expect(exclude).toEqual(DURABLE);
  });

  it('holds each Expo package at the version every 0.1.8 binary was cut with', () => {
    for (const [name, version] of Object.entries(HELD)) {
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(version);
    }
  });

  it('is still held only because 0.1.8 is the newest store build', () => {
    if (Object.keys(HELD).length > 0) {
      expect(JSON.parse(read('app.json')).expo.version).toBe('0.1.8');
    }
  });
});

describe("CI's Expo checks", () => {
  it('compare with the installed SDK rather than the live list in both workflows', () => {
    for (const workflow of ['quality.yml', 'mobile-store-release.yml']) {
      for (const name of ['Validate Expo dependency alignment', 'Run Expo Doctor']) {
        expect(workflowStep(workflow, name), `${workflow}: ${name}`).toContain(
          'EXPO_OFFLINE: "1"',
        );
      }
    }
  });

  it('report the fingerprint and the live list without failing their job', () => {
    const reach = workflowStep('quality.yml', 'Compare the runtime fingerprint with the store builds');
    expect(reach).toContain('continue-on-error: true');
    expect(reach).toContain('node ./scripts/verify-ota-target.mjs --set-aside');

    const live = workflowStep('mobile-store-release.yml', "Report Expo's live version list");
    expect(live).toContain('continue-on-error: true');
    expect(live).toContain('install --check --json');
    expect(live).not.toContain('EXPO_OFFLINE');
  });
});
