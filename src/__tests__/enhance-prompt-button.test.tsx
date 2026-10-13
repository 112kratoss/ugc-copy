import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import EnhancePromptButton from '@/components/EnhancePromptButton';
import { PROMPT_ENHANCEMENT_COST_CREDITS } from '../../ugc-mobile/lib/model-catalog/protocol';

vi.mock('@/components/enhancePromptClient', () => ({
  PromptEnhancementError: class PromptEnhancementError extends Error {},
  requestPromptEnhancement: vi.fn(),
}));

describe('EnhancePromptButton', () => {
  it('prints the price the enhancement service debits', () => {
    render(
      <EnhancePromptButton
        prompt="A red fox at dawn"
        onEnhanced={vi.fn()}
        onCreditsUpdate={vi.fn()}
        medium="image"
        selectedModel="nano-banana-2"
      />,
    );

    expect(screen.getByRole('button', { name: `Enhance, ${PROMPT_ENHANCEMENT_COST_CREDITS} credits` })).toBeEnabled();
    expect(screen.getByText(`${PROMPT_ENHANCEMENT_COST_CREDITS} credits`)).toBeInTheDocument();
  });
});
