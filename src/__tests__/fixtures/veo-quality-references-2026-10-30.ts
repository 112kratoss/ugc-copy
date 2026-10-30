import type { GenerationModelDescriptor } from '@/lib/generation-model-catalog';

/**
 * The code build as it stood before release 2026-10-30-veo-quality-references
 * (veo-quality-references-manifest.test.ts). A release test written before it holds its entries
 * to the code build of its day, so it reads today's build through this and compares like with
 * like. The release opens Veo 3.1's references mode on its Lite and Fast variants only, the two
 * Kie's REFERENCE_2_VIDEO takes and the quote allows; before it the mode opened on every variant.
 * Its quote rules did not change.
 */
export function descriptorBeforeVeoQualityReferences<T extends GenerationModelDescriptor>(current: T): T {
  const descriptor = JSON.parse(JSON.stringify(current)) as T;
  if (descriptor.id === 'veo-3.1') {
    const references = (descriptor.inputModes ?? []).find((mode) => mode.key === 'references');
    if (!references?.conditions?.some((condition) => condition.key === 'mode')) {
      throw new Error('veo-3.1 has no references mode gated on its variant');
    }
    references.conditions = references.conditions.filter((condition) => condition.key !== 'mode');
  }
  return descriptor;
}
