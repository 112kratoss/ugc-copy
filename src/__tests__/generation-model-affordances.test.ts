import { describe, expect, it } from 'vitest';

import { buildGenerationModelCatalog } from '@/lib/generation-model-catalog';
import { getVideoInputAffordances, getImageInputAffordances } from '@/lib/generation-model-affordances';
import { VIDEO_MODELS, type VideoModelId } from '@/lib/models';

/**
 * The create surfaces derive every capability gate from the catalog descriptor, falling
 * back to the old hardcoded tables only until the catalog loads. Both paths must answer
 * the same question the same way — otherwise the UI changes shape mid-session, and the
 * per-model tables the fallback still carries could rot unnoticed.
 */

const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
const videoModelIds = Object.keys(VIDEO_MODELS) as VideoModelId[];

function descriptorFor(modelId: string) {
  return catalog.models.find((model) => model.id === modelId);
}

describe('descriptor-driven affordances', () => {
  it.each(videoModelIds)('%s: descriptor and fallback agree on reference capacity', (modelId) => {
    // Veo only permits references in its lite/fast modes; ask both paths the same way.
    const settings = { referenceMode: 'elements', mode: modelId === 'veo-3.1' ? 'veo3_fast' : undefined };
    const fromDescriptor = getVideoInputAffordances(descriptorFor(modelId), modelId, settings);
    const fromFallback = getVideoInputAffordances(null, modelId, settings);

    expect(fromDescriptor.descriptorDriven).toBe(true);
    expect(fromFallback.descriptorDriven).toBe(false);
    expect(fromDescriptor.elements.enabled, `${modelId} elements.enabled`).toBe(fromFallback.elements.enabled);
    expect(fromDescriptor.elements.maxTotal, `${modelId} elements.maxTotal`).toBe(fromFallback.elements.maxTotal);
    expect(fromDescriptor.elements.maxNamed, `${modelId} elements.maxNamed`).toBe(fromFallback.elements.maxNamed);
    expect(fromDescriptor.referenceVideos.max, `${modelId} referenceVideos`).toBe(fromFallback.referenceVideos.max);
    expect(fromDescriptor.referenceAudios.max, `${modelId} referenceAudios`).toBe(fromFallback.referenceAudios.max);
    expect(fromDescriptor.frames.end, `${modelId} frames.end`).toBe(fromFallback.frames.end);
    expect(fromDescriptor.frames.startRequired, `${modelId} startRequired`).toBe(fromFallback.frames.startRequired);
    expect(fromDescriptor.namedVideoElements.enabled, `${modelId} namedVideoElements`).toBe(fromFallback.namedVideoElements.enabled);
  });

  it.each(videoModelIds)('%s: reference capacity is reachable from the default state', (modelId) => {
    // The create surfaces open in the frames shape with nothing attached. Reading capacity
    // off the slots active for *that* shape reported zero for every model whose references
    // sit behind a condition, and the control that satisfied the condition was itself gated
    // on the capacity — so the references were unreachable in a fresh session. Capacity must
    // answer "can this model take references at all", independent of what is attached now.
    const settings = { mode: modelId === 'veo-3.1' ? 'veo3_fast' : undefined };
    const fresh = getVideoInputAffordances(descriptorFor(modelId), modelId, { ...settings, referenceMode: 'frames' });
    const engaged = getVideoInputAffordances(descriptorFor(modelId), modelId, { ...settings, referenceMode: 'elements' });

    expect(fresh.elements.enabled, `${modelId} elements.enabled`).toBe(engaged.elements.enabled);
    expect(fresh.elements.maxTotal, `${modelId} elements.maxTotal`).toBe(engaged.elements.maxTotal);
    expect(fresh.referenceVideos.max, `${modelId} referenceVideos.max`).toBe(engaged.referenceVideos.max);
    expect(fresh.referenceAudios.max, `${modelId} referenceAudios.max`).toBe(engaged.referenceAudios.max);
  });

  it('reports Seedance 2.5 reference slots with nothing attached', () => {
    // The reported case: the model publishes its image, video and audio reference slots
    // and the page rendered none of them. The counts track Kie's schema for
    // bytedance/seedance-2-5 (reference_image_urls maxItems 30, video and audio 10).
    const fresh = getVideoInputAffordances(descriptorFor('seedance-2-5'), 'seedance-2-5', { referenceMode: 'frames' });
    expect(fresh.elements.enabled).toBe(true);
    expect(fresh.elements.maxTotal).toBe(30);
    expect(fresh.referenceVideos.max).toBe(10);
    expect(fresh.referenceAudios.max).toBe(10);
    // Ten slots, still thirty seconds of usable footage.
    expect(fresh.referenceVideos.maxDurationSeconds).toBe(30);
  });

  it('marks frames and references exclusive only where the provider forks', () => {
    // Verified against Kie's live model docs. Seedance sends every field to one endpoint but
    // documents the two as mutually exclusive scenarios; minimax-h3 and kling-o3 route
    // references to an endpoint carrying no frame field; wan-2.7's r2v takes `first_frame`
    // alongside `reference_image` and `reference_video`, so both groups stay live there.
    const exclusive = (modelId: VideoModelId) => getVideoInputAffordances(
      descriptorFor(modelId),
      modelId,
      { referenceMode: 'frames', mode: modelId === 'veo-3.1' ? 'veo3_fast' : undefined },
    ).framesExcludeReferences;

    expect(exclusive('seedance-2-5')).toBe(true);
    expect(exclusive('minimax-h3')).toBe(true);
    expect(exclusive('kling-o3')).toBe(true);
    expect(exclusive('wan-2.7')).toBe(false);
    // No frame slots at all, so there is nothing for references to exclude.
    expect(exclusive('gemini-omni-video')).toBe(false);
    // No reference slots, likewise.
    expect(exclusive('hailuo-2.3')).toBe(false);
  });

  it('caps Kling O3 named subjects below its total reference capacity', () => {
    const affordances = getVideoInputAffordances(descriptorFor('kling-o3'), 'kling-o3', { referenceMode: 'elements' });
    expect(affordances.elements.maxTotal).toBe(7);
    expect(affordances.elements.maxNamed).toBe(3);
  });

  it('keeps Kling O3 references across multi-shot and drops them elsewhere', () => {
    const o3 = getVideoInputAffordances(descriptorFor('kling-o3'), 'kling-o3', { referenceMode: 'elements', isMultiShot: true });
    const seedance = getVideoInputAffordances(descriptorFor('seedance-2'), 'seedance-2', { referenceMode: 'elements', isMultiShot: true });
    expect(o3.elements.enabled).toBe(true);
    expect(seedance.elements.enabled).toBe(false);
    expect(seedance.elements.disabledReason).toContain('single-shot');
  });

  it('keeps Kling video elements available in frames mode', () => {
    // The slot has its own always-active mode, so attaching an element never depends on
    // a reference-mode toggle this surface does not show for Kling.
    const affordances = getVideoInputAffordances(descriptorFor('kling-3.0-video'), 'kling-3.0-video', { referenceMode: 'frames' });
    expect(affordances.namedVideoElements.enabled).toBe(true);
    expect(affordances.namedVideoElements.max).toBe(3);
  });

  it('surfaces wan-2.7 frame-and-reference combining from the descriptor', () => {
    const combined = getVideoInputAffordances(descriptorFor('wan-2.7'), 'wan-2.7', { referenceMode: 'elements' });
    const framesOnly = getVideoInputAffordances(descriptorFor('wan-2.7'), 'wan-2.7', { referenceMode: 'frames' });
    expect(combined.combineFramesWithReferences).toBe(true);
    expect(framesOnly.combineFramesWithReferences).toBe(false);
  });

  it('carries constraint copy from the descriptor rather than hardcoded strings', () => {
    const affordances = getVideoInputAffordances(descriptorFor('seedance-2-5'), 'seedance-2-5', { referenceMode: 'elements' });
    const combined = affordances.activeConstraints.find((constraint) => constraint.type === 'combined-duration');
    expect(combined?.max).toBe(30);
    expect(combined?.message).toContain('30 seconds');
  });

  it('hides a resolution control that offers only one value', () => {
    // A single-option control is a fixed value, not a choice worth rendering.
    const singleOption = getImageInputAffordances(descriptorFor('imagen-4'));
    const multiOption = getImageInputAffordances(descriptorFor('nano-banana-2'));
    expect(singleOption?.showResolutionControl).toBe(false);
    expect(multiOption?.showResolutionControl).toBe(true);
  });

  it('reports the required character reference on ideogram-character', () => {
    const affordances = getImageInputAffordances(descriptorFor('ideogram-character'));
    // Kie's ideogram/character endpoint uses only the first reference image
    // ("rest will be ignored"), so the app stops collecting extras.
    expect(affordances?.references.max).toBe(1);
  });
});
