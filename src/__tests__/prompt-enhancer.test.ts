import { describe, expect, it } from 'vitest';
import {
  buildEnhancerSystemPrompt,
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
  });
});
