import { describe, expect, it } from 'vitest';

import {
  IMAGE_MODELS,
  MOTION_MODELS,
  SOUND_EFFECT_MODELS,
  VIDEO_MODELS,
  VOICEOVER_MODELS,
} from '@/lib/models';
import {
  ENHANCER_PLAYBOOKS,
  MODEL_ALIASES,
  getEnhancerPlaybookById,
} from '@/lib/prompt-enhancer-playbooks';
import {
  applyPromptEnhancementSafeguardsWithMetadata,
  buildEnhancerSystemPrompt,
  buildPromptEnhancementArtifacts,
  resolvePromptEnhancementAgent,
} from '@/lib/prompt-enhancer';
import { inspectPromptQuality } from '@/lib/prompt-quality';
import {
  WAN_VIDEO_DEFAULT_NEGATIVE_PROMPT,
  promptLocksExactText,
} from '@/lib/generation-services';

const imageIds = Object.keys(IMAGE_MODELS);
const videoIds = Object.keys(VIDEO_MODELS);
const motionIds = Object.keys(MOTION_MODELS);
const audioIds = [...Object.keys(VOICEOVER_MODELS), ...Object.keys(SOUND_EFFECT_MODELS)];

/**
 * The 2026-08-24 research pass found 13+ live models riding cross-provider
 * playbook aliases (Hailuo on Kling's grammar, Seedance 2.5 on Seedance 2's
 * no-timestamp rule, and so on) and 91% of enhancement traffic running under
 * the generic fallback agent. This suite pins the fixes.
 */
describe('prompt enhancer playbook contract', () => {
  it.each([...imageIds, ...videoIds, ...motionIds, ...audioIds])(
    '%s resolves to a model-specific agent, not the generic fallback',
    (id) => {
      expect(resolvePromptEnhancementAgent(id).id).not.toBe('generic-media-enhancer');
    },
  );

  it.each([...imageIds, ...videoIds, ...motionIds, ...audioIds])(
    '%s has a playbook with a word budget',
    (id) => {
      const playbook = getEnhancerPlaybookById(id);
      expect(playbook).not.toBeNull();
      expect(playbook!.budget.targetWords[0]).toBeGreaterThan(0);
      expect(playbook!.budget.targetWords[1]).toBeGreaterThanOrEqual(playbook!.budget.targetWords[0]);
    },
  );

  it('keeps aliases pointing at same-grammar targets only', () => {
    // Grammar twins verified against Kie endpoint schemas — anything else must
    // earn its own playbook instead of borrowing a neighbor's.
    expect(MODEL_ALIASES).toEqual({
      'kling-3.0-video': 'kling-3.0/video',
      'qwen3-pro': 'qwen3',
      'wan-2.7-image-pro': 'wan-2.7-image',
      'imagen-4-fast': 'imagen-4',
      'imagen-4-ultra': 'imagen-4',
      'seedance-2-mini': 'seedance-2-fast',
    });
  });

  it('gives the formerly mis-aliased models their own grammars', () => {
    // Each of these previously borrowed a cross-provider playbook.
    expect(getEnhancerPlaybookById('hailuo-2.3')?.compilerProfile).toBe('bracket-camera');
    expect(getEnhancerPlaybookById('minimax-h3')?.compilerProfile).toBe('timeline');
    expect(getEnhancerPlaybookById('seedance-2-5')?.compilerProfile).toBe('timeline');
    expect(getEnhancerPlaybookById('happyhorse-1.1')?.compilerProfile).toBe('single-clip');
    expect(getEnhancerPlaybookById('kling-3.0-turbo')?.compilerProfile).toBe('single-clip');
    expect(getEnhancerPlaybookById('gemini-omni-video')?.compilerProfile).toBe('single-clip');
    expect(getEnhancerPlaybookById('grok-imagine-image-2')?.compilerProfile).toBe('design-brief');
    expect(getEnhancerPlaybookById('imagen-4')?.compilerProfile).toBe('caption-tail');
    expect(getEnhancerPlaybookById('gpt-image-2')?.compilerProfile).toBe('labeled-sections');
  });

  it('teaches each model family its own camera and structure dialect', () => {
    const hailuo = buildEnhancerSystemPrompt('video', 'hailuo-2.3', { duration: 6 }, 'she turns her head');
    expect(hailuo).toContain('[Push in]');
    expect(hailuo).toContain('motion delta');

    const h3 = buildEnhancerSystemPrompt('video', 'minimax-h3', { duration: 10 }, 'product demo');
    expect(h3).toContain('0-5s');
    expect(h3).toContain('Audio:');

    const seedance25 = buildEnhancerSystemPrompt('video', 'seedance-2-5', { duration: 30 }, 'story ad');
    expect(seedance25).toContain('Timestamps are required here');

    const seedance2 = buildEnhancerSystemPrompt('video', 'seedance-2', { duration: 10 }, 'story ad');
    expect(seedance2).toContain('Never use timestamps');

    const happyhorse = buildEnhancerSystemPrompt('video', 'happyhorse-1.1', { duration: 8 }, 'woman talks');
    expect(happyhorse).toContain('the language named');
  });

  it('marks always-on audio models so the soundscape is always scripted', () => {
    for (const id of ['grok-imagine-video', 'wan-2.7', 'minimax-h3', 'happyhorse-1.1', 'veo-3.1']) {
      expect(getEnhancerPlaybookById(id)?.audioBehavior, id).toBe('always');
      expect(buildEnhancerSystemPrompt('video', id, { duration: 8 }, 'a demo')).toContain(
        'generates audio unconditionally'
      );
    }
    expect(getEnhancerPlaybookById('kling-3.0-turbo')?.audioBehavior).toBe('none');
    expect(getEnhancerPlaybookById('hailuo-2.3')?.audioBehavior).toBe('none');
  });

  it('keeps motion-control prompts away from choreography', () => {
    for (const id of motionIds) {
      const guidance = buildEnhancerSystemPrompt('motion', id, { hasReferenceVideo: true }, 'make her dance');
      expect(guidance.toLowerCase(), id).toContain('never describe the motion');
    }

    const inspection = inspectPromptQuality({
      medium: 'motion',
      selectedModel: 'kling-3.0',
      prompt: 'She dances wildly and does a backflip on the beach',
      context: {},
    });
    expect(inspection.warnings.map((warning) => warning.code)).toContain('motion_choreography_in_prompt');
  });

  it('covers the audio models with script-focused playbooks', () => {
    const tts = buildEnhancerSystemPrompt('audio', 'text-to-speech-turbo-2-5', undefined, 'Our serum is $4.99');
    expect(tts).toContain('script normalization');
    expect(tts).toContain('Never inject emotional stage directions');

    const dialogue = buildEnhancerSystemPrompt('audio', 'text-to-dialogue-v3', undefined, 'two people argue');
    expect(dialogue).toContain('[whispers]');
    expect(dialogue).toContain('Do not use SSML');

    const sfx = buildEnhancerSystemPrompt('audio', 'sound-effect-v2', undefined, 'a door closing');
    expect(sfx).toContain('foley');
  });

  it('blocks Kling 3.0 multi-shot above the 5-shot endpoint cap and O3 above 6', () => {
    const kling = inspectPromptQuality({
      medium: 'video',
      selectedModel: 'kling-3.0-video',
      prompt: 'A creator walks through the set as the camera tracks alongside',
      context: { isMultiShot: true, shotCount: 6, duration: 15 },
    });
    expect(kling.warnings.map((warning) => warning.code)).toContain('kling_too_many_shots');

    const o3AtSix = inspectPromptQuality({
      medium: 'video',
      selectedModel: 'kling-o3',
      prompt: 'A creator walks through the set as the camera tracks alongside',
      context: { isMultiShot: true, shotCount: 6, duration: 15 },
    });
    expect(o3AtSix.warnings.map((warning) => warning.code)).not.toContain('kling_too_many_shots');
  });

  it('flags prompts that exceed a model hard cap', () => {
    const inspection = inspectPromptQuality({
      medium: 'image',
      selectedModel: 'z-image',
      prompt: `A photorealistic photo of a cat. ${'Detailed fur and lighting. '.repeat(60)}`,
      context: {},
    });
    expect(inspection.warnings.map((warning) => warning.code)).toContain('over_model_length_cap');
  });

  it('routes Ideogram Magic Prompt off when the prompt locks exact text', () => {
    expect(promptLocksExactText('A poster with the headline "GLOW FASTER" at the top')).toBe(true);
    expect(promptLocksExactText('A poster of a serum bottle in soft light')).toBe(false);
  });

  it('restores quoted text the enhancement dropped — the hard user contract', () => {
    // Reproduces the live eval failure where the planner paraphrased the
    // headline into "space for a headline overlay" and the copy vanished.
    const result = applyPromptEnhancementSafeguardsWithMetadata(
      'poster of our serum with the headline "GLOW FASTER"',
      'Scene: a beauty studio.\nSubject: a serum bottle poster with space for a headline overlay.',
      {}
    );
    expect(result.enhancedPrompt).toContain('"GLOW FASTER"');
    expect(result.appliedSafeguards.map((safeguard) => safeguard.code)).toContain('restored_exact_text');

    // No-op when the copy survived.
    const untouched = applyPromptEnhancementSafeguardsWithMetadata(
      'poster with the headline "GLOW FASTER"',
      'A poster with the headline "GLOW FASTER" in bold sans-serif.',
      {}
    );
    expect(untouched.appliedSafeguards).toEqual([]);
  });

  it('filters literal None placeholders out of compiled prompts', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'video',
      'kling-3.0-video',
      JSON.stringify({
        sceneGoal: 'demo',
        subjectAction: 'a creator lifts the serum',
        environment: 'a bright kitchen',
        cameraMovement: 'slow push-in',
        continuityAnchors: [],
        ambience: 'daylight',
        audioCue: '',
        pacing: '',
        dialogue: '',
        durationBudget: '5s',
        shots: [{ index: 1, title: '', startState: '', actionBeat: 'lifts the serum', endState: '', camera: 'push-in', transition: 'None' }],
      }),
      { duration: 5 },
      'serum demo'
    );
    expect(artifacts.compiledPrompt).not.toMatch(/\bNone\b/);
  });

  it('keeps the Wan default negative prompt inside the 500-character field cap', () => {
    expect(WAN_VIDEO_DEFAULT_NEGATIVE_PROMPT.length).toBeLessThanOrEqual(500);
    expect(WAN_VIDEO_DEFAULT_NEGATIVE_PROMPT).toContain('subtitles');
    expect(WAN_VIDEO_DEFAULT_NEGATIVE_PROMPT).toContain('watermark');
  });

  it('has no orphan playbooks for models that no longer exist', () => {
    const liveIds = new Set([
      ...imageIds, ...videoIds, ...motionIds, ...audioIds,
      // Provider-id spellings reachable via aliases.
      'kling-3.0/video',
    ]);
    for (const playbookId of Object.keys(ENHANCER_PLAYBOOKS)) {
      expect(liveIds.has(playbookId), `playbook ${playbookId} has no live model`).toBe(true);
    }
  });
});

describe('dialect compilers', () => {
  const imagePlan = JSON.stringify({
    subject: 'a founder holding a serum bottle',
    setting: 'a bright daylight studio',
    composition: 'centered composition',
    cameraFraming: 'eye-level medium shot',
    lighting: 'soft window light',
    materialDetail: 'natural skin texture',
    readableText: null,
    referenceAnchors: [],
    constraints: [],
    finish: 'polished commercial finish',
  });

  it('hard-trims Z-Image output to its 1,000-character cap on sentence boundaries', () => {
    const longPlan = JSON.stringify({
      subject: `a founder holding a serum bottle ${'with intricate detail '.repeat(30)}`,
      setting: `a bright daylight studio ${'full of props '.repeat(30)}`,
      composition: 'centered composition',
      cameraFraming: 'eye-level medium shot',
      lighting: 'soft window light',
      materialDetail: `natural skin texture ${'and fine surface detail '.repeat(20)}`,
      readableText: null,
      referenceAnchors: [],
      constraints: [],
      finish: 'polished finish',
    });

    const artifacts = buildPromptEnhancementArtifacts('image', 'z-image', longPlan, {}, 'founder photo');
    expect(artifacts.compiledPrompt.length).toBeLessThanOrEqual(990);
    expect(artifacts.compiledPrompt.endsWith('.')).toBe(true);
  });

  it('compiles imagen through the caption-and-tail dialect', () => {
    const artifacts = buildPromptEnhancementArtifacts('image', 'imagen-4-ultra', imagePlan, {}, 'founder photo');
    expect(artifacts.playbookId).toBe('imagen-4');
    // Caption first, then a comma-separated modifier tail — not narrative sentences.
    expect(artifacts.compiledPrompt).toMatch(/^a founder holding a serum bottle in a bright daylight studio, centered composition/);
  });

  it('compiles the timeline dialect into timestamped beats with an audio line', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'video',
      'minimax-h3',
      JSON.stringify({
        sceneGoal: 'product demo',
        subjectAction: 'a creator lifts the serum',
        environment: 'a bright bathroom',
        cameraMovement: 'slow push-in',
        continuityAnchors: ['the same creator'],
        ambience: 'morning light',
        audioCue: 'soft room tone',
        pacing: 'calm',
        dialogue: '',
        durationBudget: '10-second clip',
        shots: [
          { index: 1, title: '', startState: 'she notices the serum', actionBeat: 'she lifts it', endState: 'she smiles', camera: 'push-in', transition: '' },
          { index: 2, title: '', startState: 'close on the bottle', actionBeat: 'label catches the light', endState: 'hold', camera: 'static shot', transition: '' },
        ],
      }),
      { duration: 10 },
      'serum demo'
    );

    expect(artifacts.compiledPrompt).toContain('0-5s:');
    expect(artifacts.compiledPrompt).toContain('5-10s:');
    expect(artifacts.compiledPrompt).toContain('Audio: soft room tone.');
    expect(artifacts.compiledPrompt).toContain('Preserve the same creator.');
  });

  it('always scripts audio on always-on models even when the plan omits it', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'video',
      'grok-imagine-video',
      JSON.stringify({
        sceneGoal: 'creator demo',
        subjectAction: 'a creator waves at the camera',
        environment: 'a sunny kitchen',
        cameraMovement: 'gentle push-in',
        continuityAnchors: [],
        ambience: 'warm daylight',
        audioCue: '',
        pacing: 'upbeat',
        dialogue: '',
        durationBudget: '6-second clip',
        shots: [],
      }),
      { duration: 6 },
      'creator wave'
    );

    expect(artifacts.compiledPrompt).toContain('Audio: natural ambient sound only, no music.');
  });

  it('drops dialogue on silent routes', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'video',
      'kling-3.0-turbo',
      JSON.stringify({
        sceneGoal: 'creator demo',
        subjectAction: 'a creator lifts the serum',
        environment: 'a bright kitchen',
        cameraMovement: 'slow push-in',
        continuityAnchors: [],
        ambience: 'morning light',
        audioCue: 'upbeat music',
        pacing: 'calm',
        dialogue: 'Creator says: buy now',
        durationBudget: '6-second clip',
        shots: [],
      }),
      { duration: 6 },
      'serum demo'
    );

    expect(artifacts.compiledPrompt).not.toContain('buy now');
    expect(artifacts.compiledPrompt).not.toContain('upbeat music');
  });

  it('keeps the Veo compiler scripting ambience even when the plan omits audio', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'video',
      'veo-3.1',
      JSON.stringify({
        sceneGoal: 'creator demo',
        subjectAction: 'a creator lifts the serum and smiles',
        environment: 'a bright bathroom',
        cameraMovement: 'gentle push-in',
        continuityAnchors: [],
        ambience: 'clean daylight',
        audioCue: '',
        pacing: 'one focused beat',
        dialogue: '',
        durationBudget: '8-second clip',
        shots: [],
      }),
      { duration: 8 },
      'serum reveal'
    );

    expect(artifacts.compiledPrompt).toContain('Ambient noise:');
  });
});
