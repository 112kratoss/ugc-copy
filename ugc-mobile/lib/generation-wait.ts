/**
 * What the hero wait says while a generation runs.
 *
 * HIG *Progress indicators*: "If it's helpful, display a description that
 * provides additional context for the task. Be accurate and succinct. Avoid
 * vague terms like loading or authenticating because they seldom add value" —
 * and a determinate indicator earns its place because it "can help people
 * decide whether to do something else while waiting for the task to complete,
 * restart the task at a different time, or abandon the task."
 *
 * The provider reports no progress, only `waiting` → `processing`. What can
 * always be told truthfully is *which* of those two states the run is in, and
 * how long it has been in them — which is the information the rule is actually
 * asking for. HIG *Generative AI* asks the same thing in its own words:
 * "instead of 'Processing…', say 'Finding substitutions for ingredients'."
 *
 * What the server also knows is how long this model usually takes with these
 * settings: the per-prediction status carries that estimate with the run's
 * start (`timing.estimatedTotalMs`, `timing.startedAtMs`), the same estimate the
 * web creator's bar counts down. When both are there, the wait adds a
 * determinate bar and a countdown — "Est. 0:45 left", then "Taking longer than
 * usual" once the estimate has passed — with the bar held short of full until
 * the model answers, because it is an estimate rather than a report of
 * progress. Without them it shows the phase and the time alone.
 */

export type GenerationWaitPhase = 'queued' | 'running';

export function generationWaitPhase(status: string | null | undefined): GenerationWaitPhase {
  return status === 'processing' ? 'running' : 'queued';
}

/**
 * `medium` is the noun the screen already uses for the tool — "image", "video",
 * "motion video" — so the wait names the thing being made rather than the verb
 * being performed.
 */
export function generationWaitTitle(phase: GenerationWaitPhase, medium: string) {
  return phase === 'running' ? `Making your ${medium}` : `Queued with the model`;
}

/** `0` → `0:00`, `95` → `1:35`, `3725` → `62:05`. Minutes are not capped: a long run should look long. */
export function formatElapsed(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`;
}

/**
 * The line under the spinner. It is the only thing on the screen that changes
 * while nothing else does, which is what tells someone the app has not frozen.
 */
export function generationWaitDetail(phase: GenerationWaitPhase, elapsedSeconds: number | null) {
  const elapsed = typeof elapsedSeconds === 'number' ? `Running for ${formatElapsed(elapsedSeconds)}` : null;
  const phaseText = phase === 'running'
    ? 'The model is working on it now.'
    : 'Waiting for the model to pick it up.';
  return elapsed ? `${phaseText} ${elapsed}.` : phaseText;
}

/**
 * The part of the status response's `timing` the wait reads. The server sends
 * `GenerationTiming` (`src/lib/generation-timing.ts`) and the app types the
 * field `unknown`, so each field is taken only when it has the shape that
 * module gives it: a payload that does not reads as no estimate, never as a
 * wrong one.
 */
export type GenerationWaitTiming = {
  appStatus: string | null;
  startedAtMs: number | null;
  estimatedTotalMs: number | null;
  completedInMs: number | null;
};

function positiveNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function readGenerationWaitTiming(value: unknown): GenerationWaitTiming | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const timing = value as Record<string, unknown>;
  const completedInMs = timing.completedInMs;
  return {
    appStatus: typeof timing.appStatus === 'string' ? timing.appStatus : null,
    startedAtMs: positiveNumber(timing.startedAtMs),
    estimatedTotalMs: positiveNumber(timing.estimatedTotalMs),
    completedInMs: typeof completedInMs === 'number' && Number.isFinite(completedInMs) && completedInMs >= 0 ? completedInMs : null,
  };
}

// The web's bounds (`src/lib/generation-timing.ts`): a run just started shows
// some fill, and the bar never reads as done before the model has answered.
const MIN_PROGRESS_PERCENT = 8;
const MAX_ACTIVE_PROGRESS_PERCENT = 96;

/**
 * "Est. 0:45 left" inside the estimate, "Taking longer than usual" past it, and
 * null when there is no estimate to count down or the run has settled. The
 * remaining time rounds up, so the count reads 0:01 rather than 0:00 in its
 * last second.
 */
export function generationWaitCountdownLabel(timing: GenerationWaitTiming | null, nowMs: number | null) {
  if (
    !timing
    || nowMs === null
    || timing.appStatus === 'succeeded'
    || timing.appStatus === 'failed'
    || timing.completedInMs !== null
    || timing.startedAtMs === null
    || timing.estimatedTotalMs === null
  ) {
    return null;
  }
  const remainingMs = timing.estimatedTotalMs - Math.max(0, nowMs - timing.startedAtMs);
  if (remainingMs <= 0) return 'Taking longer than usual';
  return `Est. ${formatElapsed(Math.ceil(remainingMs / 1000))} left`;
}

/** How full the bar is: 8–96 while the run is inside or past its estimate, 100 once it has finished, null without an estimate. */
export function generationWaitProgressPercent(timing: GenerationWaitTiming | null, nowMs: number | null) {
  if (!timing) return null;
  if (timing.completedInMs !== null || timing.appStatus === 'succeeded') return 100;
  if (nowMs === null || timing.startedAtMs === null || timing.estimatedTotalMs === null) return null;
  const progress = (Math.max(0, nowMs - timing.startedAtMs) / timing.estimatedTotalMs) * 100;
  return Math.min(MAX_ACTIVE_PROGRESS_PERCENT, Math.max(MIN_PROGRESS_PERCENT, progress));
}
