import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'ios', Version: '26.0' as string | number }));
vi.mock('react-native', () => ({ Platform: platform }));

// Spread the shared double (vitest.config.ts aliases expo-haptics to it) so
// the enums stay the double's and only the calls become observable.
const calls = vi.hoisted(() => ({
  selectionAsync: vi.fn(async () => {}),
  impactAsync: vi.fn(async (_style: string) => {}),
  notificationAsync: vi.fn(async (_type: string) => {}),
  performAndroidHapticsAsync: vi.fn(async (_type: string) => {}),
}));
vi.mock('expo-haptics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mocks/expo-haptics')>()),
  ...calls,
}));

import { ANDROID_EFFECTS, haptic, type HapticKind } from '@/lib/haptics';
import { AndroidHaptics as doubleAndroidHaptics } from './mocks/expo-haptics';

const KINDS: HapticKind[] = ['select', 'light', 'soft', 'medium', 'success', 'error'];
const packageRoot = path.resolve(__dirname, '../node_modules/expo-haptics');

function setPlatform(os: string, version: string | number) {
  platform.OS = os;
  platform.Version = version;
}

function playEveryKind() {
  KINDS.forEach((kind) => haptic[kind]());
  return calls.performAndroidHapticsAsync.mock.calls.map(([type]) => type);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('haptic vocabulary on iOS', () => {
  it('plays each word through the UIKit generator it always did', () => {
    setPlatform('ios', '26.0');
    expect(playEveryKind()).toEqual([]);
    expect(calls.selectionAsync).toHaveBeenCalledTimes(1);
    expect(calls.impactAsync.mock.calls).toEqual([['light'], ['soft'], ['medium']]);
    expect(calls.notificationAsync.mock.calls).toEqual([['success'], ['error']]);
  });
});

describe('haptic vocabulary on Android', () => {
  it('routes through the OS haptic constants, never the vibrator waveforms', () => {
    // Order follows KINDS: select, light, soft, medium, success, error.
    setPlatform('android', 35);
    expect(playEveryKind()).toEqual([
      'segment-tick',
      'context-click',
      'clock-tick',
      'confirm',
      'confirm',
      'reject',
    ]);
    expect(calls.selectionAsync).not.toHaveBeenCalled();
    expect(calls.impactAsync).not.toHaveBeenCalled();
    expect(calls.notificationAsync).not.toHaveBeenCalled();
  });

  it('falls back below Android 14 only for the constant that arrived there', () => {
    setPlatform('android', 33);
    expect(playEveryKind()).toEqual([
      'context-click',
      'context-click',
      'clock-tick',
      'confirm',
      'confirm',
      'reject',
    ]);
  });

  it('falls back below Android 11 for confirm and reject', () => {
    setPlatform('android', 29);
    expect(playEveryKind()).toEqual([
      'context-click',
      'context-click',
      'clock-tick',
      'virtual-key',
      'virtual-key',
      'long-press',
    ]);
  });

  it('stays silent, not thrown, when the phone rejects a constant', async () => {
    setPlatform('android', 35);
    calls.performAndroidHapticsAsync.mockRejectedValueOnce(new Error('HapticsNotSupportedException'));
    expect(() => haptic.error()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('gates nothing without a fallback the module resolves on every API level', () => {
    // expo-haptics resolves constants by reflection and, when the OS lacks
    // one, falls through to a `when` listing the constants every API level
    // has. Anything ungated, and every fallback, must be on that list: a miss
    // is a silent no-op on exactly the phones that need the fallback.
    const kotlin = readFileSync(
      path.join(packageRoot, 'android/src/main/java/expo/modules/haptics/HapticsRecord.kt'),
      'utf8'
    );
    const alwaysAvailable = Array.from(
      kotlin.matchAll(/(\w+) -> HapticFeedbackConstants\.\1\b/g),
      (match) => match[1]
    );
    expect(alwaysAvailable.length).toBeGreaterThan(0);

    for (const kind of KINDS) {
      const pick = ANDROID_EFFECTS[kind];
      const mustResolveEverywhere = 'since' in pick ? pick.fallback : pick.effect;
      expect(alwaysAvailable, `${kind} → ${mustResolveEverywhere}`).toContain(
        mustResolveEverywhere.toUpperCase()
      );
    }
  });

  it('keeps the test double in step with the real AndroidHaptics enum', () => {
    const types = readFileSync(path.join(packageRoot, 'src/Haptics.types.ts'), 'utf8');
    const enumBody = types.slice(types.indexOf('export enum AndroidHaptics'));
    const real = Object.fromEntries(
      Array.from(enumBody.matchAll(/^\s+([A-Za-z_]+) = '([a-z-]+)',/gm), (match) => [match[1], match[2]])
    );
    expect(doubleAndroidHaptics).toEqual(real);
  });
});
