import { describe, expect, it } from 'vitest';

import {
  buildGenerationModelCatalog,
  quoteGenerationModel,
} from '@/lib/generation-model-catalog';

/**
 * Regression guard for a live break: attaching Kling video elements made every quote
 * fail with "Video elements is unavailable with the selected settings."
 *
 * The create-video surface reported `slots.videoElements.count` unconditionally while
 * the `videoElements` slot was declared inside the elements-conditioned "references"
 * input mode — and that surface never puts Kling into elements mode, so the slot was
 * never active and the leftover-slot check rejected the run.
 *
 * This exercises the REAL quote path on purpose: create-video-client.test.tsx mocks
 * `useWebGenerationModelQuote` wholesale, which is exactly why the break shipped
 * unnoticed. Any future change that makes the surface's slot metadata disagree with the
 * descriptor's active slots fails here.
 */

const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });

function quoteKling(slots: Record<string, { count: number }>, referenceMode: string) {
  return quoteGenerationModel({
    kind: 'video',
    modelId: 'kling-3.0-video',
    settings: {
      mode: 'std',
      aspectRatio: '16:9',
      duration: 5,
      sound: false,
      referenceMode,
    },
    inputCounts: { images: 0, videos: 0, audios: 0 },
    inputMetadata: { slots },
    catalogRevision: catalog.revision,
  }, { catalog });
}

describe('kling video elements quote', () => {
  it('accepts a run that reports the video elements the surface actually sends', () => {
    // The surface's own reference mode for Kling. Whatever count it reports here must
    // be quotable — if it is not, the user cannot generate at all.
    expect(() => quoteKling({ videoElements: { count: 1 } }, 'frames')).not.toThrow();
  });

  it('still accepts a plain frames run with no elements', () => {
    expect(() => quoteKling({ startFrame: { count: 1 } }, 'frames')).not.toThrow();
  });

  it('quotes video elements when the slot is active', () => {
    expect(() => quoteKling({ videoElements: { count: 2 } }, 'elements')).not.toThrow();
  });
});
