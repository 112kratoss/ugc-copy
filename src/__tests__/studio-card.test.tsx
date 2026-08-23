import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import StudioCard, { StudioChip, StudioKindBadge, StudioMeta, studioActionClass } from '@/app/creations/StudioCard';

describe('StudioCard', () => {
  it('lays a compact card out as tile, state, facts, primary action, then the footer', () => {
    render(
      <StudioCard
        density="compact"
        testId="card"
        // eslint-disable-next-line @next/next/no-img-element
        media={<img alt="Generated image" src="https://example.com/a.jpg" />}
        badge={<StudioKindBadge tone="sky">Image</StudioKindBadge>}
        chips={<StudioChip tone="sky">Public</StudioChip>}
        title="Sunset study"
        summary="A warm evening."
        meta={[
          { label: 'Created', value: 'Aug 9' },
          { label: 'Render', value: '' },
          { label: 'Credits', value: 8 },
        ]}
        primaryAction={<button type="button" className={studioActionClass('primary', { full: true })}>Publish</button>}
        actions={<button type="button">Details</button>}
        menu={<button type="button" aria-label="More actions" />}
      />,
    );

    const card = screen.getByTestId('card');
    expect(card.tagName).toBe('ARTICLE');
    expect(card).toHaveClass('flex', 'flex-col', 'h-full');

    const order = [
      within(card).getByAltText('Generated image'),
      within(card).getByText('Public'),
      within(card).getByRole('heading', { name: 'Sunset study' }),
      within(card).getByText('A warm evening.'),
      within(card).getByText('Created'),
      within(card).getByRole('button', { name: 'Publish' }),
      within(card).getByRole('button', { name: 'Details' }),
      within(card).getByRole('button', { name: 'More actions' }),
    ];
    for (let index = 1; index < order.length; index += 1) {
      // DOCUMENT_POSITION_FOLLOWING: the later element comes after the earlier one.
      expect(order[index - 1].compareDocumentPosition(order[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // A fact with nothing to say is left out rather than shown empty.
    expect(within(card).queryByText('Render')).not.toBeInTheDocument();
    expect(within(card).getByText('Credits')).toBeInTheDocument();
    // The primary action spans the card.
    expect(within(card).getByRole('button', { name: 'Publish' })).toHaveClass('w-full');
  });

  it('lays an expanded card out with the media beside the body and the chips by the title', () => {
    render(
      <StudioCard
        density="expanded"
        testId="row"
        tone="archived"
        // eslint-disable-next-line @next/next/no-img-element
        media={<img alt="Post preview" src="https://example.com/b.jpg" />}
        chips={<StudioChip tone="muted">Archived</StudioChip>}
        title="Library row"
        subtitle="Manual · Updated Jun 1"
        actions={<a href="/post/1/edit">Edit post</a>}
      />,
    );

    const row = screen.getByTestId('row');
    expect(row).not.toHaveClass('flex-col');
    expect(row.querySelector('.md\\:grid-cols-\\[180px_minmax\\(0\\,1fr\\)\\]')).not.toBeNull();
    expect(within(row).getByText('Manual · Updated Jun 1')).toBeInTheDocument();
    expect(within(row).getByText('Archived')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Edit post' })).toBeInTheDocument();
    expect(row).toHaveClass('border-white/[0.08]');
  });

  it('becomes one link when given an href', () => {
    render(
      <StudioCard
        as="li"
        density="compact"
        href="/unlocks/unlock-1"
        media={<div>media</div>}
        title="Prompt pack"
      />,
    );

    const link = screen.getByRole('link', { name: /prompt pack/i });
    expect(link).toHaveAttribute('href', '/unlocks/unlock-1');
    expect(link.closest('li')).not.toBeNull();
  });

  it('renders facts as a definition list without separators', () => {
    const { container } = render(<StudioMeta items={[{ label: 'Created', value: 'Aug 9' }, { label: 'Credits', value: 8 }]} />);
    const list = container.querySelector('dl');
    expect(list?.textContent).toBe('CreatedAug 9Credits8');
    expect(list?.querySelectorAll('dt')).toHaveLength(2);
  });
});
