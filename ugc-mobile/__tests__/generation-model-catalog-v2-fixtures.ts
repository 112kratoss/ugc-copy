import type {
  GenerationModelCatalogV2,
  GenerationModelDescriptor,
} from '../lib/generation-model-catalog';

export function remoteVideoModel(
  id = 'remote-video-v2',
  overrides: Partial<GenerationModelDescriptor> = {},
): GenerationModelDescriptor {
  return {
    id,
    kind: 'video',
    displayName: id === 'remote-video-v2' ? 'Remote Video V2' : 'Fallback Video V2',
    description: 'A remotely configured video model.',
    badge: 'New',
    recommended: id !== 'remote-video-v2',
    sortOrder: id === 'remote-video-v2' ? 10 : 0,
    minClientSchemaVersion: 2,
    controls: [
      {
        key: 'referenceMode',
        label: 'Input mode',
        type: 'choice',
        presentation: 'chips',
        defaultValue: 'elements',
        options: [
          { value: 'elements', label: 'References' },
          { value: 'frames', label: 'Frames' },
        ],
      },
      {
        key: 'resolution',
        label: 'Resolution',
        type: 'choice',
        presentation: 'chips',
        defaultValue: '720p',
        options: [
          { value: '720p', label: '720p' },
          { value: '1080p', label: '1080p' },
          { value: '4k', label: '4K' },
        ],
      },
      {
        key: 'duration',
        label: 'Duration',
        type: 'integer',
        presentation: 'stepper',
        defaultValue: 7,
        min: 4,
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
      imageReferences: { max: 5, supportsNaming: true },
      videoReferences: { max: 3 },
      audioReferences: { max: 3 },
      preparedAudioReferences: null,
      characterReferences: null,
      startFrame: true,
      endFrame: true,
      combineFramesWithReferences: false,
    },
    availability: { web: true, mobile: true },
    inputModes: [
      {
        key: 'elements',
        label: 'References',
        default: true,
        conditions: [
          { source: 'setting', key: 'referenceMode', operator: 'equals', value: 'elements' },
        ],
        slots: [
          {
            key: 'imageReferences',
            kind: 'image',
            role: 'reference',
            label: 'Reference images',
            min: 0,
            max: 5,
            supportsNaming: true,
          },
          {
            key: 'videoReferences',
            kind: 'video',
            role: 'reference',
            label: 'Reference videos',
            min: 0,
            max: 3,
            durationMetadata: 'required',
            maxDurationSeconds: 15,
          },
        ],
      },
      {
        key: 'frames',
        label: 'Frames',
        default: false,
        conditions: [
          { source: 'setting', key: 'referenceMode', operator: 'equals', value: 'frames' },
        ],
        slots: [
          {
            key: 'startFrame',
            kind: 'image',
            role: 'startFrame',
            label: 'Start frame',
            min: 0,
            max: 1,
          },
        ],
      },
    ],
    inputConstraints: [
      {
        type: 'combined-duration',
        slotKeys: ['videoReferences'],
        max: 30,
        message: 'Reference videos may total at most 30 seconds.',
      },
    ],
    ...overrides,
  };
}

export function catalogV2(
  models: GenerationModelDescriptor[] = [
    remoteVideoModel('fallback-video-v2'),
    remoteVideoModel(),
  ],
): GenerationModelCatalogV2 {
  return {
    schemaVersion: 2,
    revision: 'catalog-v2-revision',
    defaults: {
      image: null,
      video: models.find((model) => model.kind === 'video')?.id ?? null,
      motion: null,
    },
    models,
  };
}
