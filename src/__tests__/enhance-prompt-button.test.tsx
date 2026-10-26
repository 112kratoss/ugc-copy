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

  // The image creator's column draws Enhance as a tile beside Templates, as the app does.
  describe('as a toolbar', () => {
    function renderToolbar(props: { prompt?: string; disabled?: boolean } = {}) {
      return render(
        <EnhancePromptButton
          variant="toolbar"
          leading={<button type="button">Templates</button>}
          prompt={props.prompt ?? 'A red fox at dawn'}
          onEnhanced={vi.fn()}
          onCreditsUpdate={vi.fn()}
          medium="image"
          selectedModel="nano-banana-2"
          disabled={props.disabled}
        />,
      );
    }

    it('draws the leading tile first, then Enhance with its price, then the level under them', () => {
      renderToolbar();
      const templates = screen.getByRole('button', { name: 'Templates' });
      const enhance = screen.getByRole('button', { name: `Enhance, ${PROMPT_ENHANCEMENT_COST_CREDITS} credits` });
      const level = screen.getByRole('group', { name: 'Enhancement level' });

      expect(enhance).toBeEnabled();
      expect(templates.compareDocumentPosition(enhance) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(enhance.compareDocumentPosition(level) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Full' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('waits for a prompt, and for a run to end', () => {
      const view = renderToolbar({ prompt: '' });
      expect(screen.getByRole('button', { name: /^Enhance, / })).toBeDisabled();

      view.rerender(
        <EnhancePromptButton
          variant="toolbar"
          prompt="A red fox at dawn"
          onEnhanced={vi.fn()}
          onCreditsUpdate={vi.fn()}
          medium="image"
          selectedModel="nano-banana-2"
          disabled
        />,
      );
      expect(screen.getByRole('button', { name: /^Enhance, / })).toBeDisabled();
    });
  });
});
