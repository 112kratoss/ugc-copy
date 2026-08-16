import { describe, expect, it } from 'vitest';

import { buildGenerationProviderRequest } from '@/lib/generation-model-adapters';
import { buildCodeGenerationModelOperations } from '@/lib/generation-model-runtime';

/**
 * Golden payload tests for the image models migrated to the declarative
 * kie-task-v1 adapter. Each expected body below is the exact request the
 * hand-coded ladder in startImageGeneration produced before migration —
 * quoted from that code, not from the adapter — so these tests are the proof
 * that the legacy branches can be deleted once the catalog release flips
 * production to kie-task-v1. If one of these fails, the adapter config has
 * changed the provider contract.
 */

const operations = new Map(
  buildCodeGenerationModelOperations()
    .filter((operation) => operation.kind === 'image')
    .map((operation) => [operation.modelId, operation]),
);

const PROMPT = 'A ceramic mug on a marble counter';
const REF_URL = 'https://cdn.example.com/signed/reference-1.png';
const REF_URL_2 = 'https://cdn.example.com/signed/reference-2.png';

function build(modelId: string, settings: Record<string, string | number | boolean>, referenceUrls: string[] = []) {
  const operation = operations.get(modelId);
  if (!operation) throw new Error(`no operation for ${modelId}`);
  expect(operation.adapterKey).toBe('kie-task-v1');
  return buildGenerationProviderRequest({
    operation,
    prompt: PROMPT,
    settings,
    inputs: referenceUrls.map((url) => ({ slot: 'imageReferences', kind: 'image' as const, url })),
  });
}

const BASE_SETTINGS = { aspectRatio: '1:1', resolution: '1K', outputFormat: 'jpg', googleSearch: false };

describe('kie-task-v1 image adapter parity with the legacy payload ladder', () => {
  it('imagen family sends prompt and aspect ratio only', () => {
    for (const modelId of ['imagen-4-fast', 'imagen-4', 'imagen-4-ultra']) {
      const request = build(modelId, BASE_SETTINGS);
      expect(request.body).toEqual({
        model: operations.get(modelId)!.providerModelMap.default,
        input: { prompt: PROMPT, aspect_ratio: '1:1' },
      });
    }
  });

  it('z-image adds the nsfw checker constant', () => {
    const request = build('z-image', BASE_SETTINGS);
    expect(request.body).toEqual({
      model: 'z-image',
      input: { prompt: PROMPT, aspect_ratio: '1:1', nsfw_checker: true },
    });
  });

  it('grok imagine 2.0 sends prompt and aspect ratio', () => {
    const request = build('grok-imagine-image-2', { ...BASE_SETTINGS, aspectRatio: '16:9' });
    expect(request.body).toEqual({
      model: 'grok-imagine-image-2-0/text-to-image',
      input: { prompt: PROMPT, aspect_ratio: '16:9' },
    });
  });

  it('nano banana 2 lite omits resolution and output format', () => {
    expect(build('nano-banana-2-lite', BASE_SETTINGS).body).toEqual({
      model: 'nano-banana-2-lite',
      input: { prompt: PROMPT, aspect_ratio: '1:1' },
    });
    expect(build('nano-banana-2-lite', BASE_SETTINGS, [REF_URL]).body.input).toMatchObject({
      image_urls: [REF_URL],
    });
  });

  it('nano banana 2 and pro keep the generic-branch field set', () => {
    for (const modelId of ['nano-banana-2', 'nano-banana-pro']) {
      const text = build(modelId, { ...BASE_SETTINGS, resolution: '2K' });
      expect(text.body).toEqual({
        model: modelId,
        input: {
          prompt: PROMPT,
          aspect_ratio: '1:1',
          resolution: '2K',
          output_format: 'jpg',
          google_search: false,
        },
      });
      const withRefs = build(modelId, { ...BASE_SETTINGS, resolution: '2K' }, [REF_URL, REF_URL_2]);
      expect(withRefs.body.input).toMatchObject({ image_input: [REF_URL, REF_URL_2] });
    }
  });

  it('qwen models translate aspect to image_size, jpg to jpeg, and switch endpoints on references', () => {
    const text = build('qwen3', { ...BASE_SETTINGS, aspectRatio: '3:2' });
    expect(text.body).toEqual({
      model: 'qwen3/text-to-image',
      input: {
        prompt: PROMPT,
        resolution: '1K',
        image_size: '3:2',
        output_format: 'jpeg',
        prompt_extend: true,
        nsfw_checker: true,
      },
    });

    const reference = build('qwen3-pro', { ...BASE_SETTINGS, resolution: '2K' }, [REF_URL]);
    expect(reference.body).toEqual({
      model: 'qwen3/pro-image-to-image',
      input: {
        prompt: PROMPT,
        resolution: '2K',
        image_size: '1:1',
        output_format: 'jpeg',
        prompt_extend: true,
        nsfw_checker: true,
        image_urls: [REF_URL],
      },
    });
  });

  it('flux 2 pro keeps nsfw checker and switches provider id on references', () => {
    expect(build('flux-2-pro', BASE_SETTINGS).body).toEqual({
      model: 'flux-2/pro-text-to-image',
      input: { prompt: PROMPT, aspect_ratio: '1:1', resolution: '1K', nsfw_checker: true },
    });
    expect(build('flux-2-pro', BASE_SETTINGS, [REF_URL]).body).toEqual({
      model: 'flux-2/pro-image-to-image',
      input: {
        prompt: PROMPT,
        aspect_ratio: '1:1',
        resolution: '1K',
        nsfw_checker: true,
        input_urls: [REF_URL],
      },
    });
  });

  it('gpt image 2 switches provider id on references', () => {
    expect(build('gpt-image-2', BASE_SETTINGS).body).toEqual({
      model: 'gpt-image-2-text-to-image',
      input: { prompt: PROMPT, aspect_ratio: '1:1', resolution: '1K' },
    });
    expect(build('gpt-image-2', BASE_SETTINGS, [REF_URL]).body).toEqual({
      model: 'gpt-image-2-image-to-image',
      input: { prompt: PROMPT, aspect_ratio: '1:1', resolution: '1K', input_urls: [REF_URL] },
    });
  });

  it('models with conditional payload logic stay on the legacy adapter', () => {
    // These cannot be expressed with the current transform set; the ladder in
    // generation-services remains their payload builder. Revisit if the adapter
    // grows value-map transforms.
    for (const modelId of [
      'grok-imagine-image',
      'seedream-5-pro',
      'seedream-5-lite',
      'wan-2.7-image',
      'wan-2.7-image-pro',
      'ideogram-v3',
      'ideogram-character',
    ]) {
      expect(operations.get(modelId)?.adapterKey, modelId).toBe('image-v1');
    }
  });
});
