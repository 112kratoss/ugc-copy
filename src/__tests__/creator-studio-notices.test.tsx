import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { StudioModelNotice, StudioOutOfDatePageNotice, StudioQuoteRetry, StudioRemixNotice } from '@/components/CreatorStudio';

describe('creator studio notices', () => {
  it('keeps the remix title on remix notices and gives model notices their own', () => {
    render(
      <>
        <StudioRemixNotice description={'Settings pre-filled from "Neon city".'} />
        <StudioModelNotice description="Model settings changed. Review the refreshed options before generating." />
      </>
    );

    const remixNotice = screen.getByText('Settings pre-filled from "Neon city".').closest('section');
    const modelNotice = screen.getByText(/Review the refreshed options/).closest('section');

    expect(remixNotice).toHaveTextContent('Remixing Community Creation');
    expect(modelNotice).toHaveTextContent('Model settings');
    expect(modelNotice).not.toHaveTextContent('Remixing Community Creation');
  });

  it('offers a dismiss button only when the model notice can be dismissed', () => {
    const onDismiss = vi.fn();
    const view = render(<StudioModelNotice description="This model is no longer available." />);
    expect(screen.queryByRole('button', { name: 'Dismiss model notice' })).not.toBeInTheDocument();

    view.rerender(<StudioModelNotice description="Model settings changed." onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss model notice' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('says why the price is missing and asks it again from Retry quote', () => {
    const onRetry = vi.fn();
    render(<StudioQuoteRetry message="Could not calculate generation cost." onRetry={onRetry} />);

    expect(screen.getByText(/Could not calculate generation cost\./)).toHaveTextContent('Retry quote');
    fireEvent.click(screen.getByRole('button', { name: 'Retry quote' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('says a page is out of date, what a reload keeps, and reloads from its button', () => {
    const onReload = vi.fn();
    const view = render(<StudioOutOfDatePageNotice isRemix={false} onReload={onReload} />);
    expect(screen.getByRole('alert')).toHaveTextContent('This page is out of date, so it cannot show what this run costs. Reload it to see the current price. Your draft is kept.');

    view.rerender(<StudioOutOfDatePageNotice isRemix onReload={onReload} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The remix starts again from the original.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Your draft is kept.');
    fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));

    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
