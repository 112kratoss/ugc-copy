/**
 * Fleet playback metrics: what each session saw of video start-up and stalls,
 * aggregated on the phone and sent as a few hundred bytes a few times per
 * session (`/api/mobile/playback-metrics`).
 *
 * The delivery plan (docs/plans/social-media-delivery-final-plan-2026-09-19.md)
 * gates its remaining decisions — a preparation scheduler, a second rendition
 * for weak cellular — on start-up and rebuffering numbers that two phones on a
 * desk cannot give. This is the same session-level aggregation the large feeds
 * run: no per-play rows, a bounded reservoir of start times for percentiles,
 * counters for the rest. Nothing identifying travels: no user, no media, no
 * address — a random session id, the app version, the platform and the
 * network kind.
 *
 * `cold` starts are players that had no frame when asked to play; `warm` ones
 * had one (a prepared neighbour, a tile's player carried into the reel). A
 * start is the time from the request to the first sign of motion — the first
 * rendered frame or the player reporting that it is playing, whichever the
 * surface sees first. A stall is `loading` after motion has been shown.
 */

export type PlaybackSurface = 'feed' | 'viewer';
export type PlaybackStartKind = 'cold' | 'warm';
export type PlaybackNetwork = 'wifi' | 'cellular' | 'none' | 'other' | 'unknown';

/** Longer than this is an abandoned load, not a start. */
export const PLAYBACK_START_LIMIT_MS = 30_000;
/** A stall that outlives this is counted at the cap: the reader has left by then. */
export const PLAYBACK_STALL_LIMIT_MS = 60_000;
/** Start times kept per bucket for percentiles, reservoir-sampled so the sample stays unbiased. */
export const PLAYBACK_METRICS_SAMPLE_LIMIT = 32;
export const PLAYBACK_METRICS_FLUSH_INTERVAL_MS = 10 * 60_000;
export const PLAYBACK_METRICS_REPORTS_PER_SESSION = 12;

export type PlaybackMetricsBucket = {
  surface: PlaybackSurface;
  kind: PlaybackStartKind;
  starts: number;
  startTotalMs: number;
  startMaxMs: number;
  samples: number[];
  stalls: number;
  stallTotalMs: number;
  stallMaxMs: number;
};

export type PlaybackMetricsReport = {
  sessionId: string;
  app: { version: string | null; build: string | null; update: string | null };
  device: { platform: 'ios' | 'android'; os: string; model: string | null; network: PlaybackNetwork };
  /** Milliseconds of the session this report covers. */
  spanMs: number;
  buckets: PlaybackMetricsBucket[];
};

export type PlaybackMetricsReporter = {
  send: (report: PlaybackMetricsReport) => Promise<unknown>;
  app: () => PlaybackMetricsReport['app'];
  device: () => Omit<PlaybackMetricsReport['device'], 'network'>;
  network: () => Promise<PlaybackNetwork>;
  /** Calls back when the app leaves the foreground; returns the unsubscribe. */
  subscribeToBackground: (onBackground: () => void) => () => void;
  /** Sampling for the reservoir; injectable so tests are deterministic. */
  random?: () => number;
};

type PendingStart = { at: number; surface: PlaybackSurface; kind: PlaybackStartKind };
type PendingStall = { at: number; surface: PlaybackSurface; kind: PlaybackStartKind };

const session = {
  id: createSessionId(),
  startedAt: Date.now(),
  spanFrom: Date.now(),
};

const buckets = new Map<string, PlaybackMetricsBucket>();
const pendingStarts = new Map<string, PendingStart>();
const pendingStalls = new Map<string, PendingStall>();
/** The bucket a key's last completed start went to: its stalls go there too. */
const playbackOf = new Map<string, { surface: PlaybackSurface; kind: PlaybackStartKind }>();

const reporting = {
  reporter: null as PlaybackMetricsReporter | null,
  timer: null as ReturnType<typeof setInterval> | null,
  unsubscribeBackground: null as (() => void) | null,
  sentReports: 0,
};

function createSessionId() {
  const random = globalThis.crypto?.randomUUID?.();
  return (random ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).slice(0, 13);
}

function bucketFor(surface: PlaybackSurface, kind: PlaybackStartKind) {
  const id = `${surface}:${kind}`;
  let bucket = buckets.get(id);
  if (!bucket) {
    bucket = { surface, kind, starts: 0, startTotalMs: 0, startMaxMs: 0, samples: [], stalls: 0, stallTotalMs: 0, stallMaxMs: 0 };
    buckets.set(id, bucket);
  }
  return bucket;
}

/**
 * A playback request: the surface asked `key`'s player to show motion. A
 * second request for a key still pending keeps the earlier time — the first
 * ask is what the reader is waiting from.
 */
export function beginPlaybackStart(key: string, at: { surface: PlaybackSurface; kind: PlaybackStartKind }) {
  if (pendingStarts.has(key)) return;
  pendingStarts.set(key, { at: Date.now(), surface: at.surface, kind: at.kind });
}

/** Motion was shown for `key`. A key with no pending start is ignored: a loop restart, a repeated event. */
export function completePlaybackStart(key: string) {
  const pending = pendingStarts.get(key);
  if (!pending) return;
  pendingStarts.delete(key);
  playbackOf.set(key, { surface: pending.surface, kind: pending.kind });
  const elapsed = Date.now() - pending.at;
  if (elapsed < 0 || elapsed > PLAYBACK_START_LIMIT_MS) return;
  const bucket = bucketFor(pending.surface, pending.kind);
  bucket.starts += 1;
  bucket.startTotalMs += elapsed;
  bucket.startMaxMs = Math.max(bucket.startMaxMs, elapsed);
  // Reservoir sampling (Algorithm R): every start has the same chance of being
  // in the sample however many there are.
  if (bucket.samples.length < PLAYBACK_METRICS_SAMPLE_LIMIT) {
    bucket.samples.push(elapsed);
  } else {
    const random = reporting.reporter?.random ?? Math.random;
    const slot = Math.floor(random() * bucket.starts);
    if (slot < PLAYBACK_METRICS_SAMPLE_LIMIT) bucket.samples[slot] = elapsed;
  }
}

/** The request for `key` was withdrawn (scrolled away, unmounted) before motion: not a start, not a failure. */
export function cancelPlaybackStart(key: string) {
  pendingStarts.delete(key);
}

/** `key`'s player went back to loading after it had shown motion. */
export function beginPlaybackStall(key: string) {
  if (pendingStalls.has(key)) return;
  const playback = playbackOf.get(key);
  if (!playback) return;
  pendingStalls.set(key, { at: Date.now(), surface: playback.surface, kind: playback.kind });
}

/** `key`'s player is playing again, or is gone: the stall ends here either way. */
export function endPlaybackStall(key: string) {
  const pending = pendingStalls.get(key);
  if (!pending) return;
  pendingStalls.delete(key);
  const elapsed = Math.min(Math.max(0, Date.now() - pending.at), PLAYBACK_STALL_LIMIT_MS);
  const bucket = bucketFor(pending.surface, pending.kind);
  bucket.stalls += 1;
  bucket.stallTotalMs += elapsed;
  bucket.stallMaxMs = Math.max(bucket.stallMaxMs, elapsed);
}

/** `key` is finished with: nothing pending on it is recorded. */
export function forgetPlayback(key: string) {
  pendingStarts.delete(key);
  pendingStalls.delete(key);
  playbackOf.delete(key);
}

function hasMetrics() {
  for (const bucket of buckets.values()) {
    if (bucket.starts > 0 || bucket.stalls > 0) return true;
  }
  return false;
}

/**
 * Sends what has accumulated since the last flush and starts over. Nothing is
 * sent for an empty span, after `PLAYBACK_METRICS_REPORTS_PER_SESSION`, or
 * while no reporter is registered; a send that fails is dropped, never retried.
 */
export function flushPlaybackMetrics() {
  const reporter = reporting.reporter;
  if (!reporter || !hasMetrics() || reporting.sentReports >= PLAYBACK_METRICS_REPORTS_PER_SESSION) return;
  reporting.sentReports += 1;
  const now = Date.now();
  const report = {
    sessionId: session.id,
    app: reporter.app(),
    device: reporter.device(),
    spanMs: Math.max(0, now - session.spanFrom),
    buckets: Array.from(buckets.values()).filter((bucket) => bucket.starts > 0 || bucket.stalls > 0),
  };
  buckets.clear();
  session.spanFrom = now;
  void reporter.network()
    .catch((): PlaybackNetwork => 'unknown')
    .then((network) => reporter.send({ ...report, device: { ...report.device, network } }))
    .catch(() => undefined);
}

/** Registers the sender and the flush triggers; returns the unregister. */
export function setPlaybackMetricsReporter(reporter: PlaybackMetricsReporter) {
  unregister();
  reporting.reporter = reporter;
  reporting.unsubscribeBackground = reporter.subscribeToBackground(flushPlaybackMetrics);
  reporting.timer = setInterval(flushPlaybackMetrics, PLAYBACK_METRICS_FLUSH_INTERVAL_MS);
  return () => {
    if (reporting.reporter !== reporter) return;
    unregister();
  };
}

function unregister() {
  reporting.unsubscribeBackground?.();
  reporting.unsubscribeBackground = null;
  if (reporting.timer) clearInterval(reporting.timer);
  reporting.timer = null;
  reporting.reporter = null;
}

export function readPlaybackMetrics() {
  return {
    sessionId: session.id,
    startedAt: session.startedAt,
    buckets: Array.from(buckets.values()).map((bucket) => ({ ...bucket, samples: bucket.samples.slice() })),
    sentReports: reporting.sentReports,
  };
}

export function clearPlaybackMetricsForTests() {
  unregister();
  buckets.clear();
  pendingStarts.clear();
  pendingStalls.clear();
  playbackOf.clear();
  reporting.sentReports = 0;
  session.spanFrom = Date.now();
}
