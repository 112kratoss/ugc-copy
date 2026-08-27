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
 * The provider reports no progress, only `waiting` → `processing`, so a
 * determinate bar would have to be invented. What can be told truthfully is
 * *which* of those two states the run is in, and how long it has been in them —
 * which is the information the rule is actually asking for. HIG *Generative AI*
 * asks the same thing in its own words: "instead of 'Processing…', say 'Finding
 * substitutions for ingredients'."
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
