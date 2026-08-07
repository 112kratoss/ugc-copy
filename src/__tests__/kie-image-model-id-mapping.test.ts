import { describe, expect, it } from 'vitest';

import { getKieImageModelId } from '@/lib/generation-services';
import {
  buildCodeGenerationModelOperations,
  resolveProviderModelId,
} from '@/lib/generation-model-runtime';
import { IMAGE_MODELS, type ImageModelId } from '@/lib/models';

/**
 * Provider model ids verified 2026-07-25 against Kie's published OpenAPI specs
 * under https://docs.kie.ai/market/. Each value below is quoted from the `model`
 * parameter's enum in the corresponding spec, so this table is evidence rather
 * than restatement of the implementation.
 */
const VERIFIED_PROVIDER_IDS: Partial<Record<ImageModelId, { text: string; reference: string }>> = {
  'flux-2-pro': { text: 'flux-2/pro-text-to-image', reference: 'flux-2/pro-image-to-image' },
  'gpt-image-2': { text: 'gpt-image-2-text-to-image', reference: 'gpt-image-2-image-to-image' },
  'grok-imagine-image': { text: 'grok-imagine/text-to-image', reference: 'grok-imagine/image-to-image' },
  'ideogram-v3': { text: 'ideogram/v3-text-to-image', reference: 'ideogram/v3-remix' },
  'imagen-4': { text: 'google/imagen4', reference: 'google/imagen4' },
  'imagen-4-fast': { text: 'google/imagen4-fast', reference: 'google/imagen4-fast' },
  'imagen-4-ultra': { text: 'google/imagen4-ultra', reference: 'google/imagen4-ultra' },
  'nano-banana-2': { text: 'nano-banana-2', reference: 'nano-banana-2' },
  'nano-banana-2-lite': { text: 'nano-banana-2-lite', reference: 'nano-banana-2-lite' },
  'nano-banana-pro': { text: 'nano-banana-pro', reference: 'nano-banana-pro' },
  'seedream-5-pro': { text: 'seedream/5-pro-text-to-image', reference: 'seedream/5-pro-image-to-image' },
  'seedream-5-lite': { text: 'seedream/5-lite-text-to-image', reference: 'seedream/5-lite-image-to-image' },
  'wan-2.7-image': { text: 'wan/2-7-image', reference: 'wan/2-7-image' },
  'wan-2.7-image-pro': { text: 'wan/2-7-image-pro', reference: 'wan/2-7-image-pro' },
  // UNVERIFIED. No published spec was found for z-image under any probed path
  // on docs.kie.ai, so this records current behaviour rather than a confirmed
  // provider id. It is listed so the completeness check below still forces a
  // decision when a new image model is registered; confirm it against the
  // provider before treating it as evidence.
  'z-image': { text: 'z-image', reference: 'z-image' },
};

describe('kie image model id mapping', () => {
  it.each(Object.entries(VERIFIED_PROVIDER_IDS))(
    'maps %s to its provider id for text and reference generations',
    (modelId, expected) => {
      expect(getKieImageModelId(modelId as ImageModelId, 0)).toBe(expected.text);
      expect(getKieImageModelId(modelId as ImageModelId, 2)).toBe(expected.reference);
    },
  );

  it('sends the slashed Wan ids, which is what the provider actually accepts', () => {
    // Regression guard. These two fell through to `return model` and were sent
    // as the dotted app id, which Kie's spec does not list as an allowed enum
    // value for the model parameter.
    expect(getKieImageModelId('wan-2.7-image', 0)).not.toBe('wan-2.7-image');
    expect(getKieImageModelId('wan-2.7-image-pro', 0)).not.toBe('wan-2.7-image-pro');
  });

  it('never emits a dotted major.minor version in a provider id', () => {
    // Every Kie id verified so far spells versions with dashes inside the path
    // segment (`wan/2-7-image`, `kling/v3-turbo-...`). A dot survives only when
    // the provider id genuinely contains one, which no image model does.
    for (const modelId of Object.keys(IMAGE_MODELS) as ImageModelId[]) {
      expect(getKieImageModelId(modelId, 0)).not.toMatch(/\d\.\d/);
    }
  });

  it('covers every registered image model, so a new one cannot be added unmapped', () => {
    const registered = Object.keys(IMAGE_MODELS).sort();
    const covered = Object.keys(VERIFIED_PROVIDER_IDS).sort();
    expect(covered).toEqual(registered);
  });
});

/**
 * The suite above pins `getKieImageModelId`, which is only ever consulted as the
 * *fallback* in `resolveProviderModelId(config, variant, fallback)` — i.e. when no
 * catalog entry exists. With `GENERATION_MODEL_CATALOG_SOURCE=code` (the default
 * off production) an entry always exists, so the request is built from
 * IMAGE_PROVIDER_MODELS and the fallback is dead code.
 *
 * That gap is exactly how the Wan ids stayed broken after the 2026-07-25 fix:
 * the fallback and the database catalog were both corrected and asserted, while
 * the table the code path actually reads kept sending the dotted app id and Kie
 * answered 422 "The model name you specified is not supported".
 */
describe('code-catalog provider model map', () => {
  const imageOperations = new Map(
    buildCodeGenerationModelOperations()
      .filter((operation) => operation.kind === 'image')
      .map((operation) => [operation.modelId, operation]),
  );

  // A deliberately invalid fallback: if resolution ever silently drops through to
  // it, the assertion fails loudly instead of passing on the fallback's correct
  // value — which is the precise failure mode this suite exists to catch.
  const POISONED_FALLBACK = 'fallback-must-not-be-used';

  it.each(Object.entries(VERIFIED_PROVIDER_IDS))(
    'resolves %s from the catalog entry the request is actually built from',
    (modelId, expected) => {
      const config = imageOperations.get(modelId);
      expect(config).toBeDefined();
      expect(resolveProviderModelId(config, 'text', POISONED_FALLBACK)).toBe(expected.text);
      expect(resolveProviderModelId(config, 'reference', POISONED_FALLBACK)).toBe(expected.reference);
    },
  );

  it('never emits a dotted major.minor version on the code-catalog path either', () => {
    for (const modelId of Object.keys(IMAGE_MODELS) as ImageModelId[]) {
      const config = imageOperations.get(modelId);
      expect(resolveProviderModelId(config, 'text', POISONED_FALLBACK)).not.toMatch(/\d\.\d/);
    }
  });
});
