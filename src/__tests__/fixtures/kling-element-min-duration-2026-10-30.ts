import type { GenerationModelDescriptor } from '@/lib/generation-model-catalog';

/**
 * The code build as it stood before release 2026-10-30-kling-element-min-duration
 * (kling-element-min-duration-manifest.test.ts). A release test written before it holds its
 * entries to the code build of its day, so it reads today's build through this and compares like
 * with like. The release publishes the shortest clip Kling 3.0's video elements take
 * (`minDurationSeconds: 3`, the start's own minimum); no other key, price or rule changed.
 */
export function descriptorBeforeKlingElementMinimum<T extends GenerationModelDescriptor>(current: T): T {
  const descriptor = JSON.parse(JSON.stringify(current)) as T;
  if (descriptor.id === 'kling-3.0-video') {
    const elements = (descriptor.inputModes ?? [])
      .flatMap((mode) => mode.slots)
      .find((slot) => slot.key === 'videoElements');
    if (elements?.minDurationSeconds === undefined) {
      throw new Error('kling-3.0-video publishes no shortest video element');
    }
    delete elements.minDurationSeconds;
  }
  return descriptor;
}
