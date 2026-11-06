import { cleanup, render, screen } from '@testing-library/react';
import { Sparkles } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button } from '@/components/DesignSystem';

afterEach(() => {
  cleanup();
});

// A button whose press waits says so, as the app's buttons do (design-mobile.md → Glyphs): it
// takes no press, it is busy for a screen reader, and the spinner takes its glyph's place beside
// the words of what it is doing.
describe('Button while it waits', () => {
  it('takes no press, is busy, and draws the spinner in its glyph’s place', () => {
    const onClick = vi.fn();
    render(<Button pending icon={Sparkles} iconPosition="start" onClick={onClick}>Adding the original…</Button>);

    const button = screen.getByRole('button', { name: 'Adding the original…' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    const glyphs = button.querySelectorAll('svg');
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]).toHaveClass('animate-spin', 'motion-reduce:animate-none');
    expect(glyphs[0]).toHaveAttribute('aria-hidden', 'true');
    button.click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('draws the spinner before the words of a button with no glyph', () => {
    render(<Button pending>Saving…</Button>);
    const button = screen.getByRole('button', { name: 'Saving…' });
    expect(button.firstElementChild).toHaveClass('animate-spin');
  });

  it('is neither busy nor held when it is not waiting', () => {
    render(<Button icon={Sparkles}>Use as reference</Button>);
    const button = screen.getByRole('button', { name: 'Use as reference' });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute('aria-busy');
    expect(button.querySelector('svg')).not.toHaveClass('animate-spin');
  });
});
