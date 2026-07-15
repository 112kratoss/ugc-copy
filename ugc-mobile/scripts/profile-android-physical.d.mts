export interface ProfileOptions {
  apk?: string;
  serial?: string;
  coldRuns: number;
  hotRuns: number;
  settleMs: number;
  adb?: string;
  aapt?: string;
  apksigner?: string;
  help: boolean;
}

export interface AdbDevice {
  serial: string;
  state: string;
  metadata: Record<string, string>;
}

export interface ApkBadging {
  packageName: string;
  versionCode: string;
  versionName: string;
  launcherActivity: string;
  debuggable: boolean;
  nativeCode: string[];
}

export interface StartTiming {
  status: string;
  launchState: string | null;
  activity: string | null;
  thisTimeMs: number | null;
  totalTimeMs: number;
  waitTimeMs: number | null;
}

export interface GraphicsMetrics {
  available: boolean;
  totalFramesRendered: number | null;
  jankyFrames: number | null;
  jankyPercent: number | null;
  p50Ms: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  missedVsync: number | null;
  highInputLatency: number | null;
  slowUiThread: number | null;
  slowBitmapUploads: number | null;
  slowIssueDrawCommands: number | null;
}

export interface TimingSample extends StartTiming {
  iteration?: number;
  capturedAt?: string;
  graphics?: GraphicsMetrics;
}

export function parseArgs(argv: string[]): ProfileOptions;
export function parseAdbDevices(output: string): AdbDevice[];
export function looksLikeEmulator(device: AdbDevice): boolean;
export function selectDevice(
  devices: AdbDevice[],
  requestedSerial?: string,
  emulatorCheck?: (device: AdbDevice) => boolean
): AdbDevice;
export function parseApkBadging(output: string): ApkBadging;
export function parseStartTiming(output: string): StartTiming;
export function requireLaunchState(
  timing: StartTiming,
  expectedState: 'COLD' | 'HOT',
  runKind: string,
  iteration: number
): StartTiming;
export function parseGfxInfo(output: string): GraphicsMetrics;
export function summarizeGraphics(samples: TimingSample[]): {
  scope: string;
  runsRequested: number;
  runsWithGraphics: number;
  totalFramesRendered: number | null;
  jankyFrames: number | null;
  jankyPercent: number | null;
  missedVsync: number | null;
  highInputLatency: number | null;
  slowUiThread: number | null;
  slowBitmapUploads: number | null;
  slowIssueDrawCommands: number | null;
  percentileScope: 'per-run-only';
};
export function summarizeTimings(samples: TimingSample[]): {
  count: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  medianMs: number;
  p90Ms: number;
  p95Ms: number;
};
