import {
  IMAGE_MODELS,
  MOTION_MODELS,
  VIDEO_MODELS,
  type ImageModelId,
  type VideoModelId,
} from '@/lib/models';

import type {
  CatalogCondition,
  CatalogPrimitive,
  GenerationModelKind,
} from '@/lib/generation-model-catalog';

export const GENERATION_MODEL_ADAPTER_KEYS = [
  'image-v1',
  'video-v1',
  'motion-v1',
  'kie-task-v1',
] as const;

export const GENERATION_MODEL_PRICING_STRATEGIES = [
  'flat',
  'lookup',
  'per-second',
  'conditional',
  'reference-adjustment',
  // Accepted while schema-v1 releases are transitioned to declarative pricing.
  'image-v1',
  'video-v1',
  'motion-v1',
] as const;

export const GENERATION_MODEL_VALIDATION_STRATEGIES = [
  'descriptor-rules-v1',
  // Accepted while schema-v1 releases are transitioned to descriptor rules.
  'image-v1',
  'video-v1',
  'motion-v1',
] as const;

/**
 * Combined reference-video duration ceiling, in seconds, mirroring
 * `referenceAssetCapSeconds` in generation-model-catalog. Kie enforces these totals
 * regardless of how many reference files the model accepts.
 */
const REFERENCE_VIDEO_SECONDS_CAPS: Record<string, number> = {
  'seedance-2': 15,
  'seedance-2-fast': 15,
  'seedance-2-mini': 15,
  'seedance-2-5': 30,
  'minimax-h3': 15,
};

/**
 * Reference-image capacity per video model, mirroring `VIDEO_INPUT_LIMITS.images` in
 * generation-model-catalog. The two tables cannot share a constant — catalog imports
 * this module, so the dependency only runs one way — so a test pins them in agreement.
 * A model missing here has its reference mode capped at 0 and cannot attach an image.
 */
const VIDEO_REFERENCE_IMAGE_CAPS: Record<string, number> = {
  'seedance-1.5-pro': 2,
  'seedance-2': 5,
  'seedance-2-fast': 5,
  'seedance-2-mini': 5,
  'seedance-2-5': 30,
  'wan-2.7': 5,
  'happyhorse-1.1': 9,
  'gemini-omni-video': 7,
  'veo-3.1': 3,
  'grok-imagine-video': 1,
  'kling-o3': 7,
  'minimax-h3': 9,
};

export const GENERATION_MODEL_VALIDATION_RULE_TYPES = [
  'control-options',
  'control-range',
  'max-slot-count',
  'min-slot-count',
  'combined-duration',
  'mutually-exclusive-slots',
  'weighted-slot-count',
  'forbidden-combination',
] as const;

export type GenerationModelAdapterKey = typeof GENERATION_MODEL_ADAPTER_KEYS[number];
export type GenerationModelPricingStrategy = typeof GENERATION_MODEL_PRICING_STRATEGIES[number];
export type GenerationModelValidationStrategy = typeof GENERATION_MODEL_VALIDATION_STRATEGIES[number];
export type GenerationModelValidationRuleType = typeof GENERATION_MODEL_VALIDATION_RULE_TYPES[number];

export type GenerationModelOperationalConfig = {
  modelId: string;
  kind: GenerationModelKind;
  adapterKey: GenerationModelAdapterKey;
  adapterConfig: Record<string, unknown>;
  providerModelMap: Record<string, string>;
  pricingStrategy: GenerationModelPricingStrategy;
  pricingConfig: Record<string, unknown>;
  validationStrategy: GenerationModelValidationStrategy;
  validationConfig: Record<string, unknown>;
  verificationConfig: Record<string, unknown>;
};

export type GenerationModelRuntimeInputs = {
  counts: {
    images: number;
    videos: number;
    audios: number;
    preparedAudios: number;
    characters: number;
  };
  slotCounts: Record<string, number>;
  slotDurationsSeconds: Record<string, number[]>;
  referenceVideoDurationsSeconds: number[];
};

type PricingSelector = {
  source: 'setting' | 'inputCount';
  key: string;
  defaultValue?: CatalogPrimitive;
  presence?: boolean;
};

type PricingExpression = {
  strategy: Exclude<GenerationModelPricingStrategy, 'image-v1' | 'video-v1' | 'motion-v1'>;
  config: Record<string, unknown>;
};

const IMAGE_PROVIDER_MODELS: Record<ImageModelId, Record<string, string>> = {
  'nano-banana-2-lite': { default: 'nano-banana-2-lite' },
  'nano-banana-2': { default: 'nano-banana-2' },
  'nano-banana-pro': { default: 'nano-banana-pro' },
  'gpt-image-2': {
    text: 'gpt-image-2-text-to-image',
    reference: 'gpt-image-2-image-to-image',
  },
  'seedream-5-pro': {
    text: 'seedream/5-pro-text-to-image',
    reference: 'seedream/5-pro-image-to-image',
  },
  'seedream-5-lite': {
    text: 'seedream/5-lite-text-to-image',
    reference: 'seedream/5-lite-image-to-image',
  },
  // Wan publishes its image models under a slashed, dash-separated id. Sending
  // the dotted app id here is what Kie rejects with "The model name you
  // specified is not supported" (422) — the same correction the 2026-07-25
  // release applied to the database catalog and to the fallback in
  // generation-services.ts, which this table shadows whenever a catalog entry
  // exists (i.e. always). VIDEO_PROVIDER_MODELS['wan-2.7'] already carries the
  // slashed form.
  'wan-2.7-image': { default: 'wan/2-7-image' },
  'wan-2.7-image-pro': { default: 'wan/2-7-image-pro' },
  'imagen-4-fast': { default: 'google/imagen4-fast' },
  'imagen-4': { default: 'google/imagen4' },
  'imagen-4-ultra': { default: 'google/imagen4-ultra' },
  'ideogram-v3': {
    text: 'ideogram/v3-text-to-image',
    reference: 'ideogram/v3-remix',
  },
  'flux-2-pro': {
    text: 'flux-2/pro-text-to-image',
    reference: 'flux-2/pro-image-to-image',
  },
  'z-image': { default: 'z-image' },
  'grok-imagine-image': {
    text: 'grok-imagine/text-to-image',
    reference: 'grok-imagine/image-to-image',
  },
  // Grok Imagine 2.0 exposes an image-edit endpoint too, but it edits a prior Kie task by id
  // rather than an uploaded image, so only the text variant is reachable from our flow.
  'grok-imagine-image-2': {
    default: 'grok-imagine-image-2-0/text-to-image',
    text: 'grok-imagine-image-2-0/text-to-image',
  },
  'qwen3': {
    text: 'qwen3/text-to-image',
    reference: 'qwen3/image-to-image',
  },
  // The docs path is market/qwen3-pro/*, but the provider ids nest Pro under the qwen3 vendor.
  'qwen3-pro': {
    text: 'qwen3/pro-text-to-image',
    reference: 'qwen3/pro-image-to-image',
  },
  // Character references are mandatory, so both admission modes resolve to the same endpoint.
  'ideogram-character': {
    default: 'ideogram/character',
    text: 'ideogram/character',
    reference: 'ideogram/character',
  },
};

/**
 * Shared by both Nano Banana tiers — they take the same provider fields, so keeping one
 * definition stops a provider change from landing on one tier and missing the other.
 */
const NANO_BANANA_ADAPTER_CONFIG: Record<string, unknown> = {
  settings: {
    aspectRatio: { field: 'aspect_ratio' },
    resolution: { field: 'resolution' },
    outputFormat: { field: 'output_format' },
    googleSearch: { field: 'google_search' },
  },
  slots: { imageReferences: { field: 'image_input', cardinality: 'many', source: 'url' } },
};

/** Shared by both Qwen tiers, for the same reason. */
const QWEN_IMAGE_ADAPTER_CONFIG: Record<string, unknown> = {
  settings: {
    resolution: { field: 'resolution' },
    aspectRatio: { field: 'image_size' },
    outputFormat: { field: 'output_format', transform: 'jpg-to-jpeg' },
  },
  constants: { prompt_extend: true, nsfw_checker: true },
  slots: { imageReferences: { field: 'image_urls', cardinality: 'many', source: 'url' } },
  variantSelector: { type: 'slot-presence', slot: 'imageReferences', present: 'reference', absent: 'text' },
};

/**
 * Declarative kie-task-v1 adapter configs for image models whose provider payloads
 * are exactly expressible as bindings (no conditional field logic). Models listed
 * here run through `buildGenerationProviderRequest` instead of the hand-coded
 * payload ladder in generation-services; the ladder branches stay only as the
 * deployment-window fallback until the catalog release flips production, and the
 * golden tests in kie-task-image-adapter-parity.test.ts pin the two paths equal.
 *
 * Deliberately NOT migratable with the current transform set: seedream-5-pro/lite
 * (resolution→quality ternary), ideogram-v3/-character (aspect→image_size value
 * map), wan-2.7-image/-pro (per-image bbox_list), grok-imagine-image (fields
 * conditional on reference presence). Video models need per-variant field sets
 * the adapter cannot yet express.
 */
const KIE_TASK_IMAGE_ADAPTER_CONFIGS: Partial<Record<ImageModelId, Record<string, unknown>>> = {
  'imagen-4-fast': { settings: { aspectRatio: { field: 'aspect_ratio' } } },
  'imagen-4': { settings: { aspectRatio: { field: 'aspect_ratio' } } },
  'imagen-4-ultra': { settings: { aspectRatio: { field: 'aspect_ratio' } } },
  'z-image': {
    settings: { aspectRatio: { field: 'aspect_ratio' } },
    constants: { nsfw_checker: true },
  },
  'grok-imagine-image-2': { settings: { aspectRatio: { field: 'aspect_ratio' } } },
  'nano-banana-2-lite': {
    settings: { aspectRatio: { field: 'aspect_ratio' } },
    slots: { imageReferences: { field: 'image_urls', cardinality: 'many', source: 'url' } },
  },
  'nano-banana-2': NANO_BANANA_ADAPTER_CONFIG,
  'nano-banana-pro': NANO_BANANA_ADAPTER_CONFIG,
  'qwen3': QWEN_IMAGE_ADAPTER_CONFIG,
  'qwen3-pro': QWEN_IMAGE_ADAPTER_CONFIG,
  'flux-2-pro': {
    settings: {
      aspectRatio: { field: 'aspect_ratio' },
      resolution: { field: 'resolution' },
    },
    constants: { nsfw_checker: true },
    slots: { imageReferences: { field: 'input_urls', cardinality: 'many', source: 'url' } },
    variantSelector: { type: 'slot-presence', slot: 'imageReferences', present: 'reference', absent: 'text' },
  },
  'gpt-image-2': {
    settings: {
      aspectRatio: { field: 'aspect_ratio' },
      resolution: { field: 'resolution' },
    },
    slots: { imageReferences: { field: 'input_urls', cardinality: 'many', source: 'url' } },
    variantSelector: { type: 'slot-presence', slot: 'imageReferences', present: 'reference', absent: 'text' },
  },
};

const VIDEO_PROVIDER_MODELS: Record<VideoModelId, Record<string, string>> = {
  'kling-3.0-video': { default: 'kling-3.0/video' },
  'kling-3.0-turbo': {
    default: 'kling/v3-turbo-text-to-video',
    text: 'kling/v3-turbo-text-to-video',
    image: 'kling/v3-turbo-image-to-video',
  },
  'seedance-1.5-pro': { default: 'bytedance/seedance-1.5-pro' },
  'seedance-2': { default: 'bytedance/seedance-2' },
  'seedance-2-fast': { default: 'bytedance/seedance-2-fast' },
  'seedance-2-mini': { default: 'bytedance/seedance-2-mini' },
  'wan-2.7': {
    default: 'wan/2-7-text-to-video',
    text: 'wan/2-7-text-to-video',
    image: 'wan/2-7-image-to-video',
    reference: 'wan/2-7-r2v',
  },
  'happyhorse-1.1': {
    default: 'happyhorse-1-1/text-to-video',
    text: 'happyhorse-1-1/text-to-video',
    image: 'happyhorse-1-1/image-to-video',
    reference: 'happyhorse-1-1/reference-to-video',
  },
  'gemini-omni-video': { default: 'gemini-omni-video' },
  'hailuo-2.3': {
    default: 'hailuo/2-3-image-to-video-standard',
    standard: 'hailuo/2-3-image-to-video-standard',
    pro: 'hailuo/2-3-image-to-video-pro',
  },
  'veo-3.1': {
    default: 'veo3_fast',
    veo3_lite: 'veo3_lite',
    veo3_fast: 'veo3_fast',
    veo3: 'veo3',
  },
  'grok-imagine-video': {
    default: 'grok-imagine/text-to-video',
    text: 'grok-imagine/text-to-video',
    image: 'grok-imagine/image-to-video',
  },
  'seedance-2-5': { default: 'bytedance/seedance-2-5' },
  // Kling markets 3.0 Omni as "Kling O3"; the provider ids keep the versioned vendor prefix.
  'kling-o3': {
    default: 'kling-3.0-omni/text-to-video',
    text: 'kling-3.0-omni/text-to-video',
    image: 'kling-3.0-omni/image-to-video',
    reference: 'kling-3.0-omni/reference-to-video',
  },
  'minimax-h3': {
    default: 'minimax-h3/text-to-video',
    text: 'minimax-h3/text-to-video',
    image: 'minimax-h3/image-to-video',
    reference: 'minimax-h3/reference-to-video',
  },
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function selector(
  source: PricingSelector['source'],
  key: string,
  options: Pick<PricingSelector, 'defaultValue' | 'presence'> = {},
): PricingSelector {
  return { source, key, ...options };
}

function lookup(
  dimensions: PricingSelector[],
  table: unknown,
  fallbackCredits?: number,
): PricingExpression {
  return {
    strategy: 'lookup',
    config: {
      dimensions,
      table: cloneJson(table),
      ...(fallbackCredits === undefined ? {} : { fallbackCredits }),
    },
  };
}

function perSecond(rate: PricingExpression | number, durationSettingKey = 'duration'): PricingExpression {
  return {
    strategy: 'per-second',
    config: {
      durationSettingKey,
      rate,
      rounding: 'ceil',
    },
  };
}

function conditional(
  branches: Array<{ conditions: CatalogCondition[]; pricing: PricingExpression }>,
  fallback: PricingExpression,
): PricingExpression {
  return {
    strategy: 'conditional',
    config: { branches, fallback },
  };
}

function countTable(max: number, valueForCount: (count: number) => number): Record<string, number> {
  return Object.fromEntries(
    Array.from({ length: max + 1 }, (_, count) => [String(count), valueForCount(count)]),
  );
}

function imagePricingExpression(model: (typeof IMAGE_MODELS)[ImageModelId]): PricingExpression {
  if ('qualityPricing' in model && model.id === 'grok-imagine-image') {
    return conditional(
      [{
        conditions: [{
          source: 'inputCount',
          key: 'images',
          operator: 'greaterThan',
          value: 0,
        }],
        pricing: { strategy: 'flat', config: { credits: model.qualityPricing.imageToImage } },
      }],
      lookup(
        [selector('setting', 'qualityMode', { defaultValue: 'standard' })],
        {
          standard: model.qualityPricing.standard,
          quality: model.qualityPricing.quality,
        },
      ),
    );
  }
  if ('qualityPricing' in model && (model.id === 'ideogram-v3' || model.id === 'ideogram-character')) {
    return lookup(
      [selector('setting', 'qualityMode', { defaultValue: 'turbo' })],
      model.qualityPricing,
    );
  }
  if ('additionalReferenceCredit' in model) {
    // Seedream bundles the first reference into the base price; Qwen bills every one.
    const freeReferences = 'referenceCreditIncludesFirst' in model && model.referenceCreditIncludesFirst ? 0 : 1;
    const byResolutionAndCount = Object.fromEntries(
      Object.entries(model.pricing).map(([resolution, credits]) => [
        resolution,
        countTable(model.maxImages, (count) => (
          Math.ceil(Number(credits) + Math.max(0, count - freeReferences) * model.additionalReferenceCredit)
        )),
      ]),
    );
    return lookup(
      [
        selector('setting', 'resolution', { defaultValue: model.resolutions[0] }),
        selector('inputCount', 'images', { defaultValue: 0 }),
      ],
      byResolutionAndCount,
    );
  }
  return lookup(
    [selector('setting', 'resolution', { defaultValue: model.resolutions[0] })],
    model.pricing,
  );
}

function seedanceReferencePricing(
  model: (typeof VIDEO_MODELS)['seedance-2' | 'seedance-2-fast' | 'seedance-2-mini' | 'seedance-2-5'],
): PricingExpression {
  return {
    strategy: 'reference-adjustment',
    config: {
      unit: 'second',
      settingKey: 'resolution',
      durationSettingKey: 'duration',
      referenceDurationSlots: ['videoReferences'],
      rounding: 'ceil',
      rates: {
        noReference: Object.fromEntries(
          Object.entries(model.pricing).map(([resolution, rates]) => [resolution, rates.noVideo]),
        ),
        withReference: Object.fromEntries(
          Object.entries(model.pricing).map(([resolution, rates]) => [resolution, rates.withVideo]),
        ),
      },
    },
  };
}

function videoPricingExpression(model: (typeof VIDEO_MODELS)[VideoModelId]): PricingExpression {
  switch (model.id) {
    case 'kling-3.0-video':
      return perSecond(lookup(
        [
          selector('setting', 'mode', { defaultValue: 'std' }),
          selector('setting', 'sound', { defaultValue: false }),
        ],
        {
          std: { false: model.pricing.std.noSound, true: model.pricing.std.withSound },
          pro: { false: model.pricing.pro.noSound, true: model.pricing.pro.withSound },
        },
      ));
    case 'seedance-1.5-pro':
      return lookup(
        [
          selector('setting', 'resolution', { defaultValue: '480p' }),
          selector('setting', 'sound', { defaultValue: false }),
          selector('setting', 'duration', { defaultValue: 4 }),
        ],
        Object.fromEntries(Object.entries(model.pricing).map(([resolution, prices]) => [
          resolution,
          {
            false: prices.noSound,
            true: prices.withSound,
          },
        ])),
      );
    case 'seedance-2':
    case 'seedance-2-fast':
    case 'seedance-2-mini':
    case 'seedance-2-5':
      return seedanceReferencePricing(model);
    case 'kling-o3':
      return perSecond(lookup(
        [
          selector('setting', 'resolution', { defaultValue: '720p' }),
          selector('setting', 'sound', { defaultValue: false }),
        ],
        Object.fromEntries(Object.entries(model.pricing).map(([resolution, rates]) => [
          resolution,
          { false: rates.noSound, true: rates.withSound },
        ])),
      ));
    case 'kling-3.0-turbo':
    case 'wan-2.7':
    case 'happyhorse-1.1':
    case 'grok-imagine-video':
    case 'minimax-h3':
      return perSecond(lookup(
        [selector('setting', 'resolution', { defaultValue: model.resolutions[0] })],
        model.pricing,
      ));
    case 'gemini-omni-video':
      return conditional(
        [{
          conditions: [{
            source: 'inputCount',
            key: 'videos',
            operator: 'greaterThan',
            value: 0,
          }],
          pricing: lookup(
            [selector('setting', 'resolution', { defaultValue: '720p' })],
            {
              '720p': model.pricing.withVideo.standard,
              '1080p': model.pricing.withVideo.standard,
              '4k': model.pricing.withVideo['4k'],
            },
          ),
        }],
        lookup(
          [
            selector('setting', 'resolution', { defaultValue: '720p' }),
            selector('setting', 'duration', { defaultValue: 4 }),
          ],
          {
            '720p': model.pricing['720p'],
            '1080p': model.pricing['1080p'],
            '4k': model.pricing['4k'],
          },
        ),
      );
    case 'hailuo-2.3':
      return lookup(
        [
          selector('setting', 'mode', { defaultValue: 'standard' }),
          selector('setting', 'resolution', { defaultValue: '768P' }),
          selector('setting', 'duration', { defaultValue: 6 }),
        ],
        model.pricing,
      );
    case 'veo-3.1':
      return conditional(
        [{
          conditions: [{
            source: 'setting',
            key: 'mode',
            operator: 'equals',
            value: 'veo3',
          }],
          pricing: lookup(
            [
              selector('inputCount', 'images', { presence: true }),
              selector('setting', 'resolution', { defaultValue: '720p' }),
            ],
            {
              false: model.pricing.veo3.text,
              true: model.pricing.veo3.reference,
            },
          ),
        }],
        lookup(
          [
            selector('setting', 'mode', { defaultValue: 'veo3_fast' }),
            selector('setting', 'resolution', { defaultValue: '720p' }),
          ],
          {
            veo3_lite: model.pricing.veo3_lite,
            veo3_fast: model.pricing.veo3_fast,
          },
        ),
      );
  }
}

function validationConfigForModel(
  kind: GenerationModelKind,
  modelId: string,
): Record<string, unknown> {
  const rules: Array<Record<string, unknown>> = [];
  if (kind === 'image' && modelId === 'ideogram-character') {
    // `reference_image_urls` is required by the provider — there is no text-only
    // mode — so catch the empty case here rather than as a 422 from Kie.
    rules.push({
      type: 'min-slot-count',
      slotKey: 'imageReferences',
      min: 1,
      message: 'Add at least one character reference image.',
    });
  }
  if (kind === 'image' && modelId === 'gpt-image-2') {
    rules.push(
      {
        type: 'control-options',
        key: 'resolution',
        options: ['1K'],
        conditions: [
          { source: 'setting', key: 'aspectRatio', operator: 'equals', value: 'auto' },
        ],
        message: 'GPT Image 2 supports 1K output when aspect ratio is automatic.',
      },
      {
        type: 'control-options',
        key: 'resolution',
        options: ['1K', '2K'],
        conditions: [
          { source: 'setting', key: 'aspectRatio', operator: 'equals', value: '1:1' },
        ],
        message: 'GPT Image 2 supports 1K or 2K output for square images.',
      },
    );
  }
  if (kind === 'image' && modelId === 'wan-2.7-image-pro') {
    rules.push({
      type: 'forbidden-combination',
      conditions: [
        { source: 'setting', key: 'resolution', operator: 'equals', value: '4K' },
        { source: 'inputCount', key: 'images', operator: 'greaterThan', value: 0 },
      ],
      field: 'resolution',
      message: 'Wan 2.7 Image Pro supports 4K for text-to-image only.',
    });
  }
  if (kind === 'video') {
    rules.push(
      {
        type: 'max-slot-count',
        slotKey: 'images',
        max: 2,
        conditions: [{ source: 'setting', key: 'referenceMode', operator: 'equals', value: 'frames' }],
      },
    );
    // Every model that publishes reference-image capacity must appear here, or its
    // reference mode is capped at 0 by the else branch below and the quote rejects any
    // run that attaches one — which is exactly how seedance-2-5, kling-o3, and
    // minimax-h3 shipped with their reference support unreachable.
    const max = VIDEO_REFERENCE_IMAGE_CAPS[modelId];
    if (max !== undefined) {
      rules.push({
        type: 'max-slot-count',
        slotKey: 'images',
        max,
        conditions: [{ source: 'setting', key: 'referenceMode', operator: 'equals', value: 'elements' }],
      });
    } else {
      rules.push({
        type: 'max-slot-count',
        slotKey: 'images',
        max: 0,
        conditions: [{ source: 'setting', key: 'referenceMode', operator: 'equals', value: 'elements' }],
        message: modelId === 'kling-3.0-video'
          ? 'Reusable image references are not available for Kling yet.'
          : 'Reusable references are not available for this model yet.',
      });
    }
    if (modelId === 'kling-o3') {
      // Named multi-image subjects: 3 subjects × 4 images. Per-subject grouping
      // (2–4 images each) is enforced in generation-services.
      rules.push({
        type: 'max-slot-count',
        slotKey: 'images',
        max: 12,
        conditions: [{ source: 'setting', key: 'referenceMode', operator: 'equals', value: 'subjects' }],
      });
    }
    if (modelId === 'veo-3.1') {
      rules.push({
        type: 'max-slot-count',
        slotKey: 'images',
        max: 0,
        conditions: [
          { source: 'setting', key: 'referenceMode', operator: 'equals', value: 'elements' },
          { source: 'setting', key: 'mode', operator: 'notIn', value: ['veo3_lite', 'veo3_fast'] },
        ],
        message: 'Reusable references require Veo Lite or Fast.',
      });
    }
    if (modelId === 'wan-2.7') {
      rules.push({
        type: 'weighted-slot-count',
        weights: { images: 1, videos: 1, audios: 1 },
        max: 5,
        conditions: [{ source: 'setting', key: 'referenceMode', operator: 'equals', value: 'elements' }],
        field: 'references',
        message: 'Wan 2.7 supports up to 5 reusable references in total.',
      });
    }
    if (modelId === 'gemini-omni-video') {
      rules.push(
        {
          type: 'max-slot-count',
          slotKey: 'characters',
          max: 3,
          message: 'Gemini Omni supports up to 3 prepared character references.',
        },
        {
          type: 'max-slot-count',
          slotKey: 'preparedAudios',
          max: 3,
          message: 'Gemini Omni supports up to 3 prepared voice references.',
        },
        {
          type: 'weighted-slot-count',
          weights: { images: 1, videos: 2, characters: 1 },
          max: 7,
          field: 'references',
          message: 'Gemini Omni supports seven reference slots; videos use two and characters use one.',
        },
      );
    }
    if (modelId === 'hailuo-2.3') {
      rules.push(
        {
          type: 'min-slot-count',
          slotKey: 'images',
          min: 1,
          conditions: [{ source: 'setting', key: 'referenceMode', operator: 'equals', value: 'frames' }],
          message: 'Hailuo 2.3 requires a start image.',
        },
        {
          type: 'forbidden-combination',
          conditions: [
            { source: 'setting', key: 'resolution', operator: 'equals', value: '1080P' },
            { source: 'setting', key: 'duration', operator: 'equals', value: 10 },
          ],
          field: 'duration',
          message: 'Hailuo 2.3 supports 1080P output at 6 seconds only.',
        },
      );
    }
    // Kie caps the combined duration of reference videos separately from the file
    // count, so the extra slots seedance-2-5 and minimax-h3 accept buy more clips, not
    // more footage. 2.5 reaches 30s; the rest of the Seedance 2 family and minimax-h3
    // stop at 15.
    const referenceSeconds = REFERENCE_VIDEO_SECONDS_CAPS[modelId];
    if (referenceSeconds !== undefined) {
      rules.push({
        type: 'combined-duration',
        slotKeys: ['videoReferences'],
        max: referenceSeconds,
        field: 'videos',
        message: `Reference videos may be at most ${referenceSeconds} seconds in total.`,
      });
    }
    if (modelId === 'minimax-h3') {
      // minimax-h3/reference-to-video declares `anyOf: [reference_image_urls,
      // reference_video_urls]` and spells it out in prose: "reference_audio cannot be
      // used alone, it must be accompanied by reference_image or reference_video".
      // Audio alone still routes to the reference endpoint (see the minimax branch in
      // generation-services), so without this the provider 422s after we have already
      // quoted the run. Deliberately unconditional on referenceMode: the routing keys
      // off attached audio, not the mode.
      rules.push({
        type: 'forbidden-combination',
        conditions: [
          { source: 'inputCount', key: 'audioReferences', operator: 'greaterThan', value: 0 },
          { source: 'inputCount', key: 'imageReferences', operator: 'equals', value: 0 },
          { source: 'inputCount', key: 'videoReferences', operator: 'equals', value: 0 },
        ],
        field: 'audios',
        message: 'MiniMax H3 needs a reference image or video alongside reference audio.',
      });
    }
  }
  const normalizedDefaults = kind === 'image'
    ? { outputFormat: 'jpg', googleSearch: false }
    : kind === 'video'
      ? {
          mode: '',
          resolution: '',
          sound: false,
          fixedLens: false,
          referenceMode: 'frames',
        }
      : {};
  return {
    passthroughSettingKeys: kind === 'video' ? ['referenceMode'] : [],
    normalizedDefaults,
    rules,
  };
}

export function buildCodeGenerationModelOperations(): GenerationModelOperationalConfig[] {
  const imageEntries = Object.values(IMAGE_MODELS).map((model) => {
    const pricing = imagePricingExpression(model);
    const kieTaskAdapterConfig = KIE_TASK_IMAGE_ADAPTER_CONFIGS[model.id];
    return {
      modelId: model.id,
      kind: 'image' as const,
      adapterKey: kieTaskAdapterConfig ? ('kie-task-v1' as const) : ('image-v1' as const),
      adapterConfig: kieTaskAdapterConfig ?? {},
      providerModelMap: IMAGE_PROVIDER_MODELS[model.id],
      pricingStrategy: pricing.strategy,
      pricingConfig: pricing.config,
      validationStrategy: 'descriptor-rules-v1' as const,
      validationConfig: validationConfigForModel('image', model.id),
      verificationConfig: { mode: 'manual', provider: 'kie' },
    };
  });
  const videoEntries = Object.values(VIDEO_MODELS).map((model) => {
    const pricing = videoPricingExpression(model);
    return {
      modelId: model.id,
      kind: 'video' as const,
      adapterKey: 'video-v1' as const,
      adapterConfig: {},
      providerModelMap: VIDEO_PROVIDER_MODELS[model.id],
      pricingStrategy: pricing.strategy,
      pricingConfig: pricing.config,
      validationStrategy: 'descriptor-rules-v1' as const,
      validationConfig: validationConfigForModel('video', model.id),
      verificationConfig: { mode: 'manual', provider: 'kie' },
    };
  });
  const motionEntries = Object.values(MOTION_MODELS).map((model) => ({
    modelId: model.id,
    kind: 'motion' as const,
    adapterKey: 'motion-v1' as const,
    adapterConfig: {},
    providerModelMap: { default: model.apiModelId },
    pricingStrategy: 'per-second' as const,
    pricingConfig: perSecond(
      lookup(
        [selector('setting', 'resolution', { defaultValue: model.resolutions[0] })],
        model.pricing,
      ),
    ).config,
    validationStrategy: 'descriptor-rules-v1' as const,
    validationConfig: validationConfigForModel('motion', model.id),
    verificationConfig: { mode: 'manual', provider: 'kie' },
  }));

  return [...imageEntries, ...videoEntries, ...motionEntries];
}

export function resolveProviderModelId(
  config: GenerationModelOperationalConfig | null | undefined,
  variant: string,
  fallback: string,
): string {
  if (!config) return fallback;
  const configured = config?.providerModelMap[variant] ?? config?.providerModelMap.default;
  if (typeof configured === 'string' && configured.trim()) return configured;
  throw new Error(
    `The published provider model mapping for ${config.modelId} variant ${variant} is unavailable.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function normalizedRuntimeInputs(
  value: GenerationModelRuntimeInputs | GenerationModelRuntimeInputs['counts'],
): GenerationModelRuntimeInputs {
  if ('counts' in value) return value;
  return {
    counts: value,
    slotCounts: {},
    slotDurationsSeconds: {},
    referenceVideoDurationsSeconds: [],
  };
}

function inputCount(inputs: GenerationModelRuntimeInputs, key: string): number {
  if (key in inputs.slotCounts) return inputs.slotCounts[key] ?? 0;
  return inputs.counts[key as keyof GenerationModelRuntimeInputs['counts']] ?? 0;
}

function conditionActualValue(
  condition: CatalogCondition,
  settings: Record<string, CatalogPrimitive>,
  inputs: GenerationModelRuntimeInputs,
): CatalogPrimitive {
  return condition.source === 'setting'
    ? settings[condition.key] ?? ''
    : inputCount(inputs, condition.key);
}

export function generationModelConditionMatches(
  condition: CatalogCondition,
  settings: Record<string, CatalogPrimitive>,
  inputValue: GenerationModelRuntimeInputs | GenerationModelRuntimeInputs['counts'],
): boolean {
  const inputs = normalizedRuntimeInputs(inputValue);
  const actual = conditionActualValue(condition, settings, inputs);
  const expected = condition.value;
  switch (condition.operator) {
    case 'equals':
      return actual === expected;
    case 'notEquals':
      return actual !== expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'notIn':
      return Array.isArray(expected) && !expected.includes(actual);
    case 'greaterThan':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'greaterThanOrEqual':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
  }
}

function allConditionsMatch(
  value: unknown,
  settings: Record<string, CatalogPrimitive>,
  inputs: GenerationModelRuntimeInputs,
): boolean {
  return Array.isArray(value)
    && value.every((condition) => (
      isRecord(condition)
      && generationModelConditionMatches(condition as unknown as CatalogCondition, settings, inputs)
    ));
}

function selectorValue(
  rawSelector: unknown,
  settings: Record<string, CatalogPrimitive>,
  inputs: GenerationModelRuntimeInputs,
): string {
  if (!isRecord(rawSelector) || (rawSelector.source !== 'setting' && rawSelector.source !== 'inputCount') || typeof rawSelector.key !== 'string') {
    throw new Error('Invalid pricing lookup selector.');
  }
  const actual = rawSelector.source === 'setting'
    ? settings[rawSelector.key] ?? rawSelector.defaultValue
    : inputCount(inputs, rawSelector.key);
  if (rawSelector.presence === true) return String(Number(actual ?? 0) > 0);
  if (typeof actual !== 'string' && typeof actual !== 'number' && typeof actual !== 'boolean') {
    throw new Error(`Pricing selector ${rawSelector.key} is unavailable.`);
  }
  return String(actual);
}

function lookupCost(
  config: Record<string, unknown>,
  settings: Record<string, CatalogPrimitive>,
  inputs: GenerationModelRuntimeInputs,
): number {
  if (!Array.isArray(config.dimensions) || !isRecord(config.table)) {
    throw new Error('Invalid lookup pricing configuration.');
  }
  let value: unknown = config.table;
  for (const dimension of config.dimensions) {
    const key = selectorValue(dimension, settings, inputs);
    value = isRecord(value) ? value[key] : undefined;
  }
  const selected = finiteNumber(value);
  if (selected !== null) return selected;
  const fallback = finiteNumber(config.fallbackCredits);
  if (fallback !== null) return fallback;
  throw new Error('The selected settings have no configured price.');
}

function pricingExpression(value: unknown): PricingExpression {
  if (!isRecord(value) || typeof value.strategy !== 'string' || !isRecord(value.config)) {
    throw new Error('Invalid nested pricing expression.');
  }
  if (!GENERATION_MODEL_PRICING_STRATEGIES.includes(value.strategy as GenerationModelPricingStrategy)) {
    throw new Error(`Unsupported pricing strategy ${value.strategy}.`);
  }
  return value as unknown as PricingExpression;
}

function roundCost(value: number, rounding: unknown): number {
  if (rounding === 'none') return value;
  if (rounding === 'round') return Math.round(value);
  if (rounding === 'floor') return Math.floor(value);
  return Math.ceil(value);
}

function evaluateReferenceAdjustment(
  config: Record<string, unknown>,
  settings: Record<string, CatalogPrimitive>,
  inputs: GenerationModelRuntimeInputs,
): number {
  if (config.unit !== 'second'
    || typeof config.settingKey !== 'string'
    || typeof config.durationSettingKey !== 'string'
    || !Array.isArray(config.referenceDurationSlots)
    || !isRecord(config.rates)
    || !isRecord(config.rates.noReference)
    || !isRecord(config.rates.withReference)) {
    throw new Error('Invalid reference-adjustment pricing configuration.');
  }
  const resolution = settings[config.settingKey];
  const outputDuration = finiteNumber(settings[config.durationSettingKey]);
  if (typeof resolution !== 'string' || outputDuration === null || outputDuration < 0) {
    throw new Error('Reference-adjustment pricing inputs are unavailable.');
  }
  const slotKeys = config.referenceDurationSlots.filter((slot): slot is string => typeof slot === 'string');
  const durations = slotKeys.flatMap((slotKey) => (
    inputs.slotDurationsSeconds[slotKey]
      ?? (slotKey === 'videoReferences' ? inputs.referenceVideoDurationsSeconds : [])
  ));
  const referenceCount = slotKeys.reduce((total, slotKey) => total + inputCount(inputs, slotKey), 0);
  const hasReferences = referenceCount > 0
    || durations.length > 0
    || (slotKeys.includes('videoReferences') && inputs.counts.videos > 0);
  if (hasReferences && durations.length < referenceCount) {
    throw new Error('Reference duration metadata is required for authoritative pricing.');
  }
  const rateTable = hasReferences ? config.rates.withReference : config.rates.noReference;
  const rate = finiteNumber(rateTable[resolution]);
  if (rate === null || rate < 0) {
    throw new Error(`No reference-adjustment rate is configured for ${resolution}.`);
  }
  const referenceDuration = hasReferences
    ? durations.reduce((total, duration) => total + duration, 0)
    : 0;
  return roundCost((outputDuration + referenceDuration) * rate, config.rounding);
}

function evaluatePricing(
  strategy: GenerationModelPricingStrategy,
  config: Record<string, unknown>,
  settings: Record<string, CatalogPrimitive>,
  inputs: GenerationModelRuntimeInputs,
  depth = 0,
): number {
  if (depth > 4) throw new Error('Pricing configuration is nested too deeply.');
  if (strategy === 'flat') {
    const cost = finiteNumber(config.credits);
    if (cost === null) throw new Error('Invalid flat pricing configuration.');
    return cost;
  }
  if (strategy === 'lookup') return lookupCost(config, settings, inputs);
  if (strategy === 'per-second') {
    if (typeof config.durationSettingKey !== 'string') {
      throw new Error('Invalid per-second pricing configuration.');
    }
    const duration = finiteNumber(settings[config.durationSettingKey]);
    if (duration === null || duration < 0) throw new Error('Pricing duration is unavailable.');
    const rate = finiteNumber(config.rate)
      ?? (() => {
        const nested = pricingExpression(config.rate);
        return evaluatePricing(nested.strategy, nested.config, settings, inputs, depth + 1);
      })();
    return roundCost(duration * rate, config.rounding);
  }
  if (strategy === 'conditional') {
    if (!Array.isArray(config.branches)) throw new Error('Invalid conditional pricing configuration.');
    for (const branch of config.branches) {
      if (!isRecord(branch)) throw new Error('Invalid conditional pricing branch.');
      if (allConditionsMatch(branch.conditions, settings, inputs)) {
        const nested = pricingExpression(branch.pricing);
        return evaluatePricing(nested.strategy, nested.config, settings, inputs, depth + 1);
      }
    }
    const fallback = pricingExpression(config.fallback);
    return evaluatePricing(fallback.strategy, fallback.config, settings, inputs, depth + 1);
  }
  if (strategy === 'reference-adjustment') {
    return evaluateReferenceAdjustment(config, settings, inputs);
  }
  return evaluateLegacyPricing(strategy, config, settings, inputs);
}

function evaluateLegacyPricing(
  strategy: 'image-v1' | 'video-v1' | 'motion-v1',
  config: Record<string, unknown>,
  settings: Record<string, CatalogPrimitive>,
  inputs: GenerationModelRuntimeInputs,
): number {
  const modelId = typeof config.id === 'string' ? config.id : '';
  const codeConfig = buildCodeGenerationModelOperations().find((entry) => (
    entry.modelId === modelId && entry.pricingStrategy !== strategy
  ));
  if (!codeConfig) {
    throw new Error(`Legacy pricing configuration for ${modelId || 'unknown model'} cannot be migrated.`);
  }

  // The compatibility release's database values remain authoritative. Rebuild
  // the declarative expression with those values instead of using code prices.
  let expression: PricingExpression;
  if (strategy === 'image-v1' && modelId in IMAGE_MODELS) {
    expression = imagePricingExpression(config as unknown as (typeof IMAGE_MODELS)[ImageModelId]);
  } else if (strategy === 'video-v1' && modelId in VIDEO_MODELS) {
    expression = videoPricingExpression(config as unknown as (typeof VIDEO_MODELS)[VideoModelId]);
  } else if (strategy === 'motion-v1') {
    const resolutions = Array.isArray(config.resolutions) ? config.resolutions : [];
    const defaultResolution = typeof resolutions[0] === 'string' ? resolutions[0] : '720p';
    expression = perSecond(lookup(
      [selector('setting', 'resolution', { defaultValue: defaultResolution })],
      config.pricing,
    ));
  } else {
    throw new Error(`Legacy pricing strategy ${strategy} does not match ${modelId}.`);
  }
  return evaluatePricing(expression.strategy, expression.config, settings, inputs, 1);
}

export function calculateGenerationModelRuntimeCost(
  config: GenerationModelOperationalConfig,
  settings: Record<string, CatalogPrimitive>,
  inputValue: GenerationModelRuntimeInputs | GenerationModelRuntimeInputs['counts'],
): number {
  const cost = evaluatePricing(
    config.pricingStrategy,
    config.pricingConfig,
    settings,
    normalizedRuntimeInputs(inputValue),
  );
  if (!Number.isFinite(cost) || cost < 0) {
    throw new Error(`Invalid pricing configuration for ${config.modelId}.`);
  }
  const billableCredits = Math.ceil(cost);
  if (!Number.isSafeInteger(billableCredits)) {
    throw new Error(`Invalid pricing configuration for ${config.modelId}.`);
  }
  return billableCredits;
}
