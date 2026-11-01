import type { CatalogInputMode } from '@/lib/generation-model-catalog';
import productionMotion from '../../../contracts/production-motion-descriptors-v1.json';

/** A model's input modes from one member of the contract; a model missing from it fails the suite at import. */
function modesOf(models: ReadonlyArray<{ id: string; inputModes: unknown }>, id: string): CatalogInputMode[] {
  const model = models.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`contracts/production-motion-descriptors-v1.json has no ${id}`);
  return model.inputModes as CatalogInputMode[];
}

/**
 * Kling 3.0 motion's input modes as production publishes them, from the contract the app's suite
 * reads too (`contracts/production-motion-descriptors-v1.json`, which says when and from which
 * release it was read): since release kling-3-motion-inputs-20261101, the code build's
 * `motion-inputs` slots (`characterImage`, `referenceVideo`), as Kling 2.6's.
 */
export const PRODUCTION_KLING_3_MOTION_MODES = modesOf(productionMotion.models, 'kling-3.0');

/**
 * Kling 3.0 motion's input modes as production served them until that release, and serves them
 * again if it is rolled back (the contract's `rollback`): one default mode with plain reference
 * slots (`imageReferences`, `videoReferences`), the shape the compatibility release gave it.
 */
export const ROLLBACK_KLING_3_MOTION_MODES = modesOf(productionMotion.rollback.models, 'kling-3.0');
