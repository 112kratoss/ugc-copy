import type { CatalogInputMode } from '@/lib/generation-model-catalog';
import productionMotion from '../../../contracts/production-motion-descriptors-v1.json';

/**
 * Kling 3.0 motion's input modes as production publishes them, from the contract the app's suite
 * reads too (`contracts/production-motion-descriptors-v1.json`, which says when and from which
 * release it was read): one default mode with plain reference slots, the shape the compatibility
 * release gave a model no later release re-emitted. The code catalog, and Kling 2.6 in production,
 * give motion its `motion-inputs` slots instead (`characterImage`, `referenceVideo`).
 */
export const PRODUCTION_KLING_3_MOTION_MODES = productionMotion.models
  .find((model) => model.id === 'kling-3.0')?.inputModes as CatalogInputMode[];
