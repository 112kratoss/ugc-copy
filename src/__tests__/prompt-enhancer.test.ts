import { describe, expect, it } from 'vitest';
import {
  applyPromptEnhancementSafeguards,
  buildEnhancerSystemPrompt,
  buildPromptEnhancementArtifacts,
  buildPromptStrategyGuidance,
  buildWorkflowPromptFieldGuidance,
  resolvePromptScenario,
} from '@/lib/prompt-enhancer';
import { PROMPT_ENHANCER_FIXTURES } from '@/__tests__/fixtures/prompt-enhancer-fixtures';

describe('prompt enhancer strategy', () => {
  it.each(PROMPT_ENHANCER_FIXTURES)('resolves scenario for $name', (fixture) => {
    expect(resolvePromptScenario(fixture.medium, fixture.selectedModel, fixture.context)).toBe(
      fixture.expectedScenario
    );
  });

  it.each(PROMPT_ENHANCER_FIXTURES)('builds scenario-aware guidance for $name', (fixture) => {
    const guidance = buildPromptStrategyGuidance({
      medium: fixture.medium,
      selectedModel: fixture.selectedModel,
      context: fixture.context,
      includeExamples: true,
    });

    for (const expected of fixture.expectedIncludes) {
      expect(guidance).toContain(expected);
    }

    for (const excluded of fixture.expectedExcludes ?? []) {
      expect(guidance).not.toContain(excluded);
    }
  });

  it('only adds text rendering guidance when the image prompt asks for text', () => {
    const withText = buildEnhancerSystemPrompt(
      'image',
      'nano-banana-2',
      { aspectRatio: '1:1' },
      'Create a poster and the text reads SALE'
    );
    const withoutText = buildEnhancerSystemPrompt(
      'image',
      'nano-banana-2',
      { aspectRatio: '1:1' },
      'Create a founder portrait in the studio'
    );

    expect(withText).toContain('Text rendering guidance:');
    expect(withoutText).not.toContain('Text rendering guidance:');
    expect(withText).toContain('ImagePromptSpec schema');
  });

  it('only includes Google Search grounding guidance when it is enabled', () => {
    const grounded = buildPromptStrategyGuidance({
      medium: 'image',
      selectedModel: 'nano-banana-2',
      context: { googleSearch: true },
    });
    const notGrounded = buildPromptStrategyGuidance({
      medium: 'image',
      selectedModel: 'nano-banana-2',
      context: { googleSearch: false },
    });

    expect(grounded).toContain('Google Search grounding is enabled');
    expect(notGrounded).not.toContain('Google Search grounding is enabled');
  });

  it('builds structured image artifacts for Nano Banana 2 with concise readable-text output', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'image',
      'nano-banana-2',
      JSON.stringify({
        subject: 'a founder holding a serum bottle',
        setting: 'a bright daylight studio',
        composition: 'centered portrait composition',
        cameraFraming: 'eye-level medium shot',
        lighting: 'soft diffused window light',
        materialDetail: 'natural skin texture and crisp glass reflections',
        readableText: {
          exactText: 'SALE',
          placement: 'on the poster header',
          treatment: 'clean sans-serif lettering',
        },
        finish: 'polished commercial finish',
      }),
      { aspectRatio: '9:16' },
      'Founder poster with SALE text'
    );

    expect(artifacts.plannerMode).toBe('structured-image');
    expect(artifacts.compiledPrompt).toContain('a founder holding a serum bottle');
    expect(artifacts.compiledPrompt).toContain('Include readable text "SALE"');
    expect(artifacts.compiledPrompt).toContain('polished commercial finish');
  });

  it('builds richer image artifacts for Nano Banana Pro with reference anchors', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'image',
      'nano-banana-pro',
      JSON.stringify({
        subject: 'a premium skincare product hero still',
        setting: 'on a marble vanity in a warm editorial bathroom',
        composition: 'clean poster-style layout with strong negative space',
        cameraFraming: 'three-quarter product framing',
        lighting: 'soft golden-hour light',
        materialDetail: 'tactile packaging detail and crisp glass highlights',
        referenceAnchors: ['the attached creator identity', 'the exact product packaging'],
        readableText: {
          exactText: 'Build Your Routine',
          placement: 'as the top headline',
          treatment: 'high-contrast premium sans-serif typography',
        },
        constraints: ['the branding legible', 'the product label unobstructed'],
        finish: 'high-fidelity commercial polish',
      }),
      { referenceImageCount: 2 },
      'Premium skincare poster'
    );

    expect(artifacts.compiledPrompt).toContain('premium skincare product hero still');
    expect(artifacts.compiledPrompt).toContain('Preserve the attached creator identity and the exact product packaging');
    expect(artifacts.compiledPrompt).toContain('Include readable text "Build Your Routine"');
    expect(artifacts.compiledPrompt).toContain('Keep the branding legible and the product label unobstructed');
  });

  it('compiles Veo prompts without quoted dialogue and keeps one scene per clip', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'video',
      'veo-3.1',
      JSON.stringify({
        sceneGoal: 'show the creator discovering the product benefit',
        subjectAction: 'a creator lifts the serum and smiles to camera',
        environment: 'inside a bright modern bathroom',
        cameraMovement: 'gentle push-in',
        ambience: 'clean natural daylight',
        pacing: 'one focused 8-second beat',
        durationBudget: '8-second clip',
        dialogue: 'Creator says: "Glow in one swipe."',
      }),
      { duration: 8 },
      'Creator reveals the serum benefit'
    );

    expect(artifacts.compiledPrompt).toContain('a creator lifts the serum and smiles to camera');
    expect(artifacts.compiledPrompt).toContain('Creator says: Glow in one swipe.');
    expect(artifacts.compiledPrompt).not.toContain('"Glow in one swipe."');
  });

  it('compiles Seedance prompts with fixed-lens and audio cues only when enabled', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'video',
      'seedance-1.5-pro',
      JSON.stringify({
        sceneGoal: 'bartender greeting guests',
        subjectAction: 'a bartender leans forward to welcome the group',
        environment: 'inside a lively Portuguese tavern',
        cameraMovement: 'medium shot with subtle drift',
        ambience: 'warm evening atmosphere',
        audioCue: 'clinking glasses and soft crowd chatter',
        pacing: 'relaxed but responsive pacing',
        durationBudget: '8-second clip',
      }),
      { duration: 8, sound: true, fixedLens: true },
      'Bartender greets guests'
    );

    expect(artifacts.compiledPrompt).toContain('static locked camera');
    expect(artifacts.compiledPrompt).toContain('Audio cues: clinking glasses and soft crowd chatter.');
  });

  it('compiles Kling multi-shot prompts into the current shot when shot index is known', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'video',
      'kling-3.0/video',
      JSON.stringify({
        sceneGoal: 'premium unboxing sequence',
        subjectAction: 'hands reveal a premium device',
        environment: 'on a moody premium tabletop',
        cameraMovement: 'slow cinematic push-in',
        continuityAnchors: ['the same matte black box', 'the same pair of hands'],
        ambience: 'controlled studio atmosphere',
        pacing: 'measured premium pacing',
        durationBudget: '4-second shot',
        shots: [
          {
            index: 1,
            title: 'Box arrival',
            startState: 'the unopened box lands on the table',
            actionBeat: 'hands square the product to camera',
            endState: 'the lid is ready to lift',
            camera: 'low-angle dolly-in',
          },
          {
            index: 2,
            title: 'Product reveal',
            startState: 'the lid lifts away',
            actionBeat: 'the device is revealed on velvet',
            endState: 'hands pause for a hero hold',
            camera: 'slow overhead glide',
            transition: 'keep the same premium tabletop lighting',
          },
        ],
      }),
      { isMultiShot: true, shotIndex: 1, shotCount: 2, duration: 4 },
      'Two-shot premium unboxing'
    );

    expect(artifacts.compiledPrompt).toContain('Product reveal');
    expect(artifacts.compiledPrompt).toContain('slow overhead glide');
    expect(artifacts.compiledPrompt).not.toContain('Shot 1:');
  });

  it('emits ordered shot prompts only when multi-shot mode requests a full sequence', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'video',
      'kling-3.0/video',
      JSON.stringify({
        sceneGoal: 'premium unboxing sequence',
        subjectAction: 'hands reveal a premium device',
        environment: 'on a moody premium tabletop',
        cameraMovement: 'slow cinematic push-in',
        shots: [
          {
            index: 1,
            title: 'Box arrival',
            startState: 'the unopened box lands on the table',
            actionBeat: 'hands square the product to camera',
            endState: 'the lid is ready to lift',
            camera: 'low-angle dolly-in',
          },
          {
            index: 2,
            title: 'Product reveal',
            startState: 'the lid lifts away',
            actionBeat: 'the device is revealed on velvet',
            endState: 'hands pause for a hero hold',
            camera: 'slow overhead glide',
          },
        ],
      }),
      { isMultiShot: true, shotCount: 2 },
      'Two-shot premium unboxing'
    );

    expect(artifacts.compiledPrompt).toContain('Shot 1:');
    expect(artifacts.compiledPrompt).toContain('Shot 2:');
  });

  it('falls back to raw enhancer text when structured output is malformed', () => {
    const artifacts = buildPromptEnhancementArtifacts(
      'image',
      'nano-banana-2',
      'A concise founder portrait in a bright studio with crisp product visibility.',
      { aspectRatio: '1:1' },
      'Founder portrait'
    );

    expect(artifacts.compiledPrompt).toBe('A concise founder portrait in a bright studio with crisp product visibility.');
  });

  it('preserves missing named handles in standard safeguard mode', () => {
    const safeguarded = applyPromptEnhancementSafeguards(
      'Place @serum on a marble vanity',
      'A premium product still on a marble vanity.',
      {
        elementReferences: [{ handle: '@serum', displayName: 'Serum bottle' }],
      }
    );

    expect(safeguarded).toContain('@serum');
    expect(safeguarded).toContain('Preserve the named reference elements @serum exactly as referenced.');
  });

  it('reverts append-only element prompts when the enhanced prompt breaks the locked opening', () => {
    const safeguarded = applyPromptEnhancementSafeguards(
      'Use @serum in a bright studio',
      'A premium product shot in a bright studio with crisp highlights.',
      {
        elementEnhancementMode: 'append-only',
        elementReferences: [{ handle: '@serum', displayName: 'Serum bottle' }],
      }
    );

    expect(safeguarded).toBe('Use @serum in a bright studio');
  });

  it('builds workflow field guidance that changes by model and objective', () => {
    const guidance = buildWorkflowPromptFieldGuidance({
      fieldName: 'videoPrompt',
      modelSelector: 'primaryModel',
      medium: 'video',
      scenario: 'video.image_to_video_start_frame',
      modelIds: ['kling-3.0-video', 'veo-3.1'],
      context: { creativeIntent: 'ugc-ad' },
      additionalRules: ['These prompts should remain reference-friendly.'],
    });

    expect(guidance).toContain('videoPrompt guidance:');
    expect(guidance).toContain('These prompts should remain reference-friendly.');
    expect(guidance).toContain('If primaryModel is kling-3.0-video');
    expect(guidance).toContain('If primaryModel is veo-3.1');
    expect(guidance).toContain('creator-led commercial realism');
    expect(guidance).toContain('one scene with explicit subject, action, context, camera, and ambience');
  });
});
