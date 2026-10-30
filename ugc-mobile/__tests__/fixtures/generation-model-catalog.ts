import {
  parseModelCatalogDetail,
  type CatalogControl,
  type GenerationModelCatalog,
  type GenerationModelDescriptor,
  type GenerationModelKind,
} from '../../lib/generation-model-catalog';
import publishedDefaults from './published-default-descriptors.json';

function controls(kind: GenerationModelKind): CatalogControl[] {
  if (kind === 'motion') {
    return [
      { key: 'resolution', label: 'Resolution', type: 'choice', presentation: 'chips', defaultValue: '720p', options: [{ value: '720p', label: '720p' }, { value: '1080p', label: '1080p' }] },
      { key: 'characterOrientation', label: 'Orientation', type: 'choice', presentation: 'chips', defaultValue: 'video', options: [{ value: 'video', label: 'Video' }, { value: 'image', label: 'Image' }] },
      { key: 'duration', label: 'Duration', type: 'integer', presentation: 'stepper', defaultValue: 10, min: 1, max: 30, step: 1, unit: 'seconds' },
    ];
  }
  if (kind === 'video') {
    return [
      { key: 'aspectRatio', label: 'Aspect ratio', type: 'choice', presentation: 'chips', defaultValue: '16:9', options: [{ value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }] },
      { key: 'mode', label: 'Mode', type: 'choice', presentation: 'chips', defaultValue: 'std', options: [{ value: 'std', label: 'Standard' }, { value: 'pro', label: 'Pro' }] },
      { key: 'duration', label: 'Duration', type: 'integer', presentation: 'stepper', defaultValue: 5, min: 3, max: 15, step: 1, unit: 'seconds' },
      { key: 'sound', label: 'Sound', type: 'boolean', presentation: 'toggle', defaultValue: false },
    ];
  }
  return [
    { key: 'aspectRatio', label: 'Aspect ratio', type: 'choice', presentation: 'chips', defaultValue: '4:5', options: [{ value: '4:5', label: '4:5' }, { value: '3:2', label: '3:2' }, { value: '1:1', label: '1:1' }] },
    { key: 'resolution', label: 'Resolution', type: 'choice', presentation: 'chips', defaultValue: '1K', options: [{ value: '1K', label: '1K' }] },
  ];
}

function model(
  id: string,
  kind: GenerationModelKind,
  displayName: string,
  overrides: Partial<GenerationModelDescriptor> = {}
): GenerationModelDescriptor {
  return {
    id,
    kind,
    displayName,
    description: `${displayName} test descriptor`,
    badge: null,
    recommended: false,
    sortOrder: 0,
    minClientSchemaVersion: 1,
    controls: controls(kind),
    capabilities: { multiShot: false, sound: kind === 'video', fixedLens: false, googleSearch: false, outputFormat: false },
    inputs: {
      imageReferences: kind === 'image' ? { max: 14, supportsNaming: true } : null,
      videoReferences: kind === 'motion' ? { max: 1 } : null,
      audioReferences: null,
      startFrame: kind === 'video',
      endFrame: kind === 'video',
    },
    ...overrides,
  };
}

export function createTestGenerationModelCatalog(extraModels: GenerationModelDescriptor[] = []): GenerationModelCatalog {
  return {
    schemaVersion: 1,
    revision: 'test-catalog-rev',
    defaults: { image: 'nano-banana-2', video: 'kling-3.0-video', motion: 'kling-3.0' },
    models: [
      model('nano-banana-2', 'image', 'Nano Banana 2.0', { badge: 'Recommended', recommended: true }),
      model('nano-banana-pro', 'image', 'Nano Banana Pro', { badge: 'Pro' }),
      model('gpt-image-2', 'image', 'GPT Image 2', { badge: 'New' }),
      model('grok-imagine-image', 'image', 'Grok Imagine', {
        badge: 'New',
        controls: [
          { key: 'aspectRatio', label: 'Aspect ratio', type: 'choice', presentation: 'chips', defaultValue: '3:2', options: [{ value: '3:2', label: '3:2' }, { value: '2:3', label: '2:3' }, { value: '1:1', label: '1:1' }, { value: '9:16', label: '9:16' }, { value: '16:9', label: '16:9' }] },
          { key: 'resolution', label: 'Resolution', type: 'choice', presentation: 'chips', defaultValue: '1K', options: [{ value: '1K', label: '1K' }] },
          { key: 'qualityMode', label: 'Quality', type: 'choice', presentation: 'chips', defaultValue: 'standard', options: [{ value: 'standard', label: 'Standard' }, { value: 'quality', label: 'Quality' }] },
        ],
        inputs: { imageReferences: { max: 1, supportsNaming: true }, videoReferences: null, audioReferences: null, startFrame: false, endFrame: false },
      }),
      model('kling-3.0-video', 'video', 'Kling 3.0 Cinematic', { recommended: true }),
      model('kling-2.6', 'motion', 'Kling 2.6'),
      model('kling-3.0', 'motion', 'Kling 3.0', { recommended: true }),
      ...extraModels,
    ],
  };
}

export const remoteImageModel = model('remote-image-v1', 'image', 'Remote Image V1', {
  badge: 'New',
  controls: [
    { key: 'aspectRatio', label: 'Aspect ratio', type: 'choice', presentation: 'chips', defaultValue: '2:3', options: [{ value: '2:3', label: '2:3' }, { value: '1:1', label: '1:1' }] },
    { key: 'resolution', label: 'Resolution', type: 'choice', presentation: 'chips', defaultValue: '2K', options: [{ value: '2K', label: '2K' }] },
  ],
  inputs: { imageReferences: { max: 3, supportsNaming: true }, videoReferences: null, audioReferences: null, startFrame: false, endFrame: false },
});

function choiceControl(
  key: string,
  label: string,
  defaultValue: string,
  values: string[],
  presentation: 'chips' | 'select' = 'chips',
  normalizedValueType?: 'string' | 'number',
): CatalogControl {
  return {
    key, label, type: 'choice', presentation, defaultValue, options: values.map((value) => ({ value, label: value })),
    ...(normalizedValueType ? { normalizedValueType } : {}),
  };
}

const seedanceReferenceModeIs = (value: 'frames' | 'elements') => [
  { source: 'setting' as const, key: 'referenceMode', operator: 'equals' as const, value },
];

/**
 * Seedance 1.5 Pro as the production mobile catalog publishes it (revision pixverse-mobile-20261008): the
 * guided first video's starting model. Its duration is a choice of strings, and nothing in a run needs a picture.
 */
export const seedance15ProModel = model('seedance-1.5-pro', 'video', 'Seedance 1.5 Pro', {
  sortOrder: 20,
  controls: [
    choiceControl('aspectRatio', 'Aspect ratio', '1:1', ['1:1', '21:9', '4:3', '3:4', '16:9', '9:16']),
    choiceControl('resolution', 'Resolution', '480p', ['480p', '720p', '1080p']),
    // The server answers this choice as a number in a quote's normalized settings.
    choiceControl('duration', 'Duration', '4', ['4', '8', '12'], 'chips', 'number'),
    { key: 'sound', label: 'Sound', type: 'boolean', presentation: 'toggle', defaultValue: false },
    { key: 'fixedLens', label: 'Fixed lens', type: 'boolean', presentation: 'toggle', defaultValue: false },
    choiceControl('referenceMode', 'Input mode', 'frames', ['frames', 'elements']),
  ],
  capabilities: { multiShot: false, sound: true, fixedLens: true, googleSearch: false, outputFormat: false },
  inputs: { imageReferences: { max: 2, supportsNaming: true }, videoReferences: null, audioReferences: null, startFrame: true, endFrame: true },
  inputModes: [
    {
      key: 'frames',
      label: 'Frames',
      default: true,
      conditions: seedanceReferenceModeIs('frames'),
      slots: [
        { key: 'startFrame', kind: 'image', role: 'startFrame', label: 'Start frame', min: 0, max: 1 },
        { key: 'endFrame', kind: 'image', role: 'endFrame', label: 'End frame', min: 0, max: 1 },
      ],
    },
    {
      key: 'references',
      label: 'Reusable references',
      default: false,
      conditions: seedanceReferenceModeIs('elements'),
      slots: [{ key: 'imageReferences', kind: 'image', role: 'reference', label: 'Reference images', min: 0, max: 2, supportsNaming: true }],
    },
  ],
});

/** Production's seedance-2-mini controls (wan-start-frame-apart-20261019): an integer duration, 4–15 s. */
export const seedance2MiniModel = model('seedance-2-mini', 'video', 'Seedance 2 Mini', {
  sortOrder: 24,
  controls: [
    choiceControl('aspectRatio', 'Aspect ratio', '16:9', ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9']),
    choiceControl('resolution', 'Resolution', '480p', ['480p', '720p']),
    { key: 'duration', label: 'Duration', type: 'integer', presentation: 'stepper', unit: 'seconds', min: 4, max: 15, step: 1, defaultValue: 10 },
    { key: 'sound', label: 'Sound', type: 'boolean', presentation: 'toggle', defaultValue: false },
    choiceControl('referenceMode', 'Input mode', 'frames', ['frames', 'elements']),
  ],
  capabilities: { multiShot: false, sound: true, fixedLens: false, googleSearch: false, outputFormat: false },
  inputs: { imageReferences: { max: 5, supportsNaming: true }, videoReferences: { max: 3 }, audioReferences: { max: 3 }, startFrame: true, endFrame: true },
});

/** Seedance 2 Mini as the release that made it the default video published it (mini-default-video-20261028): 5 s by default. */
export const seedance2MiniAtRelease: GenerationModelDescriptor = {
  ...seedance2MiniModel,
  controls: seedance2MiniModel.controls.map((control) => (
    control.key === 'duration' && control.type === 'integer' ? { ...control, defaultValue: 5 } : control
  )),
};

/**
 * Veo 3.1 as release veo-quality-references-20261030 publishes it: production's descriptor field for field
 * (src/__tests__/fixtures/production-video-descriptors-2026-10-29.json), with the one change that release
 * makes. Its reference pictures open on Lite and Fast only, the variants Kie's REFERENCE_2_VIDEO takes,
 * through an `in` condition on `mode` beside `referenceMode`; on Quality a run goes as frames, and pictures a
 * draft holds wait apart.
 */
export const veo31Model = model('veo-3.1', 'video', 'Veo 3.1', {
  description: 'Google-class video generation with fast and quality variants',
  sortOrder: 100,
  controls: [
    choiceControl('aspectRatio', 'Aspect ratio', '16:9', ['16:9', '9:16', 'Auto']),
    {
      key: 'mode',
      label: 'Model variant',
      type: 'choice',
      presentation: 'chips',
      defaultValue: 'veo3_lite',
      options: [{ value: 'veo3_lite', label: 'Lite' }, { value: 'veo3_fast', label: 'Fast' }, { value: 'veo3', label: 'Quality' }],
    },
    choiceControl('resolution', 'Resolution', '720p', ['720p', '1080p', '4k']),
    choiceControl('duration', 'Duration', '8', ['8'], 'chips', 'number'),
    {
      key: 'referenceMode',
      label: 'Input mode',
      type: 'choice',
      presentation: 'chips',
      defaultValue: 'frames',
      options: [{ value: 'frames', label: 'Frames' }, { value: 'elements', label: 'References' }],
      minClientSchemaVersion: 2,
    },
  ],
  capabilities: { multiShot: false, sound: false, fixedLens: false, googleSearch: false, outputFormat: false },
  inputs: { imageReferences: { max: 3, supportsNaming: true }, videoReferences: null, audioReferences: null, startFrame: true, endFrame: true, combineFramesWithReferences: false },
  availability: { web: true, mobile: true },
  inputModes: [
    {
      key: 'frames',
      label: 'Frames',
      default: true,
      conditions: seedanceReferenceModeIs('frames'),
      slots: [
        { key: 'startFrame', kind: 'image', role: 'startFrame', label: 'Start frame', min: 0, max: 1 },
        { key: 'endFrame', kind: 'image', role: 'endFrame', label: 'End frame', min: 0, max: 1 },
      ],
    },
    {
      key: 'references',
      label: 'Reusable references',
      default: false,
      conditions: [
        ...seedanceReferenceModeIs('elements'),
        { source: 'setting', key: 'mode', operator: 'in', value: ['veo3_lite', 'veo3_fast'] },
      ],
      slots: [{ key: 'imageReferences', kind: 'image', role: 'reference', label: 'Reference images', min: 0, max: 3, supportsNaming: true }],
    },
  ],
  inputConstraints: [],
});

/**
 * The production mobile descriptors a Recreate meets (revision gpt-image-2-5-20260911): their
 * controls, defaults, capabilities and input limits. Every tool's catalog default disagrees with
 * the bundled default draft — video at 16:9 against 9:16, image at `auto` against 4:5, motion in
 * the model itself (kling-2.6 against kling-3.0) — and the remixed models lack some of the
 * default model's controls.
 */
export function createRemixRestoreCatalog(): GenerationModelCatalog {
  return {
    schemaVersion: 1,
    revision: 'gpt-image-2-5-20260911',
    defaults: { image: 'nano-banana-2', video: 'kling-3.0-video', motion: 'kling-2.6' },
    models: [
      model('nano-banana-2', 'image', 'Nano Banana 2.0', {
        controls: [
          choiceControl('aspectRatio', 'Aspect ratio', 'auto', ['auto', '1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'], 'select'),
          choiceControl('resolution', 'Resolution', '1K', ['1K', '2K', '4K']),
          choiceControl('outputFormat', 'Output format', 'jpg', ['jpg', 'png']),
          { key: 'googleSearch', label: 'Google Search', type: 'boolean', presentation: 'toggle', defaultValue: false },
        ],
        capabilities: { multiShot: false, sound: false, fixedLens: false, googleSearch: true, outputFormat: true },
        inputs: { imageReferences: { max: 14, supportsNaming: true }, videoReferences: null, audioReferences: null, startFrame: false, endFrame: false },
      }),
      model('gpt-image-2', 'image', 'GPT Image 2', {
        controls: [
          choiceControl('aspectRatio', 'Aspect ratio', 'auto', ['auto', '1:1', '5:4', '9:16', '21:9', '16:9', '4:3', '3:2', '4:5', '3:4', '2:3'], 'select'),
          choiceControl('resolution', 'Resolution', '1K', ['1K', '2K', '4K']),
        ],
        inputs: { imageReferences: { max: 16, supportsNaming: true }, videoReferences: null, audioReferences: null, startFrame: false, endFrame: false },
      }),
      model('kling-3.0-video', 'video', 'Kling 3.0 Cinematic', {
        controls: [
          choiceControl('aspectRatio', 'Aspect ratio', '16:9', ['16:9', '9:16', '1:1']),
          choiceControl('mode', 'Quality mode', 'std', ['std', 'pro']),
          { key: 'duration', label: 'Duration', type: 'integer', presentation: 'stepper', defaultValue: 5, min: 3, max: 15, step: 1, unit: 'seconds' },
          { key: 'sound', label: 'Sound', type: 'boolean', presentation: 'toggle', defaultValue: false },
          { key: 'isMultiShot', label: 'Multi-shot', type: 'boolean', presentation: 'toggle', defaultValue: false },
        ],
        capabilities: { multiShot: true, sound: true, fixedLens: false, googleSearch: false, outputFormat: false },
        inputs: { imageReferences: null, videoReferences: { max: 3 }, audioReferences: null, startFrame: true, endFrame: true },
      }),
      model('seedance-2', 'video', 'Seedance 2', {
        controls: [
          choiceControl('aspectRatio', 'Aspect ratio', '16:9', ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9']),
          choiceControl('resolution', 'Resolution', '480p', ['480p', '720p', '1080p', '4k']),
          { key: 'duration', label: 'Duration', type: 'integer', presentation: 'stepper', defaultValue: 15, min: 4, max: 15, step: 1, unit: 'seconds' },
          { key: 'sound', label: 'Sound', type: 'boolean', presentation: 'toggle', defaultValue: false },
          choiceControl('referenceMode', 'Input mode', 'frames', ['frames', 'elements']),
        ],
        inputs: { imageReferences: { max: 5, supportsNaming: true }, videoReferences: { max: 3 }, audioReferences: { max: 3 }, startFrame: true, endFrame: true },
      }),
      model('kling-2.6', 'motion', 'Kling 2.6', {
        inputs: { imageReferences: { max: 1, supportsNaming: false }, videoReferences: { max: 1 }, audioReferences: null, startFrame: false, endFrame: false },
      }),
    ],
  };
}

/**
 * The catalog as production published it to the app on 2026-10-30 (`published-default-descriptors.json`):
 * each tool's default, which the creators' opening (lib/app-creator-opening) draws before the catalog
 * arrives, with Kling 3.0 Cinematic, Kling 3.0 and Seedance 2 beside them. `overrides` stands in for a
 * later release or a stored one (another default or revision).
 */
export function createPublishedDefaultsCatalog(overrides: Partial<Pick<GenerationModelCatalog, 'revision' | 'defaults'>> = {}): GenerationModelCatalog {
  return {
    schemaVersion: 3,
    revision: publishedDefaults.revision,
    defaults: publishedDefaults.defaults,
    models: publishedDefaults.models.map((model) => parseModelCatalogDetail(model)),
    ...overrides,
  };
}
