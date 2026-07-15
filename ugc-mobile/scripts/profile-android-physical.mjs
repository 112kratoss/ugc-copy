#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'com.magicbooklet.mobile';
const DEFAULT_COLD_RUNS = 5;
const DEFAULT_HOT_RUNS = 5;
const DEFAULT_SETTLE_MS = 750;
const MAX_RUNS = 50;

class ProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
  }
}

function usage() {
  return `Usage:
  npm run profile:android:physical -- --apk /absolute/path/app-release.apk [options]

Required:
  --apk PATH          Signed, non-debuggable APK for ${PACKAGE_NAME}

Options:
  --serial SERIAL     Target one physical device when several are connected
  --cold-runs N       Force-stopped launches to measure (default: ${DEFAULT_COLD_RUNS})
  --hot-runs N        Background resumes to measure (default: ${DEFAULT_HOT_RUNS})
  --settle-ms N       Delay between lifecycle operations (default: ${DEFAULT_SETTLE_MS})
  --adb PATH          Explicit adb executable
  --aapt PATH         Explicit aapt executable
  --apksigner PATH    Explicit apksigner executable
  --help              Show this help

Safety:
  The profiler installs with replacement semantics, force-stops/launches the app,
  sends the device Home for hot launches, and resets graphics counters. It never
  clears app data/cache, grants permissions, changes compilation mode, or reboots.`;
}

function readOption(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new ProfileError('INVALID_ARGUMENT', `${option} requires a value.`);
  }
  return value;
}

function parseInteger(value, option, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!/^\d+$/.test(value)) {
    throw new ProfileError('INVALID_ARGUMENT', `${option} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ProfileError(
      'INVALID_ARGUMENT',
      `${option} must be between ${min} and ${max}.`
    );
  }
  return parsed;
}

export function parseArgs(argv) {
  const options = {
    apk: undefined,
    serial: undefined,
    coldRuns: DEFAULT_COLD_RUNS,
    hotRuns: DEFAULT_HOT_RUNS,
    settleMs: DEFAULT_SETTLE_MS,
    adb: undefined,
    aapt: undefined,
    apksigner: undefined,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    switch (option) {
      case '--apk':
        options.apk = readOption(argv, index, option);
        index += 1;
        break;
      case '--serial':
        options.serial = readOption(argv, index, option);
        index += 1;
        break;
      case '--cold-runs':
        options.coldRuns = parseInteger(readOption(argv, index, option), option, {
          min: 1,
          max: MAX_RUNS,
        });
        index += 1;
        break;
      case '--hot-runs':
        options.hotRuns = parseInteger(readOption(argv, index, option), option, {
          min: 1,
          max: MAX_RUNS,
        });
        index += 1;
        break;
      case '--settle-ms':
        options.settleMs = parseInteger(readOption(argv, index, option), option, {
          min: 0,
          max: 10_000,
        });
        index += 1;
        break;
      case '--adb':
      case '--aapt':
      case '--apksigner':
        options[option.slice(2)] = readOption(argv, index, option);
        index += 1;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new ProfileError('INVALID_ARGUMENT', `Unknown option: ${option}`);
    }
  }

  if (!options.help && !options.apk) {
    throw new ProfileError('INVALID_ARGUMENT', '--apk is required.');
  }
  return options;
}

function executableExists(path) {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(command) {
  const candidates = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, command));
  return candidates.find(executableExists);
}

function sdkRoots() {
  return [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Library', 'Android', 'sdk'),
    join(homedir(), 'Android', 'Sdk'),
  ].filter((value, index, values) => value && values.indexOf(value) === index);
}

function findBuildTool(command) {
  for (const root of sdkRoots()) {
    const directory = join(root, 'build-tools');
    if (!existsSync(directory)) continue;
    const versions = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => {
        const leftIsPreview = /[a-z]/i.test(left);
        const rightIsPreview = /[a-z]/i.test(right);
        if (leftIsPreview !== rightIsPreview) return leftIsPreview ? 1 : -1;
        return right.localeCompare(left, undefined, { numeric: true });
      });
    for (const version of versions) {
      const candidate = join(directory, version, command);
      if (executableExists(candidate)) return candidate;
    }
  }
  return undefined;
}

function resolveTool(command, explicitPath, kind) {
  if (explicitPath) {
    const candidate = resolve(explicitPath);
    if (!executableExists(candidate)) {
      throw new ProfileError('TOOL_NOT_FOUND', `${kind} is not executable: ${candidate}`);
    }
    return candidate;
  }

  const pathMatch = findOnPath(command);
  if (pathMatch) return pathMatch;

  if (command === 'adb') {
    for (const root of sdkRoots()) {
      const candidate = join(root, 'platform-tools', 'adb');
      if (executableExists(candidate)) return candidate;
    }
  } else {
    const buildTool = findBuildTool(command);
    if (buildTool) return buildTool;
  }

  throw new ProfileError(
    'TOOL_NOT_FOUND',
    `${kind} was not found. Set the Android SDK environment or pass --${command}.`
  );
}

function redact(value, sensitiveValues) {
  return sensitiveValues
    .filter(Boolean)
    .reduce((result, sensitive) => result.split(sensitive).join('[redacted]'), value);
}

function runCommand(command, args, { timeoutMs = 30_000, redact: sensitiveValues = [] } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  });
  const stdout = (result.stdout ?? '').replace(/\r\n/g, '\n').trim();
  const stderr = (result.stderr ?? '').replace(/\r\n/g, '\n').trim();

  if (result.error || result.status !== 0) {
    const rawReason = result.error?.message ?? stderr ?? stdout ?? `exit status ${result.status}`;
    const reason = redact(rawReason, sensitiveValues);
    throw new ProfileError(
      'COMMAND_FAILED',
      `${basename(command)} ${args[0] ?? ''} failed: ${reason}`
    );
  }
  return { stdout, stderr };
}

export function parseAdbDevices(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('List of devices attached') && !line.startsWith('*'))
    .map((line) => {
      const fields = line.split(/\s+/);
      const [serial, state, ...details] = fields;
      const metadata = Object.fromEntries(
        details
          .map((value) => value.split(/:(.*)/s))
          .filter((pair) => pair.length >= 2 && pair[0])
          .map(([key, value]) => [key, value])
      );
      return { serial, state, metadata };
    });
}

export function looksLikeEmulator(device) {
  const fingerprint = [
    device.serial,
    device.metadata?.model,
    device.metadata?.product,
    device.metadata?.device,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return (
    device.serial.startsWith('emulator-') ||
    /(?:^|[_\s-])(emulator|sdk_gphone|goldfish|ranchu|genymotion|vbox)(?:$|[_\s-])/.test(
      fingerprint
    )
  );
}

export function selectDevice(devices, requestedSerial, emulatorCheck = looksLikeEmulator) {
  if (requestedSerial) {
    const requested = devices.find((device) => device.serial === requestedSerial);
    if (!requested) {
      throw new ProfileError('DEVICE_NOT_FOUND', 'The requested device is not visible to adb.');
    }
    if (requested.state !== 'device') {
      throw new ProfileError(
        'DEVICE_NOT_READY',
        `The requested device is ${requested.state}; authorize it and reconnect.`
      );
    }
    if (emulatorCheck(requested)) {
      throw new ProfileError('EMULATOR_REJECTED', 'This profiler only accepts physical devices.');
    }
    return requested;
  }

  const physical = devices.filter(
    (device) => device.state === 'device' && !emulatorCheck(device)
  );
  if (physical.length !== 1) {
    throw new ProfileError(
      'PHYSICAL_DEVICE_COUNT',
      `Expected exactly one ready physical device, found ${physical.length}. Pass --serial when several are connected.`
    );
  }
  return physical[0];
}

function parseGetprop(output) {
  const properties = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\[([^\]]+)\]: \[([^\]]*)\]$/);
    if (match) properties[match[1]] = match[2];
  }
  return properties;
}

function runtimeLooksLikeEmulator(properties) {
  const hardware = properties['ro.hardware'] ?? '';
  const fingerprint = properties['ro.build.fingerprint'] ?? '';
  const model = properties['ro.product.model'] ?? '';
  const characteristics = properties['ro.build.characteristics'] ?? '';
  return (
    properties['ro.kernel.qemu'] === '1' ||
    properties['ro.boot.qemu'] === '1' ||
    /goldfish|ranchu|vbox|qemu/i.test(hardware) ||
    /generic|emulator|sdk_gphone/i.test(fingerprint) ||
    /emulator|sdk_gphone/i.test(model) ||
    /emulator/i.test(characteristics)
  );
}

function adbFor(adb, serial, args, options = {}) {
  return runCommand(adb, ['-s', serial, ...args], {
    ...options,
    redact: [serial, ...(options.redact ?? [])],
  });
}

function getDeviceProperties(adb, serial) {
  return parseGetprop(adbFor(adb, serial, ['shell', 'getprop']).stdout);
}

export function parseApkBadging(output) {
  const packageMatch = output.match(/^package: name='([^']+)'[^\n]*versionCode='([^']+)'[^\n]*versionName='([^']*)'/m);
  const activityMatch = output.match(/^launchable-activity: name='([^']+)'/m);
  const nativeCodeMatch = output.match(/^native-code: (.+)$/m);
  if (!packageMatch) {
    throw new ProfileError('INVALID_APK', 'Unable to read the APK package metadata.');
  }
  if (!activityMatch) {
    throw new ProfileError('INVALID_APK', 'The APK has no launchable activity.');
  }
  return {
    packageName: packageMatch[1],
    versionCode: packageMatch[2],
    versionName: packageMatch[3],
    launcherActivity: activityMatch[1],
    debuggable: /^application-debuggable$/m.test(output),
    nativeCode: nativeCodeMatch
      ? [...nativeCodeMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
      : [],
  };
}

function inspectApk(aapt, apksigner, apkPath) {
  const badging = runCommand(aapt, ['dump', 'badging', apkPath], {
    redact: [apkPath],
  }).stdout;
  const metadata = parseApkBadging(badging);
  if (metadata.packageName !== PACKAGE_NAME) {
    throw new ProfileError(
      'PACKAGE_MISMATCH',
      `Expected ${PACKAGE_NAME}, found ${metadata.packageName}. Nothing was installed.`
    );
  }
  if (
    metadata.launcherActivity !== `${PACKAGE_NAME}.MainActivity` &&
    !metadata.launcherActivity.startsWith(`${PACKAGE_NAME}.`)
  ) {
    throw new ProfileError(
      'ACTIVITY_MISMATCH',
      `Launcher activity ${metadata.launcherActivity} is outside ${PACKAGE_NAME}.`
    );
  }
  if (metadata.debuggable) {
    throw new ProfileError(
      'DEBUGGABLE_APK',
      'The APK is debuggable; use a signed release APK for representative profiling.'
    );
  }

  let signature;
  try {
    signature = runCommand(
      apksigner,
      ['verify', '--verbose', '--print-certs', apkPath],
      { timeoutMs: 60_000, redact: [apkPath] }
    ).stdout;
  } catch {
    throw new ProfileError(
      'APK_SIGNATURE_INVALID',
      'APK signature verification failed. Nothing was installed.'
    );
  }
  const signerCount = Number(signature.match(/^Number of signers: (\d+)$/m)?.[1] ?? 0);
  const signerSha256 = signature.match(
    /^Signer #1 certificate SHA-256 digest: ([a-fA-F0-9]+)$/m
  )?.[1];
  if (!signerCount || !signerSha256) {
    throw new ProfileError('UNSIGNED_APK', 'APK signature verification returned no signer.');
  }

  const verifiedSchemes = Object.fromEntries(
    [...signature.matchAll(/^Verified using (.+?): (true|false)$/gm)].map((match) => [
      match[1],
      match[2] === 'true',
    ])
  );
  return { ...metadata, signerCount, signerSha256, verifiedSchemes };
}

function field(output, name) {
  return output.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1]?.trim();
}

function numericField(output, name) {
  const value = field(output, name);
  if (value === undefined || !/^-?\d+$/.test(value)) return null;
  return Number(value);
}

export function parseStartTiming(output) {
  const status = field(output, 'Status');
  const totalTimeMs = numericField(output, 'TotalTime');
  if (status?.toLowerCase() !== 'ok' || totalTimeMs === null) {
    throw new ProfileError('LAUNCH_FAILED', `Unexpected am start output: ${output.slice(0, 500)}`);
  }
  return {
    status,
    launchState: field(output, 'LaunchState') ?? null,
    activity: field(output, 'Activity') ?? null,
    thisTimeMs: numericField(output, 'ThisTime'),
    totalTimeMs,
    waitTimeMs: numericField(output, 'WaitTime'),
  };
}

export function requireLaunchState(timing, expectedState, runKind, iteration) {
  const actualState = timing.launchState?.toUpperCase() ?? 'MISSING';
  if (actualState !== expectedState) {
    throw new ProfileError(
      'UNEXPECTED_LAUNCH_STATE',
      `${runKind} run ${iteration} expected LaunchState ${expectedState}, received ${actualState}. ` +
        'The sample is not comparable and was not reported.'
    );
  }
  return timing;
}

function matchNumber(output, pattern) {
  const match = output.match(pattern);
  return match ? Number(match[1]) : null;
}

export function parseGfxInfo(output) {
  const totalFramesRendered = matchNumber(output, /Total frames rendered:\s*(\d+)/i);
  const jankyMatch = output.match(/Janky frames(?: \(legacy\))?:\s*(\d+)\s*\(([\d.]+)%\)/i);
  return {
    available: totalFramesRendered !== null,
    totalFramesRendered,
    jankyFrames: jankyMatch ? Number(jankyMatch[1]) : null,
    jankyPercent: jankyMatch ? Number(jankyMatch[2]) : null,
    p50Ms: matchNumber(output, /50th percentile:\s*(\d+)ms/i),
    p90Ms: matchNumber(output, /90th percentile:\s*(\d+)ms/i),
    p95Ms: matchNumber(output, /95th percentile:\s*(\d+)ms/i),
    p99Ms: matchNumber(output, /99th percentile:\s*(\d+)ms/i),
    missedVsync: matchNumber(output, /Number Missed Vsync:\s*(\d+)/i),
    highInputLatency: matchNumber(output, /Number High input latency:\s*(\d+)/i),
    slowUiThread: matchNumber(output, /Number Slow UI thread:\s*(\d+)/i),
    slowBitmapUploads: matchNumber(output, /Number Slow bitmap uploads:\s*(\d+)/i),
    slowIssueDrawCommands: matchNumber(output, /Number Slow issue draw commands:\s*(\d+)/i),
  };
}

function sumComplete(metrics, key) {
  if (!metrics.length || metrics.some((metric) => !Number.isFinite(metric[key]))) return null;
  return metrics.reduce((sum, metric) => sum + metric[key], 0);
}

export function summarizeGraphics(samples) {
  const metrics = samples.map((sample) => sample.graphics).filter((metric) => metric?.available);
  const totalFramesRendered = sumComplete(metrics, 'totalFramesRendered');
  const jankyFrames = sumComplete(metrics, 'jankyFrames');
  return {
    scope: 'sum of independently reset per-run graphics counters',
    runsRequested: samples.length,
    runsWithGraphics: metrics.length,
    totalFramesRendered,
    jankyFrames,
    jankyPercent:
      totalFramesRendered > 0 && jankyFrames !== null
        ? Number(((jankyFrames / totalFramesRendered) * 100).toFixed(2))
        : null,
    missedVsync: sumComplete(metrics, 'missedVsync'),
    highInputLatency: sumComplete(metrics, 'highInputLatency'),
    slowUiThread: sumComplete(metrics, 'slowUiThread'),
    slowBitmapUploads: sumComplete(metrics, 'slowBitmapUploads'),
    slowIssueDrawCommands: sumComplete(metrics, 'slowIssueDrawCommands'),
    percentileScope: 'per-run-only',
  };
}

function percentile(sorted, value) {
  if (!sorted.length) return null;
  const index = Math.max(0, Math.ceil((value / 100) * sorted.length) - 1);
  return sorted[index];
}

export function summarizeTimings(samples) {
  const values = samples.map((sample) => sample.totalTimeMs).sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const middle = Math.floor(values.length / 2);
  const median =
    values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
  return {
    count: values.length,
    minMs: values[0],
    maxMs: values.at(-1),
    meanMs: Number(mean.toFixed(1)),
    medianMs: Number(median.toFixed(1)),
    p90Ms: percentile(values, 90),
    p95Ms: percentile(values, 95),
  };
}

function delay(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function launch(adb, serial, component) {
  const output = adbFor(adb, serial, [
    'shell',
    'am',
    'start',
    '-W',
    '-n',
    component,
  ]).stdout;
  return parseStartTiming(output);
}

function resetGraphics(adb, serial) {
  adbFor(adb, serial, ['shell', 'dumpsys', 'gfxinfo', PACKAGE_NAME, 'reset']);
}

function readGraphics(adb, serial, settleMs) {
  delay(settleMs);
  return parseGfxInfo(
    adbFor(adb, serial, ['shell', 'dumpsys', 'gfxinfo', PACKAGE_NAME]).stdout
  );
}

function collectStartups(adb, serial, component, options) {
  const coldSamples = [];
  for (let iteration = 1; iteration <= options.coldRuns; iteration += 1) {
    adbFor(adb, serial, ['shell', 'am', 'force-stop', PACKAGE_NAME]);
    delay(options.settleMs);
    resetGraphics(adb, serial);
    const timing = requireLaunchState(
      launch(adb, serial, component),
      'COLD',
      'Cold',
      iteration
    );
    coldSamples.push({
      iteration,
      capturedAt: new Date().toISOString(),
      ...timing,
      graphics: readGraphics(adb, serial, options.settleMs),
    });
  }

  const hotSamples = [];
  for (let iteration = 1; iteration <= options.hotRuns; iteration += 1) {
    adbFor(adb, serial, ['shell', 'input', 'keyevent', 'KEYCODE_HOME']);
    delay(options.settleMs);
    resetGraphics(adb, serial);
    const timing = requireLaunchState(
      launch(adb, serial, component),
      'HOT',
      'Hot',
      iteration
    );
    hotSamples.push({
      iteration,
      capturedAt: new Date().toISOString(),
      ...timing,
      graphics: readGraphics(adb, serial, options.settleMs),
    });
  }
  return {
    cold: { samples: coldSamples, summary: summarizeTimings(coldSamples) },
    hot: { samples: hotSamples, summary: summarizeTimings(hotSamples) },
  };
}

function readApkFileIdentity(apkPath) {
  try {
    const stats = statSync(apkPath);
    if (!stats.isFile()) throw new Error('not a file');
    return {
      fileName: basename(apkPath),
      bytes: stats.size,
      sha256: createHash('sha256').update(readFileSync(apkPath)).digest('hex'),
    };
  } catch {
    throw new ProfileError(
      'APK_NOT_FOUND',
      'The APK could not be read. Provide an absolute path to an existing file.'
    );
  }
}

function deviceDetails(device, properties) {
  return {
    serialSha256: createHash('sha256').update(device.serial).digest('hex'),
    manufacturer: properties['ro.product.manufacturer'] ?? null,
    model: properties['ro.product.model'] ?? device.metadata.model ?? null,
    device: properties['ro.product.device'] ?? device.metadata.device ?? null,
    androidRelease: properties['ro.build.version.release'] ?? null,
    sdkLevel: properties['ro.build.version.sdk']
      ? Number(properties['ro.build.version.sdk'])
      : null,
    primaryAbi: properties['ro.product.cpu.abi'] ?? null,
  };
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function profile(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const apkPath = resolve(options.apk);
  if (!isAbsolute(options.apk) || !existsSync(apkPath)) {
    throw new ProfileError('APK_NOT_FOUND', '--apk must be an absolute path to an existing file.');
  }
  const apkFile = readApkFileIdentity(apkPath);

  const adb = resolveTool('adb', options.adb, 'adb');
  const aapt = resolveTool('aapt', options.aapt, 'aapt');
  const apksigner = resolveTool('apksigner', options.apksigner, 'apksigner');

  // APK validation deliberately happens before any install command.
  const apk = inspectApk(aapt, apksigner, apkPath);
  const listedDevices = parseAdbDevices(runCommand(adb, ['devices', '-l']).stdout);
  const propertyCache = new Map();
  const selected = selectDevice(listedDevices, options.serial, (device) => {
    if (looksLikeEmulator(device)) return true;
    const properties = getDeviceProperties(adb, device.serial);
    propertyCache.set(device.serial, properties);
    return runtimeLooksLikeEmulator(properties);
  });
  const properties = propertyCache.get(selected.serial) ?? getDeviceProperties(adb, selected.serial);
  if (runtimeLooksLikeEmulator(properties)) {
    throw new ProfileError('EMULATOR_REJECTED', 'This profiler only accepts physical devices.');
  }

  const installOutput = adbFor(adb, selected.serial, ['install', '-r', apkPath], {
    timeoutMs: 180_000,
    redact: [apkPath],
  }).stdout;
  if (!/\bSuccess\b/.test(installOutput)) {
    throw new ProfileError('INSTALL_FAILED', `adb install did not report success: ${installOutput}`);
  }

  const installedPath = adbFor(adb, selected.serial, ['shell', 'pm', 'path', PACKAGE_NAME]).stdout;
  if (!installedPath.startsWith('package:')) {
    throw new ProfileError('INSTALL_FAILED', `${PACKAGE_NAME} is not installed after adb install.`);
  }

  const component = `${PACKAGE_NAME}/${apk.launcherActivity}`;
  const startup = collectStartups(adb, selected.serial, component, options);

  emit({
    schemaVersion: 1,
    status: 'ok',
    generatedAt: new Date().toISOString(),
    safety: {
      preservesAppData: true,
      clearsAppData: false,
      grantsPermissions: false,
      changesCompilationMode: false,
      operations: [
        'adb install -r',
        'am force-stop',
        'am start',
        'KEYCODE_HOME',
        'dumpsys gfxinfo reset/read',
      ],
    },
    app: {
      packageName: apk.packageName,
      launcherActivity: apk.launcherActivity,
      versionCode: apk.versionCode,
      versionName: apk.versionName,
      debuggable: apk.debuggable,
      nativeCode: apk.nativeCode,
      apkFileName: apkFile.fileName,
      apkBytes: apkFile.bytes,
      apkSha256: apkFile.sha256,
      signerCount: apk.signerCount,
      signerSha256: apk.signerSha256,
      verifiedSchemes: apk.verifiedSchemes,
    },
    device: deviceDetails(selected, properties),
    install: {
      result: 'Success',
      replacementInstall: true,
      preservesExistingData: true,
    },
    startup: {
      configuration: {
        coldRuns: options.coldRuns,
        hotRuns: options.hotRuns,
        settleMs: options.settleMs,
        coldDefinition: 'force-stop followed by explicit activity launch',
        hotDefinition: 'Home followed by explicit activity resume without force-stop',
      },
      ...startup,
    },
    graphics: {
      scope: 'startup runs with counters reset immediately before each launch',
      cold: summarizeGraphics(startup.cold.samples),
      hot: summarizeGraphics(startup.hot.samples),
      combined: summarizeGraphics([...startup.cold.samples, ...startup.hot.samples]),
    },
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  profile(process.argv.slice(2)).catch((error) => {
    emit({
      schemaVersion: 1,
      status: 'error',
      generatedAt: new Date().toISOString(),
      error: {
        code: error instanceof ProfileError ? error.code : 'UNEXPECTED_ERROR',
        message: error instanceof Error ? error.message : String(error),
      },
    });
    process.exitCode = 1;
  });
}
