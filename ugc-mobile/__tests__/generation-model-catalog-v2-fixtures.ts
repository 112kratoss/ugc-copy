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

/**
 * Kling 3.0 as published (config/generation-model-catalog/releases/2026-10-30-kling-element-min-duration.json):
 * frames, and its clips in a mode of their own beside them, each under the handle its prompt mentions
 * and at least 3 seconds long.
 */
export function klingVideoModel(): GenerationModelDescriptor {
  const choice = (key: string, label: string, values: string[]) => ({
    key, label, type: 'choice' as const, presentation: 'chips' as const, defaultValue: values[0], options: values.map((value) => ({ value, label: value })),
  });
  const toggle = (key: string, label: string) => ({ key, label, type: 'boolean' as const, presentation: 'toggle' as const, defaultValue: false });
  return remoteVideoModel('kling-3.0-video', {
    displayName: 'Kling 3.0 Cinematic',
    controls: [
      choice('aspectRatio', 'Aspect ratio', ['16:9', '9:16', '1:1']),
      choice('mode', 'Quality mode', ['std', 'pro']),
      { key: 'duration', label: 'Duration', type: 'integer', presentation: 'stepper', defaultValue: 5, min: 3, max: 15, step: 1, unit: 'seconds' },
      toggle('sound', 'Sound'),
      toggle('isMultiShot', 'Multi-shot'),
    ],
    capabilities: { multiShot: true, sound: true, fixedLens: false, googleSearch: false, outputFormat: false },
    inputs: {
      imageReferences: null,
      videoReferences: { max: 3 },
      audioReferences: null,
      preparedAudioReferences: null,
      characterReferences: null,
      startFrame: true,
      endFrame: true,
      combineFramesWithReferences: false,
    },
    inputModes: [
      {
        key: 'frames',
        label: 'Frames',
        default: true,
        conditions: [{ source: 'setting', key: 'referenceMode', operator: 'equals', value: 'frames' }],
        slots: [
          { key: 'startFrame', kind: 'image', role: 'startFrame', label: 'Start frame', min: 0, max: 1 },
          { key: 'endFrame', kind: 'image', role: 'endFrame', label: 'End frame', min: 0, max: 1 },
        ],
      },
      {
        key: 'video-elements',
        label: 'Video elements',
        default: false,
        slots: [{ key: 'videoElements', kind: 'video', role: 'reference', label: 'Video elements', min: 0, max: 3, supportsNaming: true, durationMetadata: 'optional', minDurationSeconds: 3 }],
      },
    ],
    inputConstraints: [],
  });
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
