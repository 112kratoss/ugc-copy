import { describe, expect, it } from 'vitest';

import { GENERATION_PROMPT_MAX_LENGTH } from '../../ugc-mobile/lib/model-catalog/protocol';
import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS } from '@/lib/models';
import {
  providerPromptMaxLength,
  providerPromptViolation,
  referenceMediaLengthViolation,
} from '@/lib/provider-input-limits';

// Kie's documented prompt caps, read 2026-10-20 for the model check-up
// (archive/model-checkup-2026-10-20/evidence/prompt-limits.txt). A model missing here
// takes at least the shared 10,000 characters.
const KIE_PROMPT_CAPS: Record<string, number> = {
  'z-image': 1000,
  'seedream-5-lite': 2995,
  'kling-3.0-turbo': 2500,
  'kling-3.0-video': 2500,
  'seedance-1.5-pro': 2500,
  'kling-o3': 3072,
  'grok-imagine-video-1.5': 4096,
  'flux-2-pro': 5000,
  'grok-imagine-image': 5000,
  'grok-imagine-video': 5000,
  'hailuo-2.3': 5000,
  'happyhorse-1.1': 5000,
  'ideogram-character': 5000,
  'ideogram-v3': 5000,
  'pixverse-v6': 5000,
  'qwen-image-2.1': 5000,
  'qwen3': 5000,
  'qwen3-pro': 5000,
  'seedream-5-flash': 5000,
  'seedream-5-pro': 5000,
  'wan-2.7': 5000,
  'wan-2.7-image': 5000,
  'wan-2.7-image-pro': 5000,
  'minimax-h3': 7000,
  'grok-imagine-image-2': 8000,
};

const ALL_MODEL_IDS = [
  ...Object.keys(IMAGE_MODELS),
  ...Object.keys(VIDEO_MODELS),
  ...Object.keys(MOTION_MODELS),
];

describe('provider input limits', () => {
  it('caps each model at the prompt length Kie documents, and leaves the rest at the shared limit', () => {
    const capped = Object.fromEntries(ALL_MODEL_IDS.flatMap((modelId) => {
      const cap = providerPromptMaxLength(modelId);
      return cap === null ? [] : [[modelId, cap]];
    }));

    expect(capped).toEqual(KIE_PROMPT_CAPS);
    for (const cap of Object.values(capped)) expect(cap).toBeLessThan(GENERATION_PROMPT_MAX_LENGTH);
  });

  it('names every model it holds by the name the creators show', () => {
    for (const modelId of Object.keys(KIE_PROMPT_CAPS)) {
      const message = providerPromptViolation(modelId, { prompt: 'a'.repeat(KIE_PROMPT_CAPS[modelId] + 1) });
      expect(message, modelId).not.toContain(modelId);
      expect(message, modelId).toMatch(/ prompts support up to [\d,]+ characters\.$/);
    }
  });

  it('holds Grok Imagine’s text-to-image cap only when no picture is sent', () => {
    expect(providerPromptMaxLength('grok-imagine-image')).toBe(5000);
    expect(providerPromptMaxLength('grok-imagine-image', { hasReferenceImages: true })).toBeNull();
    expect(providerPromptViolation('grok-imagine-image', { prompt: 'a'.repeat(5001), hasReferenceImages: true })).toBeNull();
  });

  it('refuses a prompt shorter than the provider takes, where it documents more than one character', () => {
    expect(providerPromptViolation('seedream-5-lite', { prompt: 'abc' })).toBe('Seedream 5 Lite prompts need at least 4 characters.');
    expect(providerPromptViolation('seedream-5-lite', { prompt: 'abcd' })).toBeNull();
    expect(providerPromptViolation('pixverse-v6', { prompt: 'ab' })).toBe('PixVerse V6 prompts need at least 3 characters.');
    expect(providerPromptViolation('seedance-1.5-pro', { prompt: 'ab' })).toBe('Seedance 1.5 Pro prompts need at least 3 characters.');
    expect(providerPromptViolation('seedance-2-5', { prompt: 'ab' })).toBeNull();
    expect(providerPromptViolation('nano-banana-2', { prompt: 'a' })).toBeNull();
  });

  it('judges no prompt where the provider is sent none, and still judges the shots', () => {
    expect(providerPromptViolation('kling-3.0-video', { prompt: null, shots: ['a'.repeat(500)] })).toBeNull();
    expect(providerPromptViolation('kling-3.0-video', { prompt: null, shots: ['ok', 'a'.repeat(501)] }))
      .toBe('Shot 2: Kling 3.0 Cinematic shot prompts support up to 500 characters.');
  });

  it('counts a Kling 3.0 element mention as 37 characters, only for the run’s own elements', () => {
    // 468 characters as typed, 500 as Kie counts one mention of a 5-character handle.
    const atLimit = `${'a'.repeat(462)} @lead`;
    const run = { prompt: null, elementHandles: ['@lead'] };
    expect(providerPromptViolation('kling-3.0-video', { ...run, shots: [atLimit] })).toBeNull();
    expect(providerPromptViolation('kling-3.0-video', { ...run, shots: [`a${atLimit}`] }))
      .toBe('Shot 1: Kling 3.0 Cinematic shot prompts support up to 500 characters, counting each video element mention as 37.');
    // A mention of something that is not one of its elements is plain text.
    expect(providerPromptViolation('kling-3.0-video', { prompt: null, shots: [`a${atLimit}`], elementHandles: ['@other'] })).toBeNull();
    // A handle longer than 37 is counted as written.
    const longHandle = `@${'h'.repeat(40)}`;
    expect(providerPromptViolation('kling-3.0-video', {
      prompt: `${'a'.repeat(2500 - longHandle.length - 1)} ${longHandle}`,
      elementHandles: [longHandle],
    })).toBeNull();
    // Other models count characters as written.
    expect(providerPromptViolation('kling-o3', { prompt: null, shots: [`${'a'.repeat(506)} @lead`], elementHandles: ['@lead'] })).toBeNull();
  });

  describe('reference media lengths', () => {
    it('refuses the first file under its model’s minimum, by what it is to the run', () => {
      expect(referenceMediaLengthViolation('seedance-2-mini', [
        { role: 'video', durationSeconds: 4 },
        { role: 'video', durationSeconds: 1.95 },
      ])).toBe('Seedance 2 Mini reference videos must be at least 2 seconds long. Reference video 2 runs 1.9 seconds.');
      expect(referenceMediaLengthViolation('wan-2.7', [{ role: 'audio', durationSeconds: 0.5, label: 'Narrator' }]))
        .toBe('Wan 2.7 reference audio must be at least 1 second long. Narrator runs 0.5 seconds.');
      expect(referenceMediaLengthViolation('kling-3.0', [{ role: 'motion', durationSeconds: 2.99 }]))
        .toBe('Kling 3.0 motion reference videos must be at least 3 seconds long. The reference video runs 2.9 seconds.');
      expect(referenceMediaLengthViolation('kling-2.6', [{ role: 'motion', durationSeconds: 2, exact: false }]))
        .toBe('Kling 2.6 motion reference videos must be at least 3 seconds long.');
    });

    it('takes a file at the minimum, a length nobody measured, and a model with no minimum', () => {
      expect(referenceMediaLengthViolation('minimax-h3', [
        { role: 'video', durationSeconds: 2 },
        { role: 'audio', durationSeconds: 2 },
      ])).toBeNull();
      expect(referenceMediaLengthViolation('seedance-2', [
        { role: 'video', durationSeconds: null },
        { role: 'video', durationSeconds: 0 },
        { role: 'video' },
      ])).toBeNull();
      // Wan 2.7 documents no minimum for its reference clips, only for its voice.
      expect(referenceMediaLengthViolation('wan-2.7', [{ role: 'video', durationSeconds: 0.5 }])).toBeNull();
      expect(referenceMediaLengthViolation('gemini-omni-video', [{ role: 'video', durationSeconds: 0.5 }])).toBeNull();
    });
  });
});
