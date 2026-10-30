import { describe, expect, it } from 'vitest';

import { creatorCanvasChip } from '@/components/CreatorColumn';
import { creatorCanvasPhase, creatorCanvasSettledStatus, creatorCanvasTitle, type CreatorCanvasPhase } from '@/lib/creator-canvas-phase';

const quiet = { hasResult: false, isGenerating: false, isBackgroundProcessing: false, hasFailure: false };
const WORDS = { making: 'Making your video', waiting: 'Your video' };

describe('creatorCanvasPhase', () => {
  it('reads the four facts in the order the canvases drew them', () => {
    expect(creatorCanvasPhase(quiet)).toBe('empty');
    expect(creatorCanvasPhase({ ...quiet, hasFailure: true })).toBe('failed');
    // A run finishing on the server outranks the last run's failure.
    expect(creatorCanvasPhase({ ...quiet, hasFailure: true, isBackgroundProcessing: true })).toBe('background');
    expect(creatorCanvasPhase({ ...quiet, isBackgroundProcessing: true, isGenerating: true })).toBe('generating');
    // A result on the canvas outranks a run starting after it.
    expect(creatorCanvasPhase({ hasResult: true, isGenerating: true, isBackgroundProcessing: true, hasFailure: true })).toBe('done');
  });
});

describe('creatorCanvasTitle and creatorCanvasChip', () => {
  const cases: Array<[CreatorCanvasPhase, string, string | null]> = [
    ['empty', 'Your video', null],
    ['generating', 'Making your video', 'Seedance 2 Mini · 480P · 5s · 19 credits'],
    ['background', 'Your video', null],
    ['failed', 'It didn’t finish', 'Seedance 2 Mini · 480P · 5s'],
    ['done', 'Done', 'Seedance 2 Mini · 480P · 5s · 19 credits'],
  ];

  it.each(cases)('%s says “%s” with the chip %s', (phase, title, chip) => {
    expect(creatorCanvasTitle(phase, WORDS)).toBe(title);
    expect(creatorCanvasChip(phase, 'Seedance 2 Mini · 480P · 5s', 19)).toBe(chip);
  });
});

// What a creator tells the shell's run toasts (`useAnnounceRunSettledOnPage`): only a run whose end
// the canvas shows, so a run still at work, or left to the server, keeps its toast.
describe('creatorCanvasSettledStatus', () => {
  it.each<[CreatorCanvasPhase, 'succeeded' | 'failed' | null]>([
    ['done', 'succeeded'],
    ['failed', 'failed'],
    ['generating', null],
    ['background', null],
    ['empty', null],
  ])('%s → %s', (phase, status) => {
    expect(creatorCanvasSettledStatus(phase)).toBe(status);
  });
});
