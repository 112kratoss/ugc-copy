/**
 * Where a creator's run is, as its canvas says it (the artboards Main, Generating, Failed
 * and Result): one reading of the page's run state for the image, video and motion creators,
 * which drew their canvas from the same four facts in three copies.
 *
 * - `done`: the run's result is on the canvas;
 * - `generating`: a run the page started, or picked up, is at work;
 * - `background`: a run that is taking long is being finished on the server;
 * - `failed`: the last run did not finish and nothing else is going on;
 * - `empty`: nothing yet.
 */
export type CreatorCanvasPhase = 'empty' | 'generating' | 'background' | 'failed' | 'done';

export function creatorCanvasPhase(run: {
  hasResult: boolean;
  isGenerating: boolean;
  isBackgroundProcessing: boolean;
  hasFailure: boolean;
}): CreatorCanvasPhase {
  if (run.hasResult) return 'done';
  if (run.isGenerating) return 'generating';
  if (run.isBackgroundProcessing) return 'background';
  return run.hasFailure ? 'failed' : 'empty';
}

/** How the run ended, where the canvas shows it end: what the page tells the shell's run toasts. */
export function creatorCanvasSettledStatus(phase: CreatorCanvasPhase): 'succeeded' | 'failed' | null {
  if (phase === 'done') return 'succeeded';
  return phase === 'failed' ? 'failed' : null;
}

/**
 * The canvas's heading: "Done", the tool's words for a run at work ("Making your video") and
 * for its place before a result ("Your video"), and "It didn’t finish".
 */
export function creatorCanvasTitle(phase: CreatorCanvasPhase, words: { making: string; waiting: string }): string {
  switch (phase) {
    case 'done':
      return 'Done';
    case 'generating':
      return words.making;
    case 'failed':
      return 'It didn’t finish';
    default:
      return words.waiting;
  }
}
