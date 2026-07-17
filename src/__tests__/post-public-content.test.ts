import { describe, expect, it } from 'vitest';

import {
  isGeneratedRecipeSetupText,
  sanitizePublicPostContent,
} from '@/lib/post-public-content';

describe('public post content privacy', () => {
  it('recognizes generated setup notes without matching ordinary captions', () => {
    expect(isGeneratedRecipeSetupText('Saved generation setup\nModel: GPT Image 2')).toBe(true);
    expect(isGeneratedRecipeSetupText('Saved generation setup')).toBe(true);
    expect(isGeneratedRecipeSetupText('A saved generation setup made this easier.')).toBe(false);
  });

  it('removes recipe prompts and generated paid setup copy from public payloads', () => {
    expect(sanitizePublicPostContent({
      prompt: 'SECRET_PROMPT',
      body: 'Saved generation setup\nModel: GPT Image 2',
      description: 'Saved generation setup\nInputs: 2 saved references',
      hasRecipe: true,
      isPaidRecipe: true,
    })).toEqual({
      prompt: '',
      body: '',
      description: '',
    });
  });

  it('keeps deliberate public captions while a paid recipe stays gated', () => {
    expect(sanitizePublicPostContent({
      prompt: 'SECRET_PROMPT',
      body: 'Here is the finished campaign image.',
      description: 'A public result with a reusable recipe attached.',
      hasRecipe: true,
      isPaidRecipe: true,
    })).toEqual({
      prompt: '',
      body: 'Here is the finished campaign image.',
      description: 'A public result with a reusable recipe attached.',
    });
  });
});
