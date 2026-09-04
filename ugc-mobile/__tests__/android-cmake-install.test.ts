import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FALLBACK_CMAKE_VERSION,
  findSdkManager,
  installAndroidCmake,
  readReactNativeCmakeVersion,
  resolveCmakeVersion,
  shouldInstallCmake,
} from '../scripts/install-android-cmake.mjs';

const projectRoot = path.resolve(__dirname, '..');

/**
 * The Android store build compiles React Native from source (see
 * plugins/withAndroidReleaseSafety.js), and ReactAndroid's native configure step
 * demands the exact CMake it pins. EAS builders ship the NDK but not that CMake,
 * which is how build 2efa1903 died on 2026-09-04 while local builds passed. The
 * post-install hook installs it; these pin the hook to the installed react-native
 * so a React Native bump cannot silently leave the fallback stale.
 */
describe('install-android-cmake', () => {
  it('reads the CMake version ReactAndroid pins from the installed react-native', () => {
    const version = readReactNativeCmakeVersion(projectRoot);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version).toBe(FALLBACK_CMAKE_VERSION);
    expect(resolveCmakeVersion({}, projectRoot)).toBe(version);
  });

  it('lets CMAKE_VERSION override the pin, matching ReactAndroid', () => {
    expect(resolveCmakeVersion({ CMAKE_VERSION: '3.22.1' }, projectRoot)).toBe('3.22.1');
  });

  it('only acts on EAS Android builders', () => {
    expect(shouldInstallCmake({})).toBe(false);
    expect(shouldInstallCmake({ EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'ios' })).toBe(false);
    expect(shouldInstallCmake({ EAS_BUILD_PLATFORM: 'android' })).toBe(false);
    expect(shouldInstallCmake({ EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'android' })).toBe(true);
  });

  it('is a no-op outside EAS and skips an SDK that already holds the version', () => {
    const logs: string[] = [];
    expect(installAndroidCmake({ env: {}, projectRoot, log: (line) => logs.push(line) }))
      .toEqual({ installed: false, reason: 'not-eas-android' });

    const sdkRoot = mkdtempSync(path.join(tmpdir(), 'android-sdk-'));
    const version = readReactNativeCmakeVersion(projectRoot)!;
    mkdirSync(path.join(sdkRoot, 'cmake', version, 'bin'), { recursive: true });
    writeFileSync(path.join(sdkRoot, 'cmake', version, 'bin', 'cmake'), '');
    expect(installAndroidCmake({
      env: { EAS_BUILD: 'true', EAS_BUILD_PLATFORM: 'android', ANDROID_HOME: sdkRoot },
      projectRoot,
      log: (line) => logs.push(line),
    })).toEqual({ installed: false, reason: 'present', version });
    expect(logs.some((line) => line.includes('already present'))).toBe(true);
  });

  it('locates sdkmanager under the SDK before falling back to PATH', () => {
    const sdkRoot = mkdtempSync(path.join(tmpdir(), 'android-sdk-'));
    expect(findSdkManager(sdkRoot, { PATH: '' })).toBeNull();
    mkdirSync(path.join(sdkRoot, 'cmdline-tools/latest/bin'), { recursive: true });
    writeFileSync(path.join(sdkRoot, 'cmdline-tools/latest/bin/sdkmanager'), '');
    expect(findSdkManager(sdkRoot, { PATH: '' }))
      .toBe(path.join(sdkRoot, 'cmdline-tools/latest/bin/sdkmanager'));
  });
});
