import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { workflowStep } from './fixtures/workflow-steps';

const projectRoot = join(__dirname, '..');
const read = (relativePath: string) => readFileSync(join(projectRoot, relativePath), 'utf8');

/**
 * CI runs `expo install --check`, and Expo Doctor's version check, offline
 * (EXPO_OFFLINE=1 in quality.yml and in the store release's validate job):
 * against the versions the installed expo package lists in its
 * bundledNativeModules.json. Online they used Expo's live list, so every Expo
 * patch release turned every tree red with nothing changed here: on
 * 2026-08-26, then expo-updates 55.0.31 on 2026-09-19 (#180), then expo
 * 55.0.32, expo-auth-session 55.0.19 and expo-dev-client 55.0.41 on
 * 2026-10-21 (#517). Offline, only @shopify/flash-list differs from that list
 * today (2.3.2 against 2.0.2); it and react-native, both pinned on purpose,
 * are the whole of `expo.install.exclude`. Run locally without the variable,
 * the check and Doctor name the held packages below (so does EAS Build's own
 * Doctor phase, as warnings). Offline also skips what only the live list
 * names: `expo` itself, typescript, @types/react and babel-preset-expo, so an
 * SDK upgrade runs the check online. Doctor still reads Expo's config schema
 * and React Native Directory live.
 *
 * Expo's live list is read in two places instead (scripts/expo-live-versions.mjs,
 * run in ci-advisory-steps.test.ts): a report on main's Quality runs, and a
 * gate on a pull request that changes the app's version. That release bump is
 * where new store binaries come from, so a native patch, which moves the
 * runtime fingerprint and strands over-the-air updates anywhere else, costs
 * nothing there.
 *
 * Between store builds main keeps the versions the binaries in users' hands
 * were cut with. The lockfile holds them and HELD pins any that Expo has
 * already moved past: `npm update expo` or an online `expo install --fix`
 * alone would otherwise take a bump with CI green. Once app.json leaves
 * HELD_FOR, each held package must have moved past its pin. In the
 * release-bump commit, run `./node_modules/.bin/expo install --fix` in
 * ugc-mobile (online), repin android-config.test.ts's expo-dev-client range,
 * and leave HELD as it is; empty it in the commit that records the new
 * binaries in ota-targets.json. A rebuild at the same version trips none of
 * this. One that carries a native change anyway can take the bumps too,
 * repinning HELD and android-config.test.ts's range to the new versions in
 * the same commit.
 *
 * HELD is empty: the 0.1.8 hold (expo 55.0.31, expo-updates 55.0.30,
 * expo-auth-session 55.0.18, expo-dev-client 55.0.40, from #180) was taken by
 * the 0.1.9 release bump (#763: expo 55.0.32, expo-updates 55.0.33,
 * expo-auth-session 55.0.19, expo-dev-client 55.0.41), and ota-targets.json
 * records those 0.1.9 builds. Fill it again, with HELD_FOR set to the version
 * in users' hands, when Expo next ships a patch release main should not take
 * until a store build.
 */
const DURABLE = ['react-native', '@shopify/flash-list'];
const HELD_FOR = '0.1.9';
const HELD: Record<string, string> = {};

/** Whether `version` (x.y.z, any pre-release ignored) comes after `than`. */
function isLater(version: string | undefined, than: string) {
  if (!version) return false;
  const [a, b] = [version, than].map((value) => value.split('-')[0].split('.').map(Number));
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

describe('expo.install.exclude', () => {
  const exclude: string[] = JSON.parse(read('package.json')).expo.install.exclude;
  const lock = JSON.parse(read('package-lock.json'));
  const version: string = JSON.parse(read('app.json')).expo.version;

  it('names only the lasting holds', () => {
    expect(exclude).toEqual(DURABLE);
  });

  it(`holds each Expo package at its ${HELD_FOR} version, and lets go of it at the release bump`, () => {
    for (const [name, held] of Object.entries(HELD)) {
      const locked: string | undefined = lock.packages[`node_modules/${name}`]?.version;
      if (version === HELD_FOR) {
        expect(locked, name).toBe(held);
      } else {
        expect(isLater(locked, held), `${name} ${locked} must move past ${held} now that the app is ${version}`).toBe(true);
      }
    }
  });

  it('compares versions the way the pins need', () => {
    expect(isLater('55.0.32', '55.0.31')).toBe(true);
    expect(isLater('55.1.0', '55.0.40')).toBe(true);
    expect(isLater('55.0.31', '55.0.31')).toBe(false);
    expect(isLater('55.0.9', '55.0.10')).toBe(false);
    expect(isLater(undefined, '55.0.31')).toBe(false);
  });
});

describe("CI's dependency check", () => {
  it('runs offline, with Doctor, in both workflows', () => {
    for (const workflow of ['quality.yml', 'mobile-store-release.yml']) {
      for (const name of ['Validate Expo dependency alignment', 'Run Expo Doctor']) {
        expect(workflowStep(workflow, name), `${workflow}: ${name}`).toContain('EXPO_OFFLINE: "1"');
      }
    }
  });
});
