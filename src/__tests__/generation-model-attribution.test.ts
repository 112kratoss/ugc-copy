import { describe, expect, it } from 'vitest';

import { resolveGenerationAppModelId } from '@/lib/generation-model-attribution';

/**
 * Rows shaped from real production data on 2026-07-25. `generations.model` is
 * not one id space: image start paths persist the app id there, while video and
 * motion paths persist the provider id and keep the app id in
 * `workflow_settings`.
 */
describe('generation model attribution', () => {
  it('returns the app id directly for image rows, where both columns agree', () => {
    expect(resolveGenerationAppModelId({
      model: 'nano-banana-2',
      workflow_settings: { model: 'nano-banana-2' },
    })).toBe('nano-banana-2');
  });

  it('prefers workflow_settings for video rows, whose model column holds the provider id', () => {
    // Without this the same model attributes as 'kling-3.0-video' at task
    // creation and 'kling-3.0/video' at status-poll time, splitting one
    // model's traffic across two keys and halving both denominators.
    expect(resolveGenerationAppModelId({
      model: 'kling-3.0/video',
      workflow_settings: { model: 'kling-3.0-video' },
    })).toBe('kling-3.0-video');

    expect(resolveGenerationAppModelId({
      model: 'bytedance/seedance-2',
      workflow_settings: { model: 'seedance-2' },
    })).toBe('seedance-2');
  });

  it('never returns a provider id when an app id is available', () => {
    const resolved = resolveGenerationAppModelId({
      model: 'bytedance/seedance-2',
      workflow_settings: { model: 'seedance-2' },
    });
    expect(resolved).not.toContain('/');
  });

  it('falls back to the model column for legacy motion rows with no workflow settings', () => {
    // Known residual gap, recorded rather than hidden: these attribute under
    // the provider id. That is consistent — one key, not a split — which is
    // the property the rates actually depend on.
    expect(resolveGenerationAppModelId({
      model: 'kling-2.6/motion-control',
      workflow_settings: null,
    })).toBe('kling-2.6/motion-control');
  });

  it('ignores a blank or non-string workflow settings model', () => {
    expect(resolveGenerationAppModelId({ model: 'gpt-image-2', workflow_settings: { model: '   ' } }))
      .toBe('gpt-image-2');
    expect(resolveGenerationAppModelId({ model: 'gpt-image-2', workflow_settings: { model: 42 } }))
      .toBe('gpt-image-2');
    expect(resolveGenerationAppModelId({ model: 'gpt-image-2', workflow_settings: 'not-an-object' }))
      .toBe('gpt-image-2');
  });

  it('returns null rather than a placeholder when nothing is attributable', () => {
    // null keeps the row out of per-model rates entirely; a placeholder would
    // accumulate unrelated traffic under one synthetic model.
    expect(resolveGenerationAppModelId(null)).toBeNull();
    expect(resolveGenerationAppModelId(undefined)).toBeNull();
    expect(resolveGenerationAppModelId({ model: null, workflow_settings: null })).toBeNull();
    expect(resolveGenerationAppModelId({ model: '  ', workflow_settings: null })).toBeNull();
  });
});
