import type {
  CatalogControl,
  GenerationModelCatalog,
  GenerationModelDescriptor,
  GenerationModelKind,
} from '../../lib/generation-model-catalog';

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
