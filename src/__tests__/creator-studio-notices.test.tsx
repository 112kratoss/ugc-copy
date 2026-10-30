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

  it('draws the original in the remix notice and opens it from the picture', () => {
    const onOpen = vi.fn();
    const description = 'Settings pre-filled from "Neon city".';
    const view = render(
      <StudioRemixNotice
        description={description}
        original={{ mediaType: 'image', src: 'https://example.com/result.png', onOpen }}
      />
    );

    const picture = screen.getByRole('button', { name: 'View original' });
    expect(picture.querySelector('img')).toHaveAttribute('src', 'https://example.com/result.png');
    fireEvent.click(picture);
    expect(onOpen).toHaveBeenCalledTimes(1);

    // A video shows a still from its first moment, never a playing loop.
    view.rerender(
      <StudioRemixNotice
        description={description}
        original={{ mediaType: 'video', src: 'https://example.com/result.mp4', onOpen }}
      />
    );
    const clip = screen.getByRole('button', { name: 'View original' });
    const still = clip.querySelector('video');
    expect(still).toHaveAttribute('src', 'https://example.com/result.mp4#t=0.1');
    expect(still).toHaveAttribute('preload', 'metadata');
    expect(still).not.toHaveAttribute('autoplay');
    expect(still).not.toHaveAttribute('tabindex');
    fireEvent.click(clip);
    expect(onOpen).toHaveBeenCalledTimes(2);

    // No restored result: nothing to open, and the notice keeps its icon.
    view.rerender(<StudioRemixNotice description={description} original={null} />);
    expect(screen.queryByRole('button', { name: 'View original' })).not.toBeInTheDocument();
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
    const view = render(<StudioOutOfDatePageNotice isRemix={false} reloadDidNotHelp={false} onReload={onReload} />);
    expect(screen.getByRole('alert')).toHaveTextContent('This page is out of date, so it cannot show what this run costs. Reload it to see the current price. Your draft is kept.');

    view.rerender(<StudioOutOfDatePageNotice isRemix reloadDidNotHelp={false} onReload={onReload} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The remix starts again from the original.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Your draft is kept.');
    fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));

    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('says a reload brought the same version back, and offers no reload again', () => {
    const view = render(<StudioOutOfDatePageNotice isRemix={false} reloadDidNotHelp onReload={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('This page is out of date, so it cannot show what this run costs, and reloading it brought back the same version. Wait a few minutes, then reload the page.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('Your draft is kept.');
    expect(screen.queryByRole('button', { name: 'Reload page' })).not.toBeInTheDocument();

    view.rerender(<StudioOutOfDatePageNotice isRemix reloadDidNotHelp onReload={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The remix starts again from the original.');
  });
});
