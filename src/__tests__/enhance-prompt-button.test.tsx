import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import EnhancePromptButton from '@/components/EnhancePromptButton';
import { requestPromptEnhancement, type PromptEnhancementResult } from '@/components/enhancePromptClient';
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

  // The prompt box stays open while the enhancer works, for up to 45 s, so an answer
  // can land on words the person has typed since.
  describe('an answer that lands after the press', () => {
    const shared = { onCreditsUpdate: vi.fn(), medium: 'image' as const, selectedModel: 'nano-banana-2' };

    function answerLater() {
      let answer: (result: PromptEnhancementResult) => void = () => undefined;
      vi.mocked(requestPromptEnhancement).mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
      return (result: PromptEnhancementResult) => act(async () => { answer(result); });
    }

    it('replaces the prompt that was sent', async () => {
      const answer = answerLater();
      const onEnhanced = vi.fn();
      render(<EnhancePromptButton prompt="A red fox" onEnhanced={onEnhanced} {...shared} />);

      fireEvent.click(screen.getByRole('button', { name: /^Enhance, / }));
      await answer({ enhancedPrompt: 'A red fox at dawn, rim light.' });

      expect(onEnhanced).toHaveBeenCalledWith('A red fox at dawn, rim light.', expect.objectContaining({ enhancedPrompt: 'A red fox at dawn, rim light.' }));
      expect(screen.queryByRole('button', { name: 'Use enhanced' })).toBeNull();
    });

    it('keeps words typed meanwhile, and offers the answer beside them', async () => {
      const answer = answerLater();
      const onEnhanced = vi.fn();
      const onCreditsUpdate = vi.fn();
      const view = render(<EnhancePromptButton prompt="A red fox" onEnhanced={onEnhanced} {...shared} onCreditsUpdate={onCreditsUpdate} />);

      fireEvent.click(screen.getByRole('button', { name: /^Enhance, / }));
      view.rerender(<EnhancePromptButton prompt="A red fox in snow" onEnhanced={onEnhanced} {...shared} onCreditsUpdate={onCreditsUpdate} />);
      await answer({ enhancedPrompt: 'A red fox at dawn, rim light.', remainingCredits: 40 });

      expect(onEnhanced).not.toHaveBeenCalled();
      expect(onCreditsUpdate).toHaveBeenCalledWith(40);
      expect(screen.getByText('Your edits were kept.')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Use enhanced' }));
      expect(onEnhanced).toHaveBeenCalledWith('A red fox at dawn, rim light.', expect.objectContaining({ enhancedPrompt: 'A red fox at dawn, rim light.' }));

      // Undo goes back to the words typed, not to the ones sent.
      view.rerender(<EnhancePromptButton prompt="A red fox at dawn, rim light." onEnhanced={onEnhanced} {...shared} onCreditsUpdate={onCreditsUpdate} />);
      expect(screen.queryByRole('button', { name: 'Use enhanced' })).toBeNull();
      expect(screen.queryByText('Your edits were kept.')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(onEnhanced).toHaveBeenLastCalledWith('A red fox in snow');
    });

    // A shot's callback writes the shots it was drawn with: the press-time one would
    // undo edits made to the other shots during the wait.
    it('hands the answer to the newest callback', async () => {
      const answer = answerLater();
      const drawnAtPress = vi.fn();
      const drawnLatest = vi.fn();
      const view = render(<EnhancePromptButton prompt="A red fox" onEnhanced={drawnAtPress} {...shared} />);

      fireEvent.click(screen.getByRole('button', { name: /^Enhance, / }));
      view.rerender(<EnhancePromptButton prompt="A red fox" onEnhanced={drawnLatest} {...shared} />);
      await answer({ enhancedPrompt: 'A red fox at dawn, rim light.' });

      expect(drawnAtPress).not.toHaveBeenCalled();
      expect(drawnLatest).toHaveBeenCalledWith('A red fox at dawn, rim light.', expect.anything());
    });

    // A shot's button goes with its shot (keyed by its id), the workflow editor's with its
    // node, and their last callbacks would write back the shot list as it stood then.
    it('lets an answer go whose button has gone', async () => {
      const answer = answerLater();
      const onEnhanced = vi.fn();
      const onCreditsUpdate = vi.fn();
      const view = render(<EnhancePromptButton prompt="A red fox" onEnhanced={onEnhanced} {...shared} onCreditsUpdate={onCreditsUpdate} />);

      fireEvent.click(screen.getByRole('button', { name: /^Enhance, / }));
      view.unmount();
      await answer({ enhancedPrompt: 'A red fox at dawn, rim light.', remainingCredits: 40 });

      expect(onEnhanced).not.toHaveBeenCalled();
      expect(onCreditsUpdate).toHaveBeenCalledWith(40);
    });

    it('offers the answer only while the words it was offered beside stand', async () => {
      const answer = answerLater();
      const onEnhanced = vi.fn();
      const view = render(<EnhancePromptButton prompt="A red fox" onEnhanced={onEnhanced} {...shared} />);

      fireEvent.click(screen.getByRole('button', { name: /^Enhance, / }));
      view.rerender(<EnhancePromptButton prompt="A red fox in snow" onEnhanced={onEnhanced} {...shared} />);
      await answer({ enhancedPrompt: 'A red fox at dawn, rim light.' });
      expect(screen.getByRole('button', { name: 'Use enhanced' })).toBeInTheDocument();

      // Written on, or over with something else: the answer no longer belongs beside it.
      view.rerender(<EnhancePromptButton prompt="A white hare" onEnhanced={onEnhanced} {...shared} />);
      expect(screen.queryByRole('button', { name: 'Use enhanced' })).toBeNull();
      expect(screen.queryByText('Your edits were kept.')).toBeNull();
    });
  });
});
