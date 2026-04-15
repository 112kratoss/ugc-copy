import { isAudioModel, isImageModel, isMotionModel } from '@/lib/models';

export type GenerationKind = 'image' | 'video' | 'motion' | 'audio';
export type GenerationAppStatus = 'processing' | 'waiting' | 'succeeded' | 'failed';
export type GenerationProviderState = 'waiting' | 'queuing' | 'generating' | 'success' | 'fail' | null;

export interface GenerationTiming {
  appStatus: GenerationAppStatus;
  providerState: GenerationProviderState;
  phaseLabel: string;
  startedAtMs: number | null;
  updatedAtMs: number | null;
  completedAtMs: number | null;
  elapsedMs: number | null;
  completedInMs: number | null;
}

type TimingDescriptor = {
  category?: string | null;
  model?: string | null;
};

type MarketTaskDetails = {
  state?: unknown;
  createTime?: unknown;
  updateTime?: unknown;
  completeTime?: unknown;
  costTime?: unknown;
};

type VeoTaskDetails = {
  successFlag?: unknown;
  createTime?: unknown;
  completeTime?: unknown;
};

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function normalizeNumericTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * SECOND_MS;
  }

  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (!Number.isNaN(numeric)) {
      return numeric > 1e12 ? numeric : numeric * SECOND_MS;
    }
  }

  return null;
}

function normalizeStringTimestamp(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const numeric = normalizeNumericTimestamp(trimmed);
  if (numeric !== null) {
    return numeric;
  }

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    const asUtc = Date.parse(`${trimmed.replace(' ', 'T')}Z`);
    if (!Number.isNaN(asUtc)) {
      return asUtc;
    }
  }

  const direct = Date.parse(trimmed);
  if (!Number.isNaN(direct)) {
    return direct;
  }

  return null;
}

export function parseProviderTimestamp(value: unknown): number | null {
  if (typeof value === 'string') {
    return normalizeStringTimestamp(value);
  }

  return normalizeNumericTimestamp(value);
}

function normalizeDurationMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 0 ? value : null;
  }

  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
  }

  return null;
}

export function getGenerationKind(descriptor: TimingDescriptor): GenerationKind {
  if (descriptor.category === 'image') {
    return 'image';
  }

  if (descriptor.category === 'motion') {
    return 'motion';
  }

  if (descriptor.category === 'audio') {
    return 'audio';
  }

  if (descriptor.model) {
    if (isImageModel(descriptor.model)) {
      return 'image';
    }

    if (isMotionModel(descriptor.model)) {
      return 'motion';
    }

    if (isAudioModel(descriptor.model)) {
      return 'audio';
    }
  }

  return 'video';
}

function getReadyLabel(kind: GenerationKind): string {
  switch (kind) {
    case 'image':
      return 'Image ready';
    case 'motion':
      return 'Motion render ready';
    case 'audio':
      return 'Audio ready';
    default:
      return 'Video ready';
  }
}

function getFailedLabel(kind: GenerationKind): string {
  switch (kind) {
    case 'image':
      return 'Image failed';
    case 'motion':
      return 'Motion render failed';
    case 'audio':
      return 'Audio failed';
    default:
      return 'Video failed';
  }
}

function getGeneratingLabel(kind: GenerationKind): string {
  switch (kind) {
    case 'image':
      return 'Generating image';
    case 'motion':
      return 'Generating motion render';
    case 'audio':
      return 'Generating audio';
    default:
      return 'Generating video';
  }
}

function getAppStatusFromProviderState(providerState: GenerationProviderState): GenerationAppStatus {
  if (providerState === 'success') {
    return 'succeeded';
  }

  if (providerState === 'fail') {
    return 'failed';
  }

  if (providerState === 'waiting' || providerState === 'queuing') {
    return 'waiting';
  }

  return 'processing';
}

function coerceProviderState(value: unknown): GenerationProviderState {
  if (
    value === 'waiting' ||
    value === 'queuing' ||
    value === 'generating' ||
    value === 'success' ||
    value === 'fail'
  ) {
    return value;
  }

  return null;
}

export function getPhaseLabelForTiming(params: {
  kind: GenerationKind;
  appStatus: GenerationAppStatus;
  providerState: GenerationProviderState;
}): string {
  const { kind, appStatus, providerState } = params;

  if (providerState === 'waiting') {
    return 'Waiting for provider';
  }

  if (providerState === 'queuing') {
    return 'Queued at provider';
  }

  if (providerState === 'generating') {
    return getGeneratingLabel(kind);
  }

  if (providerState === 'success' || appStatus === 'succeeded') {
    return getReadyLabel(kind);
  }

  if (providerState === 'fail' || appStatus === 'failed') {
    return getFailedLabel(kind);
  }

  if (appStatus === 'waiting') {
    return 'Waiting for provider';
  }

  return getGeneratingLabel(kind);
}

function buildGenerationTiming(params: {
  kind: GenerationKind;
  appStatus: GenerationAppStatus;
  providerState: GenerationProviderState;
  startedAtMs?: number | null;
  updatedAtMs?: number | null;
  completedAtMs?: number | null;
  completedInMs?: number | null;
  phaseLabel?: string | null;
  nowMs?: number;
}): GenerationTiming {
  const nowMs = params.nowMs ?? Date.now();
  const startedAtMs = params.startedAtMs ?? null;
  const completedAtMs = params.completedAtMs ?? null;
  const completedInMs =
    params.completedInMs ??
    (startedAtMs !== null && completedAtMs !== null ? Math.max(0, completedAtMs - startedAtMs) : null);
  const elapsedMs =
    params.appStatus === 'succeeded' || params.appStatus === 'failed'
      ? completedInMs
      : startedAtMs !== null
        ? Math.max(0, nowMs - startedAtMs)
        : null;

  return {
    appStatus: params.appStatus,
    providerState: params.providerState,
    phaseLabel:
      params.phaseLabel?.trim() ||
      getPhaseLabelForTiming({
        kind: params.kind,
        appStatus: params.appStatus,
        providerState: params.providerState,
      }),
    startedAtMs,
    updatedAtMs: params.updatedAtMs ?? completedAtMs ?? null,
    completedAtMs,
    elapsedMs,
    completedInMs,
  };
}

export function createLocalGenerationTiming(params: {
  kind: GenerationKind;
  phaseLabel: string;
  startedAtMs?: number;
  appStatus?: GenerationAppStatus;
  nowMs?: number;
}): GenerationTiming {
  return buildGenerationTiming({
    kind: params.kind,
    appStatus: params.appStatus ?? 'processing',
    providerState: null,
    phaseLabel: params.phaseLabel,
    startedAtMs: params.startedAtMs ?? (params.nowMs ?? Date.now()),
    nowMs: params.nowMs,
  });
}

export function normalizeStoredGenerationTiming(params: {
  kind: GenerationKind;
  status: string | null | undefined;
  createdAt?: unknown;
  completedAt?: unknown;
  nowMs?: number;
}): GenerationTiming {
  const providerState = coerceProviderState(params.status);
  const appStatus =
    params.status === 'succeeded' || params.status === 'success'
      ? 'succeeded'
      : params.status === 'failed' || params.status === 'fail'
        ? 'failed'
        : params.status === 'waiting'
          ? 'waiting'
          : providerState
            ? getAppStatusFromProviderState(providerState)
            : 'processing';

  return buildGenerationTiming({
    kind: params.kind,
    appStatus,
    providerState,
    startedAtMs: parseProviderTimestamp(params.createdAt),
    completedAtMs: parseProviderTimestamp(params.completedAt),
    nowMs: params.nowMs,
  });
}

export function normalizeMarketGenerationTiming(params: {
  kind: GenerationKind;
  task: MarketTaskDetails | null | undefined;
  fallbackStartedAtMs?: number | null;
  nowMs?: number;
}): GenerationTiming {
  const providerState = coerceProviderState(params.task?.state);

  return buildGenerationTiming({
    kind: params.kind,
    appStatus: getAppStatusFromProviderState(providerState),
    providerState,
    startedAtMs: parseProviderTimestamp(params.task?.createTime) ?? params.fallbackStartedAtMs ?? null,
    updatedAtMs: parseProviderTimestamp(params.task?.updateTime) ?? parseProviderTimestamp(params.task?.completeTime),
    completedAtMs: parseProviderTimestamp(params.task?.completeTime),
    completedInMs: normalizeDurationMs(params.task?.costTime),
    nowMs: params.nowMs,
  });
}

export function normalizeVeoGenerationTiming(params: {
  kind: GenerationKind;
  task: VeoTaskDetails | null | undefined;
  fallbackStartedAtMs?: number | null;
  nowMs?: number;
}): GenerationTiming {
  const successFlag = Number(params.task?.successFlag);
  const providerState: GenerationProviderState =
    successFlag === 1 ? 'success' : successFlag === 2 || successFlag === 3 ? 'fail' : 'generating';
  const startedAtMs = parseProviderTimestamp(params.task?.createTime) ?? params.fallbackStartedAtMs ?? null;
  const completedAtMs = parseProviderTimestamp(params.task?.completeTime);

  return buildGenerationTiming({
    kind: params.kind,
    appStatus: getAppStatusFromProviderState(providerState),
    providerState,
    startedAtMs,
    updatedAtMs: completedAtMs,
    completedAtMs,
    completedInMs:
      startedAtMs !== null && completedAtMs !== null ? Math.max(0, completedAtMs - startedAtMs) : null,
    nowMs: params.nowMs,
  });
}

export function freezeGenerationTiming(timing: GenerationTiming, nowMs = Date.now()): GenerationTiming {
  const elapsedMs =
    timing.completedInMs ??
    (timing.startedAtMs !== null ? Math.max(0, nowMs - timing.startedAtMs) : timing.elapsedMs);

  return {
    ...timing,
    elapsedMs,
    completedInMs: timing.completedInMs ?? elapsedMs ?? null,
  };
}

export function getGenerationTimingSummaryLabel(timing: GenerationTiming, nowMs = Date.now()): string | null {
  if (timing.completedInMs !== null) {
    return `Completed in ${formatDurationShort(timing.completedInMs)}`;
  }

  const elapsedMs =
    timing.elapsedMs ??
    (timing.startedAtMs !== null ? Math.max(0, nowMs - timing.startedAtMs) : null);

  if (elapsedMs === null) {
    return null;
  }

  return `Elapsed ${formatElapsedClock(elapsedMs)}`;
}

export function formatElapsedClock(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / SECOND_MS));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatDurationShort(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / SECOND_MS));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }

  return `${seconds}s`;
}

export function formatTimeAgoShort(timestampMs: number, nowMs = Date.now()): string {
  const delta = Math.max(0, nowMs - timestampMs);

  if (delta < MINUTE_MS) {
    return `${Math.max(1, Math.floor(delta / SECOND_MS))}s ago`;
  }

  if (delta < HOUR_MS) {
    return `${Math.floor(delta / MINUTE_MS)}m ago`;
  }

  if (delta < DAY_MS) {
    return `${Math.floor(delta / HOUR_MS)}h ago`;
  }

  return `${Math.floor(delta / DAY_MS)}d ago`;
}

export function toIsoTimestamp(timestampMs: number | null): string | null {
  if (timestampMs === null) {
    return null;
  }

  return new Date(timestampMs).toISOString();
}
