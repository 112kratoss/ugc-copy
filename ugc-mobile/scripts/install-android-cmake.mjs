#!/usr/bin/env node
/**
 * EAS post-install hook: make sure the Android builder has the CMake that
 * React Native's ReactAndroid build pins.
 *
 * `withAndroidReleaseSafety` compiles React Native from source (the patched
 * StatusBarModule/WindowUtil only apply that way), and ReactAndroid's
 * `build.gradle.kts` configures its native build with
 * `System.getenv("CMAKE_VERSION") ?: "3.30.5"`. The EAS image ships the NDK but
 * not that CMake, so the store build died in `configureCMakeRelWithDebInfo`
 * with `[CXX1300] CMake '3.30.5' was not found` (build 2efa1903, 2026-09-04)
 * while local builds, whose Android Studio SDK already holds 3.30.5, passed.
 *
 * Runs only on EAS Android builders; everywhere else it is a no-op so `npm
 * install` on a laptop never touches the SDK. The version is read from the
 * installed react-native so an upgrade cannot leave a stale pin behind.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FALLBACK_CMAKE_VERSION = '3.30.5';

export function readReactNativeCmakeVersion(projectRoot) {
  const gradleFile = path.join(
    projectRoot,
    'node_modules/react-native/ReactAndroid/build.gradle.kts',
  );
  if (!existsSync(gradleFile)) return null;
  const match = readFileSync(gradleFile, 'utf8')
    .match(/System\.getenv\("CMAKE_VERSION"\)\s*\?:\s*"([0-9][0-9.]*)"/);
  return match?.[1] ?? null;
}

export function resolveCmakeVersion(env, projectRoot) {
  const override = env.CMAKE_VERSION?.trim();
  if (override) return override;
  return readReactNativeCmakeVersion(projectRoot) ?? FALLBACK_CMAKE_VERSION;
}

export function shouldInstallCmake(env) {
  return env.EAS_BUILD === 'true' && env.EAS_BUILD_PLATFORM === 'android';
}

export function findSdkManager(sdkRoot, env = process.env) {
  const candidates = [
    path.join(sdkRoot, 'cmdline-tools/latest/bin/sdkmanager'),
    path.join(sdkRoot, 'cmdline-tools/tools/bin/sdkmanager'),
    path.join(sdkRoot, 'tools/bin/sdkmanager'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  // The EAS image puts cmdline-tools on PATH; fall back to resolution by name.
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'sdkmanager');
    if (dir && existsSync(candidate)) return candidate;
  }
  return null;
}

export function installAndroidCmake({ env = process.env, projectRoot = process.cwd(), log = console.log } = {}) {
  if (!shouldInstallCmake(env)) {
    log('install-android-cmake: not an EAS Android build, nothing to do.');
    return { installed: false, reason: 'not-eas-android' };
  }
  const version = resolveCmakeVersion(env, projectRoot);
  const sdkRoot = env.ANDROID_HOME?.trim() || env.ANDROID_SDK_ROOT?.trim();
  if (!sdkRoot) {
    throw new Error('install-android-cmake: ANDROID_HOME/ANDROID_SDK_ROOT is not set on this builder.');
  }
  if (existsSync(path.join(sdkRoot, 'cmake', version, 'bin', 'cmake'))) {
    log(`install-android-cmake: CMake ${version} already present in ${sdkRoot}.`);
    return { installed: false, reason: 'present', version };
  }
  const sdkmanager = findSdkManager(sdkRoot, env);
  if (!sdkmanager) {
    throw new Error(`install-android-cmake: sdkmanager not found under ${sdkRoot} or on PATH.`);
  }
  log(`install-android-cmake: installing cmake;${version} via ${sdkmanager}.`);
  // Licenses are pre-accepted on EAS images; the piped answers cover a fresh SDK.
  execFileSync(sdkmanager, ['--install', `cmake;${version}`], {
    input: 'y\n'.repeat(30),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (!existsSync(path.join(sdkRoot, 'cmake', version, 'bin', 'cmake'))) {
    throw new Error(`install-android-cmake: cmake;${version} did not appear under ${sdkRoot}/cmake after install.`);
  }
  log(`install-android-cmake: CMake ${version} ready.`);
  return { installed: true, version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    installAndroidCmake();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
