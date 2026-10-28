import type { GenerationModelDescriptor } from '@/lib/generation-model-catalog';

/**
 * The code build as it stood before release 2026-10-28-mini-default-video
 * (mini-default-video-manifest.test.ts). A release test written before it holds its entries to
 * the code build of its day, so it reads today's build through this and compares like with like.
 * The release made Seedance 2 Mini the default video model, which the catalog marks
 * `recommended` in Kling 3.0's place, and opened Mini's duration on 5 s instead of 10.
 */
export function descriptorBeforeMiniDefault<T extends GenerationModelDescriptor>(current: T): T {
  const descriptor = JSON.parse(JSON.stringify(current)) as T;
  if (descriptor.id === 'kling-3.0-video') descriptor.recommended = true;
  if (descriptor.id === 'seedance-2-mini') {
    descriptor.recommended = false;
    const duration = descriptor.controls.find((control) => control.key === 'duration');
    if (duration?.type !== 'integer') throw new Error('seedance-2-mini has no integer duration control');
    duration.defaultValue = 10;
  }
  return descriptor;
}
