import type { GenerationModelDescriptor } from '@/lib/generation-model-catalog';

/**
 * The slots release 2026-10-31-slot-min-durations (slot-min-durations-manifest.test.ts) gives the
 * shortest clip or track the start takes (`minDurationSeconds`, the start's own minimums), by model.
 * Kling 3.0 motion's code build publishes one too, but that release left the model's compatibility
 * descriptor in place; release kling-3-motion-inputs-20261101 carries the code build's.
 */
export const SLOT_MIN_DURATION_SLOTS: Readonly<Record<string, readonly string[]>> = {
  'seedance-2': ['videoReferences', 'audioReferences'],
  'seedance-2-fast': ['videoReferences', 'audioReferences'],
  'seedance-2-mini': ['videoReferences', 'audioReferences'],
  'seedance-2-5': ['videoReferences', 'audioReferences'],
  'minimax-h3': ['videoReferences', 'audioReferences'],
  'wan-2.7': ['audioReferences'],
  'wan-3.0': ['videoReferences', 'audioReferences'],
  'wan-3.0-prime': ['videoReferences', 'audioReferences'],
  'kling-2.6': ['referenceVideo'],
  'kling-3.0': ['referenceVideo'],
};

/**
 * The code build as it stood before release 2026-10-31-slot-min-durations. A release test written
 * before it holds its entries to the code build of its day, so it reads today's build through this
 * and compares like with like. The release publishes the shortest clip or track on the slots above;
 * no other key, price or rule changed.
 */
export function descriptorBeforeSlotMinDurations<T extends GenerationModelDescriptor>(current: T): T {
  const descriptor = JSON.parse(JSON.stringify(current)) as T;
  for (const key of SLOT_MIN_DURATION_SLOTS[descriptor.id] ?? []) {
    const slots = (descriptor.inputModes ?? []).flatMap((mode) => mode.slots).filter((slot) => slot.key === key);
    if (slots.length === 0 || slots.some((slot) => slot.minDurationSeconds === undefined)) {
      throw new Error(`${descriptor.id} publishes no shortest ${key}`);
    }
    for (const slot of slots) delete slot.minDurationSeconds;
  }
  return descriptor;
}
