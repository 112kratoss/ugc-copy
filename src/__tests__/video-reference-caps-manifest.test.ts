import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildGenerationModelCatalog,
  quoteGenerationModel,
  CatalogError,
} from '@/lib/generation-model-catalog';
import { buildCodeGenerationModelOperations } from '@/lib/generation-model-runtime';

import { descriptorBeforeKieCheckup } from './fixtures/kie-checkup-2026-10-20';
import { descriptorBeforeSlotMinDurations } from './fixtures/slot-min-durations-2026-10-31';

/**
 * Release 2026-09-03-video-reference-caps: seedance-2-5 and minimax-h3 refreshed against
 * Kie's live OpenAPI specs.
 *
 * The caps in that manifest are mirrored by five separate tables in application code —
 * VIDEO_INPUT_LIMITS, the runtime validation ladder, getVideoElementSupport (twice, server
 * and client), getVideoReferenceSupport, and the mobile view model. Raising one and missing
 * another is how this family of models shipped advertising references it could not accept.
 * Comparing the manifest descriptor to the descriptor the app builds catches every one of
 * them at once, because the app descriptor is assembled from those same tables. The app
 * descriptor is read as it stood before the 2026-10-20 check-up, which capped minimax-h3 at
 * five reference images; the caps and prices asserted below are today's.
 */

type ManifestSlot = { key: string; durationMetadata?: string; max?: number };
type ManifestDescriptor = {
  inputs: Record<string, unknown>;
  inputModes?: Array<{ key: string; slots: ManifestSlot[] }>;
};

const manifest = JSON.parse(fs.readFileSync(path.resolve(
  process.cwd(),
  'config/generation-model-catalog/releases/2026-09-03-video-reference-caps.json',
), 'utf8')) as {
  release: { revision: string; basedOnRevision: string };
  entries: Array<{ modelId: string; publicDescriptor: ManifestDescriptor }>;
};

const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });

function entry(modelId: string) {
  const found = manifest.entries.find((item) => item.modelId === modelId);
  if (!found) throw new Error(`no manifest entry for ${modelId}`);
  return found;
}

function descriptor(modelId: string) {
  const found = catalog.models.find((model) => model.id === modelId);
  if (!found) throw new Error(`no descriptor for ${modelId}`);
  return found;
}

function slot(source: ManifestDescriptor, modeKey: string, slotKey: string): ManifestSlot {
  const mode = (source.inputModes ?? []).find((item) => item.key === modeKey);
  const found = (mode?.slots ?? []).find((item) => item.key === slotKey);
  if (!found) throw new Error(`no ${modeKey}/${slotKey} slot`);
  return found;
}

function fieldErrorsFor(run: () => unknown): Record<string, string> {
  try {
    run();
  } catch (error) {
    if (error instanceof CatalogError) return error.fieldErrors;
    throw error;
  }
  throw new Error('expected the quote to be rejected');
}

describe('video reference caps track Kie', () => {
  it('chains onto the release the catalog last published', () => {
    expect(manifest.release.basedOnRevision).toBe('kling-o3-subjects-20260824');
  });

  it.each(['seedance-2-5', 'minimax-h3'])(
    '%s: the manifest and the app agree on every reference cap',
    (modelId) => {
      const built = descriptorBeforeKieCheckup(descriptorBeforeSlotMinDurations(descriptor(modelId)));
      expect(built.inputs).toEqual(entry(modelId).publicDescriptor.inputs);
      for (const slotKey of ['imageReferences', 'videoReferences', 'audioReferences']) {
        expect(slot(built as unknown as ManifestDescriptor, 'references', slotKey), `${modelId}.${slotKey}`)
          .toEqual(slot(entry(modelId).publicDescriptor, 'references', slotKey));
      }
    },
  );

  it('reads seedance-2-5 caps off bytedance/seedance-2-5', () => {
    // reference_image_urls maxItems 30, reference_video_urls 10, reference_audio_urls 10.
    expect(descriptor('seedance-2-5').inputs.imageReferences?.max).toBe(30);
    expect(descriptor('seedance-2-5').inputs.videoReferences?.max).toBe(10);
    expect(descriptor('seedance-2-5').inputs.audioReferences?.max).toBe(10);
  });

  it('keeps seedance-2-5 at thirty seconds of reference footage across ten slots', () => {
    // "Total duration of reference videos must not exceed 30 seconds" is enforced by Kie
    // independently of the file cap, so ten slots buy more clips, not more footage.
    expect(descriptor('seedance-2-5').inputConstraints).toContainEqual(
      expect.objectContaining({ type: 'combined-duration', slotKeys: ['videoReferences'], max: 30 }),
    );
    expect(Object.values(fieldErrorsFor(() => quoteGenerationModel({
      kind: 'video',
      modelId: 'seedance-2-5',
      settings: { resolution: '720p', duration: 10, referenceMode: 'elements' },
      inputCounts: { videos: 3 },
      inputMetadata: { slots: { videoReferences: { count: 3, durationsSeconds: [12, 12, 12] } } },
    }))).join(' ')).toMatch(/at most 30 seconds/);
  });

  it('reads minimax-h3 caps off minimax-h3/reference-to-video', () => {
    // reference_image_urls maxItems 9, reference_video_urls 3, reference_audio_urls 3. Kie
    // bills each image past the fifth, so since the 2026-10-20 re-check references stop at 5.
    expect(descriptor('minimax-h3').inputs.imageReferences?.max).toBe(5);
    expect(descriptor('minimax-h3').inputs.videoReferences?.max).toBe(3);
    expect(descriptor('minimax-h3').inputs.audioReferences?.max).toBe(3);
  });

  it('holds minimax-h3 to fifteen seconds of reference footage across three slots', () => {
    expect(Object.values(fieldErrorsFor(() => quoteGenerationModel({
      kind: 'video',
      modelId: 'minimax-h3',
      settings: { resolution: '768P', duration: 6, referenceMode: 'elements' },
      inputCounts: { videos: 3 },
      inputMetadata: { slots: { videoReferences: { count: 3, durationsSeconds: [8, 8, 8] } } },
    }))).join(' ')).toMatch(/at most 15 seconds/);
  });

  it('refuses minimax-h3 reference audio with nothing beside it', () => {
    // minimax-h3/reference-to-video declares anyOf[reference_image_urls,
    // reference_video_urls]: "reference_audio cannot be used alone, it must be accompanied
    // by reference_image or reference_video". Audio alone still routes to that endpoint,
    // so without this the provider 422s a run we already quoted and charged for.
    expect(Object.values(fieldErrorsFor(() => quoteGenerationModel({
      kind: 'video',
      modelId: 'minimax-h3',
      settings: { resolution: '768P', duration: 6, referenceMode: 'elements' },
      inputCounts: { audios: 1 },
      inputMetadata: { slots: { audioReferences: { count: 1 } } },
    }))).join(' ')).toMatch(/reference image or video/);

    // The same audio alongside an image is exactly what the provider asks for.
    expect(() => quoteGenerationModel({
      kind: 'video',
      modelId: 'minimax-h3',
      settings: { resolution: '768P', duration: 6, referenceMode: 'elements' },
      inputCounts: { images: 1, audios: 1 },
      inputMetadata: {
        slots: { imageReferences: { count: 1 }, audioReferences: { count: 1 } },
      },
    })).not.toThrow();
  });

  it('prices seedance-2-5 1080p at Kie\'s list rate, not the offer', () => {
    // Kie listed 114 / 68.5 under a "Limited-Time 1080P Offer: 28% OFF until Sep 17, 2026
    // 06:00 UTC". Billing the offer would have under-billed every 1080p run from the moment
    // it lapsed, so this tier carried the rate behind it (114/0.72 and 68.5/0.72, rounded up:
    // 159 / 96). The offer ended on Oct 17 and Kie lists 158 / 95 (re-read 2026-10-20), which
    // the tier now passes through like 480p and 720p.
    const quote = quoteGenerationModel({
      kind: 'video',
      modelId: 'seedance-2-5',
      settings: { resolution: '1080p', duration: 10 },
      inputCounts: {},
    });
    expect(quote.costCredits).toBe(1580);
    expect(quote.costCredits).toBeGreaterThan(114 * 10);

    const withReference = quoteGenerationModel({
      kind: 'video',
      modelId: 'seedance-2-5',
      settings: { resolution: '1080p', duration: 10, referenceMode: 'elements' },
      inputCounts: { videos: 1 },
      inputMetadata: { slots: { videoReferences: { count: 1, durationsSeconds: [5] } } },
    });
    // Billed on input plus output seconds, per Kie's note on the with-video rate.
    expect(withReference.costCredits).toBe((10 + 5) * 95);
  });

  it('leaves the 480p and 720p tiers alone', () => {
    // These carry no promotional offer and already match Kie exactly.
    for (const [resolution, rate] of [['480p', 28], ['720p', 63]] as const) {
      expect(quoteGenerationModel({
        kind: 'video',
        modelId: 'seedance-2-5',
        settings: { resolution, duration: 10 },
        inputCounts: {},
      }).costCredits).toBe(rate * 10);
    }
  });

  it('caps elements-mode images at exactly what each model publishes', () => {
    // Two tables, one number: VIDEO_INPUT_LIMITS.images feeds the descriptor, and
    // VIDEO_REFERENCE_IMAGE_CAPS feeds the quote's max-slot-count rule. They live in
    // different modules because the import between them only runs one way. When they
    // disagree the model advertises capacity the quote then refuses — which is how
    // seedance-2-5, kling-o3 and minimax-h3 shipped with unusable reference support.
    const operations = new Map(
      buildCodeGenerationModelOperations().map((operation) => [operation.modelId, operation]),
    );
    // Models offered nowhere too: a retired model keeps its caps for a release that brings it back.
    const everyModel = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2, includeUnavailable: true });
    for (const model of everyModel.models.filter((entry) => entry.kind === 'video')) {
      const published = model.inputs.imageReferences?.max ?? 0;
      const rules = (operations.get(model.id)?.validationConfig.rules ?? []) as Array<{
        type: string;
        slotKey?: string;
        max?: number;
        conditions?: Array<{ key: string; value: unknown }>;
      }>;
      // A model whose start frame rides beside its references (Wan 2.7 since release
      // wan-start-frame-apart-20261019, Grok Imagine Video 1.5 since 2026-10-29) has its cap
      // count the reference slot; every other cap counts pictures. Read off the descriptor's
      // flag, this also pins the runtime's START_FRAME_WITH_REFERENCES to the catalog.
      const elementsRule = rules.find((rule) => (
        rule.type === 'max-slot-count'
        && rule.slotKey === (model.inputs.combineFramesWithReferences ? 'imageReferences' : 'images')
        && (rule.conditions ?? []).some((condition) => (
          condition.key === 'referenceMode' && condition.value === 'elements'
        ))
      ));
      expect(elementsRule?.max, `${model.id} elements-mode image cap`).toBe(published);
    }
  });

  it('demands duration metadata wherever a combined-duration ceiling exists', () => {
    // The manifest validator rejects a combined-duration constraint on a slot whose
    // durationMetadata is optional, because a client that reports nothing sums to zero
    // and sails past the ceiling. Code-built descriptors must honour the same invariant.
    for (const model of catalog.models) {
      for (const constraint of model.inputConstraints ?? []) {
        if (constraint.type !== 'combined-duration') continue;
        for (const slotKey of constraint.slotKeys) {
          const declared = (model.inputModes ?? [])
            .flatMap((mode) => mode.slots)
            .find((item) => item.key === slotKey);
          expect(declared?.durationMetadata, `${model.id}.${slotKey}`).toBe('required');
        }
      }
    }
  });
});
