import { describe, expect, it } from 'vitest';

import {
  buildGenerationModelCatalog,
  quoteGenerationModel,
  type CatalogInputSlot,
} from '@/lib/generation-model-catalog';
import { VIDEO_MODELS, getVideoElementSupport, type VideoModelId } from '@/lib/models';

/**
 * A model may not advertise a capability it cannot actually use.
 *
 * seedance-2-5, kling-o3 and minimax-h3 all shipped publishing reference-image capacity
 * while three separate layers denied it: `getVideoElementSupport` had no branch (so the
 * editor never rendered), the quote's validation config capped elements-mode images at 0,
 * and for minimax the start path discarded reference clips entirely. Each layer failed
 * silently. These tests make that class of gap fail loudly instead.
 */

const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });

function descriptorFor(modelId: string) {
  const model = catalog.models.find((entry) => entry.id === modelId);
  if (!model) throw new Error(`no descriptor for ${modelId}`);
  return model;
}

/** Every slot the model declares anywhere, across all input modes. */
function declaredSlots(modelId: string): CatalogInputSlot[] {
  return (descriptorFor(modelId).inputModes ?? []).flatMap((mode) => mode.slots);
}

const videoModelIds = Object.keys(VIDEO_MODELS) as VideoModelId[];

describe('advertised capabilities are reachable', () => {
  it.each(videoModelIds)(
    '%s: published reference-image capacity matches what the element editor allows',
    (modelId) => {
      const published = descriptorFor(modelId).inputs.imageReferences?.max ?? 0;
      // Veo gates references behind its own modes; ask in a mode that permits them.
      const support = getVideoElementSupport(modelId, { mode: 'veo3_fast' });
      if (published > 0) {
        expect(support.enabled, `${modelId} publishes ${published} refs but the editor is disabled`).toBe(true);
        expect(support.maxElements).toBe(published);
      } else {
        expect(support.enabled).toBe(false);
      }
    },
  );

  it.each(['seedance-2-5', 'kling-o3', 'minimax-h3'])(
    '%s can quote a run that attaches its published references',
    (modelId) => {
      const published = descriptorFor(modelId).inputs.imageReferences?.max ?? 0;
      expect(published).toBeGreaterThan(0);
      const settings = Object.fromEntries(
        descriptorFor(modelId).controls.map((control) => [control.key, control.defaultValue]),
      );
      expect(() => quoteGenerationModel({
        kind: 'video',
        modelId,
        settings: { ...settings, referenceMode: 'elements' },
        inputCounts: { images: published, videos: 0, audios: 0 },
        inputMetadata: { slots: { imageReferences: { count: published } } },
        catalogRevision: catalog.revision,
      }, { catalog })).not.toThrow();
    },
  );

  it('caps Kling O3 named subjects below its total reference capacity', () => {
    const slot = declaredSlots('kling-o3').find((entry) => entry.key === 'imageReferences');
    // 7 images may be attached; at most 3 of them are named subjects.
    expect(slot?.max).toBe(7);
    expect(slot?.maxNamed).toBe(3);
    expect(getVideoElementSupport('kling-o3').maxNamed).toBe(3);
  });

  it('lets Kling O3 keep its subjects across a multi-shot run', () => {
    // Every other model loses references in multi-shot; O3 is the exception.
    expect(getVideoElementSupport('kling-o3', { isMultiShot: true }).enabled).toBe(true);
    expect(getVideoElementSupport('seedance-2', { isMultiShot: true }).enabled).toBe(false);
  });

  it('gives Seedance 2.5 the 30-second reference budget its output length implies', () => {
    const constraint = (descriptorFor('seedance-2-5').inputConstraints ?? [])
      .find((entry) => entry.type === 'combined-duration');
    expect(constraint?.max).toBe(30);
    expect(constraint?.message).toContain('30 seconds');

    // The rest of the family still stops at 15.
    const sibling = (descriptorFor('seedance-2').inputConstraints ?? [])
      .find((entry) => entry.type === 'combined-duration');
    expect(sibling?.max).toBe(15);
  });

  it('keeps Kling video elements usable alongside start frames', () => {
    // The provider combines named video elements WITH a start frame, so the slot cannot
    // live inside the frames-vs-references either/or.
    const modes = descriptorFor('kling-3.0-video').inputModes ?? [];
    const elementsMode = modes.find((mode) => mode.slots.some((slot) => slot.key === 'videoElements'));
    expect(elementsMode?.conditions ?? []).toEqual([]);
    expect(modes.some((mode) => mode.slots.some((slot) => slot.role === 'startFrame'))).toBe(true);
  });
});
