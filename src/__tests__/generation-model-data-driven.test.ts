import { describe, expect, it } from 'vitest';

import {
  CatalogError,
  quoteGenerationModel,
  type GenerationModelCatalog,
  type GenerationModelDescriptor,
  type GenerationModelQuoteInput,
} from '@/lib/generation-model-catalog';
import {
  calculateGenerationModelRuntimeCost,
  resolveProviderModelId,
  type GenerationModelOperationalConfig,
  type GenerationModelRuntimeInputs,
} from '@/lib/generation-model-runtime';

const descriptor: GenerationModelDescriptor = {
  id: 'remote-video-model',
  kind: 'video',
  displayName: 'Remote Video Model',
  description: 'A catalog-only test model.',
  badge: 'Remote',
  recommended: true,
  sortOrder: 0,
  minClientSchemaVersion: 2,
  controls: [
    {
      key: 'resolution',
      label: 'Resolution',
      type: 'choice',
      presentation: 'chips',
      defaultValue: '720p',
      options: [
        { value: '720p', label: '720p' },
        { value: '1080p', label: '1080p' },
      ],
    },
    {
      key: 'duration',
      label: 'Duration',
      type: 'integer',
      presentation: 'stepper',
      defaultValue: 5,
      min: 1,
      max: 15,
      step: 1,
      unit: 'seconds',
    },
  ],
  capabilities: {
    multiShot: false,
    sound: false,
    fixedLens: false,
    googleSearch: false,
    outputFormat: false,
  },
  inputs: {
    imageReferences: null,
    videoReferences: { max: 3 },
    audioReferences: null,
    startFrame: false,
    endFrame: false,
  },
  availability: { web: true, mobile: true },
  inputModes: [{
    key: 'references',
    label: 'References',
    default: true,
    slots: [{
      key: 'videoReferences',
      kind: 'video',
      role: 'reference',
      label: 'Reference videos',
      min: 0,
      max: 3,
      durationMetadata: 'required',
    }],
  }],
  inputConstraints: [{
    type: 'combined-duration',
    slotKeys: ['videoReferences'],
    max: 15,
    message: 'Reference videos may be at most 15 seconds in total.',
  }],
};

const catalog: GenerationModelCatalog = {
  schemaVersion: 2,
  revision: 'remote-revision-1',
  defaults: { image: null, video: descriptor.id, motion: null },
  models: [descriptor],
};

function operation(
  pricingStrategy: GenerationModelOperationalConfig['pricingStrategy'],
  pricingConfig: Record<string, unknown>,
  validationConfig: Record<string, unknown> = { rules: [] },
): GenerationModelOperationalConfig {
  return {
    modelId: descriptor.id,
    kind: descriptor.kind,
    adapterKey: 'kie-task-v1',
    adapterConfig: { inputMap: { duration: 'duration' } },
    providerModelMap: { default: 'provider/private-model-id' },
    pricingStrategy,
    pricingConfig,
    validationStrategy: 'descriptor-rules-v1',
    validationConfig,
    verificationConfig: {},
  };
}

function quote(
  input: Partial<GenerationModelQuoteInput>,
  config: GenerationModelOperationalConfig,
) {
  return quoteGenerationModel({
    kind: 'video',
    modelId: descriptor.id,
    schemaVersion: 2,
    settings: { resolution: '720p', duration: 5 },
    catalogRevision: catalog.revision,
    ...input,
  }, {
    catalog,
    operations: new Map([[descriptor.id, config]]),
  });
}

const emptyInputs: GenerationModelRuntimeInputs = {
  counts: { images: 0, videos: 0, audios: 0, preparedAudios: 0, characters: 0 },
  slotCounts: {},
  slotDurationsSeconds: {},
  referenceVideoDurationsSeconds: [],
};

describe('data-driven generation pricing and validation', () => {
  it('quotes a catalog-only model with flat, lookup, per-second, and conditional pricing', () => {
    expect(quote({}, operation('flat', { credits: 9 })).costCredits).toBe(9);
    expect(quote({}, operation('flat', { credits: 3.2 })).costCredits).toBe(4);
    expect(quote(
      { settings: { resolution: '1080p', duration: 5 } },
      operation('lookup', {
        dimensions: [{ source: 'setting', key: 'resolution' }],
        table: { '720p': 10, '1080p': 20 },
      }),
    ).costCredits).toBe(20);
    expect(quote(
      { settings: { resolution: '1080p', duration: 4 } },
      operation('per-second', {
        durationSettingKey: 'duration',
        rounding: 'ceil',
        rate: {
          strategy: 'lookup',
          config: {
            dimensions: [{ source: 'setting', key: 'resolution' }],
            table: { '720p': 2, '1080p': 3.5 },
          },
        },
      }),
    ).costCredits).toBe(14);
    expect(quote(
      {
        inputCounts: { videos: 1 },
        inputMetadata: {
          slots: { videoReferences: { count: 1, durationsSeconds: [2] } },
          referenceVideoDurationsSeconds: [2],
        },
      },
      operation('conditional', {
        branches: [{
          conditions: [{ source: 'inputCount', key: 'videos', operator: 'greaterThan', value: 0 }],
          pricing: { strategy: 'flat', config: { credits: 7 } },
        }],
        fallback: { strategy: 'flat', config: { credits: 11 } },
      }),
    ).costCredits).toBe(7);
  });

  it('bills Seedance-style reference duration using private declarative rates', () => {
    const config = operation('reference-adjustment', {
      unit: 'second',
      settingKey: 'resolution',
      durationSettingKey: 'duration',
      referenceDurationSlots: ['videoReferences'],
      rounding: 'ceil',
      rates: {
        noReference: { '720p': 41, '1080p': 102 },
        withReference: { '720p': 25, '1080p': 62 },
      },
    });

    expect(quote(
      { settings: { resolution: '1080p', duration: 7 } },
      config,
    ).costCredits).toBe(714);
    expect(quote({
      settings: { resolution: '1080p', duration: 7 },
      inputCounts: { videos: 2 },
      inputMetadata: {
        slots: { videoReferences: { count: 2, durationsSeconds: [2, 3] } },
        referenceVideoDurationsSeconds: [2, 3],
      },
    }, config).costCredits).toBe(744);
  });

  it('fails closed when reference durations are absent and rejects excessive combined duration', () => {
    const config = operation('reference-adjustment', {
      unit: 'second',
      settingKey: 'resolution',
      durationSettingKey: 'duration',
      referenceDurationSlots: ['videoReferences'],
      rounding: 'ceil',
      rates: {
        noReference: { '720p': 41 },
        withReference: { '720p': 25 },
      },
    }, {
      rules: [{
        type: 'combined-duration',
        slotKeys: ['videoReferences'],
        max: 15,
        field: 'videos',
      }],
    });

    expect(() => quote({ inputCounts: { videos: 1 } }, config))
      .toThrowError(expect.objectContaining({
        code: 'INVALID_MODEL_SETTINGS',
        fieldErrors: expect.objectContaining({
          videoReferences: expect.stringContaining('duration metadata'),
        }),
      }));
    expect(() => quote({
      inputCounts: { videos: 2 },
      inputMetadata: {
        slots: { videoReferences: { count: 2, durationsSeconds: [8, 8] } },
        referenceVideoDurationsSeconds: [8, 8],
      },
    }, config)).toThrowError(expect.objectContaining({
      code: 'INVALID_MODEL_SETTINGS',
      fieldErrors: expect.objectContaining({ videos: expect.any(String) }),
    }));
  });

  it('applies allowlisted validation rules and rejects stale revisions before pricing', () => {
    const config = operation('flat', { credits: 1 }, {
      rules: [{
        type: 'max-slot-count',
        slotKey: 'videos',
        max: 1,
        field: 'videos',
        message: 'Only one reference video is allowed.',
      }],
    });

    expect(() => quote({ inputCounts: { videos: 2 } }, config))
      .toThrowError(expect.objectContaining({
        code: 'INVALID_MODEL_SETTINGS',
        fieldErrors: expect.objectContaining({
          videos: 'Only one reference video is allowed.',
        }),
      }));
    expect(() => quote({ catalogRevision: 'stale-revision' }, config))
      .toThrowError(expect.objectContaining({
        code: 'CATALOG_CHANGED',
        status: 409,
      } satisfies Partial<CatalogError>));
  });

  it('rejects missing lookup prices rather than deducting a guessed amount', () => {
    const config = operation('lookup', {
      dimensions: [{ source: 'setting', key: 'resolution' }],
      table: { '720p': 2 },
    });
    expect(() => calculateGenerationModelRuntimeCost(
      config,
      { resolution: '1080p', duration: 5 },
      emptyInputs,
    )).toThrow('no configured price');
  });

  it('evaluates conditioned controls independent of order and rejects inactive input modes', () => {
    const conditionedDescriptor: GenerationModelDescriptor = {
      ...descriptor,
      controls: [
        {
          key: 'advancedDuration',
          label: 'Advanced duration',
          type: 'integer',
          presentation: 'stepper',
          defaultValue: 5,
          min: 1,
          max: 10,
          step: 1,
          conditions: [{
            source: 'setting',
            key: 'inputMode',
            operator: 'equals',
            value: 'references',
          }],
        },
        {
          key: 'inputMode',
          label: 'Input mode',
          type: 'choice',
          presentation: 'chips',
          defaultValue: 'frames',
          options: [
            { value: 'frames', label: 'Frames' },
            { value: 'references', label: 'References' },
          ],
        },
      ],
      inputModes: [{
        key: 'references',
        label: 'References',
        default: false,
        conditions: [{
          source: 'setting',
          key: 'inputMode',
          operator: 'equals',
          value: 'references',
        }],
        slots: [{
          key: 'videoReferences',
          kind: 'video',
          role: 'reference',
          label: 'Reference videos',
          min: 1,
          max: 3,
          durationMetadata: 'required',
        }],
      }],
      inputConstraints: [],
    };
    const conditionedCatalog: GenerationModelCatalog = {
      ...catalog,
      models: [conditionedDescriptor],
    };
    const config = operation('flat', { credits: 1 });
    const quoteConditioned = (settings: Record<string, unknown>, inputMetadata?: GenerationModelQuoteInput['inputMetadata']) => (
      quoteGenerationModel({
        kind: 'video',
        modelId: conditionedDescriptor.id,
        schemaVersion: 2,
        catalogRevision: conditionedCatalog.revision,
        settings,
        inputMetadata,
      }, {
        catalog: conditionedCatalog,
        operations: new Map([[conditionedDescriptor.id, config]]),
      })
    );

    expect(() => quoteConditioned({
      inputMode: 'references',
      advancedDuration: 11,
    })).toThrowError(expect.objectContaining({
      fieldErrors: expect.objectContaining({
        advancedDuration: expect.any(String),
        videoReferences: expect.any(String),
      }),
    }));
    expect(() => quoteConditioned(
      { inputMode: 'frames' },
      { slots: { videoReferences: { count: 1, durationsSeconds: [2] } } },
    )).toThrowError(expect.objectContaining({
      fieldErrors: expect.objectContaining({
        videoReferences: expect.stringContaining('unavailable'),
      }),
    }));
  });

  it('fails closed when an authoritative provider variant is missing', () => {
    expect(resolveProviderModelId(null, 'default', 'compiled/fallback')).toBe('compiled/fallback');
    expect(() => resolveProviderModelId({
      ...operation('flat', { credits: 1 }),
      providerModelMap: { text: 'provider/text' },
    }, 'reference', 'compiled/fallback')).toThrow('provider model mapping');
  });
});
