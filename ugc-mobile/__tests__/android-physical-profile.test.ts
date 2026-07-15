import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseAdbDevices,
  parseApkBadging,
  parseArgs,
  parseGfxInfo,
  parseStartTiming,
  requireLaunchState,
  selectDevice,
  summarizeGraphics,
  summarizeTimings,
} from '../scripts/profile-android-physical.mjs';

const projectRoot = resolve(__dirname, '..');

describe('physical Android profiler', () => {
  it('requires an APK and validates bounded run counts', () => {
    expect(() => parseArgs([])).toThrow('--apk is required');
    expect(() =>
      parseArgs(['--apk', '/tmp/app.apk', '--cold-runs', '0'])
    ).toThrow('between 1 and 50');
    expect(
      parseArgs([
        '--apk',
        '/tmp/app.apk',
        '--serial',
        'PHONE123',
        '--cold-runs',
        '7',
        '--hot-runs',
        '9',
      ])
    ).toMatchObject({
      apk: '/tmp/app.apk',
      serial: 'PHONE123',
      coldRuns: 7,
      hotRuns: 9,
    });
  });

  it('selects the only physical device and rejects emulator targets', () => {
    const devices = parseAdbDevices(`List of devices attached
PHONE123 device product:husky model:Pixel_8_Pro device:husky transport_id:1
emulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:2
UNAUTHORIZED unauthorized usb:1-1 transport_id:3
`);

    expect(selectDevice(devices)).toMatchObject({ serial: 'PHONE123', state: 'device' });
    expect(() => selectDevice(devices, 'emulator-5554')).toThrow(
      'only accepts physical devices'
    );
    expect(() => selectDevice(devices, 'UNAUTHORIZED')).toThrow('unauthorized');
  });

  it('requires a serial when multiple physical devices are ready', () => {
    const devices = parseAdbDevices(`List of devices attached
PHONE1 device model:Pixel_8
PHONE2 device model:SM_S928B
`);

    expect(() => selectDevice(devices)).toThrow('Expected exactly one ready physical device');
    expect(selectDevice(devices, 'PHONE2').serial).toBe('PHONE2');
  });

  it('lets the runtime property probe reject disguised emulators', () => {
    const devices = parseAdbDevices(`List of devices attached
LOCALHOST123 device model:Android_Device
`);

    expect(() => selectDevice(devices, undefined, () => true)).toThrow(
      'Expected exactly one ready physical device, found 0'
    );
  });

  it('does not expose a requested serial in selection errors', () => {
    const serial = 'SECRET_DEVICE_SERIAL';
    const devices = parseAdbDevices('List of devices attached\n');

    try {
      selectDevice(devices, serial);
      throw new Error('Expected device selection to fail');
    } catch (error) {
      expect(String(error)).not.toContain(serial);
    }
  });

  it('parses release APK, startup, and frame metrics', () => {
    const apk = parseApkBadging(`package: name='com.magicbooklet.mobile' versionCode='14' versionName='0.0.1'
sdkVersion:'24'
targetSdkVersion:'36'
launchable-activity: name='com.magicbooklet.mobile.MainActivity' label='' icon=''
native-code: 'arm64-v8a'
`);
    const timing = parseStartTiming(`Status: ok
LaunchState: COLD
Activity: com.magicbooklet.mobile/.MainActivity
ThisTime: 430
TotalTime: 462
WaitTime: 469
Complete
`);
    const graphics = parseGfxInfo(`Total frames rendered: 131
Janky frames: 36 (27.48%)
50th percentile: 19ms
90th percentile: 42ms
95th percentile: 55ms
99th percentile: 88ms
Number Missed Vsync: 9
Number High input latency: 2
Number Slow UI thread: 4
Number Slow bitmap uploads: 1
Number Slow issue draw commands: 3
`);

    expect(apk).toMatchObject({
      packageName: 'com.magicbooklet.mobile',
      launcherActivity: 'com.magicbooklet.mobile.MainActivity',
      debuggable: false,
      nativeCode: ['arm64-v8a'],
    });
    expect(timing).toMatchObject({ launchState: 'COLD', totalTimeMs: 462 });
    expect(requireLaunchState(timing, 'COLD', 'Cold', 1)).toBe(timing);
    expect(graphics).toMatchObject({
      available: true,
      totalFramesRendered: 131,
      jankyFrames: 36,
      jankyPercent: 27.48,
      p50Ms: 19,
      p95Ms: 55,
    });
  });

  it('rejects mislabeled cold and hot launch samples', () => {
    const cold = parseStartTiming(`Status: ok
LaunchState: COLD
TotalTime: 462
`);
    const hot = parseStartTiming(`Status: ok
LaunchState: HOT
TotalTime: 91
`);

    expect(requireLaunchState(cold, 'COLD', 'Cold', 1)).toBe(cold);
    expect(requireLaunchState(hot, 'HOT', 'Hot', 1)).toBe(hot);
    expect(() => requireLaunchState(hot, 'COLD', 'Cold', 2)).toThrow(
      'expected LaunchState COLD, received HOT'
    );
    expect(() => requireLaunchState(cold, 'HOT', 'Hot', 3)).toThrow(
      'expected LaunchState HOT, received COLD'
    );
  });

  it('summarizes startup timings with deterministic nearest-rank percentiles', () => {
    const samples = [385, 462, 574, 629, 655, 675].map((totalTimeMs) => ({
      status: 'ok',
      launchState: 'COLD',
      activity: 'com.magicbooklet.mobile/.MainActivity',
      thisTimeMs: totalTimeMs,
      totalTimeMs,
      waitTimeMs: totalTimeMs,
    }));

    expect(summarizeTimings(samples)).toEqual({
      count: 6,
      minMs: 385,
      maxMs: 675,
      meanMs: 563.3,
      medianMs: 601.5,
      p90Ms: 675,
      p95Ms: 675,
    });
  });

  it('aggregates independently reset frame counters with weighted jank', () => {
    const graphics = [
      parseGfxInfo(`Total frames rendered: 100
Janky frames: 10 (10.00%)
50th percentile: 8ms
90th percentile: 20ms
95th percentile: 25ms
99th percentile: 40ms
Number Missed Vsync: 2
Number High input latency: 1
Number Slow UI thread: 3
Number Slow bitmap uploads: 0
Number Slow issue draw commands: 4
`),
      parseGfxInfo(`Total frames rendered: 50
Janky frames: 10 (20.00%)
50th percentile: 12ms
90th percentile: 28ms
95th percentile: 35ms
99th percentile: 60ms
Number Missed Vsync: 3
Number High input latency: 2
Number Slow UI thread: 1
Number Slow bitmap uploads: 1
Number Slow issue draw commands: 2
`),
      parseGfxInfo('No process found for: com.magicbooklet.mobile'),
    ];
    const samples = graphics.map((runGraphics, index) => ({
      status: 'ok',
      launchState: index === 0 ? 'COLD' : 'HOT',
      activity: 'com.magicbooklet.mobile/.MainActivity',
      thisTimeMs: 100,
      totalTimeMs: 100,
      waitTimeMs: 100,
      graphics: runGraphics,
    }));

    expect(summarizeGraphics(samples)).toEqual({
      scope: 'sum of independently reset per-run graphics counters',
      runsRequested: 3,
      runsWithGraphics: 2,
      totalFramesRendered: 150,
      jankyFrames: 20,
      jankyPercent: 13.33,
      missedVsync: 5,
      highInputLatency: 3,
      slowUiThread: 4,
      slowBitmapUploads: 1,
      slowIssueDrawCommands: 6,
      percentileScope: 'per-run-only',
    });
  });

  it('keeps the CLI data-preserving and exposes it through npm', () => {
    const source = readFileSync(
      resolve(projectRoot, 'scripts/profile-android-physical.mjs'),
      'utf8'
    );
    const packageJson = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));
    const collectionStart = source.indexOf('function collectStartups');
    const collectionEnd = source.indexOf('function readApkFileIdentity', collectionStart);
    const collectionSource = source.slice(collectionStart, collectionEnd);

    expect(packageJson.scripts['profile:android:physical']).toBe(
      'node ./scripts/profile-android-physical.mjs'
    );
    expect(source).toContain("['install', '-r', apkPath]");
    expect(source).toContain("serialSha256: createHash('sha256').update(device.serial)");
    expect(source).toContain('fileName: basename(apkPath)');
    expect(source).toContain('apkFileName: apkFile.fileName');
    expect(source).not.toContain('\n      apkPath,');
    expect(source).not.toContain('serial: device.serial');
    expect(collectionSource.match(/resetGraphics\(adb, serial\);/g)).toHaveLength(2);
    expect(collectionSource.match(/graphics: readGraphics\(adb, serial, options\.settleMs\)/g))
      .toHaveLength(2);
    expect(source).not.toContain('const gfxOutput =');
    expect(source).toContain(
      'combined: summarizeGraphics([...startup.cold.samples, ...startup.hot.samples])'
    );
    expect(source).not.toMatch(/['\"](?:pm clear|uninstall|reboot|root|remount)['\"]/);
    expect(source).not.toContain("'install', '-r', '-g'");
    expect(source).not.toContain('drop_caches');
  });
});
