import type { CatalogInputMode } from '@/lib/generation-model-catalog';

/**
 * Kling 3.0 motion's input modes as production publishes them (release
 * `wan-start-frame-apart-20261019`, read 2026-10-19): one default mode with plain reference
 * slots, the shape the compatibility release gave a model no later release re-emitted. The
 * code catalog, and Kling 2.6 in production, give motion its `motion-inputs` slots instead
 * (`characterImage`, `referenceVideo`). Update this when a release re-emits the model.
 */
export const PRODUCTION_KLING_3_MOTION_MODES: CatalogInputMode[] = [{
  key: 'default',
  label: 'Default',
  default: true,
  slots: [
    { key: 'imageReferences', label: 'Reference images', kind: 'image', role: 'reference', min: 0, max: 1 },
    { key: 'videoReferences', label: 'Reference videos', kind: 'video', role: 'reference', min: 0, max: 1 },
  ],
}];
