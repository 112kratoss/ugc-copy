import { describe, expect, it } from 'vitest';

import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS } from '@/lib/models';
import { SUPPORTED_ENHANCEMENT_MODELS } from '@/lib/prompt-enhancer';
import { estimateGenerationDurationMs } from '@/lib/generation-timing';
import { FALLBACK_SOURCE_TOOLS } from '@/lib/source-tools';
import { buildCodeGenerationModelOperations } from '@/lib/generation-model-runtime';

/**
 * One test that lists what you forgot. Adding a model used to mean remembering
 * ~13 registration spots; the ones with no compile-time or test gate failed
 * silently (no progress bar) or loudly in production (the enhance endpoint
 * returns HTTP 400 for unregistered models). A 2026-08-16 audit found 13 live
 * models missing from the enhancer and timing registries. This suite makes
 * every such gap a named test failure.
 */

const imageIds = Object.keys(IMAGE_MODELS);
const videoIds = Object.keys(VIDEO_MODELS);
const motionIds = Object.keys(MOTION_MODELS);

describe('model registration completeness', () => {
  it.each([...imageIds, ...videoIds, ...motionIds])(
    '%s is registered with the prompt enhancer (missing => enhance endpoint 400s)',
    (id) => {
      expect(SUPPORTED_ENHANCEMENT_MODELS.has(id)).toBe(true);
    },
  );

  it.each(imageIds)('%s has an image duration estimate (missing => no progress bar)', (id) => {
    expect(estimateGenerationDurationMs({ kind: 'image', model: id })).not.toBeNull();
  });

  it.each(videoIds)('%s has a video duration estimate (missing => no progress bar)', (id) => {
    expect(estimateGenerationDurationMs({ kind: 'video', model: id, durationSeconds: 5 })).not.toBeNull();
  });

  it('lists every model in the first-party attribution catalog', () => {
    const magicbooklet = FALLBACK_SOURCE_TOOLS.find((tool) => tool.slug === 'magicbooklet');
    const slugs = new Set((magicbooklet?.models ?? []).map((model) => model.slug));
    const missing = [...imageIds, ...videoIds].filter((id) => !slugs.has(id));
    expect(missing).toEqual([]);
  });

  it('keeps video models off kie-task-v1 until the legacy start path can dispatch them', () => {
    // startImageGeneration dispatches kie-task-v1 operations to the declarative
    // adapter; startVideoGeneration has no such seam yet (no video model needs
    // it — multi-variant payloads are not yet expressible). If this fails you
    // are adding the first declarative video model: build the video dispatch
    // seam first, mirroring the image one in generation-services.ts.
    const videoOperations = buildCodeGenerationModelOperations().filter((op) => op.kind === 'video');
    for (const operation of videoOperations) {
      expect(operation.adapterKey, operation.modelId).toBe('video-v1');
    }
  });
});
