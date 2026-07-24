import { describe, expect, it } from 'vitest';

import {
  GenerationProviderAdapterError,
  buildGenerationProviderRequest,
  type GenericGenerationAdapterOperation,
} from '@/lib/generation-model-adapters';
import seedanceRelease from '../../config/generation-model-catalog/releases/2026-07-24-seedance-2-hd.json';

describe('generation model adapters', () => {
  it.each(['1080p', '4k'])(
    'maps the published Seedance 2 %s option into the Kie payload',
    (resolution) => {
      const entry = seedanceRelease.entries.find(({ modelId }) => modelId === 'seedance-2');
      expect(entry).toBeDefined();
      const request = buildGenerationProviderRequest({
        operation: {
          modelId: entry!.modelId,
          kind: entry!.kind,
          adapterKey: entry!.adapterKey,
          providerModelMap: entry!.providerModelMap,
          adapterConfig: entry!.adapterConfig,
        } as GenericGenerationAdapterOperation,
        prompt: 'A cinematic product reveal',
        settings: {
          aspectRatio: '9:16',
          resolution,
          duration: 7,
          sound: false,
        },
        inputs: [],
      });

      expect(request).toMatchObject({
        endpoint: 'https://api.kie.ai/api/v1/jobs/createTask',
        providerModelId: 'bytedance/seedance-2',
        body: {
          model: 'bytedance/seedance-2',
          input: {
            prompt: 'A cinematic product reveal',
            aspect_ratio: '9:16',
            resolution,
            duration: 7,
            generate_audio: false,
            web_search: false,
            return_last_frame: false,
          },
        },
      });
    },
  );

  it('builds a Kie request from private declarative mappings', () => {
    const request = buildGenerationProviderRequest({
      operation: {
        modelId: 'catalog-only-video',
        kind: 'video',
        adapterKey: 'kie-task-v1',
        providerModelMap: {
          text: 'provider/text-video',
          reference: 'provider/reference-video',
        },
        adapterConfig: {
          promptField: 'prompt',
          variantSelector: {
            type: 'slot-presence',
            slot: 'references',
            present: 'reference',
            absent: 'text',
          },
          settings: {
            aspectRatio: { field: 'aspect_ratio' },
            duration: { field: 'duration', transform: 'integer' },
            sound: { field: 'generate_audio', transform: 'boolean' },
          },
          slots: {
            references: {
              field: 'reference_image_urls',
              cardinality: 'many',
              source: 'url',
            },
          },
          constants: {
            watermark: false,
          },
        },
      },
      prompt: 'A paper bird takes flight',
      settings: {
        aspectRatio: '9:16',
        duration: 7,
        sound: true,
      },
      inputs: [
        {
          slot: 'references',
          kind: 'image',
          url: 'https://signed.example/reference.png',
        },
      ],
    });

    expect(request).toEqual({
      endpoint: 'https://api.kie.ai/api/v1/jobs/createTask',
      providerModelId: 'provider/reference-video',
      variant: 'reference',
      body: {
        model: 'provider/reference-video',
        input: {
          prompt: 'A paper bird takes flight',
          aspect_ratio: '9:16',
          duration: 7,
          generate_audio: true,
          reference_image_urls: ['https://signed.example/reference.png'],
          watermark: false,
        },
      },
    });
  });

  it('rejects provider-controlled endpoints and unsafe field mappings', () => {
    expect(() => buildGenerationProviderRequest({
      operation: {
        modelId: 'unsafe-model',
        kind: 'image',
        adapterKey: 'kie-task-v1',
        providerModelMap: { default: 'provider/model' },
        adapterConfig: {
          endpoint: 'https://attacker.example',
          settings: {
            prompt: { field: '__proto__' },
          },
        },
      },
      prompt: 'Safe prompt',
      settings: { prompt: 'value' },
      inputs: [],
    })).toThrow(GenerationProviderAdapterError);
  });

  it('fails closed when a selected provider variant is missing', () => {
    expect(() => buildGenerationProviderRequest({
      operation: {
        modelId: 'missing-variant',
        kind: 'video',
        adapterKey: 'kie-task-v1',
        providerModelMap: { text: 'provider/text' },
        adapterConfig: {
          variantSelector: {
            type: 'slot-presence',
            slot: 'startFrame',
            present: 'image',
            absent: 'text',
          },
        },
      },
      prompt: 'Prompt',
      settings: {},
      inputs: [{ slot: 'startFrame', kind: 'image', url: 'https://signed.example/frame.png' }],
    })).toThrow('Provider model variant image is not configured');
  });
});
