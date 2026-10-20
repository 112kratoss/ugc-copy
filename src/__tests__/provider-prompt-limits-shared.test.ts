import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { GENERATION_PROMPT_MAX_LENGTH, MOTION_PROMPT_MAX_LENGTH } from '../../ugc-mobile/lib/model-catalog/protocol';
import {
  creatorPromptViolation,
  PROVIDER_PROMPT_RULES,
  promptLengthLabel,
  promptLengthMeter,
  promptLengthState,
  promptLimitFor,
  promptLimitViolation,
  type ProviderPromptRule,
} from '../../ugc-mobile/lib/model-catalog/provider-prompt-limits';
import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS } from '@/lib/models';
import { providerPromptViolation } from '@/lib/provider-input-limits';

/**
 * PROMPT_RULES as src/lib/provider-input-limits.ts held them before they moved to the
 * shared module (fc7426a3), copied here so the move is proven to change no number.
 */
const RULES_BEFORE_THE_MOVE = {
  'z-image': { maxLength: 1000 },
  'seedream-5-lite': { maxLength: 2995, minLength: 4 },
  'seedream-5-flash': { maxLength: 5000, minLength: 4 },
  'seedream-5-pro': { maxLength: 5000, minLength: 4 },
  'flux-2-pro': { maxLength: 5000, minLength: 3 },
  'grok-imagine-image': { maxLength: 5000, textOnly: true },
  'grok-imagine-image-2': { maxLength: 8000 },
  'ideogram-character': { maxLength: 5000 },
  'ideogram-v3': { maxLength: 5000 },
  'qwen-image-2.1': { maxLength: 5000 },
  'qwen3': { maxLength: 5000 },
  'qwen3-pro': { maxLength: 5000 },
  'wan-2.7-image': { maxLength: 5000 },
  'wan-2.7-image-pro': { maxLength: 5000 },
  'kling-3.0-turbo': { maxLength: 2500 },
  'kling-3.0-video': { maxLength: 2500, shotMaxLength: 500, elementMentionLength: 37 },
  'kling-o3': { maxLength: 3072, shotMaxLength: 512 },
  'seedance-1.5-pro': { maxLength: 2500, minLength: 3 },
  'seedance-2': { minLength: 3 },
  'seedance-2-fast': { minLength: 3 },
  'seedance-2-mini': { minLength: 3 },
  'grok-imagine-video-1.5': { maxLength: 4096 },
  'grok-imagine-video': { maxLength: 5000 },
  'hailuo-2.3': { maxLength: 5000 },
  'happyhorse-1.1': { maxLength: 5000 },
  'pixverse-v6': { maxLength: 5000, minLength: 3 },
  'wan-2.7': { maxLength: 5000 },
  'minimax-h3': { maxLength: 7000 },
};

const MODELS = { ...IMAGE_MODELS, ...VIDEO_MODELS, ...MOTION_MODELS } as Record<string, { displayName: string }>;
const ALL_MODEL_IDS = Object.keys(MODELS);

describe('shared provider prompt limits', () => {
  it('holds every model to the numbers the server held it to before they were shared', () => {
    expect(PROVIDER_PROMPT_RULES).toEqual(RULES_BEFORE_THE_MOVE);
    // Every rule names a model the app runs.
    for (const modelId of Object.keys(PROVIDER_PROMPT_RULES)) expect(ALL_MODEL_IDS, modelId).toContain(modelId);
  });

  it('gives the server and the creators the same words for every model', () => {
    for (const modelId of ALL_MODEL_IDS) {
      const name = MODELS[modelId].displayName;
      const rule: ProviderPromptRule = PROVIDER_PROMPT_RULES[modelId] ?? {};
      const runs = [
        { prompt: 'a'.repeat((rule.maxLength ?? GENERATION_PROMPT_MAX_LENGTH) + 1) },
        { prompt: 'ab' },
        { prompt: null, shots: ['ok', 'b'.repeat((rule.shotMaxLength ?? rule.maxLength ?? GENERATION_PROMPT_MAX_LENGTH) + 1)] },
        { prompt: 'a'.repeat(rule.maxLength ?? 1), hasReferenceImages: true },
      ];
      for (const run of runs) {
        expect(promptLimitViolation(modelId, name, run), modelId).toBe(providerPromptViolation(modelId, run));
      }
    }
  });

  it('gives each creator the limit its model holds a prompt and a shot to', () => {
    for (const modelId of ALL_MODEL_IDS) {
      const kind = Object.hasOwn(MOTION_MODELS, modelId) ? 'motion' : Object.hasOwn(VIDEO_MODELS, modelId) ? 'video' : 'image';
      const rule: ProviderPromptRule | undefined = PROVIDER_PROMPT_RULES[modelId];
      const routeMax = kind === 'motion' ? MOTION_PROMPT_MAX_LENGTH : GENERATION_PROMPT_MAX_LENGTH;
      const limit = promptLimitFor(modelId, { kind });
      expect(limit.maxLength, modelId).toBe(rule?.maxLength ?? routeMax);
      expect(limit.minLength, modelId).toBe(rule?.minLength ?? null);
      expect(limit.shotMaxLength, modelId).toBe(rule?.shotMaxLength ?? rule?.maxLength ?? routeMax);
    }
    expect(promptLimitFor('kling-3.0-video')).toEqual({ maxLength: 2500, minLength: null, shotMaxLength: 500, elementMentionLength: 37 });
    // Grok Imagine's text-to-image cap goes with the pictures: its edit endpoint takes the route's 10,000.
    expect(promptLimitFor('grok-imagine-image').maxLength).toBe(5000);
    expect(promptLimitFor('grok-imagine-image', { hasReferenceImages: true }).maxLength).toBe(GENERATION_PROMPT_MAX_LENGTH);
  });

  it('reads a counter quiet with room, near in the limit’s last tenth, and over past it', () => {
    expect([899, 900, 1000, 1001].map((length) => promptLengthState(length, 1000))).toEqual(['within', 'near', 'near', 'over']);
    expect([449, 450, 500, 501].map((length) => promptLengthState(length, 500))).toEqual(['within', 'near', 'near', 'over']);
    expect(promptLengthLabel(4812, 5000)).toBe('4,812 / 5,000');
    expect(promptLengthLabel(0, 10000)).toBe('0 / 10,000');
    // The text as a run sends it: trimmed.
    expect(promptLengthMeter('  hello  ', 1000)).toEqual({ length: 5, limit: 1000, state: 'within', label: '5 / 1,000' });
    // A mention of one of the run's elements counts as wide as Kling counts it; any other word as written.
    expect(promptLengthMeter('@lead walks', 500, { elementMentionLength: 37, elementHandles: ['@lead'] }).length).toBe(43);
    expect(promptLengthMeter('@lead walks', 500, { elementMentionLength: 37, elementHandles: ['@other'] }).length).toBe(11);
    expect(promptLengthMeter('@lead walks', 500, { elementHandles: ['@lead'] }).length).toBe(11);
  });

  it('shapes a creator’s run as the video start does before it asks', () => {
    const long = 'x'.repeat(3100);
    // A multi-shot Kling 3.0 run sends its shots and no prompt: the prompt kept behind them is not held.
    expect(creatorPromptViolation('kling-3.0-video', 'Kling 3.0 Cinematic', { prompt: long, isMultiShot: true, shots: ['ok'] })).toBeNull();
    expect(creatorPromptViolation('kling-3.0-video', 'Kling 3.0 Cinematic', { prompt: long }))
      .toBe('Kling 3.0 Cinematic prompts support up to 2,500 characters.');
    // Kling O3 sends the prompt it keeps, or its first shot when it keeps none.
    expect(creatorPromptViolation('kling-o3', 'Kling O3', { prompt: long, isMultiShot: true, shots: ['ok'] }))
      .toBe('Kling O3 prompts support up to 3,072 characters.');
    expect(creatorPromptViolation('kling-o3', 'Kling O3', { prompt: '', isMultiShot: true, shots: ['', 'c'.repeat(513)] }))
      .toBe('Shot 2: Kling O3 shot prompts support up to 512 characters.');
    // An empty prompt is the creator's own "prompt required"; a short one is the provider's.
    expect(creatorPromptViolation('seedream-5-lite', 'Seedream 5 Lite', { prompt: '   ' })).toBeNull();
    expect(creatorPromptViolation('seedream-5-lite', 'Seedream 5 Lite', { prompt: ' cat ' }))
      .toBe('Seedream 5 Lite prompts need at least 4 characters.');
    expect(creatorPromptViolation('nano-banana-2', 'Nano Banana 2.0', { prompt: 'a' })).toBeNull();
    // The words the server would say for the same run.
    expect(creatorPromptViolation('z-image', 'Z-Image', { prompt: ` ${'z'.repeat(1001)} ` }))
      .toBe(providerPromptViolation('z-image', { prompt: 'z'.repeat(1001) }));
  });

  it('stays importable by the app, the web bundle and the server: no platform import', () => {
    const source = readFileSync('ugc-mobile/lib/model-catalog/provider-prompt-limits.ts', 'utf8');
    const imports = [...source.matchAll(/^import[^;]*from '([^']+)';$/gm)].map((match) => match[1]);
    expect(imports).toEqual(['./protocol']);
  });
});
